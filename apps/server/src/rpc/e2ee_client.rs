//! The client side of `/ws-e2ee` (#202): the pinned Noise NK channel, its records, the
//! `e2ee_auth` exchange and the RPC request/ack codec, for `bibcode diagnostics` talking to a
//! remote server itself. The wire contract is the responder's (`e2ee.rs`) and
//! `docs/architecture/remote.md` "Direct-connection E2EE"; this client offers no channel
//! features, so every record it accepts is a plain `0x00` final or `0x01` continuation.
//!
//! Everything it reads is bounded before it is kept: a record by the Noise ciphertext limit,
//! a logical message by [`MAX_CLIENT_MESSAGE_BYTES`] and the responder's record count, and the
//! pre-auth reply by the responder's own pre-auth bound.

use std::{sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use snow::TransportState;
use thiserror::Error;
use tokio::{
    net::TcpStream,
    time::{Instant, timeout_at},
};
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream,
    tungstenite::{self, Message, protocol::WebSocketConfig},
};

use super::{
    ClientMessage, RequestId, RpcExit, ServerMessage,
    e2ee::{
        E2EE_HANDSHAKE_TIMEOUT, E2EE_HOST_IDENTITY_CLOSE_CODE, E2EE_RECORD_FLAG_CONTINUATION,
        E2EE_RECORD_FLAG_FINAL, MAX_E2EE_CIPHERTEXT_BYTES, MAX_E2EE_PREAUTH_MESSAGE_BYTES,
        MAX_E2EE_RECORDS_PER_MESSAGE, plaintext_records,
    },
};
use crate::auth::NOISE_NK_PARAMS;

