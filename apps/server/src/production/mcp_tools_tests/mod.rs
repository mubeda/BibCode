//! The outside-agent MCP thread tools (#139) end to end: the real tool registration, the real
//! orchestration RPC registry and engine on SQLite, and the real auth service. Only the
//! provider is faked: its events are dispatched to the engine as a provider runtime would.
//! Each tool family has its own file; this one holds the shared harness.

mod attribution;
mod diagnostics;
mod foundation;
mod git;
mod previews;
mod pull_requests;
mod terminals;
mod thread_actions;
mod threads;
mod worktrees;

use std::{sync::Arc, time::Duration};

use serde_json::{Map, Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::{
    provider_runtime::{
        BoxRuntimeFuture, ProviderDriver, ProviderDriverFactory, ProviderLaunchRequest,
        ProviderRuntimeError, ProviderRuntimeSupervisor, SupervisorOptions,
    },
    turn_delivery::{DeliveryRouter, TurnDeliveryService},
};
use crate::{
    ServerConfig,
    activity::{ActivityProjection, ActivityRepository},
    auth::{AuthService, ClientMetadata, SecretStore, SessionTransport, issue_mcp_pairing_link},
    mcp::control::{ClientPrincipal, McpAccess, McpControl, McpServerSettings},
    orchestration::{OrchestrationEngine, engine::EngineOptions},
    persistence::{Database, Repositories, run_migrations},
    rpc::RpcRegistry,
};

const CREATED_AT: &str = "2026-10-30T00:00:00.000Z";

struct NeverFactory;

impl ProviderDriverFactory for NeverFactory {
    fn create(
        &self,
        request: ProviderLaunchRequest,
    ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>> {
        Box::pin(async move {
            Err(ProviderRuntimeError::UnsupportedProvider {
                provider: request.provider,
            })
        })
    }
}

pub(crate) struct Harness {
    pub(crate) engine: OrchestrationEngine,
    pub(crate) control: McpControl,
    pub(crate) auth: AuthService,
    pub(crate) repositories: Repositories,
    pub(crate) settings: watch::Sender<McpServerSettings>,
    delivery: Arc<TurnDeliveryService>,
    provider: Arc<ProviderRuntimeSupervisor>,
    _state: tempfile::TempDir,
    _secrets: tempfile::TempDir,
}

impl Harness {
    pub(crate) async fn new() -> Self {
        Self::with_methods(|_| {}).await
    }

    /// A harness whose registry also holds the methods `register` adds: fake git and pull
    /// request handlers under their real tags, so scope and admission run as for the real ones.
    pub(crate) async fn with_methods(register: impl FnOnce(&mut RpcRegistry)) -> Self {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let engine = OrchestrationEngine::start(database.clone(), EngineOptions::default())
            .await
            .expect("engine starts");
        let state = tempfile::tempdir().expect("state");
        engine
            .dispatch(command(json!({
                "type": "project.create",
                "commandId": "project-create",
                "projectId": "p1",
                "title": "Project",
                "workspaceRoot": state.path(),
                "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("project created");
        let provider = Arc::new(ProviderRuntimeSupervisor::start(
            engine.clone(),
            Arc::new(NeverFactory),
            ActivityProjection::new(ActivityRepository::new(database.clone())),
            SupervisorOptions::default(),
        ));
        let router: DeliveryRouter = Arc::new(|_| Box::pin(async { Ok(()) }));
        let delivery = Arc::new(TurnDeliveryService::start_with_router(
            engine.clone(),
            1,
            router,
        ));
        let mut registry = RpcRegistry::empty();
        // One upload registry serves `uploads.*` and turn admission, as in production.
        let uploads = crate::transfer::staging::UploadRegistry::new(
            state.path().join("uploads"),
            crate::transfer::staging::UploadLimits::default(),
            Arc::new(tokio::time::Instant::now),
        );
        super::orchestration_rpc::register_orchestration_rpc_with_delivery(
            &mut registry,
            engine.clone(),
            provider.clone(),
            state.path().to_path_buf(),
            delivery.clone(),
            uploads.clone(),
        );
        super::uploads_rpc::register_uploads_rpc(
            &mut registry,
            uploads,
            state.path().join("pastes"),
        );
        register(&mut registry);
        let repositories = Repositories::new(database);
        let secrets = tempfile::tempdir().expect("secrets");
        let auth = AuthService::new_with_persistence(
            &ServerConfig::new(".").with_bind("127.0.0.1", 3773),
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("secret store"),
            repositories.clone(),
        )
        .await
        .expect("auth");
        let (settings, receiver) = watch::channel(McpServerSettings {
            enabled: true,
            access: McpAccess::FullAccess,
            ..McpServerSettings::default()
        });
        let control = McpControl::new(registry, auth.clone(), engine.clone(), receiver);
        Self {
            engine,
            control,
            auth,
            repositories,
            settings,
            delivery,
            provider,
            _state: state,
            _secrets: secrets,
        }
    }

    /// An outside agent's credential with ceiling `access`, minted and exchanged as the relay
    /// does.
    pub(crate) async fn agent(&self, access: McpAccess) -> (ClientPrincipal, String) {
        self.agent_labelled("MCP · test", access).await
    }

    /// [`Self::agent`] with the credential's label `label`.
    async fn agent_labelled(&self, label: &str, access: McpAccess) -> (ClientPrincipal, String) {
        let link = issue_mcp_pairing_link(&self.repositories, label.into(), access.as_str(), &[])
            .await
            .expect("link");
        let session = self
            .auth
            .exchange_bootstrap(
                &link.credential,
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("exchange");
        let principal = self
            .control
            .authenticate(&session.token)
            .await
            .expect("an MCP credential");
        (principal, session.token)
    }

    pub(crate) async fn call(
        &self,
        agent: &ClientPrincipal,
        tool: &str,
        arguments: Value,
    ) -> Value {
        let Value::Object(arguments) = arguments else {
            panic!("arguments are an object");
        };
        self.control
            .call(agent, tool, &arguments, None, CancellationToken::new())
            .await
    }

    /// What the provider runtime would dispatch for one turn: it starts, streams a reply, and
    /// settles.
    pub(crate) async fn provider_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        reply: &str,
        settle: bool,
    ) {
        let session = |status: &str, active: Option<&str>| {
            json!({
                "type": "thread.session.set",
                "commandId": format!("session-{turn_id}-{status}"),
                "threadId": thread_id,
                "session": {
                    "threadId": thread_id, "status": status, "providerName": "codex",
                    "providerInstanceId": "codex", "runtimeMode": "full-access",
                    "activeTurnId": active, "lastError": null, "updatedAt": CREATED_AT,
                },
                "createdAt": CREATED_AT,
            })
        };
        let mut commands = vec![
            session("running", Some(turn_id)),
            json!({
                "type": "thread.message.assistant.delta", "commandId": format!("delta-{turn_id}"),
                "threadId": thread_id, "messageId": format!("reply-{turn_id}"), "delta": reply,
                "turnId": turn_id, "createdAt": CREATED_AT,
            }),
        ];
        if settle {
            commands.push(json!({
                "type": "thread.message.assistant.complete", "commandId": format!("complete-{turn_id}"),
                "threadId": thread_id, "messageId": format!("reply-{turn_id}"),
                "turnId": turn_id, "createdAt": CREATED_AT,
            }));
            commands.push(session("ready", None));
        }
        for value in commands {
            self.engine
                .dispatch(command(value))
                .await
                .expect("provider event");
        }
    }

    pub(crate) async fn shutdown(self) {
        self.delivery.shutdown().await;
        self.provider.shutdown().await.expect("provider shutdown");
        self.engine.shutdown().await;
    }
}

pub(super) fn command(value: Value) -> crate::orchestration::engine::OrchestrationCommand {
    serde_json::from_value(value).expect("command decodes")
}

pub(super) fn structured(result: &Value) -> &Value {
    assert_ne!(result["isError"], true, "{result}");
    &result["structuredContent"]
}

pub(super) fn error_tag(result: &Value) -> &str {
    assert_eq!(result["isError"], true, "{result}");
    result["structuredContent"]["error"]["_tag"]
        .as_str()
        .unwrap_or_default()
}

pub(super) async fn start(
    harness: &Harness,
    agent: &ClientPrincipal,
    arguments: Value,
) -> (String, String) {
    let started = harness.call(agent, "start_thread", arguments).await;
    let started = structured(&started);
    (
        started["threadId"].as_str().unwrap().to_owned(),
        started["messageId"].as_str().unwrap().to_owned(),
    )
}

pub(super) fn basic_start() -> Value {
    json!({ "projectId": "p1", "prompt": "Summarize the README", "providerInstanceId": "codex", "model": "gpt-5" })
}
