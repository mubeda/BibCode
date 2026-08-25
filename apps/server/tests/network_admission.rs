use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bibcode_server::{
    ServerConfig, ServerError, ServerRuntime, TlsFiles,
    service::ServiceMode,
    transport::{
        ListenerSecurity, TransportError, validate_listener,
        validate_listener_with_resolved_addresses,
    },
};
use futures_util::SinkExt;
use p256::ecdsa::{Signature, SigningKey, signature::hazmat::PrehashSigner};
use rcgen::{CertificateParams, ExtendedKeyUsagePurpose, KeyPair, KeyUsagePurpose};
use serde_json::json;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use time::{Duration, OffsetDateTime};
use x509_parser::parse_x509_certificate;

fn dpop_proof(
    signing_key: &SigningKey,
    method: &str,
    url: &str,
    access_token: Option<&str>,
) -> String {
    let point = signing_key.verifying_key().to_sec1_point(false);
    let header = json!({
        "typ": "dpop+jwt",
        "alg": "ES256",
        "jwk": {
            "kty": "EC",
            "crv": "P-256",
            "x": URL_SAFE_NO_PAD.encode(point.x().expect("P-256 x coordinate")),
            "y": URL_SAFE_NO_PAD.encode(point.y().expect("P-256 y coordinate")),
        }
    });
    let mut normalized_url = url::Url::parse(url).expect("fixture URL");
    normalized_url.set_query(None);
    normalized_url.set_fragment(None);
    let mut payload = json!({
        "htm": method,
        "htu": normalized_url.to_string(),
        "jti": uuid::Uuid::new_v4().to_string(),
        "iat": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_secs(),
    });
    if let Some(access_token) = access_token {
        payload["ath"] = json!(URL_SAFE_NO_PAD.encode(Sha256::digest(access_token.as_bytes())));
    }
    let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).expect("DPoP header JSON"));
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("DPoP payload JSON"));
    let signing_input = format!("{header}.{payload}");
    let digest = Sha256::digest(signing_input.as_bytes());
    let signature: Signature = signing_key
        .sign_prehash(&digest)
        .expect("sign DPoP fixture");
    format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    )
}

struct TlsFixture {
    _directory: TempDir,
    certificate_chain: PathBuf,
    private_key: PathBuf,
}

impl TlsFixture {
    fn valid() -> Self {
        let now = OffsetDateTime::now_utc();
        Self::with_validity(now - Duration::days(1), now + Duration::days(30))
    }

    fn with_validity(not_before: OffsetDateTime, not_after: OffsetDateTime) -> Self {
        let directory = tempfile::tempdir().expect("TLS fixture directory");
        let certificate_chain = directory.path().join("certificate.pem");
        let private_key = directory.path().join("private-key.pem");
        let key_pair = KeyPair::generate().expect("generate TLS key pair");
        let mut params = CertificateParams::new(vec![
            "localhost".to_owned(),
            "127.0.0.1".to_owned(),
            "0.0.0.0".to_owned(),
        ])
        .expect("certificate parameters");
        params.not_before = not_before;
        params.not_after = not_after;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let certificate = params
            .self_signed(&key_pair)
            .expect("self-signed certificate");
        std::fs::write(&certificate_chain, certificate.pem()).expect("write certificate");
        std::fs::write(&private_key, key_pair.serialize_pem()).expect("write private key");
        Self {
            _directory: directory,
            certificate_chain,
            private_key,
        }
    }

    fn files(&self) -> TlsFiles {
        TlsFiles {
            certificate_chain: self.certificate_chain.clone(),
            private_key: self.private_key.clone(),
        }
    }

    fn certificate_pem(&self) -> Vec<u8> {
        std::fs::read(&self.certificate_chain).expect("read certificate PEM")
    }