/// The largest logical message this client keeps. One diagnostics `Chunk` carries one item of
/// at most 64 KiB of archive (about 87 KiB encoded); nothing this client asks for is larger.
pub(crate) const MAX_CLIENT_MESSAGE_BYTES: usize = 1024 * 1024;
const NOISE_TAG_BYTES: usize = 16;
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Error)]
pub(crate) enum E2eeClientError {
    #[error("{0}")]
    Endpoint(String),
    #[error("could not connect: {0}")]
    Unreachable(String),
    #[error("could not verify the server's TLS certificate: {0}")]
    Tls(String),
    #[error("the server did not prove the host identity pinned at pairing")]
    HostIdentityMismatch,
    #[error("the server refused the credential")]
    Unauthorized,
    #[error("the server sent something this client does not understand: {0}")]
    Protocol(String),
    #[error("the connection was lost: {0}")]
    ConnectionLost(String),
    #[error("the server did not answer in time ({0})")]
    Timeout(&'static str),
}

/// Which certificates an `https` endpoint may present. Production trusts the platform's
/// roots, as `reqwest` does; tests add a root of their own.
#[derive(Clone, Debug, Default)]
pub(crate) enum ServerTrust {
    #[default]
    Platform,
    #[cfg(test)]
    PlatformAnd(Vec<rustls::pki_types::CertificateDer<'static>>),
}

/// How an RPC call ended other than successfully.
#[derive(Debug)]
pub(crate) enum RpcCallError<E> {
    Client(E2eeClientError),
    /// The request's typed failure (`Exit` with a `Fail` cause).
    Failed(Value),
    /// The request was interrupted or died on the server.
    Ended,
    /// The server ended the connection's protocol (`Defect`, `ClientProtocolError`); an
    /// unknown method arrives this way.
    Defect(String),
    /// The caller refused an item.
    Rejected(E),
}

impl<E> From<E2eeClientError> for RpcCallError<E> {
    fn from(error: E2eeClientError) -> Self {
        Self::Client(error)
    }
}

/// Wait bounds for a streamed request.
#[derive(Clone, Copy, Debug)]
pub(crate) struct StreamWaits {
    /// For the first item (the server may first build what it sends).
    pub first: Duration,
    /// For each item after it.
    pub next: Duration,
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// One encrypted connection to a remote server's `/ws-e2ee`.
pub(crate) struct E2eeClient {
    socket: Socket,
    transport: TransportState,
    next_request_id: u64,
}

/// `<endpoint>/ws-e2ee` as a WebSocket URL: the path is replaced, as the web client does.
pub(crate) fn e2ee_url(endpoint: &str) -> Result<url::Url, E2eeClientError> {
    let invalid = || E2eeClientError::Endpoint(format!("{endpoint} is not an http(s) address"));
    let mut url = url::Url::parse(endpoint.trim()).map_err(|_| invalid())?;
    let scheme = match url.scheme() {
        "http" => "ws",
        "https" => "wss",
        _ => return Err(invalid()),
    };
    if url.host_str().is_none_or(str::is_empty) || !url.username().is_empty() {
        return Err(invalid());
    }
    url.set_scheme(scheme).map_err(|()| invalid())?;
    url.set_path("/ws-e2ee");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn tls_connector(trust: &ServerTrust) -> Result<Connector, E2eeClientError> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let verifier = match trust {
        ServerTrust::Platform => rustls_platform_verifier::Verifier::new(provider.clone()),
        #[cfg(test)]
        ServerTrust::PlatformAnd(roots) => {
            rustls_platform_verifier::Verifier::new_with_extra_roots(
                roots.clone(),
                provider.clone(),
            )
        }
    }
    .map_err(|error| E2eeClientError::Tls(error.to_string()))?;
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| E2eeClientError::Tls(error.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(config)))
}

fn connect_error(error: tungstenite::Error) -> E2eeClientError {
    match error {
        tungstenite::Error::Tls(error) => E2eeClientError::Tls(error.to_string()),
        tungstenite::Error::Io(error)
            if error
                .get_ref()
                .is_some_and(|inner| inner.is::<rustls::Error>()) =>
        {
            E2eeClientError::Tls(error.to_string())
        }
        other => E2eeClientError::Unreachable(other.to_string()),
    }
}

impl E2eeClient {
    /// Opens `/ws-e2ee` on `endpoint` and completes the Noise NK handshake pinned to
    /// `host_key`. The deadline covers the socket, TLS, the upgrade and the handshake; the
    /// caller authenticates before [`E2EE_HANDSHAKE_TIMEOUT`] passes, as the server requires.
    pub(crate) async fn connect(
        endpoint: &str,
        host_key: &[u8],
        trust: &ServerTrust,
        deadline: Instant,
    ) -> Result<Self, E2eeClientError> {
        let url = e2ee_url(endpoint)?;
        if host_key.len() != 32 {
            return Err(E2eeClientError::Endpoint(
                "the pinned host key is not 32 bytes".to_owned(),
            ));
        }
        let connector = if url.scheme() == "wss" {
            tls_connector(trust)?
        } else {
            Connector::Plain
        };
        let config = WebSocketConfig::default()
            .max_frame_size(Some(MAX_E2EE_CIPHERTEXT_BYTES))
            .max_message_size(Some(MAX_E2EE_CIPHERTEXT_BYTES));
        let (mut socket, _) = timeout_at(
            deadline,
            tokio_tungstenite::connect_async_tls_with_config(
                url.as_str(),
                Some(config),
                true,
                Some(connector),
            ),
        )
        .await
        .map_err(|_| E2eeClientError::Timeout("connecting"))?
        .map_err(connect_error)?;

        let protocol = |error: snow::Error| E2eeClientError::Protocol(error.to_string());
        let mut handshake = snow::Builder::new(NOISE_NK_PARAMS.parse().map_err(protocol)?)
            .remote_public_key(host_key)
            .map_err(protocol)?
            .build_initiator()
            .map_err(protocol)?;
        let mut message_a = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
        let length = handshake
            .write_message(&[], &mut message_a)
            .map_err(protocol)?;
        message_a.truncate(length);
        timeout_at(deadline, socket.send(Message::Binary(message_a.into())))
            .await
            .map_err(|_| E2eeClientError::Timeout("the handshake"))?
            .map_err(|error| E2eeClientError::ConnectionLost(error.to_string()))?;
        // The responder closes with 4403 when message A does not decrypt under its key.
        let message_b = timeout_at(deadline, next_binary(&mut socket))
            .await
            .map_err(|_| E2eeClientError::Timeout("the handshake"))??;
        let mut payload = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
        let length = handshake
            .read_message(&message_b, &mut payload)
            .map_err(|_| E2eeClientError::HostIdentityMismatch)?;
        if length != 0 {
            return Err(E2eeClientError::Protocol(
                "the handshake reply carried a payload".to_owned(),
            ));
        }
        let transport = handshake.into_transport_mode().map_err(protocol)?;
        Ok(Self {
            socket,
            transport,
            next_request_id: 1,
        })
    }

    /// Sends `e2ee_auth` (no channel features) and returns the `e2ee_authenticated` reply.
    pub(crate) async fn authenticate(
        &mut self,
        auth: E2eeAuth<'_>,
        deadline: Instant,
    ) -> Result<Value, E2eeClientError> {
        let message = match auth {
            E2eeAuth::Pairing(token) => json!({ "type": "e2ee_auth", "pairing": token }),
            E2eeAuth::Bearer(credential) => json!({ "type": "e2ee_auth", "bearer": credential }),
        };
        let bytes = serde_json::to_vec(&message).expect("static JSON");
        timeout_at(deadline, self.send(&bytes))
            .await
            .map_err(|_| E2eeClientError::Timeout("authentication"))??;
        let reply = timeout_at(
            deadline,
            self.receive_bounded(MAX_E2EE_PREAUTH_MESSAGE_BYTES),
        )
        .await
        .map_err(|_| E2eeClientError::Timeout("authentication"))??;
        let reply: Value = serde_json::from_slice(&reply)
            .map_err(|error| E2eeClientError::Protocol(error.to_string()))?;
        match reply.get("type").and_then(Value::as_str) {
            Some("e2ee_authenticated") => Ok(reply),
            Some("e2ee_error")
                if reply.get("code").and_then(Value::as_str) == Some("unauthorized") =>
            {
                Err(E2eeClientError::Unauthorized)
            }
            _ => Err(E2eeClientError::Protocol(
                "the authentication reply was not one this client knows".to_owned(),
            )),
        }
    }

