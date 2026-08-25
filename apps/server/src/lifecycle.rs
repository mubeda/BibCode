use std::{net::SocketAddr, sync::Arc};

use thiserror::Error;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::{
    auth::{AuthService, SecretStore, build_pairing_url},
    config::{ServerConfig, ServerMode},
    data_root::{DataRootError, ResolvedDataRoot, resolve_data_root},
    diagnostics::{
        DesktopUiProcessObserver, NotApplicableUiProcessObserver,
        UnavailableDesktopUiProcessObserver,
    },
    http, local_control, logging,
    maintenance::{UpdateMaintenance, maintenance_routes_enabled, reconcile_update_status},
    persistence::{Database, Repositories, StatePaths, StoreRuntimeGuard, prepare_store},
    production::http_routes::{HttpRouteError, HttpRoutesState},
    production::runtime::ProductionRuntime,
    production::{
        connect_mcp::{
            ConnectMcpConfig, ConnectMcpService, PairingCredential, PairingIssuer, PreviewInvoker,
        },
        jwt::PersistentJwtCodec,
        server_terminal::ProcessTreeCleanup,
    },
    rpc::RpcRegistry,
    transport::{self, TransportError},
};

const SIGNING_KEY_NAME: &str = "server-signing-key";
const SIGNING_KEY_BYTES: usize = 32;
const ASSET_KEY_NAME: &str = "asset-access-key";
const ASSET_KEY_BYTES: usize = 32;

pub struct ServerRuntime;

