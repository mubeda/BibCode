//! Antigravity chat over `agy acp`: ACP v1 on stdio, through the transport Cursor and Grok share.

pub use crate::provider::cursor::acp;

pub mod runtime;

#[cfg_attr(test, allow(unused_imports))]
pub use acp::{AcpConnectionConfig, AcpJsonRpcConnection, IncomingEvent};
#[cfg_attr(test, allow(unused_imports))]
pub use runtime::{
    AntigravityPromptReceipt, AntigravityRuntimeError, AntigravityRuntimeEvent,
    AntigravitySessionOptions, AntigravitySessionRuntime, DEFAULT_CANCEL_GRACE,
    DEFAULT_CONTROL_TIMEOUT, DEFAULT_START_TIMEOUT,
};
