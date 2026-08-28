use std::{
    collections::HashMap,
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
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::timeout,
};
use tokio_util::sync::{CancellationToken, PollSender};

use super::{
    RpcRegistry, RpcSessionContext,
    session::{
        PUMP_JOIN_TIMEOUT, RpcInboundFrame, RpcOutboundBudget, RpcOutboundFrame,
        SOCKET_WRITE_TIMEOUT, run_session_split_budgeted,
    },
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
pub(crate) const E2EE_MAX_ESTABLISHED_CONNECTIONS: usize = 64;
pub(crate) const E2EE_MAX_ESTABLISHED_CONNECTIONS_PER_PRINCIPAL: usize = 32;
pub(crate) const E2EE_INBOUND_BUFFER_BUDGET_BYTES: usize = 128 * 1024 * 1024;
pub(crate) const E2EE_INBOUND_BUFFER_BUDGET_BYTES_PER_PRINCIPAL: usize = 64 * 1024 * 1024;
pub(crate) const E2EE_OUTBOUND_BUFFER_BUDGET_BYTES: usize = 128 * 1024 * 1024;
pub(crate) const E2EE_OUTBOUND_BUFFER_BUDGET_BYTES_PER_CONNECTION: usize = 64 * 1024 * 1024;

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
static E2EE_RESOURCE_BUDGET: LazyLock<E2eeResourceBudget> = LazyLock::new(|| {
    E2eeResourceBudget::new(
        E2EE_MAX_ESTABLISHED_CONNECTIONS,
        E2EE_MAX_ESTABLISHED_CONNECTIONS_PER_PRINCIPAL,
        E2EE_INBOUND_BUFFER_BUDGET_BYTES,
        E2EE_INBOUND_BUFFER_BUDGET_BYTES_PER_PRINCIPAL,
        E2EE_OUTBOUND_BUFFER_BUDGET_BYTES,
    )
});

struct E2eeResourceBudget {
    global_established: Arc<Semaphore>,
    per_principal_established: usize,
    global_inbound: Arc<Semaphore>,
    per_principal_inbound: usize,
    global_outbound: Arc<Semaphore>,
    principals: Mutex<HashMap<String, std::sync::Weak<PrincipalResourceBudget>>>,
}

struct PrincipalResourceBudget {
    established: Arc<Semaphore>,
    inbound: Arc<Semaphore>,
}

impl E2eeResourceBudget {
    fn new(
        global_established: usize,
        per_principal_established: usize,
        global_inbound: usize,
        per_principal_inbound: usize,
        global_outbound: usize,
    ) -> Self {
        Self {
            global_established: Arc::new(Semaphore::new(global_established)),
            per_principal_established,
            global_inbound: Arc::new(Semaphore::new(global_inbound)),
            per_principal_inbound,
            global_outbound: Arc::new(Semaphore::new(global_outbound)),
            principals: Mutex::new(HashMap::new()),
        }
    }

    fn try_reserve(&self) -> Result<E2eeEstablishedReservation<'_>, &'static str> {
        let global = Arc::clone(&self.global_established)
            .try_acquire_owned()
            .map_err(|_| "protocol")?;
        Ok(E2eeEstablishedReservation {
            budget: self,
            global,
        })
    }

    fn principal_budget(&self, principal_id: &str) -> Arc<PrincipalResourceBudget> {
        let mut principals = self
            .principals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        principals.retain(|_, budget| budget.strong_count() > 0);
        if let Some(budget) = principals
            .get(principal_id)
            .and_then(std::sync::Weak::upgrade)
        {
            return budget;
        }
        let budget = Arc::new(PrincipalResourceBudget {
            established: Arc::new(Semaphore::new(self.per_principal_established)),
            inbound: Arc::new(Semaphore::new(self.per_principal_inbound)),
        });
        principals.insert(principal_id.to_owned(), Arc::downgrade(&budget));
        budget
    }

    fn global_inbound(&self) -> Arc<Semaphore> {
        Arc::clone(&self.global_inbound)
    }

    fn global_outbound(&self) -> Arc<Semaphore> {
        Arc::clone(&self.global_outbound)
    }
}

struct E2eeEstablishedReservation<'a> {
    budget: &'a E2eeResourceBudget,
    global: OwnedSemaphorePermit,
}

