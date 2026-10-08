//! Pure request/response rewriting for the preview gateway: cookies, `Location`, origin
//! checks, and the minimal HTML pages the gateway serves itself.

use url::{Host, Position, Url};

pub const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

const GATEWAY_COOKIE_PREFIX: &str = "bibcode-gw-";
/// Prefix of every BiBCode session cookie: desktop mode names it `bibcode_session_<port>`,
/// so another instance's session on the same host must stay protected too.
const SESSION_COOKIE_PREFIX: &str = "bibcode_session";

pub fn gateway_cookie_name(gateway_port: u16) -> String {
    format!("{GATEWAY_COOKIE_PREFIX}{gateway_port}")
}

/// Value of this listener's own gateway cookie; cookies for other gateway ports are ignored.
pub fn gateway_session_from_cookie(cookie_header: &str, gateway_port: u16) -> Option<String> {
    let wanted = gateway_cookie_name(gateway_port);
    cookie_header.split(';').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name.trim() == wanted).then(|| value.trim().to_owned())
    })
}

fn is_reserved_cookie(name: &str, session_cookie_name: &str) -> bool {
    name == session_cookie_name
        || name.starts_with(SESSION_COOKIE_PREFIX)
        || name.starts_with(GATEWAY_COOKIE_PREFIX)
}

fn cookie_name(pair: &str) -> &str {
    pair.split_once('=').map_or(pair, |(name, _)| name).trim()
}

/// Request `Cookie` header without the BiBCode session cookie and any gateway cookie;
/// `None` when nothing is left to forward.
pub fn strip_request_cookies(cookie_header: &str, session_cookie_name: &str) -> Option<String> {
    let kept: Vec<&str> = cookie_header
        .split(';')
        .map(str::trim)
        .filter(|pair| {
            !pair.is_empty() && !is_reserved_cookie(cookie_name(pair), session_cookie_name)
        })
        .collect();
    (!kept.is_empty()).then(|| kept.join("; "))
}

/// Upstream `Set-Cookie` without its `Domain` attribute; `None` when it would overwrite a
/// BiBCode session or gateway cookie, or when it is nameless. Browsers store a nameless
/// cookie and send its bare value, so `=bibcode_session=x` would arrive as a reserved cookie.
pub fn filter_set_cookie(value: &str, session_cookie_name: &str) -> Option<String> {
    let mut parts = value.split(';').map(str::trim);
    let first = parts.next()?;
    let name = cookie_name(first);
    if !first.contains('=') || name.is_empty() || is_reserved_cookie(name, session_cookie_name) {
        return None;
    }
    let kept: Vec<&str> = std::iter::once(first)
        .chain(parts.filter(|attribute| !cookie_name(attribute).eq_ignore_ascii_case("domain")))
        .collect();
    Some(kept.join("; "))
}

/// Points an upstream redirect at the client-facing gateway origin when it targets the
/// upstream's own loopback port; every other `Location` is returned unchanged.
pub fn rewrite_location(location: &str, upstream_port: u16, client_origin: &str) -> String {
    // Browsers treat `\` like `/` in special-scheme URLs, so `\\host`, `/\host` and `\/host`
    // are all protocol-relative.
    let mut leading = location.chars();
    let protocol_relative = matches!(
        (leading.next(), leading.next()),
        (Some('/' | '\\'), Some('/' | '\\'))
    );
    let absolute = if protocol_relative {
        format!("http://{}", &location[2..])
    } else {
        location.to_owned()
    };
    let Ok(url) = Url::parse(&absolute) else {
        return location.to_owned();
    };
    let is_upstream_loopback = url.scheme() == "http"
        && url.port_or_known_default() == Some(upstream_port)
        && match url.host() {
            Some(Host::Domain(domain)) => domain == "localhost",
            Some(Host::Ipv4(ip)) => ip.octets() == [127, 0, 0, 1],
            Some(Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        };
    if is_upstream_loopback {
        format!("{client_origin}{}", &url[Position::BeforePath..])
    } else {
        location.to_owned()
    }
}

pub fn client_origin(scheme: &str, host_header: &str) -> String {
    format!("{scheme}://{host_header}")
}

/// Gateway origin rule: unsafe or upgrade requests must carry exactly the origin the
/// client used to reach the gateway.
pub fn gateway_origin_allowed(origin: Option<&str>, client_origin: &str) -> bool {
    origin == Some(client_origin)
}

/// `to` when it is a same-origin absolute path: no scheme, no host, no `//`, no backslash,
/// and no control characters that browsers strip or reinterpret inside URLs.
pub fn bootstrap_target(to: &str) -> Option<String> {
    let is_path = to.starts_with('/')
        && !to.starts_with("//")
        && !to.contains('\\')
        && !to.chars().any(char::is_control);
    is_path.then(|| to.to_owned())
}

/// Page that replaces the bootstrap URL, and its capability, with `to`. An invalid `to`
/// falls back to `/` so the page can never navigate off the gateway origin.
pub fn bootstrap_page(to: &str) -> String {
    let target = bootstrap_target(to).unwrap_or_else(|| "/".to_owned());
    let literal = serde_json::to_string(&target)
        .expect("a string always serializes")
        .replace('<', "\\u003c");
    format!(
        "<!doctype html><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\">\
<title>Opening preview</title><script>location.replace({literal})</script>"
    )
}

fn escape_html(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            other => escaped.push(other),
        }
    }
    escaped
}