    /// Encrypts and sends one logical message.
    pub(crate) async fn send(&mut self, plaintext: &[u8]) -> Result<(), E2eeClientError> {
        let records = plaintext_records(plaintext)
            .map_err(|error| E2eeClientError::Protocol(error.to_string()))?;
        for (flag, chunk) in records {
            let mut record = Vec::with_capacity(chunk.len() + 1);
            record.push(flag);
            record.extend_from_slice(chunk);
            let mut frame = vec![0_u8; record.len() + NOISE_TAG_BYTES];
            let length = self
                .transport
                .write_message(&record, &mut frame)
                .map_err(|error| E2eeClientError::Protocol(error.to_string()))?;
            frame.truncate(length);
            self.socket
                .send(Message::Binary(frame.into()))
                .await
                .map_err(|error| E2eeClientError::ConnectionLost(error.to_string()))?;
        }
        Ok(())
    }

    /// Receives one logical message of at most `limit` bytes.
    pub(crate) async fn receive_bounded(
        &mut self,
        limit: usize,
    ) -> Result<Vec<u8>, E2eeClientError> {
        let mut assembled = Vec::new();
        let mut scratch = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
        for _ in 0..MAX_E2EE_RECORDS_PER_MESSAGE {
            let frame = next_binary(&mut self.socket).await?;
            let length = self
                .transport
                .read_message(&frame, &mut scratch)
                .map_err(|_| E2eeClientError::Protocol("a record did not decrypt".to_owned()))?;
            let Some((&flag, chunk)) = scratch[..length].split_first() else {
                return Err(E2eeClientError::Protocol("an empty record".to_owned()));
            };
            if assembled.len() + chunk.len() > limit {
                return Err(E2eeClientError::Protocol(format!(
                    "a message over {limit} bytes"
                )));
            }
            assembled.extend_from_slice(chunk);
            match flag {
                E2EE_RECORD_FLAG_FINAL => return Ok(assembled),
                E2EE_RECORD_FLAG_CONTINUATION if !chunk.is_empty() => {}
                E2EE_RECORD_FLAG_CONTINUATION => {
                    return Err(E2eeClientError::Protocol(
                        "an empty continuation record".to_owned(),
                    ));
                }
                other => {
                    return Err(E2eeClientError::Protocol(format!(
                        "record flag {other:#04x}, which this client never asked for"
                    )));
                }
            }
        }
        Err(E2eeClientError::Protocol(format!(
            "a message of more than {MAX_E2EE_RECORDS_PER_MESSAGE} records"
        )))
    }

    async fn send_client_message(
        &mut self,
        message: &ClientMessage,
    ) -> Result<(), E2eeClientError> {
        let bytes = serde_json::to_vec(message).expect("client messages serialize");
        self.send(&bytes).await
    }

    async fn receive_server_message(
        &mut self,
        wait: Duration,
        waiting_for: &'static str,
    ) -> Result<ServerMessage, E2eeClientError> {
        let bytes = tokio::time::timeout(wait, self.receive_bounded(MAX_CLIENT_MESSAGE_BYTES))
            .await
            .map_err(|_| E2eeClientError::Timeout(waiting_for))??;
        serde_json::from_slice(&bytes).map_err(|error| E2eeClientError::Protocol(error.to_string()))
    }

    fn request_id(&mut self) -> RequestId {
        let id = self.next_request_id;
        self.next_request_id += 1;
        RequestId::try_from(id.to_string()).expect("decimal request ids")
    }

    fn request(&mut self, tag: &str, payload: Value) -> (RequestId, ClientMessage) {
        let id = self.request_id();
        let message = ClientMessage::Request {
            id: id.clone(),
            tag: tag.to_owned(),
            payload,
            headers: Vec::new(),
            trace_id: None,
            span_id: None,
            sampled: None,
        };
        (id, message)
    }

