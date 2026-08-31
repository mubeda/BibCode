//! Registers the Git Manager RPC contract surface.

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::rpc::{RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk};

pub const GIT_MANAGER_UNARY_METHODS: &[&str] = &[
    "gitManager.commit",
    "gitManager.discard",
    "gitManager.discardPartial",
    "gitManager.getCommits",
    "gitManager.getDiff",
    "gitManager.getRefs",
    "gitManager.getStashes",
    "gitManager.listPullRequests",
    "gitManager.previewMerge",
    "gitManager.stagePartial",
    "gitManager.undoCommit",
    "gitManager.unstagePartial",
];

pub const GIT_MANAGER_STREAM_METHODS: &[&str] =
    &["gitManager.runOperation", "subscribeGitManagerSignal"];

#[derive(Clone, Copy, Debug, Default)]
pub struct GitManagerRpcServices;

impl GitManagerRpcServices {
    async fn not_implemented_unary(self, request: RpcRequest) -> RpcResult {
        Err(not_implemented_error(&request.tag))
    }

    fn not_implemented_stream(self, request: RpcRequest) -> mpsc::Receiver<RpcStreamChunk> {
        let (sender, receiver) = mpsc::channel(1);
        sender
            .try_send(Err(not_implemented_error(&request.tag)))
            .expect("new Git Manager stub stream accepts its terminal failure");
        receiver
    }
}

pub fn register_git_manager_rpc(registry: &mut RpcRegistry, services: GitManagerRpcServices) {
    for method in GIT_MANAGER_UNARY_METHODS {
        registry.register_unary(*method, move |request, _cancellation| {
            services.not_implemented_unary(request)
        });
    }

    for method in GIT_MANAGER_STREAM_METHODS {
        registry.register_stream(*method, move |request, _cancellation| {
            services.not_implemented_stream(request)
        });
    }
}

fn not_implemented_error(operation: &str) -> Value {
    json!({
        "_tag": "GitManagerOperationError",
        "operation": operation,
        "code": "not-implemented",
        "message": "This Git Manager operation is not implemented yet.",
        "blocked": null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{ACTIVE_RPC_METHODS, MethodMode};

    fn registry_with_non_git_manager_methods() -> RpcRegistry {
        let mut registry = RpcRegistry::empty();
        for method in ACTIVE_RPC_METHODS
            .iter()
            .filter(|method| !method.name.starts_with("gitManager."))
            .filter(|method| method.name != "subscribeGitManagerSignal")
        {
            match method.mode {
                MethodMode::Unary => registry
                    .register_unary(method.name, |_request, _cancellation| async {
                        Ok(json!({}))
                    }),
                MethodMode::Stream => {
                    registry.register_stream(method.name, |_request, _cancellation| {
                        let (_sender, receiver) = mpsc::channel(1);
                        receiver
                    });
                }
            }
        }
        registry
    }

    #[test]
    fn registers_every_git_manager_method_needed_by_production_startup() {
        let mut registry = registry_with_non_git_manager_methods();
        register_git_manager_rpc(&mut registry, GitManagerRpcServices);
        registry
            .validate_complete()
            .expect("the production Git Manager registry is complete");
    }

    #[test]
    fn registry_validation_fails_when_git_manager_registration_is_omitted() {
        let registry = registry_with_non_git_manager_methods();
        let error = registry
            .validate_complete()
            .expect_err("Git Manager methods are required at startup");
        assert!(error.contains("gitManager.commit"));
        assert!(error.contains("subscribeGitManagerSignal"));
    }
}
