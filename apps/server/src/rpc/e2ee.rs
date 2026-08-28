use std::{
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

#[cfg(test)]
use std::ops::AsyncFnMut;

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt, stream};
use serde::Deserialize;
use serde_json::json;
use thiserror::Error;
use tokio::{sync::Semaphore, time::timeout};
use tokio_util::sync::{CancellationToken, PollSender};

use super::{
    RpcRegistry, RpcSessionContext,
    session::{PUMP_JOIN_TIMEOUT, SOCKET_WRITE_TIMEOUT, run_session_split},
};
use crate::{
    auth::{AuthService, HostIdentity, NOISE_NK_PARAMS, Principal, SessionTransport},
    config::ServerConfig,
    http::spawn_session_expiration_guard,
};

pub(crate) const MAX_E2EE_CIPHERTEXT_BYTES: usize = 65_535;
const NOISE_TAG_BYTES: usize = 16;
pub(crate) const E2EE_RECORD_FLAG_FINAL: u8 = 0x00;
pub(crate) const E2EE_RECORD_FLAG_CONTINUATION: u8 = 0x01;
pub(crate) const MAX_E2EE_CHUNK_BYTES: usize = MAX_E2EE_CIPHERTEXT_BYTES - NOISE_TAG_BYTES - 1;
pub(crate) const MAX_E2EE_LOGICAL_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_E2EE_PREAUTH_MESSAGE_BYTES: usize = 64 * 1024;
/// One deadline covering upgrade -> handshake -> e2ee_authenticated.
pub(crate) const E2EE_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Wrong pinned key: the responder cannot decrypt Message 1 and closes with this code.
pub(crate) const E2EE_HOST_IDENTITY_CLOSE_CODE: u16 = 4403;
pub(crate) const E2EE_MAX_PREAUTH_CONNECTIONS: usize = 32;

struct PlaintextRecords<'a> {
    plaintext: &'a [u8],
    offset: usize,
    emitted_empty: bool,
}

impl<'a> Iterator for PlaintextRecords<'a> {
    type Item = (u8, &'a [u8]);

    fn next(&mut self) -> Option<Self::Item> {
        if self.plaintext.is_empty() {
            if self.emitted_empty {
                return None;
            }
            self.emitted_empty = true;
            return Some((E2EE_RECORD_FLAG_FINAL, &[]));
        }
        if self.offset >= self.plaintext.len() {
            return None;
        }
        let end = self
            .offset
            .saturating_add(MAX_E2EE_CHUNK_BYTES)
            .min(self.plaintext.len());
        let flag = if end == self.plaintext.len() {
            E2EE_RECORD_FLAG_FINAL
        } else {
            E2EE_RECORD_FLAG_CONTINUATION
        };
        let chunk = &self.plaintext[self.offset..end];
        self.offset = end;
        Some((flag, chunk))
    }
}

fn plaintext_records(plaintext: &[u8]) -> Result<PlaintextRecords<'_>, E2eeSessionError> {
    if plaintext.len() > MAX_E2EE_LOGICAL_MESSAGE_BYTES {
        return Err(E2eeSessionError::Protocol(
            "outbound message too large".into(),
        ));
    }
    Ok(PlaintextRecords {
        plaintext,
        offset: 0,
        emitted_empty: false,
    })
}

static E2EE_PREAUTH_PERMITS: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(E2EE_MAX_PREAUTH_CONNECTIONS)));

#[derive(Debug, Error)]
pub(crate) enum E2eeSessionError {
    #[error("Noise handshake rejected")]
    Handshake,
    #[error("E2EE protocol violation: {0}")]
    Protocol(String),
    #[error("E2EE cryptographic operation failed: {0}")]
    Crypto(String),
    #[error("E2EE transport closed")]
    Closed,
    #[error("E2EE transport operation timed out")]
    Timeout,
}

