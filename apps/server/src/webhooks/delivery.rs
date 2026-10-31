//! One webhook request, made so a person's endpoint URL cannot turn BiBCode into a proxy into
//! its own network (an SSRF surface):
//!
//! - **HTTPS only**, with no user name or password in the URL. The design's loopback `http`
//!   opt-in is not offered.
//! - **Global addresses only.** The host is resolved once per attempt, and every address it
//!   resolves to must be public by X6's classification (`git::clone_policy::is_public`, which
//!   the clone policy owns and keeps widening; webhooks import it rather than copy it).
//! - **Pinned.** The request connects to the checked addresses through reqwest's resolve
//!   override, and every other name fails to resolve, so DNS cannot move the host to another
//!   address between the check and the connection. A fresh client per attempt keeps no pooled
//!   connection to an address checked earlier.
//! - **No proxy, no redirects.** System and environment proxies are ignored, and a 3xx is a
//!   failure, never followed.
//! - **Bounded.** 5 seconds to connect, 10 seconds in all, and the response body is never
//!   read: only the status is kept.

use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};

use tokio_util::sync::CancellationToken;

use crate::git::clone_policy::{HostResolver, is_public};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);
const USER_AGENT: &str = concat!("BiBCode-Webhooks/", env!("CARGO_PKG_VERSION"));

/// Why a URL is refused before any request: also what `webhooks.upsert` answers.
pub(crate) const URL_MESSAGE: &str = "Use an https:// URL with a public host name, without a user name or password, such as https://hooks.example.com/bibcode.";

/// How the dispatcher reaches the network: the resolver, and in tests the fixture's trust and
/// loopback allowance.
#[derive(Clone)]
pub(crate) struct NetPolicy {
    resolver: Arc<dyn HostResolver>,
    #[cfg(test)]
    fixture: Option<Fixture>,
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct Fixture {
    /// The only roots the client trusts (real certificate verification stays on).
    pub(crate) roots: Vec<reqwest::Certificate>,
    /// Loopback counts as public, so a local HTTPS fixture stands in for a public host.
    pub(crate) admit_loopback: bool,
}

impl NetPolicy {
    pub(crate) fn system() -> Self {
        Self::new(Arc::new(crate::git::clone_policy::SystemResolver))
    }