pub struct ServerHandle {
    local_addr: SocketAddr,
    advertised_base_url: String,
    data_root: ResolvedDataRoot,
    startup_access: Option<StartupAccess>,
    database: Option<Database>,
    _store_runtime_guard: StoreRuntimeGuard,
    _production_runtime: Option<Arc<ProductionRuntime>>,
    _log_sink: Arc<logging::LogSinkLease>,
    local_control: Option<local_control::LocalControlHandle>,
    shutdown: CancellationToken,
    task: Option<JoinHandle<Result<(), std::io::Error>>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartupAccess {
    pub connection_string: String,
    pub credential: String,
    pub pairing_url: String,
}

#[derive(Debug, Error)]
pub enum ServerError {
    #[error(transparent)]
    DataRoot(#[from] DataRootError),
    #[error("failed to create the server base directory")]
    CreateBaseDirectory(#[source] std::io::Error),
    #[error("failed to initialize native server state files: {0}")]
    StateFiles(String),
    #[error("failed to initialize native server logging: {0}")]
    Logging(String),
    #[error("failed to initialize the protected local control channel: {0}")]
    LocalControlInitialize(String),
    #[error("the protected local control channel failed: {0}")]
    LocalControlServe(String),
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error("failed to initialize environment authentication: {0}")]
    AuthInitialize(String),
    #[error("failed to initialize SQLite persistence: {0}")]
    PersistenceInitialize(String),
    #[error("failed to initialize the native production runtime: {0}")]
    ProductionInitialize(String),
    #[error("the server task failed")]
    Serve(#[source] std::io::Error),
    #[error("the server task was cancelled unexpectedly")]
    Join(#[source] tokio::task::JoinError),
    #[error("the server task was already joined")]
    AlreadyJoined,
}

impl ServerRuntime {
    pub async fn start(config: ServerConfig) -> Result<ServerHandle, ServerError> {
        let ui_process_observer = default_ui_process_observer(config.mode);
        Self::start_internal(
            config,
            None,
            ui_process_observer,
            ProcessTreeCleanup::EmbeddedHost,
        )
        .await
    }

    pub(crate) async fn start_standalone(
        config: ServerConfig,
    ) -> Result<ServerHandle, ServerError> {
        let ui_process_observer = default_ui_process_observer(config.mode);
        Self::start_internal(
            config,
            None,
            ui_process_observer,
            ProcessTreeCleanup::StandaloneServer,
        )
        .await
    }

    pub async fn start_with_ui_process_observer(
        config: ServerConfig,
        ui_process_observer: Arc<dyn DesktopUiProcessObserver>,
    ) -> Result<ServerHandle, ServerError> {
        Self::start_internal(
            config,
            None,
            ui_process_observer,
            ProcessTreeCleanup::EmbeddedHost,
        )
        .await
    }

    pub async fn start_with_registry(
        config: ServerConfig,
        rpc_registry: RpcRegistry,
    ) -> Result<ServerHandle, ServerError> {
        let ui_process_observer = default_ui_process_observer(config.mode);
        Self::start_internal(
            config,
            Some(rpc_registry),
            ui_process_observer,
            ProcessTreeCleanup::EmbeddedHost,
        )
        .await
    }

    async fn start_internal(
        mut config: ServerConfig,
        custom_registry: Option<RpcRegistry>,
        ui_process_observer: Arc<dyn DesktopUiProcessObserver>,
        process_tree_cleanup: ProcessTreeCleanup,
    ) -> Result<ServerHandle, ServerError> {
        let resolved_data_root = resolve_data_root(config.data_root_request.clone())?;
        let shutdown = CancellationToken::new();
        let validated_listener = transport::validate_listener(&config).await?;
        let listener = transport::bind(validated_listener, shutdown.clone()).await?;
        let local_addr = listener
            .local_addr()
            .map_err(|source| TransportError::Bind { source })?;
        let advertised_base_url = listener
            .advertised_base_url()
            .map_err(|source| TransportError::Bind { source })?;
        config.transport_identity = listener.transport_identity();
        config.bound_addr = Some(local_addr);
        config.base_dir = resolved_data_root.effective.clone();
        config.resolved_data_root = Some(resolved_data_root.clone());
        tokio::fs::create_dir_all(&config.base_dir)
            .await
            .map_err(ServerError::CreateBaseDirectory)?;
        let state_paths = StatePaths::from_config(&config);
        state_paths
            .ensure_directories_without_database_side_effects()
            .await
            .map_err(|error| ServerError::StateFiles(error.to_string()))?;
        let log_sink = Arc::new(
            logging::initialize_owned(&state_paths.server_log)
                .map_err(|error| ServerError::Logging(error.to_string()))?,
        );
        let store_runtime_guard = StoreRuntimeGuard::acquire(&config.base_dir)
            .await
            .map_err(|error| ServerError::PersistenceInitialize(error.to_string()))?;
        let prepared_store = prepare_store(&config)
            .await
            .map_err(|error| ServerError::PersistenceInitialize(error.to_string()))?;
        config.storage_instance_id = Some(prepared_store.storage_instance_id);
        let environment_id = prepared_store.environment_id;
        config.environment_id = Some(environment_id);
        let storage_instance_id = prepared_store.storage_instance_id;
        let store_classification = prepared_store.classification;
        let database = prepared_store.database;
        reconcile_update_status(
            &state_paths,
            environment_id,
            storage_instance_id,
            &config.server_version,
        )
        .await
        .map_err(|error| ServerError::PersistenceInitialize(error.to_string()))?;
        let state_directory = config.base_dir.join(if config.dev_url.is_some() {
            "dev"
        } else {
            "userdata"
        });
        let secret_store = SecretStore::new(state_directory.join("secrets"))
            .await
            .map_err(|error| ServerError::AuthInitialize(error.to_string()))?;
        let signing_secret = secret_store
            .get_or_create_random(SIGNING_KEY_NAME, SIGNING_KEY_BYTES)
            .await
            .map_err(|error| ServerError::AuthInitialize(error.to_string()))?;
        let asset_secret = secret_store
            .get_or_create_random(ASSET_KEY_NAME, ASSET_KEY_BYTES)
            .await
            .map_err(|error| ServerError::AuthInitialize(error.to_string()))?;
        let auth = AuthService::new_with_persistence(
            &config,
            signing_secret,
            secret_store,
            Repositories::new(database.clone()),
        )
        .await
        .map_err(|error| ServerError::AuthInitialize(format!("{error:?}")))?;
        let startup_access =
            if config.mode == crate::config::ServerMode::Web && !config.unsafe_no_auth {
                let issued = auth
                    .issue_startup_pairing()
                    .await
                    .map_err(|error| ServerError::AuthInitialize(format!("{error:?}")))?;
                Some(build_startup_access(
                    &advertised_base_url,
                    issued.credential,
                )?)
            } else {
                None
            };
        let (rpc_registry, http_routes, production_runtime) = match custom_registry {
            Some(mut registry) => {
                crate::auth::register_rpc_handlers(&mut registry, auth.clone());
                (registry, fallback_http_routes(auth.clone()), None)
            }
            None => {
                let runtime = Arc::new(
                    ProductionRuntime::start_with_process_tree_cleanup(
                        &config,
                        database.clone(),
                        auth.clone(),
                        asset_secret,
                        ui_process_observer,
                        process_tree_cleanup,
                    )
                    .await
                    .map_err(ServerError::ProductionInitialize)?,
                );
                let jwt = PersistentJwtCodec::open(state_directory.join("environment-jwt.json"))
                    .await
                    .map_err(|error| ServerError::ProductionInitialize(error.to_string()))?;
                let endpoint = runtime.managed_endpoint_runtime();
                let pairing_auth = auth.clone();
                let pairing = PairingIssuer::new(move |thumbprint| {
                    let auth = pairing_auth.clone();
                    async move {
                        auth.issue_cloud_pairing(thumbprint)
                            .await
                            .map(|issued| PairingCredential {
                                credential: issued.credential,
                                expires_at: issued.expires_at,
                            })
                            .map_err(|error| format!("{error:?}"))
                    }
                });
                let automation = runtime.preview_automation.clone();
                let preview = PreviewInvoker::new(
                    move |scope, operation, input, tab_id, cancellation| {
                        let automation = automation.clone();
                        async move {
                            let operation = crate::mcp::preview_automation::PreviewAutomationOperation::from_wire(&operation)
                                .ok_or_else(|| format!("unsupported preview operation: {operation}"))?;
                            automation
                                .invoke(
                                    crate::mcp::preview_automation::PreviewAutomationInvokeInput {
                                        environment_id: scope.environment_id,
                                        thread_id: scope.thread_id,
                                        provider_session_id: scope.provider_session_id,
                                        provider_instance_id: scope.provider_instance_id,
                                        operation,
                                        input,
                                        tab_id,
                                        timeout_ms: None,
                                    },
                                )
                                .await
                                .map_err(|error| format!("{}: {}", error.tag(), error.message()))
                                .and_then(|value| {
                                    if cancellation.is_cancelled() {
                                        Err("preview automation request was cancelled".to_owned())
                                    } else {
                                        Ok(value)
                                    }
                                })
                        }
                    },
                );
                let descriptor = serde_json::json!({
                    "environmentId": config
                        .environment_id
                        .expect("a running server has a prepared environment identity")
                        .to_string(),
                    "label": config.environment_label,
                    "platform": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH },
                    "serverVersion": config.server_version,
                    "storageInstanceId": config
                        .storage_instance_id
                        .expect("a running server has a prepared persistent store")
                        .to_string(),
                    "protocol": {
                        "minimum": crate::http::ENVIRONMENT_PROTOCOL_VERSION,
                        "maximum": crate::http::ENVIRONMENT_PROTOCOL_VERSION,
                    },
                    "capabilities": { "repositoryIdentity": true },
                    "transport": config.transport_identity.clone(),
                });
                let connect = Arc::new(
                    ConnectMcpService::open(
                        config.database_path(),
                        ConnectMcpConfig {
                            environment_id: config
                                .environment_id
                                .expect("a running server has a prepared environment identity")
                                .to_string(),
                            descriptor,
                            mcp_endpoint: format!("{advertised_base_url}/mcp"),
                            now_epoch_seconds: Arc::new(|| {
                                time::OffsetDateTime::now_utc().unix_timestamp()
                            }),
                            max_mcp_credentials: 1_024,
                            max_mcp_sessions: 1_024,
                        },
                        jwt.jwt_codec(),
                        endpoint.endpoint(),
                        pairing,
                        preview,
                    )
                    .await
                    .map_err(|error| ServerError::ProductionInitialize(format!("{error:?}")))?,
                );
                runtime.attach_connect_mcp(connect.clone()).await;
                (
                    runtime.registry.clone(),
                    core_http_routes(auth.clone(), runtime.clone(), connect),
                    Some(runtime),
                )
            }
        };
        let admission_gate = rpc_registry.admission_gate();
        let update_maintenance = production_runtime.as_ref().map(|runtime| {
            UpdateMaintenance::new(
                admission_gate.clone(),
                runtime.clone(),
                database.clone(),
                state_paths.clone(),
                environment_id,
                storage_instance_id,
                store_classification,
                config.server_version.clone(),
                shutdown.clone(),
                config.update_maintenance_drain_timeout,
                config.update_maintenance_lease,
            )
        });
        let http_update_maintenance = maintenance_routes_enabled(&config)
            .then(|| update_maintenance.clone())
            .flatten();
        let local_control = local_control::start(
            &config,
            &state_paths,
            local_control::LocalControlContext {
                environment_id,
                storage_instance_id,
                auth: auth.clone(),
                advertised_base_url: advertised_base_url.clone(),
                update_maintenance: update_maintenance.clone(),
                admission_gate: admission_gate.clone(),
                main_shutdown: shutdown.clone(),
            },
        )
        .await
        .map_err(|error| ServerError::LocalControlInitialize(error.to_string()))?;
        let app = http::build_router(http::AppState {
            config: Arc::new(config),
            shutdown: shutdown.clone(),
            rpc_registry,
            http_routes,
            auth,
            admission_gate,
            update_maintenance: http_update_maintenance,
        });
        let server_shutdown = shutdown.clone();
        let completion_signal = shutdown.clone();
        let cleanup_runtime = production_runtime.clone();
        let task_log_sink = log_sink.clone();
        let task = tokio::spawn(async move {
            let _log_sink = task_log_sink;
            let result = axum::serve(listener, app)
                .with_graceful_shutdown(server_shutdown.cancelled_owned())
                .await;
            if let Some(runtime) = cleanup_runtime {
                runtime.shutdown().await;
            }
            completion_signal.cancel();
            result
        });

        Ok(ServerHandle {
            local_addr,
            advertised_base_url,
            data_root: resolved_data_root,
            startup_access,
            database: Some(database),
            _store_runtime_guard: store_runtime_guard,
            _production_runtime: production_runtime,
            _log_sink: log_sink,
            local_control: Some(local_control),
            shutdown,
            task: Some(task),
        })
    }
}

fn core_http_routes(
    auth: AuthService,
    runtime: Arc<ProductionRuntime>,
    connect: Arc<ConnectMcpService>,
) -> HttpRoutesState {
    let authorize = authorize_handler(auth);
    let json_runtime = runtime.clone();
    let json_connect = connect.clone();
    let json = Arc::new(move |operation, payload, context| {
        let runtime = json_runtime.clone();
        let connect = json_connect.clone();
        Box::pin(async move {
            match operation {
                crate::production::http_routes::JsonOperation::ConnectLinkProof
                | crate::production::http_routes::JsonOperation::ConnectRelayConfig
                | crate::production::http_routes::JsonOperation::ConnectLinkState
                | crate::production::http_routes::JsonOperation::ConnectUnlink
                | crate::production::http_routes::JsonOperation::ConnectHealth
                | crate::production::http_routes::JsonOperation::ConnectMintCredential => {
                    connect.json_http(operation, payload, context).await
                }
                _ => runtime.json(operation, payload, context).await,
            }
        }) as crate::production::http_routes::BoxFuture<_>
    });
    let diagnostic_runtime = runtime.clone();
    let diagnostic_logs = Arc::new(move |frontend_log, _context| {
        let runtime = diagnostic_runtime.clone();
        Box::pin(async move { runtime.diagnostic_logs(frontend_log).await })
            as crate::production::http_routes::BoxFuture<_>
    });
    let asset_runtime = runtime;
    let assets = Arc::new(move |token, path, _context| {
        let runtime = asset_runtime.clone();
        Box::pin(async move { runtime.asset(token, path).await })
            as crate::production::http_routes::BoxFuture<_>
    });
    let mcp = Arc::new(move |method, body, context| {
        let connect = connect.clone();
        Box::pin(async move { connect.mcp_http(method, body, context).await })
            as crate::production::http_routes::BoxFuture<_>
    });
    HttpRoutesState::new(authorize, json, diagnostic_logs, assets, mcp)
}

fn default_ui_process_observer(mode: ServerMode) -> Arc<dyn DesktopUiProcessObserver> {
    match mode {
        ServerMode::Web => Arc::new(NotApplicableUiProcessObserver),
        ServerMode::Desktop => Arc::new(UnavailableDesktopUiProcessObserver),
    }
}

fn authorize_handler(auth: AuthService) -> crate::production::http_routes::AuthorizeHandler {
    Arc::new(move |headers, method, uri, scope, _cancellation| {
        let auth = auth.clone();
        Box::pin(async move {
            crate::auth::authorize_http_request(&auth, &headers, &method, &uri, scope)
                .await
                .map(|_| ())
                .map_err(crate::auth::auth_error_response)
        }) as crate::production::http_routes::BoxFuture<_>
    })
}

fn fallback_http_routes(auth: AuthService) -> HttpRoutesState {
    let authorize = authorize_handler(auth);
    let json = Arc::new(move |_operation, _payload, _context| {
        Box::pin(async move {
            Err(HttpRouteError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({
                    "_tag": "NativeRuntimeUnavailableError",
                    "message": "The native production runtime is unavailable."
                }),
            ))
        }) as crate::production::http_routes::BoxFuture<_>
    });
    let assets = Arc::new(move |_token, _path, _context| {
        Box::pin(async move {
            Err(HttpRouteError::new(
                axum::http::StatusCode::NOT_FOUND,
                serde_json::json!({ "_tag": "AssetNotFoundError" }),
            ))
        }) as crate::production::http_routes::BoxFuture<_>
    });
    let diagnostic_logs = Arc::new(move |_frontend_log, _context| {
        Box::pin(async move {
            Err(HttpRouteError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({
                    "_tag": "NativeRuntimeUnavailableError",
                    "message": "The native production runtime is unavailable."
                }),
            ))
        }) as crate::production::http_routes::BoxFuture<_>
    });
    let mcp = Arc::new(move |_method, _body, _context| {
        Box::pin(async move {
            Err(HttpRouteError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({ "_tag": "McpUnavailableError" }),
            ))
        }) as crate::production::http_routes::BoxFuture<_>
    });
    HttpRoutesState::new(authorize, json, diagnostic_logs, assets, mcp)
}

