use std::{
    io::{BufReader, Cursor},
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use rustls::{InconsistentKeys, ServerConfig as RustlsServerConfig};
use thiserror::Error;
use tokio::{net::TcpListener, time::timeout};
use x509_parser::{parse_x509_certificate, time::ASN1Time};

use crate::config::{ServerConfig, TlsFiles};

const RESOLUTION_TIMEOUT: Duration = Duration::from_secs(5);
const TLS_FILE_READ_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub enum ListenerSecurity {
    LoopbackPlaintext,
    Tls(Arc<RustlsServerConfig>),
}

#[derive(Clone, Debug)]
pub struct ValidatedListenerConfig {
    pub bind: SocketAddr,
    pub advertised_scheme: &'static str,
    pub security: ListenerSecurity,
}

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("listener host {host:?} did not resolve before the startup deadline")]
    ResolutionTimeout { host: String },
    #[error("listener host {host:?} could not be resolved")]
    Resolve {
        host: String,
        #[source]
        source: std::io::Error,
    },
    #[error("listener host {host:?} resolved to no addresses")]
    NoResolvedAddresses { host: String },
    #[error("plaintext HTTP/WebSocket listeners must resolve exclusively to loopback addresses")]
    NonLoopbackPlaintext { addresses: Vec<SocketAddr> },
    #[error("unsafe authentication is forbidden for {context}")]
    UnsafeNoAuthForbidden { context: &'static str },
    #[error("TLS certificate chain could not be read")]
    ReadCertificate {
        #[source]
        source: std::io::Error,
    },
    #[error("TLS certificate chain read exceeded the startup deadline")]
    ReadCertificateTimeout,
    #[error("TLS certificate chain contains no certificates")]
    EmptyCertificateChain,
    #[error("TLS certificate chain is not valid PEM/X.509")]
    InvalidCertificateChain,
    #[error("TLS certificate is expired")]
    CertificateExpired,
    #[error("TLS certificate is not yet valid")]
    CertificateNotYetValid,
    #[error("TLS private key could not be read")]
    ReadPrivateKey {
        #[source]
        source: std::io::Error,
    },
    #[error("TLS private-key read exceeded the startup deadline")]
    ReadPrivateKeyTimeout,
    #[error("TLS private-key file does not contain a supported PKCS#1, PKCS#8, or SEC1 key")]
    UnsupportedPrivateKey { path: std::path::PathBuf },
    #[error("TLS certificate and private key do not match")]
    CertificateKeyMismatch,
    #[error("TLS configuration could not be initialized: {message}")]
    TlsConfiguration { message: String },
    #[error("TLS listener activation is unavailable until the TLS serving boundary is initialized")]
    TlsServingUnavailable,
    #[error("failed to bind the validated server listener")]
    Bind {
        #[source]
        source: std::io::Error,
    },
}

pub async fn validate_listener(
    config: &ServerConfig,
) -> Result<ValidatedListenerConfig, TransportError> {
    reject_unsafe_auth_context(config)?;
    let addresses = resolve_addresses(config).await?;
    validate_listener_with_resolved_addresses(config, addresses).await
}

#[doc(hidden)]
pub async fn validate_listener_with_resolved_addresses(
    config: &ServerConfig,
    mut addresses: Vec<SocketAddr>,
) -> Result<ValidatedListenerConfig, TransportError> {
    reject_unsafe_auth_context(config)?;
    addresses.sort_unstable();
    addresses.dedup();
    let Some(bind) = addresses.first().copied() else {
        return Err(TransportError::NoResolvedAddresses {
            host: config.host.clone(),
        });
    };
    let has_non_loopback = addresses.iter().any(|address| !address.ip().is_loopback());
    if config.unsafe_no_auth && has_non_loopback {
        return Err(TransportError::UnsafeNoAuthForbidden {
            context: "a non-loopback listener",
        });
    }

    let security = match &config.tls {
        Some(files) => ListenerSecurity::Tls(load_tls_config(files).await?),
        None if has_non_loopback => {
            return Err(TransportError::NonLoopbackPlaintext { addresses });
        }
        None => ListenerSecurity::LoopbackPlaintext,
    };
    let advertised_scheme = match &security {
        ListenerSecurity::LoopbackPlaintext => "http",
        ListenerSecurity::Tls(_) => "https",
    };
    Ok(ValidatedListenerConfig {
        bind,
        advertised_scheme,
        security,
    })
}

