//! WebSocket half of the preview gateway proxy: answers the client's upgrade once the
//! upstream accepted it, then tunnels bytes both ways until either side closes, the
//! listener shuts down, or the principal stops being active.

use std::sync::Arc;

use hyper::{
    Response, StatusCode,
    body::Incoming,
    header::{CONNECTION, HeaderMap, HeaderValue, UPGRADE},
    upgrade::OnUpgrade,
};
use hyper_util::rt::TokioIo;

use super::{COPY_BUFFER_BYTES, Lease, Listener, ProxyBody, empty, rewrite_response_headers};

pub(super) fn is_websocket(headers: &HeaderMap) -> bool {
    headers
        .get_all(UPGRADE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|token| token.trim().eq_ignore_ascii_case("websocket"))
}

/// Spawns the tunnel for an upstream `101` and returns the matching `101` for the client.
/// The tunnel owns `lease`, so its permits live as long as the WebSocket.
pub(super) fn switch_protocols(
    state: Arc<Listener>,
    principal: String,
    lease: Arc<Lease>,
    downstream: OnUpgrade,
    mut response: Response<Incoming>,
    client_origin: &str,
) -> Response<ProxyBody> {
    let upstream = hyper::upgrade::on(&mut response);
    let mut headers = std::mem::take(response.headers_mut());
    rewrite_response_headers(&mut headers, &state, client_origin);
    headers.insert(CONNECTION, HeaderValue::from_static("upgrade"));
    headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
    tokio::spawn(tunnel(state, principal, lease, downstream, upstream));
    let mut switching = Response::new(empty());
    *switching.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    *switching.headers_mut() = headers;
    switching
}

async fn tunnel(
    state: Arc<Listener>,
    principal: String,
    lease: Arc<Lease>,
    downstream: OnUpgrade,
    upstream: OnUpgrade,
) {
    let _lease = lease;
    let copy = async {
        let (Ok(downstream), Ok(upstream)) = (downstream.await, upstream.await) else {
            return;
        };
        let (mut downstream, mut upstream) = (TokioIo::new(downstream), TokioIo::new(upstream));
        let _ = tokio::io::copy_bidirectional_with_sizes(
            &mut downstream,
            &mut upstream,
            COPY_BUFFER_BYTES,
            COPY_BUFFER_BYTES,
        )
        .await;
    };
    tokio::select! {
        () = copy => {}
        () = state.until_revoked(&principal) => {}
    }
}