impl ServerHandle {
    #[must_use]
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    #[must_use]
    pub fn advertised_base_url(&self) -> &str {
        &self.advertised_base_url
    }

    #[must_use]
    pub fn data_root(&self) -> &ResolvedDataRoot {
        &self.data_root
    }

    #[must_use]
    pub fn startup_access(&self) -> Option<&StartupAccess> {
        self.startup_access.as_ref()
    }

    pub fn shutdown(&self) {
        if let Some(local_control) = &self.local_control {
            local_control.shutdown();
        }
        self.shutdown.cancel();
    }

    pub async fn wait_for_shutdown(&self) {
        self.shutdown.cancelled().await;
    }

    pub async fn join(mut self) -> Result<(), ServerError> {
        if let Some(local_control) = &self.local_control {
            local_control.shutdown();
        }
        let task = self.task.take().ok_or(ServerError::AlreadyJoined)?;
        let server_result = match task.await {
            Ok(result) => result.map_err(ServerError::Serve),
            Err(error) => Err(ServerError::Join(error)),
        };
        let control_result = match self.local_control.as_mut() {
            Some(local_control) => local_control
                .join()
                .await
                .map_err(|error| ServerError::LocalControlServe(error.to_string())),
            None => Ok(()),
        };
        self.local_control.take();
        drop(self._production_runtime.take());
        if let Some(database) = self.database.take() {
            database.close().await;
        }
        server_result.and(control_result)
    }
}