    fn certificate_der(&self) -> rustls::pki_types::CertificateDer<'static> {
        let mut reader = std::io::BufReader::new(std::io::Cursor::new(self.certificate_pem()));
        rustls_pemfile::certs(&mut reader)
            .next()
            .expect("certificate PEM entry")
            .expect("certificate DER")
    }

    fn spki_sha256(&self) -> String {
        let certificate = self.certificate_der();
        let (_, certificate) =
            parse_x509_certificate(certificate.as_ref()).expect("parse certificate");
        Sha256::digest(certificate.public_key().raw)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

#[tokio::test]
async fn listener_admission_matches_the_security_matrix() {
    let state = tempfile::tempdir().expect("state directory");

    for host in ["127.0.0.1", "::1"] {
        let validated = validate_listener(&ServerConfig::new(state.path()).with_bind(host, 0))
            .await
            .expect("loopback plaintext is allowed");
        assert_eq!(validated.advertised_scheme, "http");
        assert!(matches!(
            validated.security,
            ListenerSecurity::LoopbackPlaintext
        ));
        assert!(validated.bind.ip().is_loopback());
    }

    for host in ["0.0.0.0", "::", "192.0.2.10"] {
        let error = validate_listener(&ServerConfig::new(state.path()).with_bind(host, 3773))
            .await
            .expect_err("non-loopback plaintext must be rejected");
        assert!(matches!(error, TransportError::NonLoopbackPlaintext { .. }));
    }

    let tls = TlsFixture::valid();
    let validated = validate_listener(
        &ServerConfig::new(state.path())
            .with_bind("0.0.0.0", 0)
            .with_tls_files(tls.files()),
    )
    .await
    .expect("non-loopback TLS is allowed after validation");
    assert_eq!(validated.advertised_scheme, "https");
    assert!(matches!(validated.security, ListenerSecurity::Tls(_)));
    assert!(validated.bind.ip().is_unspecified());
}

#[tokio::test]
async fn mixed_hostname_results_cannot_downgrade_to_a_convenient_loopback_address() {
    let state = tempfile::tempdir().expect("state directory");
    let config = ServerConfig::new(state.path()).with_bind("mixed.example", 3773);
    let error = validate_listener_with_resolved_addresses(
        &config,
        vec![
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10)), 3773),
        ],
    )
    .await
    .expect_err("mixed plaintext resolution must be rejected as a whole");

    assert!(matches!(error, TransportError::NonLoopbackPlaintext { .. }));
}

#[tokio::test]
async fn tls_files_must_be_readable_current_supported_and_matched() {
    let state = tempfile::tempdir().expect("state directory");
    let valid = TlsFixture::valid();

    let missing_key = TlsFiles {
        certificate_chain: valid.certificate_chain.clone(),
        private_key: valid._directory.path().join("missing-key.pem"),
    };
    assert!(matches!(
        validate_listener(
            &ServerConfig::new(state.path())
                .with_bind("0.0.0.0", 3773)
                .with_tls_files(missing_key)
        )
        .await,
        Err(TransportError::ReadPrivateKey { .. })
    ));

    let unreadable_certificate = TlsFiles {
        certificate_chain: valid._directory.path().to_path_buf(),
        private_key: valid.private_key.clone(),
    };
    assert!(matches!(
        validate_listener(
            &ServerConfig::new(state.path())
                .with_bind("0.0.0.0", 3773)
                .with_tls_files(unreadable_certificate)
        )
        .await,
        Err(TransportError::ReadCertificate { .. })
    ));

    let other = TlsFixture::valid();
    let mismatched = TlsFiles {
        certificate_chain: valid.certificate_chain.clone(),
        private_key: other.private_key.clone(),
    };
    assert!(matches!(
        validate_listener(
            &ServerConfig::new(state.path())
                .with_bind("0.0.0.0", 3773)
                .with_tls_files(mismatched)
        )
        .await,
        Err(TransportError::CertificateKeyMismatch)
    ));

    let unsupported_directory = tempfile::tempdir().expect("unsupported key directory");
    let unsupported_key = unsupported_directory.path().join("private-key.pem");
    std::fs::write(
        &unsupported_key,
        "-----BEGIN OPENSSH PRIVATE KEY-----\nAA==\n-----END OPENSSH PRIVATE KEY-----\n",
    )
    .expect("write unsupported key");
    assert!(matches!(
        validate_listener(
            &ServerConfig::new(state.path())
                .with_bind("0.0.0.0", 3773)
                .with_tls_files(TlsFiles {
                    certificate_chain: valid.certificate_chain.clone(),
                    private_key: unsupported_key,
                })
        )
        .await,
        Err(TransportError::UnsupportedPrivateKey { .. })
    ));

    let now = OffsetDateTime::now_utc();
    let expired = TlsFixture::with_validity(now - Duration::days(30), now - Duration::days(1));
    assert!(matches!(
        validate_listener(
            &ServerConfig::new(state.path())
                .with_bind("0.0.0.0", 3773)
                .with_tls_files(expired.files())
        )
        .await,
        Err(TransportError::CertificateExpired)
    ));

    let not_yet_valid =
        TlsFixture::with_validity(now + Duration::days(1), now + Duration::days(30));
    assert!(matches!(
        validate_listener(
            &ServerConfig::new(state.path())
                .with_bind("0.0.0.0", 3773)
                .with_tls_files(not_yet_valid.files())
        )
        .await,
        Err(TransportError::CertificateNotYetValid)
    ));
}

