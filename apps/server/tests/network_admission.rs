use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use bibcode_server::{
    ServerConfig, ServerError, ServerRuntime, TlsFiles,
    transport::{
        ListenerSecurity, TransportError, validate_listener,
        validate_listener_with_resolved_addresses,
    },
};
use rcgen::{CertificateParams, KeyPair};
use tempfile::TempDir;
use time::{Duration, OffsetDateTime};

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
        .with_service_managed_launch()
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