impl E2eeEstablishedReservation<'_> {
    fn bind_principal(self, principal_id: &str) -> Result<E2eeEstablishedPermit, &'static str> {
        let principal_budget = self.budget.principal_budget(principal_id);
        let principal = Arc::clone(&principal_budget.established)
            .try_acquire_owned()
            .map_err(|_| "protocol")?;
        Ok(E2eeEstablishedPermit {
            _global: self.global,
            _principal: Some(principal),
            principal_budget: Some(principal_budget),
        })
    }

    fn unpartitioned(self) -> E2eeEstablishedPermit {
        E2eeEstablishedPermit {
            _global: self.global,
            _principal: None,
            principal_budget: None,
        }
    }
}

struct E2eeEstablishedPermit {
    _global: OwnedSemaphorePermit,
    _principal: Option<OwnedSemaphorePermit>,
    principal_budget: Option<Arc<PrincipalResourceBudget>>,
}

impl E2eeEstablishedPermit {
    fn principal_inbound(&self) -> Option<Arc<Semaphore>> {
        self.principal_budget
            .as_ref()
            .map(|budget| Arc::clone(&budget.inbound))
    }
}

struct BudgetedPlaintext {
    plaintext: Vec<u8>,
    permits: Option<E2eeRecordPermit>,
}

struct E2eeInboundBudget {
    _permits: Option<E2eeRecordPermit>,
}

struct InboundRecordBudgets<'a> {
    global: &'a Arc<Semaphore>,
    principal: Option<&'a Arc<Semaphore>>,
    connection: &'a Arc<Semaphore>,
}

struct E2eeRecordPermit {
    global: OwnedSemaphorePermit,
    principal: Option<OwnedSemaphorePermit>,
    connection: OwnedSemaphorePermit,
}