fn build_startup_access(
    advertised_base_url: &str,
    credential: String,
) -> Result<StartupAccess, ServerError> {
    let advertised_url = url::Url::parse(advertised_base_url)
        .map_err(|error| ServerError::AuthInitialize(error.to_string()))?;
    let pairing_url = build_pairing_url(&advertised_url, &credential);
    Ok(StartupAccess {
        connection_string: advertised_base_url.to_owned(),
        credential,
        pairing_url,
    })
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        if let Some(local_control) = &self.local_control {
            local_control.shutdown();
        }
        self.shutdown.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn startup_session_cookie(
        client: &reqwest::Client,
        address: std::net::SocketAddr,
        credential: &str,
    ) -> String {
        let response = client
            .post(format!("http://{address}/api/auth/browser-session"))
            .json(&serde_json::json!({ "credential": credential }))
            .send()
            .await
            .expect("startup browser session should respond");
        assert!(response.status().is_success());
        response
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .expect("startup browser session cookie")
            .to_str()
            .expect("ASCII startup cookie")
            .split(';')
            .next()
            .expect("startup cookie pair")
            .to_owned()
    }

    #[tokio::test]
    async fn rejects_relative_programmatic_data_roots_before_creating_state() {
        let error = match ServerRuntime::start(ServerConfig::new("relative/.bibcode")).await {
            Ok(_) => panic!("relative data root must fail at runtime start"),
            Err(error) => error,
        };

        assert!(matches!(error, ServerError::DataRoot(_)));
    }

    #[tokio::test]
    async fn default_ui_observers_match_the_server_runtime_mode() {
        let rows = Arc::<[crate::diagnostics::ProcessRow]>::from([]);
        let server_identity = crate::diagnostics::ProcessIdentity {
            pid: std::process::id(),
            started_at: 1,
        };
        let web = default_ui_process_observer(crate::config::ServerMode::Web)
            .observe(rows.clone(), server_identity)
            .await;
        assert_eq!(
            web.coverage.status,
            crate::diagnostics::UiCoverageStatus::NotApplicable
        );
        assert!(web.coverage.message.is_none());

        let desktop = default_ui_process_observer(crate::config::ServerMode::Desktop)
            .observe(rows, server_identity)
            .await;
        assert_eq!(
            desktop.coverage.status,
            crate::diagnostics::UiCoverageStatus::Unavailable
        );
        let message = desktop.coverage.message.expect("unavailable explanation");
        assert!(message.contains("Native server usage is included"));
        assert!(message.contains("local UI/WebView usage"));
        assert!(message.chars().count() <= 160);
    }

    #[tokio::test]
    async fn server_runtime_covers_production_fallback_startup_access_and_shutdown_paths() {
        let production_state = tempfile::tempdir().expect("production state directory");
        let production_config =
            ServerConfig::new(production_state.path()).with_bind("127.0.0.1", 0);
        let production = ServerRuntime::start(production_config)
            .await
            .expect("production server should start");
        let startup = production
            .startup_access()
            .expect("web server should issue startup access")
            .clone();
        let client = reqwest::Client::new();
        let descriptor = reqwest::get(format!(
            "http://{}/.well-known/bibcode/environment",
            production.local_addr()
        ))
        .await
        .expect("environment descriptor should respond");
        assert!(descriptor.status().is_success());
        let descriptor = descriptor
            .json::<serde_json::Value>()
            .await
            .expect("environment descriptor should decode");
        assert!(descriptor["capabilities"].get("worktreeCatalog").is_none());
        assert!(
            descriptor["capabilities"]
                .get("worktreeCatalogRefreshReason")
                .is_none()
        );
        let cookie = startup_session_cookie(
            &client,
            production.local_addr(),
            startup.credential.as_str(),
        )
        .await;
        let snapshot = client
            .get(format!(
                "http://{}/api/orchestration/snapshot",
                production.local_addr()
            ))
            .header(reqwest::header::COOKIE, &cookie)
            .send()
            .await
            .expect("orchestration snapshot should respond");
        assert!(snapshot.status().is_success());
        let link_state = client
            .get(format!(
                "http://{}/api/connect/link-state",
                production.local_addr()
            ))
            .header(reqwest::header::COOKIE, &cookie)
            .send()
            .await
            .expect("connect link state should respond");
        assert!(link_state.status().is_success());
        let diagnostic = client
            .post(format!(
                "http://{}/api/diagnostics/logs.zip",
                production.local_addr()
            ))
            .header(reqwest::header::COOKIE, &cookie)
            .json(&serde_json::json!({"frontendLog":"unit lifecycle log"}))
            .send()
            .await
            .expect("diagnostic logs should respond");
        assert!(diagnostic.status().is_success());
        production.shutdown();
        production.wait_for_shutdown().await;
        production
            .join()
            .await
            .expect("production server should join");

        let fallback_state = tempfile::tempdir().expect("fallback state directory");
        let fallback_config = ServerConfig::new(fallback_state.path()).with_bind("127.0.0.1", 0);
        let fallback = ServerRuntime::start_with_registry(fallback_config, RpcRegistry::empty())
            .await
            .expect("fallback server should start");
        let fallback_credential = fallback
            .startup_access()
            .expect("fallback server should issue startup access")
            .credential
            .clone();
        let fallback_cookie =
            startup_session_cookie(&client, fallback.local_addr(), fallback_credential.as_str())
                .await;
        let response = client
            .post(format!(
                "http://{}/api/orchestration/dispatch",
                fallback.local_addr()
            ))
            .header(reqwest::header::COOKIE, &fallback_cookie)
            .json(&serde_json::json!({}))
            .send()
            .await
            .expect("fallback route should respond");
        assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
        for response in [
            client
                .post(format!(
                    "http://{}/api/diagnostics/logs.zip",
                    fallback.local_addr()
                ))
                .header(reqwest::header::COOKIE, &fallback_cookie)
                .json(&serde_json::json!({"frontendLog":"fallback"}))
                .send()
                .await
                .expect("fallback diagnostics should respond"),
            client
                .get(format!(
                    "http://{}/api/assets/token/file",
                    fallback.local_addr()
                ))
                .header(reqwest::header::COOKIE, &fallback_cookie)
                .send()
                .await
                .expect("fallback asset should respond"),
            client
                .post(format!("http://{}/mcp", fallback.local_addr()))
                .header(reqwest::header::COOKIE, &fallback_cookie)
                .body("{}")
                .send()
                .await
                .expect("fallback MCP should respond"),
        ] {
            assert!(response.status().is_client_error() || response.status().is_server_error());
        }
        fallback.shutdown();
        fallback.join().await.expect("fallback server should join");

        let ipv4 = build_startup_access("http://localhost:3773", "pairing credential".to_string())
            .expect("IPv4 startup access should build");
        assert_eq!(ipv4.connection_string, "http://localhost:3773");
        assert!(ipv4.pairing_url.contains("token=pairing+credential"));

        let ipv6 = build_startup_access("https://localhost:3774", "credential".to_string())
            .expect("IPv6 startup access should build");
        assert_eq!(ipv6.connection_string, "https://localhost:3774");
    }
}
