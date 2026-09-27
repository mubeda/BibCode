//! Reads a test client's next frame past the server's WebSocket heartbeat.
//!
//! Once a socket is authenticated the server sends a WebSocket Ping every 15 s
//! (see `docs/architecture/rpc-and-orchestration.md`). A test session that
//! lasts longer than that, which is routine under host load, can therefore
//! read a Ping where it expects an RPC frame.
//!
//! Integration binaries include this file with `#[path]`; the library's unit
//! tests include it through `src/test_support`, where its own test runs once.

use futures_util::StreamExt;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{Error, Message},
};

/// Returns what `socket.next()` would return, skipping WebSocket Ping and
/// Pong frames.
///
/// Text, Binary and Close frames, errors and the end of the stream pass
/// through unchanged, so each caller keeps its own assertions. The caller's
/// `timeout` wraps the whole call, so a skipped frame does not extend its
/// deadline, and a "no reply within N ms" check still times out when only a
/// Ping arrives.
///
/// Skipping is enough to answer the Ping: tungstenite queues the Pong reply
/// when it reads the Ping and sends it on the next read (the next poll of this
/// stream) or on the next write or flush. A hand-written Pong would replace the
/// queued one. Verified against tungstenite 0.30.
pub async fn next_frame_past_heartbeat<S>(
    socket: &mut WebSocketStream<S>,
) -> Option<Result<Message, Error>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        match socket.next().await {
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            other => return other,
        }
    }
}