#[tokio::test]
async fn unsafe_no_auth_is_impossible_for_packaged_service_or_remote_launches() {
    let state = tempfile::tempdir().expect("state directory");
    let packaged = ServerConfig::new(state.path())
        .with_bind("127.0.0.1", 0)
        .with_static_dir(state.path().join("web"))
        .with_unsafe_no_auth();
    assert!(matches!(
        validate_listener(&packaged).await,
        Err(TransportError::UnsafeNoAuthForbidden { .. })
    ));

    let service = ServerConfig::new(state.path())
        .with_bind("127.0.0.1", 0)
        .with_service_managed_launch(ServiceMode::Workstation)
        .with_unsafe_no_auth();
    assert!(matches!(
        validate_listener(&service).await,
        Err(TransportError::UnsafeNoAuthForbidden { .. })
    ));

    let tls = TlsFixture::valid();
    let remote = ServerConfig::new(state.path())
        .with_bind("192.0.2.10", 3773)
        .with_tls_files(tls.files())
        .with_unsafe_no_auth();
    assert!(matches!(
        validate_listener(&remote).await,
        Err(TransportError::UnsafeNoAuthForbidden { .. })
    ));
}

#[tokio::test]
async fn rejected_listener_configuration_has_no_persistent_state_side_effects() {
    let parent = tempfile::tempdir().expect("parent directory");
    let state = parent.path().join("must-not-be-created");
    let error = match ServerRuntime::start(ServerConfig::new(&state).with_bind("0.0.0.0", 0)).await
    {
        Ok(_) => panic!("wildcard plaintext startup must fail"),
        Err(error) => error,
    };

    assert!(matches!(
        error,
        ServerError::Transport(TransportError::NonLoopbackPlaintext { .. })
    ));
    assert!(!state.exists());
}

#[tokio::test]
async fn desktop_bootstrap_authority_never_allows_wildcard_plaintext() {
    let state = tempfile::tempdir().expect("state directory");
    let config = ServerConfig::new(state.path())
        .with_bind("0.0.0.0", 0)
        .with_desktop("desktop-bootstrap-token")
        .expect("desktop token is valid");

    assert!(matches!(
        validate_listener(&config).await,
        Err(TransportError::NonLoopbackPlaintext { .. })
    ));
}

