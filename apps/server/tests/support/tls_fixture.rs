//! A throwaway certificate authority and a TLS-terminating proxy in front of a test server,
//! so `https` remotes are tested with real certificate verification.
//!
//! The certificates are built here (P-256, valid for 30 days from now) instead of read from
//! a fixture, so they never expire under the test and stay inside every platform verifier's
//! validity limit. Integration binaries include this file with `#[path]`; the library's unit
//! tests include it through `src/test_support`.

use std::{net::SocketAddr, sync::Arc};

use p256::{
    ecdsa::{Signature, SigningKey, signature::Signer as _},
    pkcs8::{EncodePrivateKey as _, EncodePublicKey as _},
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use sha2::{Digest as _, Sha256};
use tokio::net::{TcpListener, TcpStream};

/// A certificate authority and one server certificate it issued for `localhost` and
/// `127.0.0.1`.
pub struct TestCertificates {
    pub authority: CertificateDer<'static>,
    pub server: CertificateDer<'static>,
    pub server_key: PrivatePkcs8KeyDer<'static>,
}

fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let length = content.len();
    if length < 0x80 {
        out.push(length as u8);
    } else {
        let bytes = length.to_be_bytes();
        let first = bytes
            .iter()
            .position(|byte| *byte != 0)
            .unwrap_or(bytes.len() - 1);
        out.push(0x80 | (bytes.len() - first) as u8);
        out.extend_from_slice(&bytes[first..]);
    }
    out.extend_from_slice(content);
    out
}

fn sequence(parts: &[Vec<u8>]) -> Vec<u8> {
    tlv(0x30, &parts.concat())
}

fn oid(content: &[u8]) -> Vec<u8> {
    tlv(0x06, content)
}

fn positive_integer(bytes: &[u8]) -> Vec<u8> {
    let mut content = bytes.to_vec();
    if content.first().is_some_and(|byte| byte & 0x80 != 0) {
        content.insert(0, 0);
    }
    tlv(0x02, &content)
}

fn bit_string(bytes: &[u8]) -> Vec<u8> {
    let mut content = vec![0];
    content.extend_from_slice(bytes);
    tlv(0x03, &content)
}

fn name(common_name: &str) -> Vec<u8> {
    let attribute = sequence(&[oid(&[0x55, 0x04, 0x03]), tlv(0x0C, common_name.as_bytes())]);
    sequence(&[tlv(0x31, &attribute)])
}

fn utc_time(at: time::OffsetDateTime) -> Vec<u8> {
    let text = format!(
        "{:02}{:02}{:02}{:02}{:02}{:02}Z",
        at.year() % 100,
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    );
    tlv(0x17, text.as_bytes())
}

fn extension(id: &[u8], critical: bool, value: Vec<u8>) -> Vec<u8> {
    let mut parts = vec![oid(id)];
    if critical {
        parts.push(tlv(0x01, &[0xFF]));
    }
    parts.push(tlv(0x04, &value));
    sequence(&parts)
}

fn key_identifier(public_key: &[u8]) -> Vec<u8> {
    Sha256::digest(public_key)[..20].to_vec()
}

const ECDSA_WITH_SHA256: &[u8] = &[0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02];

fn certificate(
    subject: &str,
    issuer: &str,
    public_key_info: &[u8],
    issuer_key: &SigningKey,
    issuer_public_key_info: &[u8],
    extensions: Vec<Vec<u8>>,
) -> Vec<u8> {
    let mut serial = [0_u8; 16];
    getrandom::fill(&mut serial).expect("serial");
    serial[0] &= 0x7F;
    let now = time::OffsetDateTime::now_utc();
    let mut all_extensions = extensions;
    all_extensions.push(extension(
        &[0x55, 0x1D, 0x23],
        false,
        sequence(&[tlv(0x80, &key_identifier(issuer_public_key_info))]),
    ));
    let to_be_signed = sequence(&[
        tlv(0xA0, &positive_integer(&[2])),
        positive_integer(&serial),
        sequence(&[oid(ECDSA_WITH_SHA256)]),
        name(issuer),
        sequence(&[
            utc_time(now - time::Duration::hours(1)),
            utc_time(now + time::Duration::days(30)),
        ]),
        name(subject),
        public_key_info.to_vec(),
        tlv(0xA3, &sequence(&all_extensions)),
    ]);
    let signature: Signature = issuer_key.sign(&to_be_signed);
    sequence(&[
        to_be_signed,
        sequence(&[oid(ECDSA_WITH_SHA256)]),
        bit_string(signature.to_der().as_bytes()),
    ])
}

fn signing_key() -> SigningKey {
    loop {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).expect("key bytes");
        if let Ok(key) = SigningKey::from_slice(&bytes) {
            return key;
        }
    }
}

impl TestCertificates {
    pub fn generate() -> Self {
        let authority_key = signing_key();
        let authority_info = authority_key
            .verifying_key()
            .to_public_key_der()
            .expect("authority key")
            .into_vec();
        let authority = certificate(
            "BiBCode test authority",
            "BiBCode test authority",
            &authority_info,
            &authority_key,
            &authority_info,
            vec![
                extension(&[0x55, 0x1D, 0x13], true, sequence(&[tlv(0x01, &[0xFF])])),
                // keyCertSign and cRLSign.
                extension(&[0x55, 0x1D, 0x0F], true, tlv(0x03, &[0x01, 0x06])),
                extension(
                    &[0x55, 0x1D, 0x0E],
                    false,
                    tlv(0x04, &key_identifier(&authority_info)),
                ),
            ],
        );
        let server_key = signing_key();
        let server_info = server_key
            .verifying_key()
            .to_public_key_der()
            .expect("server key")
            .into_vec();
        let server = certificate(
            "localhost",
            "BiBCode test authority",
            &server_info,
            &authority_key,
            &authority_info,
            vec![
                extension(&[0x55, 0x1D, 0x13], true, sequence(&[])),
                // digitalSignature.
                extension(&[0x55, 0x1D, 0x0F], true, tlv(0x03, &[0x07, 0x80])),
                // serverAuth.
                extension(
                    &[0x55, 0x1D, 0x25],
                    false,
                    sequence(&[oid(&[0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01])]),
                ),
                extension(
                    &[0x55, 0x1D, 0x11],
                    false,
                    sequence(&[tlv(0x82, b"localhost"), tlv(0x87, &[127, 0, 0, 1])]),
                ),
            ],
        );
        let server_key = server_key.to_pkcs8_der().expect("server key DER");
        Self {
            authority: CertificateDer::from(authority),
            server: CertificateDer::from(server),
            server_key: PrivatePkcs8KeyDer::from(server_key.as_bytes().to_vec()),
        }
    }
}

/// Serves TLS on a loopback port and forwards every connection, decrypted, to `upstream`.
/// Returns the proxy's address; it runs until the test's runtime ends.
pub async fn tls_proxy(certificates: &TestCertificates, upstream: SocketAddr) -> SocketAddr {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("TLS versions")
        .with_no_client_auth()
        .with_single_cert(
            vec![certificates.server.clone(), certificates.authority.clone()],
            PrivateKeyDer::Pkcs8(certificates.server_key.clone_key()),
        )
        .expect("server certificate");
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind proxy");
    let address = listener.local_addr().expect("proxy address");
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                // A client that refuses the certificate ends here.
                let Ok(mut tls) = acceptor.accept(socket).await else {
                    return;
                };
                let Ok(mut server) = TcpStream::connect(upstream).await else {
                    return;
                };
                let _ = tokio::io::copy_bidirectional(&mut tls, &mut server).await;
            });
        }
    });
    address
}
