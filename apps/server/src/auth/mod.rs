mod dpop;
mod http;
mod model;
mod rpc;
mod scope;
mod secret_store;
mod service;
mod token;

pub(crate) use http::{
    add_routes, auth_error_response, authenticate_websocket, authorize_http_request,
};
#[cfg(test)]
pub(crate) use model::ClientMetadata;
pub(crate) use model::Principal;
pub(crate) use rpc::register_rpc_handlers;
pub(crate) use scope::{ACTIVITY_READ_SCOPE, authorization_error, required_scope};
pub(crate) use secret_store::SecretStore;
pub(crate) use service::{AuthError, AuthService, build_pairing_url};