impl E2eeRecordPermit {
    fn merge(&mut self, other: Self) {
        self.global.merge(other.global);
        match (&mut self.principal, other.principal) {
            (Some(principal), Some(other)) => principal.merge(other),
            (None, Some(other)) => self.principal = Some(other),
            (_, None) => {}
        }
        self.connection.merge(other.connection);
    }
}

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
    assembling_permits: Option<E2eeRecordPermit>,
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
                assembling_permits: None,
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
        self.decrypt_frame_inner(frame, max_message_bytes, None)
            .map(|message| message.map(|message| message.plaintext))
    }

    fn decrypt_frame_budgeted(
        &mut self,
        frame: &[u8],
        max_message_bytes: usize,
        global_budget: &Arc<Semaphore>,
        principal_budget: Option<&Arc<Semaphore>>,
        connection_budget: &Arc<Semaphore>,
    ) -> Result<Option<BudgetedPlaintext>, E2eeSessionError> {
        self.decrypt_frame_inner(
            frame,
            max_message_bytes,
            Some(InboundRecordBudgets {
                global: global_budget,
                principal: principal_budget,
                connection: connection_budget,
            }),
        )
    }

    fn decrypt_frame_inner(
        &mut self,
        frame: &[u8],
        max_message_bytes: usize,
        budgets: Option<InboundRecordBudgets<'_>>,
    ) -> Result<Option<BudgetedPlaintext>, E2eeSessionError> {
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
        let permit = budgets
            .map(|budgets| {
                acquire_inbound_bytes(
                    chunk.len(),
                    budgets.global,
                    budgets.principal,
                    budgets.connection,
                )
            })
            .transpose()?
            .flatten();
        match flag {
            E2EE_RECORD_FLAG_CONTINUATION => {
                self.assembling.extend_from_slice(chunk);
                if let Some(permit) = permit {
                    if let Some(assembling) = &mut self.assembling_permits {
                        assembling.merge(permit);
                    } else {
                        self.assembling_permits = Some(permit);
                    }
                }
                Ok(None)
            }
            E2EE_RECORD_FLAG_FINAL => {
                let mut message = std::mem::take(&mut self.assembling);
                message.extend_from_slice(chunk);
                let mut permits = self.assembling_permits.take();
                if let Some(permit) = permit {
                    if let Some(assembling) = &mut permits {
                        assembling.merge(permit);
                    } else {
                        permits = Some(permit);
                    }
                }
                Ok(Some(BudgetedPlaintext {
                    plaintext: message,
                    permits,
                }))
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

struct EstablishedE2eeAdmission {
    accept: E2eeAccept,
    _permit: E2eeEstablishedPermit,
}

enum EstablishOutcome {
    Accepted {
        channel: E2eeChannel,
        admission: EstablishedE2eeAdmission,
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

        let established_reservation = match E2EE_RESOURCE_BUDGET.try_reserve() {
            Ok(reservation) => reservation,
            Err(code) => return Ok(EstablishOutcome::Rejected { channel, code }),
        };

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
        let established_permit = match &accept {
            E2eeAccept::Authenticated { principal, .. } => {
                match established_reservation.bind_principal(&principal.session_id) {
                    Ok(permit) => permit,
                    Err(code) => return Ok(EstablishOutcome::Rejected { channel, code }),
                }
            }
            E2eeAccept::Unauthenticated => established_reservation.unpartitioned(),
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
        Ok::<_, E2eeSessionError>(EstablishOutcome::Accepted {
            channel,
            admission: EstablishedE2eeAdmission {
                accept,
                _permit: established_permit,
            },
        })
    })
    .await;
    drop(preauth_permit);

    let (channel, admission) = match established {
        Ok(Ok(EstablishOutcome::Accepted { channel, admission })) => (channel, admission),
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
        admission,
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
    admission: EstablishedE2eeAdmission,
    auth: AuthService,
    registry: RpcRegistry,
    session_shutdown: CancellationToken,
) {
    let EstablishedE2eeAdmission {
        accept,
        _permit: established_permit,
    } = admission;
    let principal_inbound_permits = established_permit.principal_inbound();
    let global_inbound_permits = E2EE_RESOURCE_BUDGET.global_inbound();
    let channel = Arc::new(Mutex::new(channel));
    let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::channel::<RpcOutboundFrame>(64);
    let (inbound_tx, inbound_rx) =
        tokio::sync::mpsc::channel::<Result<RpcInboundFrame, axum::Error>>(64);

    let outbound_shutdown = session_shutdown.clone();
    let outbound_channel = Arc::clone(&channel);
    let outbound_pump = tokio::spawn(async move {
        while let Some(outbound) = outbound_rx.recv().await {
            let (message, _outbound_budget) = outbound.into_parts();
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
    let inbound_connection_permits = Arc::new(Semaphore::new(MAX_E2EE_LOGICAL_MESSAGE_BYTES));
    let inbound_pump = tokio::spawn(async move {
        while let Some(frame) = ws_reader.next().await {
            let message = match frame {
                Ok(Message::Binary(bytes)) => {
                    let decrypted = decrypt_inbound_frame_budgeted(
                        &mut inbound_channel.lock().expect("E2EE channel lock"),
                        &bytes,
                        MAX_E2EE_LOGICAL_MESSAGE_BYTES,
                        &global_inbound_permits,
                        principal_inbound_permits.as_ref(),
                        &inbound_connection_permits,
                    );
                    match decrypted {
                        Ok(Some(BudgetedPlaintext { plaintext, permits })) => {
                            RpcInboundFrame::guarded(
                                Message::Binary(plaintext.into()),
                                E2eeInboundBudget { _permits: permits },
                            )
                        }
                        Ok(None) => continue,
                        Err(_) => break,
                    }
                }
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
    run_session_split_budgeted(
        writer_sink,
        reader_stream,
        registry,
        context,
        session_shutdown.clone(),
        Some(RpcOutboundBudget::new(
            E2EE_RESOURCE_BUDGET.global_outbound(),
            Arc::new(Semaphore::new(
                E2EE_OUTBOUND_BUFFER_BUDGET_BYTES_PER_CONNECTION,
            )),
        )),
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

fn decrypt_inbound_frame_budgeted(
    channel: &mut E2eeChannel,
    frame: &[u8],
    max_message_bytes: usize,
    global_budget: &Arc<Semaphore>,
    principal_budget: Option<&Arc<Semaphore>>,
    connection_budget: &Arc<Semaphore>,
) -> Result<Option<BudgetedPlaintext>, E2eeSessionError> {
    channel.decrypt_frame_budgeted(
        frame,
        max_message_bytes,
        global_budget,
        principal_budget,
        connection_budget,
    )
}

fn acquire_inbound_bytes(
    bytes: usize,
    global_budget: &Arc<Semaphore>,
    principal_budget: Option<&Arc<Semaphore>>,
    connection_budget: &Arc<Semaphore>,
) -> Result<Option<E2eeRecordPermit>, E2eeSessionError> {
    if bytes == 0 {
        return Ok(None);
    }
    let permits = u32::try_from(bytes)
        .map_err(|_| E2eeSessionError::Protocol("record budget overflow".into()))?;
    let connection = Arc::clone(connection_budget)
        .try_acquire_many_owned(permits)
        .map_err(|_| E2eeSessionError::Protocol("connection buffer budget exhausted".into()))?;
    let principal = principal_budget
        .map(|budget| {
            Arc::clone(budget)
                .try_acquire_many_owned(permits)
                .map_err(|_| E2eeSessionError::Protocol("principal buffer budget exhausted".into()))
        })
        .transpose()?;
    let global = Arc::clone(global_budget)
        .try_acquire_many_owned(permits)
        .map_err(|_| E2eeSessionError::Protocol("global buffer budget exhausted".into()))?;
    Ok(Some(E2eeRecordPermit {
        global,
        principal,
        connection,
    }))
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
    async fn partial_continuation_records_remain_wire_compatible() {
        let (mut initiator, mut responder) = establish().await;
        let frames = initiator_encrypt(
            &mut initiator,
            &[
                record(E2EE_RECORD_FLAG_CONTINUATION, b"tiny"),
                record(E2EE_RECORD_FLAG_FINAL, b" continuation"),
            ],
        );

        assert!(
            responder
                .decrypt_frame(&frames[0], MAX_E2EE_LOGICAL_MESSAGE_BYTES)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            responder
                .decrypt_frame(&frames[1], MAX_E2EE_LOGICAL_MESSAGE_BYTES)
                .unwrap()
                .unwrap(),
            b"tiny continuation"
        );
    }

    #[tokio::test]
    async fn completed_messages_retain_their_global_buffer_budget() {
        let (mut initiator, mut responder) = establish().await;
        let continuation = vec![b'f'; MAX_E2EE_CHUNK_BYTES];
        let message_bytes = continuation.len() + b"second".len();
        let global_budget = Arc::new(Semaphore::new(message_bytes));
        let connection_budget = Arc::new(Semaphore::new(message_bytes));
        let frames = initiator_encrypt(
            &mut initiator,
            &[
                record(E2EE_RECORD_FLAG_CONTINUATION, &continuation),
                record(E2EE_RECORD_FLAG_FINAL, b"second"),
            ],
        );

        assert!(
            decrypt_inbound_frame_budgeted(
                &mut responder,
                &frames[0],
                MAX_E2EE_LOGICAL_MESSAGE_BYTES,
                &global_budget,
                None,
                &connection_budget,
            )
            .unwrap()
            .is_none()
        );
        let completed = decrypt_inbound_frame_budgeted(
            &mut responder,
            &frames[1],
            MAX_E2EE_LOGICAL_MESSAGE_BYTES,
            &global_budget,
            None,
            &connection_budget,
        )
        .unwrap()
        .expect("completed message");

        assert_eq!(completed.plaintext.len(), MAX_E2EE_CHUNK_BYTES + 6);
        assert!(completed.plaintext.starts_with(&continuation));
        assert!(completed.plaintext.ends_with(b"second"));
        assert!(Arc::clone(&global_budget).try_acquire_owned().is_err());
        assert!(Arc::clone(&connection_budget).try_acquire_owned().is_err());
        drop(completed);
        assert!(Arc::clone(&global_budget).try_acquire_owned().is_ok());
        assert!(Arc::clone(&connection_budget).try_acquire_owned().is_ok());
    }

    #[tokio::test]
    async fn exhausted_global_budget_fails_another_channel_closed() {
        let (mut first_initiator, mut first_responder) = establish().await;
        let (mut second_initiator, mut second_responder) = establish().await;
        let global_budget = Arc::new(Semaphore::new(MAX_E2EE_CHUNK_BYTES));
        let first_connection_budget = Arc::new(Semaphore::new(MAX_E2EE_CHUNK_BYTES));
        let second_connection_budget = Arc::new(Semaphore::new(MAX_E2EE_CHUNK_BYTES));
        let first_frame = initiator_encrypt(
            &mut first_initiator,
            &[record(
                E2EE_RECORD_FLAG_CONTINUATION,
                &vec![0_u8; MAX_E2EE_CHUNK_BYTES],
            )],
        )
        .pop()
        .unwrap();
        let second_frame = initiator_encrypt(
            &mut second_initiator,
            &[record(E2EE_RECORD_FLAG_FINAL, b"other connection")],
        )
        .pop()
        .unwrap();

        assert!(
            decrypt_inbound_frame_budgeted(
                &mut first_responder,
                &first_frame,
                MAX_E2EE_LOGICAL_MESSAGE_BYTES,
                &global_budget,
                None,
                &first_connection_budget,
            )
            .unwrap()
            .is_none()
        );
        assert!(matches!(
            decrypt_inbound_frame_budgeted(
                &mut second_responder,
                &second_frame,
                MAX_E2EE_LOGICAL_MESSAGE_BYTES,
                &global_budget,
                None,
                &second_connection_budget,
            ),
            Err(E2eeSessionError::Protocol(_))
        ));

        drop(first_responder);
        let retry_frame = initiator_encrypt(
            &mut second_initiator,
            &[record(E2EE_RECORD_FLAG_FINAL, b"retry")],
        )
        .pop()
        .unwrap();
        assert!(
            decrypt_inbound_frame_budgeted(
                &mut second_responder,
                &retry_frame,
                MAX_E2EE_LOGICAL_MESSAGE_BYTES,
                &global_budget,
                None,
                &second_connection_budget,
            )
            .unwrap()
            .is_some()
        );
    }

    #[tokio::test]
    async fn one_connection_cannot_monopolize_the_global_budget() {
        let (mut first_initiator, mut first_responder) = establish().await;
        let (mut second_initiator, mut second_responder) = establish().await;
        let global_budget = Arc::new(Semaphore::new(MAX_E2EE_CHUNK_BYTES * 2));
        let first_connection_budget = Arc::new(Semaphore::new(MAX_E2EE_CHUNK_BYTES));
        let second_connection_budget = Arc::new(Semaphore::new(MAX_E2EE_CHUNK_BYTES));
        let continuation = record(
            E2EE_RECORD_FLAG_CONTINUATION,
            &vec![0_u8; MAX_E2EE_CHUNK_BYTES],
        );
        let first_frames =
            initiator_encrypt(&mut first_initiator, &[continuation.clone(), continuation]);
        let second_frame = initiator_encrypt(
            &mut second_initiator,
            &[record(E2EE_RECORD_FLAG_FINAL, b"second connection")],
        )
        .pop()
        .unwrap();

        assert!(
            decrypt_inbound_frame_budgeted(
                &mut first_responder,
                &first_frames[0],
                MAX_E2EE_LOGICAL_MESSAGE_BYTES,
                &global_budget,
                None,
                &first_connection_budget,
            )
            .unwrap()
            .is_none()
        );
        assert!(matches!(
            decrypt_inbound_frame_budgeted(
                &mut first_responder,
                &first_frames[1],
                MAX_E2EE_LOGICAL_MESSAGE_BYTES,
                &global_budget,
                None,
                &first_connection_budget,
            ),
            Err(E2eeSessionError::Protocol(_))
        ));
        assert!(
            decrypt_inbound_frame_budgeted(
                &mut second_responder,
                &second_frame,
                MAX_E2EE_LOGICAL_MESSAGE_BYTES,
                &global_budget,
                None,
                &second_connection_budget,
            )
            .unwrap()
            .is_some()
        );
    }

    #[tokio::test]
    async fn many_tiny_records_remain_within_the_byte_budget() {
        let (mut initiator, mut responder) = establish().await;
        let continuation_count = 1_026;
        let mut records = (0..continuation_count)
            .map(|_| record(E2EE_RECORD_FLAG_CONTINUATION, b"x"))
            .collect::<Vec<_>>();
        records.push(record(E2EE_RECORD_FLAG_FINAL, b"done"));
        let frames = initiator_encrypt(&mut initiator, &records);
        let message_bytes = continuation_count + b"done".len();
        let global_budget = Arc::new(Semaphore::new(message_bytes));
        let connection_budget = Arc::new(Semaphore::new(message_bytes));
        let mut completed = None;

        for frame in &frames {
            completed = decrypt_inbound_frame_budgeted(
                &mut responder,
                frame,
                MAX_E2EE_LOGICAL_MESSAGE_BYTES,
                &global_budget,
                None,
                &connection_budget,
            )
            .expect("legal tiny fragment");
        }

        let completed = completed.expect("final record completes message");
        assert_eq!(completed.plaintext.len(), message_bytes);
        assert!(completed.plaintext.ends_with(b"done"));
    }

    #[test]
    fn established_connection_capacity_is_released_on_drop() {
        let budget = E2eeResourceBudget::new(1, 1, 1, 1, 1);
        let permit = budget
            .try_reserve()
            .expect("first connection")
            .bind_principal("principal")
            .expect("first principal connection");
        assert!(matches!(budget.try_reserve(), Err("protocol")));
        drop(permit);
        assert!(budget.try_reserve().is_ok());
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
