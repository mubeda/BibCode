use std::{
    fmt::Write as _,
    future::pending,
    io::{BufReader, Cursor, IoSlice},
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

use rustls::{InconsistentKeys, ServerConfig as RustlsServerConfig};
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore, mpsc},
    time::{sleep, timeout},
};
use tokio_rustls::{TlsAcceptor, server::TlsStream};
use tokio_util::sync::CancellationToken;
use x509_parser::{parse_x509_certificate, time::ASN1Time};

use crate::config::{ServerConfig, TlsFiles};

const RESOLUTION_TIMEOUT: Duration = Duration::from_secs(5);
const TLS_FILE_READ_TIMEOUT: Duration = Duration::from_secs(5);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const TLS_HANDSHAKE_LIMIT: usize = 64;
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum TransportIdentity {
    LoopbackHttp,
    Https {
        #[serde(rename = "spkiSha256")]
        spki_sha256: String,
    },
}

impl TransportIdentity {
    #[must_use]
    pub const fn advertised_scheme(&self) -> &'static str {
        match self {
            Self::LoopbackHttp => "http",
            Self::Https { .. } => "https",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TlsIdentity {
    pub spki_sha256: String,
}

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
    pub transport_identity: TransportIdentity,
    advertised_host: String,
}

pub enum BoundListener {
    Plain {
        listener: TcpListener,
        advertised_host: String,
    },
    Tls {
        listener: TlsListener,
        identity: TlsIdentity,
        advertised_host: String,
    },
}

impl BoundListener {
    pub fn local_addr(&self) -> Result<SocketAddr, std::io::Error> {
        match self {
            Self::Plain { listener, .. } => listener.local_addr(),
            Self::Tls { listener, .. } => listener.local_addr(),
        }
    }

    #[must_use]
    pub const fn advertised_scheme(&self) -> &'static str {
        match self {
            Self::Plain { .. } => "http",
            Self::Tls { .. } => "https",
        }
    }

    #[must_use]
    pub fn transport_identity(&self) -> TransportIdentity {
        match self {
            Self::Plain { .. } => TransportIdentity::LoopbackHttp,
            Self::Tls { identity, .. } => TransportIdentity::Https {
                spki_sha256: identity.spki_sha256.clone(),
            },
        }
    }

    pub fn advertised_base_url(&self) -> Result<String, std::io::Error> {
        let host = match self {
            Self::Plain {
                advertised_host, ..
            }
            | Self::Tls {
                advertised_host, ..
            } => advertised_host,
        };
        let authority_host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.clone()
        };
        Ok(format!(
            "{}://{authority_host}:{}",
            self.advertised_scheme(),
            self.local_addr()?.port()
        ))
    }
}

#[doc(hidden)]
pub enum BoundIo {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl AsyncRead for BoundIo {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_read(context, buffer),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_read(context, buffer),
        }
    }
}

impl AsyncWrite for BoundIo {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<Result<usize, std::io::Error>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write(context, buffer),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_write(context, buffer),
        }
    }

    fn poll_flush(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_flush(context),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(context),
        }
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_shutdown(context),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(context),
        }
    }

    fn is_write_vectored(&self) -> bool {
        match self {
            Self::Plain(stream) => stream.is_write_vectored(),
            Self::Tls(stream) => stream.is_write_vectored(),
        }
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[IoSlice<'_>],
    ) -> Poll<Result<usize, std::io::Error>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write_vectored(context, buffers),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_write_vectored(context, buffers),
        }
    }
}

impl axum::serve::Listener for BoundListener {
    type Io = BoundIo;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self {
            Self::Plain { listener, .. } => loop {
                match TcpListener::accept(listener).await {
                    Ok((stream, peer)) => return (BoundIo::Plain(stream), peer),
                    Err(_) => sleep(ACCEPT_ERROR_BACKOFF).await,
                }
            },
            Self::Tls { listener, .. } => {
                let (stream, peer) = listener.accept().await;
                (BoundIo::Tls(Box::new(stream)), peer)
            }
        }
    }

    fn local_addr(&self) -> Result<Self::Addr, std::io::Error> {
        Self::local_addr(self)
    }
}

pub struct TlsListener {
    listener: TcpListener,
    acceptor: TlsAcceptor,
    handshake_permits: Arc<Semaphore>,
    completed_tx: mpsc::Sender<(TlsStream<TcpStream>, SocketAddr)>,
    completed_rx: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
    shutdown: CancellationToken,
}

impl TlsListener {
    fn new(
        listener: TcpListener,
        tls: Arc<RustlsServerConfig>,
        shutdown: CancellationToken,
    ) -> Self {
        let (completed_tx, completed_rx) = mpsc::channel(TLS_HANDSHAKE_LIMIT);
        Self {
            listener,
            acceptor: TlsAcceptor::from(tls),
            handshake_permits: Arc::new(Semaphore::new(TLS_HANDSHAKE_LIMIT)),
            completed_tx,
            completed_rx,
            shutdown,
        }
    }