#[tokio::test]
async fn tls_listener_serves_https_metadata_and_never_downgrades_to_plaintext() {
    let state = tempfile::tempdir().expect("state directory");
    let tls = TlsFixture::valid();
    let expected_fingerprint = tls.spki_sha256();
    let handle = ServerRuntime::start_with_registry(
        ServerConfig::new(state.path())
            .with_bind("0.0.0.0", 0)
            .with_tls_files(tls.files()),
        bibcode_server::RpcRegistry::empty(),
    )
    .await
    .expect("validated TLS server starts");
    let port = handle.local_addr().port();
    let startup_access = handle
        .startup_access()
        .expect("TLS web server issues startup access");
    assert_eq!(
        startup_access.connection_string,
        format!("https://localhost:{port}")
    );
    assert!(startup_access.pairing_url.starts_with("https://localhost:"));

    let root = reqwest::Certificate::from_pem(&tls.certificate_pem())
        .expect("fixture certificate is a valid trust root");
    let https = reqwest::Client::builder()
        .add_root_certificate(root)
        .https_only(true)
        .no_proxy()
        .build()
        .expect("HTTPS client");
    let descriptor = https
        .get(format!(
            "https://localhost:{port}/.well-known/bibcode/environment"
        ))
        .send()
        .await
        .expect("HTTPS descriptor response");
    assert!(descriptor.status().is_success());
    let descriptor = descriptor
        .json::<serde_json::Value>()
        .await
        .expect("descriptor JSON");
    assert_eq!(descriptor["transport"]["mode"], "https");
    assert_eq!(descriptor["transport"]["spkiSha256"], expected_fingerprint);

    let credential = startup_access.credential.clone();
    let signing_key = SigningKey::from_bytes((&[71_u8; 32]).into()).expect("DPoP signing key");
    let token_url = format!("https://localhost:{port}/oauth/token");
    let token_response = https
        .post(&token_url)
        .header("dpop", dpop_proof(&signing_key, "POST", &token_url, None))
        .form(&[
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:token-exchange",
            ),
            ("subject_token", credential.as_str()),
            (
                "subject_token_type",
                "urn:bibcode:params:oauth:token-type:environment-bootstrap",
            ),
            (
                "requested_token_type",
                "urn:ietf:params:oauth:token-type:access_token",
            ),
        ])
        .send()
        .await
        .expect("HTTPS token exchange");
    let token_status = token_response.status();
    let token_body = token_response
        .text()
        .await
        .expect("HTTPS token response body");
    assert!(
        token_status.is_success(),
        "HTTPS token exchange failed with {token_status}: {token_body}"
    );
    let token: serde_json::Value = serde_json::from_str(&token_body).expect("token response JSON");
    let access_token = token["access_token"].as_str().expect("access token");
    let ticket_url = format!("https://localhost:{port}/api/auth/websocket-ticket");
    let ticket = https
        .post(&ticket_url)
        .header("authorization", format!("DPoP {access_token}"))
        .header(
            "dpop",
            dpop_proof(&signing_key, "POST", &ticket_url, Some(access_token)),
        )
        .send()
        .await
        .expect("HTTPS WebSocket ticket")
        .json::<serde_json::Value>()
        .await
        .expect("ticket JSON");
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(tls.certificate_der())
        .expect("add fixture trust root");
    let provider = rustls::crypto::aws_lc_rs::default_provider();
    let client_config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(provider))
        .with_safe_default_protocol_versions()
        .expect("TLS protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("TLS WebSocket TCP connection");
    let server_name = rustls::pki_types::ServerName::try_from("localhost")
        .expect("TLS server name")
        .to_owned();
    let tls_stream = tokio_rustls::TlsConnector::from(std::sync::Arc::new(client_config))
        .connect(server_name, tcp)
        .await
        .expect("TLS WebSocket handshake");
    let (mut websocket, _) = tokio_tungstenite::client_async(
        format!(
            "wss://localhost:{port}/ws?wsTicket={}",
            ticket["ticket"].as_str().expect("WebSocket ticket")
        ),
        tls_stream,
    )
    .await
    .expect("WSS upgrade");
    websocket
        .send(tokio_tungstenite::tungstenite::Message::Close(None))
        .await
        .expect("close WSS connection");

    let plaintext = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("plaintext client");
    let plaintext_result = tokio::time::timeout(
        Duration::seconds(2).unsigned_abs(),
        plaintext
            .get(format!(
                "http://127.0.0.1:{port}/.well-known/bibcode/environment"
            ))
            .send(),
    )
    .await
    .expect("plaintext attempt is rejected promptly");
    assert!(plaintext_result.is_err());

    handle.shutdown();
    handle.join().await.expect("TLS server joins cleanly");
}

#[tokio::test]
async fn shutdown_cancels_the_bounded_set_of_stalled_tls_handshakes() {
    let state = tempfile::tempdir().expect("state directory");
    let tls = TlsFixture::valid();
    let handle = ServerRuntime::start_with_registry(
        ServerConfig::new(state.path())
            .with_bind("0.0.0.0", 0)
            .with_tls_files(tls.files()),
        bibcode_server::RpcRegistry::empty(),
    )
    .await
    .expect("validated TLS server starts");
    let port = handle.local_addr().port();
    let mut stalled = Vec::new();
    for _ in 0..80 {
        stalled.push(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .expect("stalled TLS TCP connection"),
        );
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    handle.shutdown();
    tokio::time::timeout(std::time::Duration::from_secs(2), handle.join())
        .await
        .expect("shutdown does not wait for the TLS handshake deadline")
        .expect("TLS server joins after cancelling handshakes");
    drop(stalled);
}
