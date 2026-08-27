#![expect(
    dead_code,
    reason = "the /ws-e2ee route consumes this channel in Phase 3 Task 5"
)]

use std::{ops::AsyncFnMut, time::Duration};

use serde::Deserialize;
use serde_json::json;

use crate::auth::{HostIdentity, NOISE_NK_PARAMS};

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

#[derive(Debug)]
pub(crate) enum E2eeSessionError {
    Handshake,
    Protocol(String),
    Crypto(String),
    Closed,
    Timeout,
}

pub(crate) struct E2eeChannel {
    transport: snow::TransportState,
    assembling: Vec<u8>,
}

impl E2eeChannel {
    pub(crate) async fn respond<Rx, Tx>(
        host_identity: &HostIdentity,
        mut recv_binary_frame: Rx,
        mut send_binary_frame: Tx,
    ) -> Result<Self, E2eeSessionError>
    where
        Rx: AsyncFnMut() -> Option<Vec<u8>>,
        Tx: AsyncFnMut(Vec<u8>) -> Result<(), E2eeSessionError>,
    {
        let params = NOISE_NK_PARAMS
            .parse()
            .map_err(|error| E2eeSessionError::Protocol(format!("noise params: {error:?}")))?;
        let mut responder = snow::Builder::new(params)
            .local_private_key(host_identity.private_key_bytes())
            .map_err(|error| E2eeSessionError::Protocol(format!("local key: {error:?}")))?
            .build_responder()
            .map_err(|error| E2eeSessionError::Protocol(format!("responder: {error:?}")))?;

        let message_a = recv_binary_frame().await.ok_or(E2eeSessionError::Closed)?;
        if message_a.len() > MAX_E2EE_CIPHERTEXT_BYTES {
            return Err(E2eeSessionError::Protocol(
                "oversized handshake frame".into(),
            ));
        }
        let mut payload = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
        let payload_len = responder
            .read_message(&message_a, &mut payload)
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
        send_binary_frame(message_b).await?;

        let transport = responder
            .into_transport_mode()
            .map_err(|error| E2eeSessionError::Crypto(format!("transport: {error:?}")))?;
        Ok(Self {
            transport,
            assembling: Vec::new(),
        })
    }

    pub(crate) fn encrypt_message(
        &mut self,
        plaintext: &[u8],
    ) -> Result<Vec<Vec<u8>>, E2eeSessionError> {
        if plaintext.len() > MAX_E2EE_LOGICAL_MESSAGE_BYTES {
            return Err(E2eeSessionError::Protocol(
                "outbound message too large".into(),
            ));
        }
        let mut frames = Vec::new();
        let mut chunks = plaintext.chunks(MAX_E2EE_CHUNK_BYTES).peekable();
        if chunks.peek().is_none() {
            frames.push(self.encrypt_record(E2EE_RECORD_FLAG_FINAL, &[])?);
            return Ok(frames);
        }
        while let Some(chunk) = chunks.next() {
            let flag = if chunks.peek().is_none() {
                E2EE_RECORD_FLAG_FINAL
            } else {
                E2EE_RECORD_FLAG_CONTINUATION
            };
            frames.push(self.encrypt_record(flag, chunk)?);
        }
        Ok(frames)
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
        let mut record = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
        let len = self
            .transport
            .read_message(frame, &mut record)
            .map_err(|error| E2eeSessionError::Crypto(format!("decrypt: {error:?}")))?;
        if len == 0 {
            return Err(E2eeSessionError::Protocol("empty record".into()));
        }
        let flag = record[0];
        let chunk = &record[1..len];
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
    storage_instance_id: &str,
) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "type": "e2ee_authenticated",
        "credential": credential,
        "environmentId": environment_id,
        "storageInstanceId": storage_instance_id,
    }))
    .expect("static JSON")
}

pub(crate) fn e2ee_error_json(code: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({ "type": "e2ee_error", "code": code })).expect("static JSON")
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