pub(crate) struct E2eeChannel {
    transport: snow::TransportState,
    assembling: Vec<u8>,
    decrypt_scratch: Vec<u8>,
}

impl E2eeChannel {
    #[cfg(test)]
    pub(crate) async fn respond<Rx, Tx>(
        host_identity: &HostIdentity,
        mut recv_binary_frame: Rx,
        mut send_binary_frame: Tx,
    ) -> Result<Self, E2eeSessionError>
    where
        Rx: AsyncFnMut() -> Option<Vec<u8>>,
        Tx: AsyncFnMut(Vec<u8>) -> Result<(), E2eeSessionError>,
    {
        let message_a = recv_binary_frame().await.ok_or(E2eeSessionError::Closed)?;
        let (channel, message_b) = Self::respond_to_message_a(host_identity, &message_a)?;
        send_binary_frame(message_b).await?;
        Ok(channel)
    }

    fn respond_to_message_a(
        host_identity: &HostIdentity,
        message_a: &[u8],
    ) -> Result<(Self, Vec<u8>), E2eeSessionError> {
        if message_a.len() > MAX_E2EE_CIPHERTEXT_BYTES {
            return Err(E2eeSessionError::Protocol(
                "oversized handshake frame".into(),
            ));
        }
        let params = NOISE_NK_PARAMS
            .parse()
            .map_err(|error| E2eeSessionError::Protocol(format!("noise params: {error:?}")))?;
        let mut responder = snow::Builder::new(params)
            .local_private_key(host_identity.private_key_bytes())
            .map_err(|error| E2eeSessionError::Protocol(format!("local key: {error:?}")))?
            .build_responder()
            .map_err(|error| E2eeSessionError::Protocol(format!("responder: {error:?}")))?;

        let mut payload = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
        let payload_len = responder
            .read_message(message_a, &mut payload)
            .map_err(|_| E2eeSessionError::Handshake)?;
        if payload_len != 0 {
            return Err(E2eeSessionError::Protocol(
                "message 1 carried a non-empty handshake payload".into(),
            ));
        }

        let mut message_b = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
        let len = responder
            .write_message(&[], &mut message_b)
            .map_err(|error| E2eeSessionError::Crypto(format!("message B: {error:?}")))?;
        message_b.truncate(len);

        let transport = responder
            .into_transport_mode()
            .map_err(|error| E2eeSessionError::Crypto(format!("transport: {error:?}")))?;
        Ok((
            Self {
                transport,
                assembling: Vec::new(),
                decrypt_scratch: vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES],
            },
            message_b,
        ))
    }

    #[cfg(test)]
    fn encrypt_message(&mut self, plaintext: &[u8]) -> Result<Vec<Vec<u8>>, E2eeSessionError> {
        plaintext_records(plaintext)?
            .map(|(flag, chunk)| self.encrypt_record(flag, chunk))
            .collect()
    }

    fn encrypt_record(&mut self, flag: u8, chunk: &[u8]) -> Result<Vec<u8>, E2eeSessionError> {
        let mut record = Vec::with_capacity(1 + chunk.len());
        record.push(flag);
        record.extend_from_slice(chunk);
        let mut frame = vec![0_u8; record.len() + NOISE_TAG_BYTES];
        let len = self
            .transport
            .write_message(&record, &mut frame)
            .map_err(|error| E2eeSessionError::Crypto(format!("encrypt: {error:?}")))?;
        frame.truncate(len);
        Ok(frame)
    }

    pub(crate) fn decrypt_frame(
        &mut self,
        frame: &[u8],
        max_message_bytes: usize,
    ) -> Result<Option<Vec<u8>>, E2eeSessionError> {
        if frame.len() > MAX_E2EE_CIPHERTEXT_BYTES {
            return Err(E2eeSessionError::Protocol("oversized frame".into()));
        }
        let len = self
            .transport
            .read_message(frame, &mut self.decrypt_scratch)
            .map_err(|error| E2eeSessionError::Crypto(format!("decrypt: {error:?}")))?;
        if len == 0 {
            return Err(E2eeSessionError::Protocol("empty record".into()));
        }
        let flag = self.decrypt_scratch[0];
        let chunk = &self.decrypt_scratch[1..len];
        if self.assembling.len().saturating_add(chunk.len()) > max_message_bytes {
            return Err(E2eeSessionError::Protocol("reassembly overflow".into()));
        }
        match flag {
            E2EE_RECORD_FLAG_CONTINUATION => {
                self.assembling.extend_from_slice(chunk);
                Ok(None)
            }
            E2EE_RECORD_FLAG_FINAL => {
                let mut message = std::mem::take(&mut self.assembling);
                message.extend_from_slice(chunk);
                Ok(Some(message))
            }
            other => Err(E2eeSessionError::Protocol(format!(
                "unknown record flag {other}"
            ))),
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct E2eeAuthMessage {
    pub r#type: String,
    #[serde(default)]
    pub pairing: Option<String>,
    #[serde(default)]
    pub bearer: Option<String>,
}

pub(crate) fn e2ee_authenticated_json() -> Vec<u8> {
    serde_json::to_vec(&json!({ "type": "e2ee_authenticated" })).expect("static JSON")
}

pub(crate) fn e2ee_authenticated_with_credential_json(
    credential: &str,
    environment_id: &str,
    storage_instance_id: Option<&str>,
) -> Vec<u8> {
    let mut reply = json!({
        "type": "e2ee_authenticated",
        "credential": credential,
        "environmentId": environment_id,
    });
    if let Some(storage_instance_id) = storage_instance_id {
        reply
            .as_object_mut()
            .expect("static authenticated reply is an object")
            .insert(
                "storageInstanceId".to_owned(),
                serde_json::Value::String(storage_instance_id.to_owned()),
            );
    }
    serde_json::to_vec(&reply).expect("static JSON")
}

pub(crate) fn e2ee_error_json(code: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({ "type": "e2ee_error", "code": code })).expect("static JSON")
}

pub(crate) enum E2eeAccept {
    Authenticated {
        principal: Principal,
        minted: Option<MintedE2eeSession>,
    },
    Unauthenticated,
}

pub(crate) struct MintedE2eeSession {
    pub credential: String,
}

enum EstablishOutcome {
    Accepted {
        channel: E2eeChannel,
        accept: E2eeAccept,
    },
    Rejected {
        channel: E2eeChannel,
        code: &'static str,
    },
}

/// Runs the complete `/ws-e2ee` lifecycle: Noise NK, encrypted credential
/// bootstrap, then the unchanged RPC protocol over encrypted records.
pub(crate) async fn run_e2ee_session(
    socket: WebSocket,
    auth: AuthService,
    registry: RpcRegistry,
    config: Arc<ServerConfig>,
    session_shutdown: CancellationToken,
) {
    let Ok(preauth_permit) = Arc::clone(&E2EE_PREAUTH_PERMITS).try_acquire_owned() else {
        let mut socket = socket;
        let _ = socket
            .send(Message::Close(Some(CloseFrame {
                code: 1013,
                reason: "busy".into(),
            })))
            .await;
        return;
    };

    let (mut ws_writer, mut ws_reader) = socket.split();
    let established = timeout(E2EE_HANDSHAKE_TIMEOUT, async {
        let message_a = next_binary_frame(&mut ws_reader)
            .await
            .ok_or(E2eeSessionError::Closed)?;
        let (mut channel, message_b) =
            E2eeChannel::respond_to_message_a(auth.host_identity(), &message_a)?;
        timeout(
            SOCKET_WRITE_TIMEOUT,
            ws_writer.send(Message::Binary(message_b.into())),
        )
        .await
        .map_err(|_| E2eeSessionError::Timeout)?
        .map_err(|_| E2eeSessionError::Closed)?;

        let auth_bytes = loop {
            let frame = next_binary_frame(&mut ws_reader)
                .await
                .ok_or(E2eeSessionError::Closed)?;
            if let Some(message) = channel.decrypt_frame(&frame, MAX_E2EE_PREAUTH_MESSAGE_BYTES)? {
                break message;
            }
        };
        let Ok(message) = serde_json::from_slice::<E2eeAuthMessage>(&auth_bytes) else {
            return Ok(EstablishOutcome::Rejected {
                channel,
                code: "protocol",
            });
        };
        if message.r#type != "e2ee_auth" {
            return Ok(EstablishOutcome::Rejected {
                channel,
                code: "protocol",
            });
        }

        let accept = if config.unsafe_no_auth {
            E2eeAccept::Unauthenticated
        } else {
            match (message.pairing, message.bearer) {
                (Some(pairing), None) => {
                    let Ok(issued) = auth
                        .exchange_bootstrap(
                            &pairing,
                            None,
                            e2ee_client_metadata(),
                            None,
                            SessionTransport::E2ee,
                        )
                        .await
                    else {
                        return Ok(EstablishOutcome::Rejected {
                            channel,
                            code: "unauthorized",
                        });
                    };
                    E2eeAccept::Authenticated {
                        principal: issued.principal,
                        minted: Some(MintedE2eeSession {
                            credential: issued.token,
                        }),
                    }
                }
                (None, Some(bearer)) => {
                    let Ok(principal) = auth
                        .authenticate_token(&bearer, SessionTransport::E2ee)
                        .await
                    else {
                        return Ok(EstablishOutcome::Rejected {
                            channel,
                            code: "unauthorized",
                        });
                    };
                    E2eeAccept::Authenticated {
                        principal,
                        minted: None,
                    }
                }
                _ => {
                    return Ok(EstablishOutcome::Rejected {
                        channel,
                        code: "protocol",
                    });
                }
            }
        };

        let storage_instance_id = config.storage_instance_id.as_ref().map(ToString::to_string);
        let reply = match &accept {
            E2eeAccept::Authenticated {
                minted: Some(minted),
                ..
            } => e2ee_authenticated_with_credential_json(
                &minted.credential,
                &config.environment_id,
                storage_instance_id.as_deref(),
            ),
            E2eeAccept::Authenticated { minted: None, .. } | E2eeAccept::Unauthenticated => {
                e2ee_authenticated_json()
            }
        };
        send_encrypted_frames(&mut ws_writer, &mut channel, &reply).await?;
        Ok::<_, E2eeSessionError>(EstablishOutcome::Accepted { channel, accept })
    })
    .await;
    drop(preauth_permit);

    let (channel, accept) = match established {
        Ok(Ok(EstablishOutcome::Accepted { channel, accept })) => (channel, accept),
        Ok(Ok(EstablishOutcome::Rejected { mut channel, code })) => {
            let _ =
                send_encrypted_frames(&mut ws_writer, &mut channel, &e2ee_error_json(code)).await;
            let _ = ws_writer.close().await;
            return;
        }
        Ok(Err(E2eeSessionError::Handshake)) => {
            let _ = ws_writer
                .send(Message::Close(Some(CloseFrame {
                    code: E2EE_HOST_IDENTITY_CLOSE_CODE,
                    reason: "host-identity".into(),
                })))
                .await;
            return;
        }
        Ok(Err(_)) | Err(_) => {
            let _ = ws_writer.close().await;
            return;
        }
    };

    run_established_e2ee(
        ws_writer,
        ws_reader,
        channel,
        accept,
        auth,
        registry,
        session_shutdown,
    )
    .await;
}

