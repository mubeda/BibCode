mod e2ee;
mod message;
mod methods;
mod session;

pub use message::{
    CauseItem, ClientMessage, InvalidRequestId, RequestId, RpcExit, RpcRequest, ServerMessage,
    WireMessage,
};
pub use methods::{ACTIVE_RPC_METHODS, MethodMode, RpcMethodSpec};
pub use session::{RpcRegistry, RpcResult, RpcStreamChunk};

#[expect(
    unused_imports,
    reason = "the /ws-e2ee route is added in Phase 3 Task 5"
)]
pub(crate) use e2ee::{
    E2EE_HANDSHAKE_TIMEOUT, E2EE_HOST_IDENTITY_CLOSE_CODE, E2EE_MAX_PREAUTH_CONNECTIONS,
    E2eeAuthMessage, E2eeChannel, E2eeSessionError, MAX_E2EE_CIPHERTEXT_BYTES,
    MAX_E2EE_LOGICAL_MESSAGE_BYTES, MAX_E2EE_PREAUTH_MESSAGE_BYTES, e2ee_authenticated_json,
    e2ee_authenticated_with_credential_json, e2ee_error_json,
};
pub(crate) use methods::{MethodMutability, method_mutability};
#[expect(
    unused_imports,
    reason = "the channel-backed E2EE route is added in Phase 3 Task 5"
)]
pub(crate) use session::run_session_split;
pub(crate) use session::{RpcResponseEnqueueGuard, RpcSessionContext, RpcUnaryResult, run_session};
