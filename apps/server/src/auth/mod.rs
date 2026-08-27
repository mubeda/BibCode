mod dpop;
mod host_identity;
mod http;
mod model;
mod rpc;
mod scope;
mod secret_store;
mod service;
mod token;

pub(crate) use host_identity::HostIdentity;
#[expect(
    unused_imports,
    reason = "these host identity exports are consumed by later Phase 3 tasks"
)]
pub(crate) use host_identity::{HOST_IDENTITY_SECRET_NAME, HostIdentityError, NOISE_NK_PARAMS};
pub(crate) use http::{
    add_routes, auth_error_response, authenticate_websocket, authorize_http_request,
};
#[cfg(test)]
pub(crate) use model::ClientMetadata;
pub(crate) use model::Principal;
pub(crate) use rpc::register_rpc_handlers;
pub(crate) use scope::{ACTIVITY_READ_SCOPE, authorization_error, required_scope};
pub(crate) use secret_store::SecretStore;
pub(crate) use service::{
    AuthError, AuthService, SessionTransport, issue_administrative_pairing_link,
};
