//! The pages a browser sees during remote MCP sign-in (#139, slice R): the consent page,
//! which tells the person where to approve and refreshes itself, and the error pages.
//!
//! They are server-rendered with no script. Every one sends a CSP without `script-src`,
//! `frame-ancestors 'none'` and `X-Frame-Options: DENY`, so no other page can frame them,
//! and `Referrer-Policy: no-referrer`. The client's name and the redirect host are the
//! client's own text: they are escaped.

use axum::{
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};

const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/// How often the consent page asks whether the request was decided.
const REFRESH_SECONDS: u32 = 2;

/// What the consent page shows while a request waits.
pub(crate) struct Consent<'a> {
    pub(crate) client_name: &'a str,
    pub(crate) environment: &'a str,
    /// `XXXX-XXXX`.
    pub(crate) code: &'a str,
    pub(crate) redirect_host: &'a str,
    /// The page's own poll, relative to this origin.
    pub(crate) status_url: &'a str,
}

/// The consent page. It refreshes to `status_url` until the request is decided.
pub(crate) fn consent(page: &Consent<'_>, set_cookie: Option<String>) -> Response {
    let client = escape(page.client_name);
    let environment = escape(page.environment);
    let code = escape(page.code);
    let host = escape(page.redirect_host);
    let body = format!(
        "<p class=\"lead\"><strong>{client}</strong> wants to operate <strong>{environment}</strong> in BiBCode.</p>\
         <p>Approve it in BiBCode (Settings → Agents → Agent integrations), or on the server run \
         <code>bibcode mcp authorize {code}</code>.</p>\
         <p class=\"code\" aria-label=\"Code\">Code: <span>{code}</span></p>\
         <p class=\"muted\">Check that BiBCode shows the same code. It will return to {host}. \
         This page updates by itself.</p>"
    );
    let mut response = page_response(
        StatusCode::OK,
        "Approve in BiBCode",
        &body,
        Some(page.status_url),
    );
    if let Some(cookie) = set_cookie.and_then(|cookie| HeaderValue::from_str(&cookie).ok()) {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    response
}

/// A page that says what went wrong and what to do; it never redirects.
pub(crate) fn message(status: StatusCode, title: &str, text: &str) -> Response {
    let body = format!("<p class=\"lead\">{}</p>", escape(text));
    page_response(status, title, &body, None)
}

fn page_response(
    status: StatusCode,
    title: &str,
    body: &str,
    refresh_to: Option<&str>,
) -> Response {
    let refresh = refresh_to.map_or_else(String::new, |url| {
        format!(
            "<meta http-equiv=\"refresh\" content=\"{REFRESH_SECONDS};url={}\">",
            escape(url)
        )
    });
    let title = escape(title);
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <meta name=\"color-scheme\" content=\"light dark\">{refresh}<title>{title} · BiBCode</title>\
         <style>{STYLE}</style></head><body><main><h1>{title}</h1>{body}</main></body></html>"
    );
    let mut response = (status, html).into_response();
    let headers = response.headers_mut();
    for (name, value) in [
        (header::CONTENT_TYPE, "text/html; charset=utf-8"),
        (header::CACHE_CONTROL, "no-store"),
        (header::CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    response
}

const STYLE: &str = ":root{--bg:#fafafa;--fg:#18181b;--muted:#71717a;--card:#fff;--line:#e4e4e7}\
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--card:#18181b;--line:#27272a}}\
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);\
font:14px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;padding:16px}\
main{max-width:30rem;width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}\
h1{font-size:16px;font-weight:600;margin:0 0 12px}p{margin:0 0 10px}.lead{font-size:15px}\
.muted{color:var(--muted);font-size:13px;margin:0}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;\
overflow-wrap:anywhere}.code{font-size:13px;color:var(--muted)}\
.code span{display:inline-block;margin-left:6px;font:600 20px ui-monospace,SFMono-Regular,Menlo,monospace;\
letter-spacing:.08em;color:var(--fg)}";

/// HTML-escapes text for an element or a double-quoted attribute.
pub(crate) fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            character => escaped.push(character),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn text(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn the_consent_page_cannot_be_framed_runs_no_script_and_escapes_the_client() {
        let response = consent(
            &Consent {
                client_name: "<script>alert(1)</script>",
                environment: "Office \"main\"",
                code: "ABCD-2345",
                redirect_host: "localhost:53682",
                status_url: "/oauth/authorize/status?id=a&b",
            },
            Some("c=1; Path=/oauth/authorize; HttpOnly; SameSite=Strict".to_owned()),
        );
        let headers = response.headers().clone();
        assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY");
        let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(csp.contains("frame-ancestors 'none'"));
        assert!(!csp.contains("script-src"));
        assert!(csp.contains("default-src 'none'"));
        assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
        assert!(
            headers[header::SET_COOKIE]
                .to_str()
                .unwrap()
                .contains("HttpOnly")
        );
        let body = text(response).await;
        assert!(!body.contains("<script>"));
        assert!(body.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(body.contains("bibcode mcp authorize ABCD-2345"));
        assert!(body.contains("url=/oauth/authorize/status?id=a&amp;b"));
        assert!(body.contains("It will return to localhost:53682"));
    }
}