/// Minimal self-contained page for gateway-generated 401/403/502/503 responses.
pub fn status_page(title: &str, body: &str) -> String {
    let (title, body) = (escape_html(title), escape_html(body));
    format!(
        "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">\
<meta name=\"color-scheme\" content=\"light dark\"><title>{title}</title>\
<body style=\"font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem\">\
<h1 style=\"font-size:1.25rem\">{title}</h1><p>{body}</p>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_keeps_query_and_fragment() {
        assert_eq!(
            bootstrap_target("/?key=ab12#x").as_deref(),
            Some("/?key=ab12#x")
        );
        for bad in [
            "https://evil.test/",
            "//evil.test/",
            "/\\evil.test",
            "/\t/evil.test",
            "/a\r\nb",
            "javascript:alert(1)",
            "",
        ] {
            assert_eq!(bootstrap_target(bad), None, "{bad:?}");
        }
        let page = bootstrap_page("/a?b=\"</script>");
        assert!(page.contains("location.replace("));
        assert!(!page.contains("</script>\""));
        assert_eq!(page.matches("</script>").count(), 1);
    }

    #[test]
    fn bootstrap_page_never_navigates_off_path() {
        let page = bootstrap_page("//evil.test/");
        assert!(page.contains("location.replace(\"/\")"));
    }

    #[test]
    fn cookies_are_stripped_and_filtered() {
        assert_eq!(
            strip_request_cookies(
                "bibcode_session=x; app=1; bibcode-gw-40001=y",
                "bibcode_session"
            )
            .as_deref(),
            Some("app=1")
        );
        assert_eq!(
            strip_request_cookies("bibcode-gw-1=a", "bibcode_session"),
            None
        );
        assert_eq!(
            filter_set_cookie("sid=1; Domain=evil.test; Path=/", "bibcode_session").as_deref(),
            Some("sid=1; Path=/")
        );
        assert_eq!(
            filter_set_cookie("bibcode_session=evil; Path=/", "bibcode_session"),
            None
        );
        assert_eq!(
            filter_set_cookie("bibcode-gw-40001=evil", "bibcode_session"),
            None
        );
        assert_eq!(
            gateway_session_from_cookie("a=1; bibcode-gw-40001=sess; bibcode-gw-40002=o", 40001)
                .as_deref(),
            Some("sess")
        );
        assert_eq!(gateway_cookie_name(40001), "bibcode-gw-40001");
    }

    #[test]
    fn nameless_set_cookies_are_dropped() {
        for nameless in [
            "=bibcode_session=evil",
            "=bibcode-gw-40001=x",
            "=x",
            "x",
            "; Path=/",
            "",
        ] {
            assert_eq!(
                filter_set_cookie(nameless, "bibcode_session"),
                None,
                "{nameless:?}"
            );
        }
    }

    #[test]
    fn instance_scoped_session_cookies_are_reserved() {
        assert_eq!(
            filter_set_cookie("bibcode_session_3773=evil; Path=/", "bibcode_session_4000"),
            None
        );
        assert_eq!(
            strip_request_cookies(
                "bibcode_session_3773=a; app=1; bibcode_session_4000=b",
                "bibcode_session_4000"
            )
            .as_deref(),
            Some("app=1")
        );
    }

    #[test]
    fn location_rewrites_only_the_upstream_loopback() {
        let origin = "http://127.0.0.1:41000";
        assert_eq!(
            rewrite_location("http://localhost:5173/a?b", 5173, origin),
            "http://127.0.0.1:41000/a?b"
        );
        assert_eq!(
            rewrite_location("http://127.0.0.1:5173/", 5173, origin),
            "http://127.0.0.1:41000/"
        );
        assert_eq!(
            rewrite_location("http://[::1]:5173/x", 5173, origin),
            "http://127.0.0.1:41000/x"
        );
        assert_eq!(
            rewrite_location("//localhost:5173/x#f", 5173, origin),
            "http://127.0.0.1:41000/x#f"
        );
        for backslash_form in [
            "\\\\localhost:5173/x#f",
            "/\\localhost:5173/x#f",
            "\\/localhost:5173/x#f",
        ] {
            assert_eq!(
                rewrite_location(backslash_form, 5173, origin),
                "http://127.0.0.1:41000/x#f",
                "{backslash_form}"
            );
        }
        assert_eq!(
            rewrite_location("\\\\localhost:9999/x", 5173, origin),
            "\\\\localhost:9999/x"
        );
        assert_eq!(rewrite_location("/relative", 5173, origin), "/relative");
        assert_eq!(
            rewrite_location("http://localhost:9999/", 5173, origin),
            "http://localhost:9999/"
        );
        assert_eq!(
            rewrite_location("http://example.test:5173/", 5173, origin),
            "http://example.test:5173/"
        );
    }

    #[test]
    fn gateway_origin_check_requires_exact_client_origin() {
        assert!(gateway_origin_allowed(
            Some("http://127.0.0.1:41000"),
            "http://127.0.0.1:41000"
        ));
        assert!(!gateway_origin_allowed(
            Some("http://127.0.0.1:41001"),
            "http://127.0.0.1:41000"
        ));
        assert!(!gateway_origin_allowed(None, "http://127.0.0.1:41000"));
        assert_eq!(client_origin("http", "h:41000"), "http://h:41000");
    }

    #[test]
    fn status_page_escapes_text() {
        let page = status_page("<b>t</b>", "a & \"<i>\"");
        assert!(!page.contains("<b>") && !page.contains("<i>"));
        assert!(
            page.contains("&lt;b&gt;t&lt;/b&gt;") && page.contains("a &amp; &quot;&lt;i&gt;&quot;")
        );
    }
}
