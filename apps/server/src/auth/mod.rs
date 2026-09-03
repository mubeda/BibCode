mod dpop;
mod host_identity;
mod http;
pub(crate) mod limits;
mod model;
pub mod pairing_code;
mod pairing_offer;
mod rpc;
mod scope;
mod secret_store;
mod service;
mod token;

pub(crate) use host_identity::{
    HOST_IDENTITY_SECRET_NAME, HostIdentity, HostIdentityError, NOISE_NK_PARAMS,
};
pub(crate) use http::{
    add_routes, auth_error_response, authenticate_websocket, authorize_http_request,
};
pub(crate) use model::ClientMetadata;
pub(crate) use model::Principal;
#[cfg(test)]
pub(crate) use model::STANDARD_SCOPES;
pub(crate) use pairing_offer::{mint_offline_pairing_offer, validate_pairing_offer_input};
pub(crate) use rpc::register_rpc_handlers;
pub(crate) use scope::{ACTIVITY_READ_SCOPE, authorization_error, required_scope};
pub(crate) use secret_store::{SecretStore, SecretStoreError};
pub(crate) use service::{
    AuthError, AuthService, AuthenticatedConnectionGuard, SessionTransport,
    default_standard_scopes, issue_administrative_pairing_link, issue_offline_share_pairing,
};