pub async fn bind(validated: ValidatedListenerConfig) -> Result<TcpListener, TransportError> {
    if matches!(validated.security, ListenerSecurity::Tls(_)) {
        return Err(TransportError::TlsServingUnavailable);
    }
    TcpListener::bind(validated.bind)
        .await
        .map_err(|source| TransportError::Bind { source })
}

fn reject_unsafe_auth_context(config: &ServerConfig) -> Result<(), TransportError> {
    if !config.unsafe_no_auth {
        return Ok(());
    }
    if config.managed_service_launch {
        return Err(TransportError::UnsafeNoAuthForbidden {
            context: "a managed service launch",
        });
    }
    if config.static_dir.is_some() {
        return Err(TransportError::UnsafeNoAuthForbidden {
            context: "packaged static assets",
        });
    }
    Ok(())
}

async fn resolve_addresses(config: &ServerConfig) -> Result<Vec<SocketAddr>, TransportError> {
    if let Ok(ip) = config.host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, config.port)]);
    }
    let host = config.host.clone();
    let resolved = timeout(
        RESOLUTION_TIMEOUT,
        tokio::net::lookup_host((config.host.as_str(), config.port)),
    )
    .await
    .map_err(|_| TransportError::ResolutionTimeout { host: host.clone() })?
    .map_err(|source| TransportError::Resolve {
        host: host.clone(),
        source,
    })?;
    Ok(resolved.collect())
}

async fn load_tls_config(files: &TlsFiles) -> Result<Arc<RustlsServerConfig>, TransportError> {
    let certificate_bytes = timeout(
        TLS_FILE_READ_TIMEOUT,
        tokio::fs::read(&files.certificate_chain),
    )
    .await
    .map_err(|_| TransportError::ReadCertificateTimeout)?
    .map_err(|source| TransportError::ReadCertificate { source })?;
    let mut certificate_reader = BufReader::new(Cursor::new(certificate_bytes));
    let certificates = rustls_pemfile::certs(&mut certificate_reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| TransportError::InvalidCertificateChain)?;
    if certificates.is_empty() {
        return Err(TransportError::EmptyCertificateChain);
    }
    validate_certificate_times(&certificates)?;

    let private_key_bytes = timeout(TLS_FILE_READ_TIMEOUT, tokio::fs::read(&files.private_key))
        .await
        .map_err(|_| TransportError::ReadPrivateKeyTimeout)?
        .map_err(|source| TransportError::ReadPrivateKey { source })?;
    let mut private_key_reader = BufReader::new(Cursor::new(private_key_bytes));
    let private_key = rustls_pemfile::private_key(&mut private_key_reader)
        .map_err(|source| TransportError::ReadPrivateKey { source })?
        .ok_or_else(|| TransportError::UnsupportedPrivateKey {
            path: files.private_key.clone(),
        })?;

    let provider = rustls::crypto::aws_lc_rs::default_provider();
    let builder = RustlsServerConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|error| TransportError::TlsConfiguration {
            message: error.to_string(),
        })?
        .with_no_client_auth();
    let mut tls = builder
        .with_single_cert(certificates, private_key)
        .map_err(map_rustls_config_error)?;
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(tls))
}

fn validate_certificate_times(
    certificates: &[rustls::pki_types::CertificateDer<'static>],
) -> Result<(), TransportError> {
    let now = ASN1Time::now();
    for certificate_der in certificates {
        let (_, certificate) = parse_x509_certificate(certificate_der.as_ref())
            .map_err(|_| TransportError::InvalidCertificateChain)?;
        if now < certificate.validity().not_before {
            return Err(TransportError::CertificateNotYetValid);
        }
        if now > certificate.validity().not_after {
            return Err(TransportError::CertificateExpired);
        }
    }
    Ok(())
}

fn map_rustls_config_error(error: rustls::Error) -> TransportError {
    if matches!(
        error,
        rustls::Error::InconsistentKeys(InconsistentKeys::KeyMismatch)
    ) {
        return TransportError::CertificateKeyMismatch;
    }
    TransportError::TlsConfiguration {
        message: error.to_string(),
    }
}