    pub(crate) fn new(resolver: Arc<dyn HostResolver>) -> Self {
        Self {
            resolver,
            #[cfg(test)]
            fixture: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_fixture(resolver: Arc<dyn HostResolver>, fixture: Fixture) -> Self {
        Self {
            resolver,
            fixture: Some(fixture),
        }
    }

    fn admits(&self, address: IpAddr) -> bool {
        #[cfg(test)]
        if self
            .fixture
            .as_ref()
            .is_some_and(|fixture| fixture.admit_loopback)
            && address.to_canonical().is_loopback()
        {
            return true;
        }
        is_public(address)
    }
}

/// A checked webhook URL: HTTPS, a host, no credentials.
#[derive(Clone, Debug)]
pub(crate) struct Target {
    url: url::Url,
    host: TargetHost,
    port: u16,
}

#[derive(Clone, Debug)]
enum TargetHost {
    Name(String),
    Address(IpAddr),
}

/// Parses an endpoint URL; `None` when it is not one BiBCode sends to.
pub(crate) fn check_url(text: &str) -> Option<Target> {
    if text.len() > 2_048 || text.trim() != text {
        return None;
    }
    let url = url::Url::parse(text).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let host = match url.host()? {
        url::Host::Domain(name) if !name.is_empty() => TargetHost::Name(name.to_ascii_lowercase()),
        url::Host::Domain(_) => return None,
        url::Host::Ipv4(address) => TargetHost::Address(IpAddr::V4(address)),
        url::Host::Ipv6(address) => TargetHost::Address(IpAddr::V6(address)),
    };
    let port = url.port_or_known_default()?;
    Some(Target { url, host, port })
}

/// What one attempt came to.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Attempt {
    /// The HTTP status, when a response arrived.
    pub(crate) status: Option<u16>,
    /// `None` for a 2xx; otherwise why it failed (see [`Failure::tag`]).
    pub(crate) failure: Option<Failure>,
    pub(crate) latency_ms: u64,
}

impl Attempt {
    /// A timeout, a connection error, an unresolved host, a 5xx or a 429 is tried again.
    pub(crate) fn retryable(&self) -> bool {
        match self.failure {
            Some(Failure::Status) => self.status.is_some_and(retryable_status),
            Some(failure) => failure.retryable(),
            None => false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Failure {
    /// The URL is no longer one BiBCode sends to.
    UrlRefused,
    /// The endpoint's secret could not be read, so nothing was sent unsigned.
    SecretMissing,
    /// The host resolved to a loopback, private, link-local or other non-public address.
    AddressRefused,
    /// The host did not resolve.
    Unresolved,
    Timeout,
    /// The connection or TLS handshake failed.
    Connect,
    /// A 3xx: redirects are never followed.
    Redirect,
    /// Any other 4xx or 5xx (the status says which).
    Status,
    /// Turned off, disabled or shut down while it was in flight.
    Cancelled,
}

impl Failure {
    /// The tag `webhooks.listDeliveries` reports.
    pub(crate) const fn tag(self) -> &'static str {
        match self {
            Self::UrlRefused => "url_refused",
            Self::SecretMissing => "secret_missing",
            Self::AddressRefused => "address_refused",
            Self::Unresolved => "unresolved",
            Self::Timeout => "timeout",
            Self::Connect => "connect",
            Self::Redirect => "redirect",
            Self::Status => "status",
            Self::Cancelled => "cancelled",
        }
    }

    const fn retryable(self) -> bool {
        matches!(self, Self::Unresolved | Self::Timeout | Self::Connect)
    }
}

/// The headers of one request, besides the content type.
pub(crate) struct Headers<'a> {
    pub(crate) event_type: &'a str,
    pub(crate) delivery_id: &'a str,
    pub(crate) timestamp: i64,
    pub(crate) signature: &'a str,
}

/// Sends `body` to `url` once, as the module describes. Never panics and never reads the
/// response body; `cancel` drops the request at once.
pub(crate) async fn send(
    policy: &NetPolicy,
    url: &str,
    headers: &Headers<'_>,
    body: &[u8],
    cancel: &CancellationToken,
) -> Attempt {
    let started = Instant::now();
    let result = tokio::select! {
        biased;
        () = cancel.cancelled() => Err(Failure::Cancelled),
        result = attempt(policy, url, headers, body) => result,
    };
    let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match result {
        Ok(status) => {
            let failure = match status {
                200..=299 => None,
                300..=399 => Some(Failure::Redirect),
                _ => Some(Failure::Status),
            };
            Attempt {
                status: Some(status),
                failure,
                latency_ms,
            }
        }
        Err(failure) => Attempt {
            status: None,
            failure: Some(failure),
            latency_ms,
        },
    }
}

/// Whether a status is tried again: a 5xx or 429.
pub(crate) fn retryable_status(status: u16) -> bool {
    status == 429 || (500..=599).contains(&status)
}

async fn attempt(
    policy: &NetPolicy,
    url: &str,
    headers: &Headers<'_>,
    body: &[u8],
) -> Result<u16, Failure> {
    let target = check_url(url).ok_or(Failure::UrlRefused)?;
    let addresses = match &target.host {
        TargetHost::Address(address) => vec![*address],
        TargetHost::Name(name) => {
            let resolved =
                tokio::time::timeout(RESOLVE_TIMEOUT, policy.resolver.resolve(name, target.port))
                    .await
                    .map_err(|_| Failure::Unresolved)?
                    .map_err(|_| Failure::Unresolved)?;
            if resolved.is_empty() {
                return Err(Failure::Unresolved);
            }
            resolved
        }
    };
    // Every address must be public: a name with one private address among public ones would
    // otherwise reach it on a retry or a happy-eyeballs fallback.
    if !addresses.iter().all(|address| policy.admits(*address)) {
        return Err(Failure::AddressRefused);
    }
    let mut builder = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .pool_max_idle_per_host(0)
        .dns_resolver(RefuseResolver);
    if let TargetHost::Name(name) = &target.host {
        let pinned: Vec<SocketAddr> = addresses
            .iter()
            .map(|address| SocketAddr::new(*address, target.port))
            .collect();
        builder = builder.resolve_to_addrs(name, &pinned);
    }
    #[cfg(test)]
    if let Some(fixture) = &policy.fixture {
        builder = builder.tls_certs_only(fixture.roots.clone());
    }
    let client = builder.build().map_err(|_| Failure::Connect)?;
    let response = client
        .post(target.url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(super::signing::EVENT_HEADER, headers.event_type)
        .header(super::signing::DELIVERY_HEADER, headers.delivery_id)
        .header(
            super::signing::TIMESTAMP_HEADER,
            headers.timestamp.to_string(),
        )
        .header(super::signing::SIGNATURE_HEADER, headers.signature)
        .body(body.to_vec())
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                Failure::Timeout
            } else {
                Failure::Connect
            }
        })?;
    Ok(response.status().as_u16())
}

/// Resolves nothing: every name but the pinned host fails, so nothing reaches the system
/// resolver after the check.
struct RefuseResolver;

impl reqwest::dns::Resolve for RefuseResolver {
    fn resolve(&self, _name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async {
            Err::<reqwest::dns::Addrs, _>(Box::new(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "BiBCode resolves a webhook host only through its checked addresses",
            ))
                as Box<dyn std::error::Error + Send + Sync>)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_plain_https_url_is_a_target() {
        for good in [
            "https://hooks.example.com/bibcode",
            "https://hooks.example.com:8443/a?b=c",
            "https://203.0.113.9/hook",
            "https://[2001:db8::1]/hook",
        ] {
            assert!(check_url(good).is_some(), "{good}");
        }
        for bad in [
            "http://hooks.example.com/bibcode",
            "https://user:pass@hooks.example.com/",
            "https://token@hooks.example.com/",
            "ftp://hooks.example.com/",
            "file:///etc/passwd",
            "https://",
            " https://hooks.example.com/",
            "https://hooks.example.com/#fragment",
            "not a url",
        ] {
            assert!(check_url(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn retries_follow_the_failure_kind_and_status() {
        let attempt = |status, failure| Attempt {
            status,
            failure,
            latency_ms: 0,
        };
        assert!(attempt(None, Some(Failure::Timeout)).retryable());
        assert!(attempt(None, Some(Failure::Connect)).retryable());
        assert!(!attempt(None, Some(Failure::AddressRefused)).retryable());
        assert!(!attempt(Some(301), Some(Failure::Redirect)).retryable());
        assert!(attempt(Some(500), Some(Failure::Status)).retryable());
        assert!(attempt(Some(429), Some(Failure::Status)).retryable());
        assert!(!attempt(Some(400), Some(Failure::Status)).retryable());
        assert!(!attempt(Some(200), None).retryable());
        assert!(retryable_status(500) && retryable_status(503) && retryable_status(429));
        assert!(!retryable_status(400) && !retryable_status(404) && !retryable_status(410));
    }
}