    fn local_addr(&self) -> Result<SocketAddr, std::io::Error> {
        self.listener.local_addr()
    }

    async fn accept(&mut self) -> (TlsStream<TcpStream>, SocketAddr) {
        loop {
            if self.shutdown.is_cancelled() {
                pending::<()>().await;
            }
            let permits = self.handshake_permits.clone();
            let permit = tokio::select! {
                completed = self.completed_rx.recv() => {
                    if let Some(completed) = completed {
                        return completed;
                    }
                    continue;
                }
                permit = permits.acquire_owned() => {
                    permit.expect("the TLS handshake semaphore is never closed")
                }
                () = self.shutdown.cancelled() => pending::<OwnedSemaphorePermit>().await,
            };
            tokio::select! {
                completed = self.completed_rx.recv() => {
                    drop(permit);
                    if let Some(completed) = completed {
                        return completed;
                    }
                }
                accepted = self.listener.accept() => {
                    match accepted {
                        Ok((stream, peer)) => self.spawn_handshake(stream, peer, permit),
                        Err(_) => {
                            drop(permit);
                            sleep(ACCEPT_ERROR_BACKOFF).await;
                        }
                    }
                }
                () = self.shutdown.cancelled() => {
                    drop(permit);
                    pending::<()>().await;
                }
            }
        }
    }

    fn spawn_handshake(&self, stream: TcpStream, peer: SocketAddr, permit: OwnedSemaphorePermit) {
        let acceptor = self.acceptor.clone();
        let completed = self.completed_tx.clone();
        let shutdown = self.shutdown.clone();
        tokio::spawn(async move {
            let accepted = tokio::select! {
                () = shutdown.cancelled() => None,
                result = timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream)) => {
                    match result {
                        Ok(Ok(stream)) => Some(stream),
                        Ok(Err(_)) | Err(_) => None,
                    }
                }
            };
            if let Some(stream) = accepted {
                tokio::select! {
                    () = shutdown.cancelled() => {}
                    _ = completed.send((stream, peer)) => {}
                }
            }
            drop(permit);
        });
    }
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

    let (security, transport_identity) = match &config.tls {
        Some(files) => {
            let (tls, identity) = load_tls_config(files).await?;
            (
                ListenerSecurity::Tls(tls),
                TransportIdentity::Https {
                    spki_sha256: identity.spki_sha256,
                },
            )
        }
        None if has_non_loopback => {
            return Err(TransportError::NonLoopbackPlaintext { addresses });
        }
        None => (
            ListenerSecurity::LoopbackPlaintext,
            TransportIdentity::LoopbackHttp,
        ),
    };
    let advertised_scheme = transport_identity.advertised_scheme();
    Ok(ValidatedListenerConfig {
        bind,
        advertised_scheme,
        security,
        transport_identity,
        advertised_host: advertised_host(config),
    })
}

pub async fn bind(
    validated: ValidatedListenerConfig,
    shutdown: CancellationToken,
) -> Result<BoundListener, TransportError> {
    let listener = TcpListener::bind(validated.bind)
        .await
        .map_err(|source| TransportError::Bind { source })?;
    match validated.security {
        ListenerSecurity::LoopbackPlaintext => Ok(BoundListener::Plain {
            listener,
            advertised_host: validated.advertised_host,
        }),
        ListenerSecurity::Tls(tls) => {
            let TransportIdentity::Https { spki_sha256 } = validated.transport_identity else {
                unreachable!("validated TLS security has HTTPS transport identity");
            };
            Ok(BoundListener::Tls {
                listener: TlsListener::new(listener, tls, shutdown),
                identity: TlsIdentity { spki_sha256 },
                advertised_host: validated.advertised_host,
            })
        }
    }
}

fn advertised_host(config: &ServerConfig) -> String {
    match config.host.parse::<IpAddr>() {
        Ok(address) if address.is_unspecified() => "localhost".to_owned(),
        _ => config
            .host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .unwrap_or(config.host.as_str())
            .to_owned(),
    }
}

fn reject_unsafe_auth_context(config: &ServerConfig) -> Result<(), TransportError> {
    if !config.unsafe_no_auth {
        return Ok(());
    }
    if config.managed_service_mode.is_some() {
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

async fn load_tls_config(
    files: &TlsFiles,
) -> Result<(Arc<RustlsServerConfig>, TlsIdentity), TransportError> {
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
    let identity = tls_identity(&certificates[0])?;

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
    Ok((Arc::new(tls), identity))
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

fn tls_identity(
    certificate_der: &rustls::pki_types::CertificateDer<'static>,
) -> Result<TlsIdentity, TransportError> {
    let (_, certificate) = parse_x509_certificate(certificate_der.as_ref())
        .map_err(|_| TransportError::InvalidCertificateChain)?;
    let digest = Sha256::digest(certificate.public_key().raw);
    let mut spki_sha256 = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut spki_sha256, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(TlsIdentity { spki_sha256 })
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