    /// Runs a unary request and returns its success value.
    pub(crate) async fn unary(
        &mut self,
        tag: &str,
        payload: Value,
        wait: Duration,
    ) -> Result<Option<Value>, RpcCallError<std::convert::Infallible>> {
        let (id, request) = self.request(tag, payload);
        self.send_client_message(&request).await?;
        loop {
            match self.receive_server_message(wait, "a reply").await? {
                ServerMessage::Pong => {}
                ServerMessage::Exit { request_id, exit } if request_id == id => {
                    return exit_result(exit);
                }
                other => return Err(unexpected(other)),
            }
        }
    }

    /// Runs a stream request: hands each item to `on_item`, acknowledging each chunk only
    /// after its items were accepted, so the server sends the next one only then.
    pub(crate) async fn stream<E>(
        &mut self,
        tag: &str,
        payload: Value,
        waits: StreamWaits,
        on_item: &mut dyn FnMut(&Value) -> Result<(), E>,
    ) -> Result<(), RpcCallError<E>> {
        let (id, request) = self.request(tag, payload);
        self.send_client_message(&request).await?;
        let mut wait = waits.first;
        loop {
            match self.receive_server_message(wait, "the next item").await? {
                ServerMessage::Pong => {}
                ServerMessage::Chunk { request_id, values } if request_id == id => {
                    for value in &values {
                        on_item(value).map_err(RpcCallError::Rejected)?;
                    }
                    self.send_client_message(&ClientMessage::Ack {
                        request_id: id.clone(),
                    })
                    .await?;
                    wait = waits.next;
                }
                ServerMessage::Exit { request_id, exit } if request_id == id => {
                    return exit_result(exit).map(|_| ());
                }
                other => return Err(unexpected(other)),
            }
        }
    }

    /// Closes the connection, best-effort and briefly.
    pub(crate) async fn close(mut self) {
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, self.socket.close(None)).await;
    }
}

/// How `e2ee_auth` authenticates.
#[derive(Clone, Copy, Debug)]
pub(crate) enum E2eeAuth<'a> {
    /// A one-time pairing token from an offer.
    Pairing(&'a str),
    /// A credential minted by an earlier pairing.
    Bearer(&'a str),
}

fn exit_result<E>(exit: RpcExit) -> Result<Option<Value>, RpcCallError<E>> {
    match exit {
        RpcExit::Success { value } => Ok(value),
        RpcExit::Failure { cause } => {
            for item in &cause {
                if let super::CauseItem::Fail { error } = item {
                    return Err(RpcCallError::Failed(error.clone()));
                }
            }
            Err(RpcCallError::Ended)
        }
    }
}

fn unexpected<E>(message: ServerMessage) -> RpcCallError<E> {
    match message {
        ServerMessage::Defect { defect } => RpcCallError::Defect(defect_text(&defect)),
        ServerMessage::ClientProtocolError { error } => RpcCallError::Defect(defect_text(&error)),
        _ => RpcCallError::Client(E2eeClientError::Protocol(
            "a reply for a request this client did not make".to_owned(),
        )),
    }
}

fn defect_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

/// The next binary frame; WebSocket pings and pongs are transport control (tungstenite
/// answers pings while it reads), and anything else ends the connection.
async fn next_binary(socket: &mut Socket) -> Result<Vec<u8>, E2eeClientError> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Binary(bytes))) => return Ok(bytes.to_vec()),
            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
            Some(Ok(Message::Close(frame))) => {
                if frame
                    .as_ref()
                    .is_some_and(|frame| u16::from(frame.code) == E2EE_HOST_IDENTITY_CLOSE_CODE)
                {
                    return Err(E2eeClientError::HostIdentityMismatch);
                }
                return Err(E2eeClientError::ConnectionLost(frame.map_or_else(
                    || "closed".to_owned(),
                    |frame| frame.reason.to_string(),
                )));
            }
            Some(Ok(Message::Text(_))) => {
                return Err(E2eeClientError::Protocol("a text frame".to_owned()));
            }
            Some(Err(error)) => return Err(E2eeClientError::ConnectionLost(error.to_string())),
            None => return Err(E2eeClientError::ConnectionLost("closed".to_owned())),
        }
    }
}

/// When a connection and its authentication must be done by, from now.
#[must_use]
pub(crate) fn handshake_deadline() -> Instant {
    Instant::now() + E2EE_HANDSHAKE_TIMEOUT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_e2ee_url_replaces_the_path_and_maps_the_scheme() {
        assert_eq!(
            e2ee_url("http://10.0.0.5:3773/").unwrap().as_str(),
            "ws://10.0.0.5:3773/ws-e2ee"
        );
        assert_eq!(
            e2ee_url("https://box.tail.ts.net/some/path?x=1#y")
                .unwrap()
                .as_str(),
            "wss://box.tail.ts.net/ws-e2ee"
        );
        for invalid in ["ftp://host", "not a url", "http://user@host:1", "file:///x"] {
            assert!(e2ee_url(invalid).is_err(), "{invalid}");
        }
    }
}