async fn next_binary_frame(
    reader: &mut futures_util::stream::SplitStream<WebSocket>,
) -> Option<Vec<u8>> {
    loop {
        match reader.next().await? {
            Ok(Message::Binary(frame)) => return Some(frame.to_vec()),
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            Ok(Message::Text(_) | Message::Close(_)) | Err(_) => return None,
        }
    }
}

async fn send_encrypted_frames(
    writer: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    channel: &mut E2eeChannel,
    plaintext: &[u8],
) -> Result<(), E2eeSessionError> {
    for (flag, chunk) in plaintext_records(plaintext)? {
        let frame = channel.encrypt_record(flag, chunk)?;
        timeout(
            SOCKET_WRITE_TIMEOUT,
            writer.send(Message::Binary(frame.into())),
        )
        .await
        .map_err(|_| E2eeSessionError::Timeout)?
        .map_err(|_| E2eeSessionError::Closed)?;
    }
    Ok(())
}

async fn run_established_e2ee(
    mut ws_writer: futures_util::stream::SplitSink<WebSocket, Message>,
    mut ws_reader: futures_util::stream::SplitStream<WebSocket>,
    channel: E2eeChannel,
    accept: E2eeAccept,
    auth: AuthService,
    registry: RpcRegistry,
    session_shutdown: CancellationToken,
) {
    let channel = Arc::new(Mutex::new(channel));
    let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::channel::<Message>(64);
    let (inbound_tx, inbound_rx) = tokio::sync::mpsc::channel::<Result<Message, axum::Error>>(64);

    let outbound_shutdown = session_shutdown.clone();
    let outbound_channel = Arc::clone(&channel);
    let outbound_pump = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            let plaintext = match &message {
                Message::Text(text) => text.as_bytes(),
                Message::Binary(bytes) => bytes.as_ref(),
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) => continue,
            };
            let Ok(records) = plaintext_records(plaintext) else {
                break;
            };
            let mut failed = false;
            for (flag, chunk) in records {
                let frame = {
                    let mut channel = outbound_channel.lock().expect("E2EE channel lock");
                    match channel.encrypt_record(flag, chunk) {
                        Ok(frame) => frame,
                        Err(_) => {
                            failed = true;
                            break;
                        }
                    }
                };
                if !matches!(
                    timeout(
                        SOCKET_WRITE_TIMEOUT,
                        ws_writer.send(Message::Binary(frame.into())),
                    )
                    .await,
                    Ok(Ok(()))
                ) {
                    failed = true;
                    break;
                }
            }
            if failed {
                break;
            }
        }
        let _ = timeout(SOCKET_WRITE_TIMEOUT, ws_writer.close()).await;
        outbound_shutdown.cancel();
    });

    let inbound_shutdown = session_shutdown.clone();
    let inbound_channel = Arc::clone(&channel);
    let inbound_pump = tokio::spawn(async move {
        while let Some(frame) = ws_reader.next().await {
            let message = match frame {
                Ok(Message::Binary(bytes)) => match inbound_channel
                    .lock()
                    .expect("E2EE channel lock")
                    .decrypt_frame(&bytes, MAX_E2EE_LOGICAL_MESSAGE_BYTES)
                {
                    Ok(Some(plaintext)) => Message::Binary(plaintext.into()),
                    Ok(None) => continue,
                    Err(_) => break,
                },
                Ok(Message::Ping(_) | Message::Pong(_)) => continue,
                Ok(Message::Close(_)) | Err(_) | Ok(Message::Text(_)) => break,
            };
            if inbound_tx.send(Ok(message)).await.is_err() {
                break;
            }
        }
        inbound_shutdown.cancel();
    });

    let (context, expiration_guard, connected_session) = match accept {
        E2eeAccept::Authenticated { principal, .. } => {
            let session_id = principal.session_id.clone();
            let connection_id = auth
                .mark_connected(&session_id, session_shutdown.clone())
                .await;
            let expires_at_ms = principal.expires_at_ms;
            (
                RpcSessionContext::authenticated(principal, auth.clone()),
                Some(spawn_session_expiration_guard(
                    expires_at_ms,
                    session_shutdown.clone(),
                )),
                Some((session_id, connection_id)),
            )
        }
        E2eeAccept::Unauthenticated => (RpcSessionContext::unauthenticated(), None, None),
    };

    let writer_sink = PollSender::new(outbound_tx);
    let reader_stream = stream::unfold(inbound_rx, |mut receiver| async {
        receiver.recv().await.map(|item| (item, receiver))
    });
    run_session_split(
        writer_sink,
        reader_stream,
        registry,
        context,
        session_shutdown.clone(),
    )
    .await;

    session_shutdown.cancel();
    if let Some(expiration_guard) = expiration_guard {
        let _ = expiration_guard.await;
    }
    reap_pump(outbound_pump).await;
    reap_pump(inbound_pump).await;
    if let Some((session_id, connection_id)) = connected_session {
        auth.mark_disconnected(&session_id, connection_id).await;
    }
}

