mod message;
mod methods;
mod session;

pub use message::{
    CauseItem, ClientMessage, InvalidRequestId, RequestId, RpcExit, RpcRequest, ServerMessage,
    WireMessage,
};
pub use methods::{ACTIVE_RPC_METHODS, MethodMode, RpcMethodSpec};
pub use session::{RpcRegistry, RpcResult, RpcStreamChunk};

pub(crate) use methods::{MethodMutability, method_mutability};
#[expect(
    unused_imports,
    reason = "the channel-backed E2EE route is added in Phase 3 Task 5"
)]
pub(crate) use session::run_session_split;
pub(crate) use session::{RpcResponseEnqueueGuard, RpcSessionContext, RpcUnaryResult, run_session};