async fn reap_pump(mut pump: tokio::task::JoinHandle<()>) {
    if timeout(PUMP_JOIN_TIMEOUT, &mut pump).await.is_err() {
        pump.abort();
        let _ = pump.await;
    }
}

fn e2ee_client_metadata() -> crate::auth::ClientMetadata {
    crate::auth::ClientMetadata {
        label: None,
        ip_address: None,
        user_agent: None,
        device_type: "unknown".to_owned(),
        os: None,
        browser: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::HostIdentity;

    struct SnowInitiator {
        transport: snow::TransportState,
    }

    async fn establish() -> (SnowInitiator, E2eeChannel) {
        let identity = HostIdentity::generate_ephemeral();
        let mut initiator = snow::Builder::new(crate::auth::NOISE_NK_PARAMS.parse().unwrap())
            .remote_public_key(identity.public_key_bytes())
            .unwrap()
            .build_initiator()
            .unwrap();
        let mut message_a = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
        let len_a = initiator.write_message(&[], &mut message_a).unwrap();
        message_a.truncate(len_a);

        let (to_responder, mut responder_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(4);
        let (to_initiator, mut initiator_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(4);
        to_responder.send(message_a).await.unwrap();
        let responder = E2eeChannel::respond(
            &identity,
            async || responder_rx.recv().await,
            |frame| {
                let sender = to_initiator.clone();
                async move {
                    sender
                        .send(frame)
                        .await
                        .map_err(|_| E2eeSessionError::Closed)
                }
            },
        )
        .await
        .unwrap();
        let message_b = initiator_rx.recv().await.unwrap();
        let mut payload = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
        let len = initiator.read_message(&message_b, &mut payload).unwrap();
        assert_eq!(len, 0, "message B carries an empty handshake payload");
        let transport = initiator.into_transport_mode().unwrap();
        (SnowInitiator { transport }, responder)
    }

    fn initiator_encrypt(initiator: &mut SnowInitiator, records: &[Vec<u8>]) -> Vec<Vec<u8>> {
        records
            .iter()
            .map(|record| {
                let mut frame = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
                let len = initiator
                    .transport
                    .write_message(record, &mut frame)
                    .unwrap();
                frame.truncate(len);
                frame
            })
            .collect()
    }

    fn record(flag: u8, chunk: &[u8]) -> Vec<u8> {
        let mut record = Vec::with_capacity(1 + chunk.len());
        record.push(flag);
        record.extend_from_slice(chunk);
        record
    }

    #[test]
    fn plaintext_record_iteration_is_lazy_and_preserves_flags() {
        let big = vec![b'a'; MAX_E2EE_CHUNK_BYTES * 2 + 5];
        let mut records = plaintext_records(&big).expect("valid message");
        let first = records.next().expect("first record");
        assert_eq!(first.0, E2EE_RECORD_FLAG_CONTINUATION);
        assert_eq!(first.1.len(), MAX_E2EE_CHUNK_BYTES);
        assert_eq!(records.count(), 2);
    }

    #[test]
    fn pairing_reply_omits_an_absent_storage_identity() {
        let absent = serde_json::from_slice::<serde_json::Value>(
            &e2ee_authenticated_with_credential_json("credential", "environment", None),
        )
        .expect("absent storage reply");
        assert!(absent.get("storageInstanceId").is_none());

        let present = serde_json::from_slice::<serde_json::Value>(
            &e2ee_authenticated_with_credential_json("credential", "environment", Some("storage")),
        )
        .expect("present storage reply");
        assert_eq!(present["storageInstanceId"], "storage");
    }

    #[tokio::test]
    async fn small_round_trip_uses_a_single_final_record() {
        let (mut initiator, mut responder) = establish().await;
        let frames = initiator_encrypt(
            &mut initiator,
            &[record(E2EE_RECORD_FLAG_FINAL, b"{\"hello\":true}")],
        );
        assert_eq!(frames.len(), 1);
        let message = responder
            .decrypt_frame(&frames[0], MAX_E2EE_LOGICAL_MESSAGE_BYTES)
            .unwrap()
            .unwrap();
        assert_eq!(message, b"{\"hello\":true}");
        let frames = responder.encrypt_message(b"{\"ok\":1}").unwrap();
        assert_eq!(frames.len(), 1);
        let mut plaintext = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
        let len = initiator
            .transport
            .read_message(&frames[0], &mut plaintext)
            .unwrap();
        assert_eq!(
            &plaintext[..len],
            record(E2EE_RECORD_FLAG_FINAL, b"{\"ok\":1}").as_slice()
        );
    }

    #[tokio::test]
    async fn decrypt_scratch_is_reused_between_records() {
        let (mut initiator, mut responder) = establish().await;
        let scratch = responder.decrypt_scratch.as_ptr();
        let frames = initiator_encrypt(
            &mut initiator,
            &[
                record(E2EE_RECORD_FLAG_FINAL, b"first"),
                record(E2EE_RECORD_FLAG_FINAL, b"second"),
            ],
        );

        for frame in frames {
            responder
                .decrypt_frame(&frame, MAX_E2EE_LOGICAL_MESSAGE_BYTES)
                .expect("decrypt record")
                .expect("complete message");
            assert_eq!(responder.decrypt_scratch.as_ptr(), scratch);
        }
    }

    #[tokio::test]
    async fn large_messages_fragment_and_reassemble() {
        let (mut initiator, mut responder) = establish().await;
        let big = vec![b'a'; MAX_E2EE_CHUNK_BYTES * 2 + 5];
        let frames = responder.encrypt_message(&big).unwrap();
        assert_eq!(frames.len(), 3);
        for frame in &frames {
            assert!(frame.len() <= MAX_E2EE_CIPHERTEXT_BYTES);
        }
        let mut assembled = Vec::new();
        for (index, frame) in frames.iter().enumerate() {
            let mut plaintext = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
            let len = initiator
                .transport
                .read_message(frame, &mut plaintext)
                .unwrap();
            let expected_flag = if index == frames.len() - 1 {
                E2EE_RECORD_FLAG_FINAL
            } else {
                E2EE_RECORD_FLAG_CONTINUATION
            };
            assert_eq!(plaintext[0], expected_flag);
            assembled.extend_from_slice(&plaintext[1..len]);
        }
        assert_eq!(assembled, big);
    }

    #[tokio::test]
    async fn oversized_ciphertext_frames_are_rejected_before_decryption() {
        let (_initiator, mut responder) = establish().await;
        let oversized = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES + 1];
        assert!(matches!(
            responder.decrypt_frame(&oversized, MAX_E2EE_LOGICAL_MESSAGE_BYTES),
            Err(E2eeSessionError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn reassembly_respects_the_caller_supplied_cap() {
        let (mut initiator, mut responder) = establish().await;
        let continuation = record(
            E2EE_RECORD_FLAG_CONTINUATION,
            &vec![0_u8; MAX_E2EE_CHUNK_BYTES],
        );
        let overflow = record(E2EE_RECORD_FLAG_FINAL, &[0_u8; 19]);
        let frames = initiator_encrypt(&mut initiator, &[continuation, overflow]);
        assert!(
            responder
                .decrypt_frame(&frames[0], MAX_E2EE_PREAUTH_MESSAGE_BYTES)
                .unwrap()
                .is_none()
        );
        assert!(matches!(
            responder.decrypt_frame(&frames[1], MAX_E2EE_PREAUTH_MESSAGE_BYTES),
            Err(E2eeSessionError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn logical_message_overflow_is_rejected() {
        let (mut initiator, mut responder) = establish().await;
        let continuation = record(
            E2EE_RECORD_FLAG_CONTINUATION,
            &vec![0_u8; MAX_E2EE_CHUNK_BYTES],
        );
        let needed = MAX_E2EE_LOGICAL_MESSAGE_BYTES / MAX_E2EE_CHUNK_BYTES + 1;
        let mut overflowed = false;
        for _ in 0..=needed {
            let frames = initiator_encrypt(&mut initiator, std::slice::from_ref(&continuation));
            match responder.decrypt_frame(&frames[0], MAX_E2EE_LOGICAL_MESSAGE_BYTES) {
                Ok(None) => {}
                Err(E2eeSessionError::Protocol(_)) => {
                    overflowed = true;
                    break;
                }
                other => panic!("unexpected: {other:?}"),
            }
        }
        assert!(overflowed);
    }

    #[tokio::test]
    async fn tampered_frames_fail_closed() {
        let (mut initiator, mut responder) = establish().await;
        let mut frames = initiator_encrypt(&mut initiator, &[record(E2EE_RECORD_FLAG_FINAL, b"x")]);
        let last = frames[0].len() - 1;
        frames[0][last] ^= 0x01;
        assert!(matches!(
            responder.decrypt_frame(&frames[0], MAX_E2EE_LOGICAL_MESSAGE_BYTES),
            Err(E2eeSessionError::Crypto(_))
        ));
    }

    #[tokio::test]
    async fn non_empty_message_one_payload_is_a_protocol_violation() {
        let identity = HostIdentity::generate_ephemeral();
        let mut initiator = snow::Builder::new(crate::auth::NOISE_NK_PARAMS.parse().unwrap())
            .remote_public_key(identity.public_key_bytes())
            .unwrap()
            .build_initiator()
            .unwrap();
        let mut message_a = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
        let len_a = initiator.write_message(b"sneaky", &mut message_a).unwrap();
        message_a.truncate(len_a);
        let (to_responder, mut responder_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
        to_responder.send(message_a).await.unwrap();
        let result = E2eeChannel::respond(
            &identity,
            async || responder_rx.recv().await,
            |_frame| async { Ok(()) },
        )
        .await;
        assert!(matches!(result, Err(E2eeSessionError::Protocol(_))));
    }

    #[tokio::test]
    async fn wrong_pinned_key_fails_the_handshake() {
        let identity = HostIdentity::generate_ephemeral();
        let wrong = HostIdentity::generate_ephemeral();
        let mut initiator = snow::Builder::new(crate::auth::NOISE_NK_PARAMS.parse().unwrap())
            .remote_public_key(wrong.public_key_bytes())
            .unwrap()
            .build_initiator()
            .unwrap();
        let mut message_a = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
        let len_a = initiator.write_message(&[], &mut message_a).unwrap();
        message_a.truncate(len_a);
        let (to_responder, mut responder_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
        to_responder.send(message_a).await.unwrap();
        let result = E2eeChannel::respond(
            &identity,
            async || responder_rx.recv().await,
            |_frame| async { Ok(()) },
        )
        .await;
        assert!(matches!(result, Err(E2eeSessionError::Handshake)));
    }
}
