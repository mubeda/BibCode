use super::*;

/// Read capabilities for one chat context without publishing environment-wide inventory.
pub(crate) async fn discover_capabilities(
    settings: &Value,
    instance_id: &str,
    cwd: &Path,
    attribution: Option<&ProcessAttributionRegistry>,
    cancellation: &CancellationToken,
) -> Result<Value, String> {
    if !cwd.is_absolute()
        || !tokio::fs::metadata(cwd)
            .await
            .is_ok_and(|metadata| metadata.is_dir())
    {
        return Err("Select an existing absolute workspace directory.".to_owned());
    }
    let mut definition = definitions(settings)
        .into_iter()
        .find(|definition| definition.instance_id == instance_id)
        .filter(|definition| definition.enabled && definition.available)
        .ok_or_else(|| {
            "The selected provider is unavailable or disabled. Check provider settings.".to_owned()
        })?;
    if cancellation.is_cancelled() {
        return Err("Skill discovery was cancelled. Retry to reload the catalog.".to_owned());
    }
    let mut capabilities = if definition.driver == "cursor" {
        let discovered = tokio::select! {
            () = cancellation.cancelled() => return Err("Skill discovery was cancelled.".to_owned()),
            result = discover_cursor_within(CURSOR_DISCOVERY_TIMEOUT, |found| {
                let (cwd, environment) = (cwd.to_path_buf(), definition.environment.clone());
                Box::pin(async move {
                    cursor::discover_workspace_capabilities_into(&cwd, &environment, found).await;
                })
            }) => result,
        };
        ProviderCapabilities {
            slash_commands: discovered.slash_commands,
            skills: discovered.skills,
            agents: discovered.agents,
            issues: discovered.issues,
            ..ProviderCapabilities::default()
        }
    } else if definition.driver == "opencode" && definition.endpoint.is_some() {
        tokio::select! {
            () = cancellation.cancelled() => None,
            result = opencode_capabilities(definition.endpoint.as_deref().unwrap(), definition.server_password.as_deref(), cwd, None) => result,
        }.ok_or_else(|| "Could not load OpenCode skills. Check the server connection and retry.".to_owned())?
    } else {
        let executable = resolve_provider_executable_with_environment(
            &definition.binary_path,
            definition
                .environment
                .iter()
                .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
        )
        .ok_or_else(|| {
            "The provider executable was not found. Check provider settings.".to_owned()
        })?;
        match definition.driver.as_str() {
            "codex" => {
                let config = settings
                    .get("providerInstances")
                    .and_then(|instances| instances.get(instance_id))
                    .and_then(|instance| instance.get("config"));
                let layout = codex::resolve_codex_home_layout(
                    string_setting(config, "homePath"),
                    string_setting(config, "shadowHomePath"),
                    dirs::home_dir()
                        .as_deref()
                        .unwrap_or_else(|| Path::new(".")),
                );
                codex::materialize_codex_shadow_home(&layout)
                    .await
                    .map_err(|error| error.to_string())?;
                if let Some(home) = layout.effective_home_path {
                    definition.environment.retain(|(name, _)| {
                        if cfg!(windows) {
                            !name.to_string_lossy().eq_ignore_ascii_case("CODEX_HOME")
                        } else {
                            name != "CODEX_HOME"
                        }
                    });
                    definition
                        .environment
                        .push(("CODEX_HOME".into(), home.into_os_string()));
                }
                codex_capabilities(&executable, cwd, &definition.environment, cancellation).await?
            }
            "claudeAgent" => {
                let metadata = probe_claude_metadata_with_cancellation(
                    &executable,
                    cwd,
                    &definition.environment,
                    &[],
                    cancellation,
                )
                .await
                .ok_or_else(|| {
                    "Could not load Claude skills. Check provider settings and retry.".to_owned()
                })?;
                let mut capabilities = metadata.capabilities;
                if !metadata.skills_loaded {
                    capabilities.issues.push(
                        "Claude could not reload skills. Retry to load the full catalog."
                            .to_owned(),
                    );
                }
                let skills = capabilities
                    .skills
                    .iter()
                    .filter_map(|skill| skill["name"].as_str())
                    .collect::<HashSet<_>>();
                capabilities.slash_commands.retain(|command| {
                    !command["name"]
                        .as_str()
                        .is_some_and(|name| skills.contains(name))
                });
                capabilities
            }
            "opencode" => with_local_opencode(
                &executable,
                cwd,
                &definition.environment,
                cancellation,
                |endpoint, password, protocol| async move {
                    opencode_capabilities(&endpoint, Some(&password), cwd, Some(protocol)).await
                },
            )
            .await
            .ok_or_else(|| {
                "Could not load OpenCode skills. Check provider settings and retry.".to_owned()
            })?,
            "antigravity" => {
                if definition.missing_secret {
                    return Err(ANTIGRAVITY_MISSING_SECRET_MESSAGE.to_owned());
                }
                antigravity_capabilities_with_timeout(
                    &executable,
                    cwd,
                    &definition.environment,
                    &definition.secret_values,
                    attribution,
                    cancellation,
                    ANTIGRAVITY_DISCOVERY_TIMEOUT,
                )
                .await?
            }
            _ => return Err("Skill discovery is not supported for this provider.".to_owned()),
        }
    };
    capabilities.slash_commands = merge_slash_commands(
        capabilities.slash_commands,
        built_in_slash_commands(&definition.driver),
    );
    serde_json::to_value(capabilities).map_err(|error| error.to_string())
}

const ANTIGRAVITY_COMMANDS_SETTLE_TIMEOUT: Duration = Duration::from_millis(250);
const MAX_ANTIGRAVITY_PRE_SESSION_UPDATES: usize = 32;
const MAX_ANTIGRAVITY_ACP_COMMANDS: usize = 512;

#[derive(Default)]
struct AntigravityAcpCollector {
    session_id: Option<String>,
    pending: std::collections::VecDeque<(
        Option<String>,
        Vec<crate::provider::antigravity::capabilities::AcpAvailableCommand>,
    )>,
    matched_commands: Option<Vec<crate::provider::antigravity::capabilities::AcpAvailableCommand>>,
    overflow_truncated: bool,
    closed: bool,
}

struct AntigravityAcpTransport {
    connection: cursor::AcpJsonRpcConnection,
    drain_task: tokio::task::JoinHandle<()>,
}

impl Drop for AntigravityAcpTransport {
    fn drop(&mut self) {
        self.connection.shutdown();
        self.drain_task.abort();
    }
}

enum AntigravityProbeOutcome {
    Cancelled,
    TimedOut,
    Completed {
        commands: Option<Vec<crate::provider::antigravity::capabilities::AcpAvailableCommand>>,
        overflow_truncated: bool,
        issue: Option<&'static str>,
    },
}

fn spawn_antigravity_acp_transport<R, W, E>(
    stdout: R,
    stdin: W,
    stderr: E,
    collector: std::sync::Arc<std::sync::Mutex<AntigravityAcpCollector>>,
    notify: std::sync::Arc<tokio::sync::Notify>,
) -> AntigravityAcpTransport
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
    E: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let (connection, mut incoming) = cursor::AcpJsonRpcConnection::spawn(
        stdout,
        stdin,
        stderr,
        cursor::AcpConnectionConfig::default(),
    );
    let drain_task = tokio::spawn(async move {
        while let Some(event) = incoming.recv().await {
            match event {
                cursor::IncomingEvent::Notification { method, params }
                    if method == "session/update" =>
                {
                    if let Some(mut commands) =
                        crate::provider::antigravity::capabilities::parse_available_commands_update(
                            &params,
                        )
                    {
                        let sid = params
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        let mut state = collector
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if commands.len() > MAX_ANTIGRAVITY_ACP_COMMANDS {
                            commands.truncate(MAX_ANTIGRAVITY_ACP_COMMANDS);
                            state.overflow_truncated = true;
                        }
                        if let Some(expected) = state.session_id.as_deref() {
                            if sid.as_deref() == Some(expected) {
                                state.matched_commands = Some(commands);
                                notify.notify_waiters();
                            }
                        } else if let Some((_, existing_commands)) = state
                            .pending
                            .iter_mut()
                            .find(|(existing_sid, _)| *existing_sid == sid)
                        {
                            *existing_commands = commands;
                        } else {
                            if state.pending.len() >= MAX_ANTIGRAVITY_PRE_SESSION_UPDATES {
                                state.pending.pop_front();
                                state.overflow_truncated = true;
                            }
                            state.pending.push_back((sid, commands));
                        }
                    }
                }
                cursor::IncomingEvent::Barrier(ack) => {
                    let _ = ack.send(());
                }
                cursor::IncomingEvent::ResponseObserved { .. } => {}
                cursor::IncomingEvent::Closed { .. } => {
                    let mut state = collector
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    state.closed = true;
                    notify.notify_waiters();
                    break;
                }
                cursor::IncomingEvent::Notification { .. }
                | cursor::IncomingEvent::Request { .. }
                | cursor::IncomingEvent::Stderr { .. } => {}
            }
        }
        let mut state = collector
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.closed = true;
        notify.notify_waiters();
    });
    AntigravityAcpTransport {
        connection,
        drain_task,
    }
}

async fn discover_antigravity_local_within<F>(
    limit: Duration,
    cancellation: &CancellationToken,
    discover: F,
) -> Result<crate::provider::antigravity::capabilities::LocalSkillScanResult, String>
where
    F: Future<Output = crate::provider::antigravity::capabilities::LocalSkillScanResult>,
{
    tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            Err("Skill discovery was cancelled. Retry to reload the catalog.".to_owned())
        }
        result = timeout(limit, discover) => match result {
            Ok(scan) => Ok(scan),
            Err(_) => Ok(crate::provider::antigravity::capabilities::LocalSkillScanResult {
                skills: Vec::new(),
                issues: vec![
                    "Local Antigravity skill scan timed out. Retry to reload the catalog."
                        .to_owned(),
                ],
            }),
        },
    }
}

async fn antigravity_capabilities_with_timeout(
    executable: &Path,
    cwd: &Path,
    environment: &[(OsString, OsString)],
    secret_values: &[String],
    attribution: Option<&ProcessAttributionRegistry>,
    cancellation: &CancellationToken,
    probe_timeout: Duration,
) -> Result<ProviderCapabilities, String> {
    if cancellation.is_cancelled() {
        return Err("Skill discovery was cancelled. Retry to reload the catalog.".to_owned());
    }

    let local = discover_antigravity_local_within(
        probe_timeout,
        cancellation,
        crate::provider::antigravity::capabilities::discover_local_skills_with_environment(
            cwd,
            environment,
        ),
    )
    .await?;
    if cancellation.is_cancelled() {
        return Err("Skill discovery was cancelled. Retry to reload the catalog.".to_owned());
    }

    let launch = match prepare_provider_launch(executable, ["acp"]) {
        Ok(launch) => launch,
        Err(_) => {
            return Ok(build_antigravity_capabilities(
                None,
                local,
                Some("Could not start Antigravity CLI; showing locally discovered skills."),
                false,
                secret_values,
            ));
        }
    };
    let mut command = Command::new(launch.program);
    command
        .args(launch.args)
        .current_dir(cwd)
        .envs(environment.iter().cloned())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sanitize_provider_subprocess_environment(&mut command);

    let Ok(mut spawned) = supervised_command(command).spawn() else {
        return Ok(build_antigravity_capabilities(
            None,
            local,
            Some("Could not start Antigravity CLI; showing locally discovered skills."),
            false,
            secret_values,
        ));
    };
    let started = std::time::Instant::now();
    let pid = spawned.id();
    let pipes = (
        spawned.stdout().take(),
        spawned.stdin().take(),
        spawned.stderr().take(),
    );
    let registration = match attribution {
        Some(registry) => {
            let registration = pid.and_then(|pid| {
                register_antigravity_probe(registry, pid, "Antigravity skill discovery")
            });
            if registration.is_none() {
                stop_supervised_child(&mut *spawned).await;
                return Ok(build_antigravity_capabilities(
                    None,
                    local,
                    Some(
                        "Could not attribute Antigravity process; showing locally discovered skills.",
                    ),
                    false,
                    secret_values,
                ));
            }
            registration
        }
        None => None,
    };
    let child = ProbeChild {
        child: Some(spawned),
        registration,
    };
    let (Some(stdout), Some(stdin), Some(stderr)) = pipes else {
        child.stop().await;
        return Ok(build_antigravity_capabilities(
            None,
            local,
            Some("Antigravity CLI did not expose stdio pipes; showing locally discovered skills."),
            false,
            secret_values,
        ));
    };

    let collector = std::sync::Arc::new(std::sync::Mutex::new(AntigravityAcpCollector::default()));
    let notify = std::sync::Arc::new(tokio::sync::Notify::new());
    let transport =
        spawn_antigravity_acp_transport(stdout, stdin, stderr, collector.clone(), notify.clone());
    let connection = &transport.connection;

    enum HandshakeCapture {
        Cancelled,
        TimedOut,
        Ready {
            session_id: String,
            advertises_close: bool,
            commands: Option<Vec<crate::provider::antigravity::capabilities::AcpAvailableCommand>>,
            overflow_truncated: bool,
        },
        Early(AntigravityProbeOutcome),
    }

    let captured = tokio::select! {
        biased;
        () = cancellation.cancelled() => HandshakeCapture::Cancelled,
        result = timeout(probe_timeout, async {
            let initialize = connection
                .request(
                    "initialize",
                    json!({
                        "protocolVersion": 1,
                        "clientCapabilities": {
                            "fs": { "readTextFile": false, "writeTextFile": false },
                            "terminal": false,
                        },
                        "clientInfo": { "name": "bibcode-rust", "version": env!("CARGO_PKG_VERSION") },
                    }),
                )
                .await?;
            if initialize.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
                return Ok(HandshakeCapture::Early(AntigravityProbeOutcome::Completed {
                    commands: None,
                    overflow_truncated: false,
                    issue: Some(
                        "Antigravity CLI reported an unsupported protocol; showing locally discovered skills.",
                    ),
                }));
            }
            let session = connection
                .request(
                    "session/new",
                    json!({ "cwd": cwd.to_string_lossy(), "mcpServers": [] }),
                )
                .await?;
            let Some(session_id) = session
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                return Ok(HandshakeCapture::Early(AntigravityProbeOutcome::Completed {
                    commands: None,
                    overflow_truncated: false,
                    issue: Some(
                        "Antigravity CLI did not return a session ID; showing locally discovered skills.",
                    ),
                }));
            };

            let _ = connection.barrier().await;
            let (already_matched, already_closed) = {
                let mut state = collector
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                state.session_id = Some(session_id.clone());
                let mut latest = None;
                while let Some((sid, commands)) = state.pending.pop_front() {
                    if sid.as_deref() == Some(session_id.as_str()) {
                        latest = Some(commands);
                    }
                }
                if latest.is_some() {
                    state.matched_commands = latest;
                }
                (state.matched_commands.is_some(), state.closed)
            };

            if !already_matched && !already_closed {
                let settle_deadline =
                    tokio::time::Instant::now() + ANTIGRAVITY_COMMANDS_SETTLE_TIMEOUT;
                loop {
                    let notified = notify.notified();
                    {
                        let state = collector
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if state.matched_commands.is_some() || state.closed {
                            break;
                        }
                    }
                    if tokio::time::timeout_at(settle_deadline, notified)
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }

            let state = collector
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            Ok::<HandshakeCapture, cursor::acp::AcpProtocolError>(HandshakeCapture::Ready {
                session_id,
                advertises_close: antigravity_advertises_close(&initialize),
                commands: state.matched_commands.clone(),
                overflow_truncated: state.overflow_truncated,
            })
        }) => match result {
            Ok(Ok(capture)) => capture,
            Ok(Err(cursor::acp::AcpProtocolError::RemoteRequest {
                code: -32000,
                message,
                ..
            })) if message.trim().eq_ignore_ascii_case("authentication required") => {
                HandshakeCapture::Early(AntigravityProbeOutcome::Completed {
                    commands: None,
                    overflow_truncated: false,
                    issue: Some(ANTIGRAVITY_SIGN_IN_MESSAGE),
                })
            }
            Ok(Err(cursor::acp::AcpProtocolError::RemoteRequest { .. })) => {
                HandshakeCapture::Early(AntigravityProbeOutcome::Completed {
                    commands: None,
                    overflow_truncated: false,
                    issue: Some(
                        "Could not query Antigravity commands; showing locally discovered skills.",
                    ),
                })
            }
            Ok(Err(_)) => {
                if exits::watching()
                    && let (Some(pid), Some(status)) = (pid, child.exited_on_its_own().await)
                {
                    exits::report_exit(
                        Watch::Failures,
                        &Exited {
                            kind: "provider",
                            label: "antigravity",
                            exe: &executable.to_string_lossy(),
                            pid,
                            started,
                        },
                        &status,
                        false,
                    );
                }
                HandshakeCapture::Early(AntigravityProbeOutcome::Completed {
                    commands: None,
                    overflow_truncated: false,
                    issue: Some(
                        "Could not query Antigravity commands; showing locally discovered skills.",
                    ),
                })
            }
            Err(_) => HandshakeCapture::TimedOut,
        }
    };

    let outcome = match captured {
        HandshakeCapture::Cancelled => AntigravityProbeOutcome::Cancelled,
        HandshakeCapture::TimedOut => AntigravityProbeOutcome::TimedOut,
        HandshakeCapture::Early(outcome) => outcome,
        HandshakeCapture::Ready {
            session_id,
            advertises_close,
            mut commands,
            mut overflow_truncated,
        } => {
            let mut close_cancelled = false;
            if advertises_close {
                let close_fut = async {
                    let _ = connection
                        .request("session/close", json!({ "sessionId": session_id.as_str() }))
                        .await;
                    let _ = connection.barrier().await;
                };
                tokio::select! {
                    biased;
                    () = cancellation.cancelled() => {
                        close_cancelled = true;
                    }
                    _ = timeout(ANTIGRAVITY_CLOSE_TIMEOUT, close_fut) => {
                        let state = collector
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if commands.is_none() && state.matched_commands.is_some() {
                            commands = state.matched_commands.clone();
                        }
                        overflow_truncated |= state.overflow_truncated;
                    }
                }
            }
            if close_cancelled {
                AntigravityProbeOutcome::Cancelled
            } else {
                let issue = if commands.is_none() {
                    Some(
                        "Antigravity did not report its command list in time; showing locally discovered skills. Retry to reload.",
                    )
                } else {
                    None
                };
                AntigravityProbeOutcome::Completed {
                    commands,
                    overflow_truncated,
                    issue,
                }
            }
        }
    };

    drop(transport);
    child.stop().await;

    match outcome {
        AntigravityProbeOutcome::Cancelled => {
            Err("Skill discovery was cancelled. Retry to reload the catalog.".to_owned())
        }
        AntigravityProbeOutcome::TimedOut => Ok(build_antigravity_capabilities(
            None,
            local,
            Some("Timed out waiting for Antigravity commands; showing locally discovered skills."),
            false,
            secret_values,
        )),
        AntigravityProbeOutcome::Completed {
            commands,
            overflow_truncated,
            issue,
        } => Ok(build_antigravity_capabilities(
            commands.as_deref(),
            local,
            issue,
            overflow_truncated,
            secret_values,
        )),
    }
}

fn build_antigravity_capabilities(
    commands: Option<&[crate::provider::antigravity::capabilities::AcpAvailableCommand]>,
    local: crate::provider::antigravity::capabilities::LocalSkillScanResult,
    issue: Option<&str>,
    overflow_truncated: bool,
    secret_values: &[String],
) -> ProviderCapabilities {
    let merged = crate::provider::antigravity::capabilities::merge_acp_available_commands(
        commands,
        &local.skills,
    );
    let mut capabilities = ProviderCapabilities {
        slash_commands: merged.slash_commands,
        skills: merged.skills,
        agents: Vec::new(),
        issues: local.issues,
        ..ProviderCapabilities::default()
    };
    if overflow_truncated {
        capabilities.issues.push(
            "Antigravity returned too many command updates; showing a truncated catalog."
                .to_owned(),
        );
    }
    if let Some(issue) = issue {
        capabilities.issues.push(issue.to_owned());
    }
    scrub_antigravity_capabilities(&mut capabilities, secret_values);
    capabilities
}

fn scrub_antigravity_capabilities(
    capabilities: &mut ProviderCapabilities,
    secret_values: &[String],
) {
    if secret_values.is_empty() {
        return;
    }
    capabilities.slash_commands.retain_mut(|command| {
        let Some(object) = command.as_object_mut() else {
            return false;
        };
        if object
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| contains_any_secret(name, secret_values))
        {
            return false;
        }
        scrub_string_field(object, "description", secret_values);
        if let Some(input) = object.get_mut("input").and_then(Value::as_object_mut) {
            scrub_string_field(input, "hint", secret_values);
        }
        true
    });
    capabilities.skills.retain_mut(|skill| {
        let Some(object) = skill.as_object_mut() else {
            return false;
        };
        if object
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| contains_any_secret(name, secret_values))
        {
            return false;
        }
        scrub_string_field(object, "description", secret_values);
        scrub_string_field(object, "path", secret_values);
        true
    });
    for issue in &mut capabilities.issues {
        *issue = scrub_secrets_in_text(issue, secret_values);
    }
}

fn contains_any_secret(text: &str, secret_values: &[String]) -> bool {
    secret_values
        .iter()
        .any(|secret| !secret.is_empty() && text.contains(secret.as_str()))
}

fn scrub_string_field(
    object: &mut serde_json::Map<String, Value>,
    field: &str,
    secret_values: &[String],
) {
    if let Some(Value::String(text)) = object.get_mut(field) {
        *text = scrub_secrets_in_text(text, secret_values);
    }
}

fn scrub_secrets_in_text(text: &str, secret_values: &[String]) -> String {
    let mut scrubbed = text.to_owned();
    for secret in secret_values {
        if !secret.is_empty() && scrubbed.contains(secret.as_str()) {
            scrubbed = scrubbed.replace(secret.as_str(), "[REDACTED]");
        }
    }
    scrubbed
}

/// A scan that outlives `limit` (a slow network folder) keeps what it found,
/// marked incomplete, instead of failing the whole catalog.
async fn discover_cursor_within(
    limit: Duration,
    discover: impl for<'a> FnOnce(
        &'a mut cursor::CursorWorkspaceCapabilities,
    ) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send + 'a>>,
) -> cursor::CursorWorkspaceCapabilities {
    let mut found = cursor::CursorWorkspaceCapabilities::default();
    let timed_out = timeout(limit, discover(&mut found)).await.is_err();
    if timed_out {
        found
            .issues
            .push("Skill list is incomplete: discovery timed out. Retry to reload it.".to_owned());
    }
    found
}

async fn codex_capabilities(
    executable: &Path,
    cwd: &Path,
    environment: &[(OsString, OsString)],
    cancellation: &CancellationToken,
) -> Result<ProviderCapabilities, String> {
    let launch =
        prepare_provider_launch(executable, ["app-server"]).map_err(|error| error.to_string())?;
    let mut command = Command::new(launch.program);
    command
        .args(launch.args)
        .current_dir(cwd)
        .envs(environment.iter().cloned())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sanitize_provider_subprocess_environment(&mut command);
    let mut child = supervised_command(command)
        .spawn()
        .map_err(|error| error.to_string())?;
    let result = async {
        let stdout = child.stdout().take().ok_or("Codex stdout is unavailable")?;
        let stdin = child.stdin().take().ok_or("Codex stdin is unavailable")?;
        let stderr = child.stderr().take().ok_or("Codex stderr is unavailable")?;
        let (connection, _incoming) = codex::JsonRpcConnection::spawn(stdout, stdin, stderr, codex::ConnectionConfig::default());
        let cwd = cwd.to_string_lossy();

        let result = tokio::select! {
            biased;
            () = cancellation.cancelled() => Err("Skill discovery was cancelled.".to_owned()),
            result = timeout(PROBE_TIMEOUT, read_codex_capabilities(&connection, &cwd)) => result.unwrap_or_else(|_| Err("Codex skill discovery timed out. Retry to reload the catalog.".to_owned())),
        };
        connection.close().await;
        result
    }.await;
    stop_supervised_child(&mut *child).await;
    result
}

async fn read_codex_capabilities(
    connection: &codex::JsonRpcConnection,
    cwd: &str,
) -> Result<ProviderCapabilities, String> {
    connection
        .request(
            "initialize",
            codex::build_initialize_params(env!("CARGO_PKG_VERSION")),
        )
        .await
        .map_err(|error| error.to_string())?;
    connection
        .notify_without_params("initialized")
        .await
        .map_err(|error| error.to_string())?;
    // A fresh App Server has no remote installed-plugin cache until this read.
    let mut issues = match connection
        .request("plugin/installed", json!({"cwds":[cwd]}))
        .await
    {
        Ok(response)
            if response["marketplaceLoadErrors"]
                .as_array()
                .is_some_and(|errors| !errors.is_empty()) =>
        {
            tracing::warn!("Codex returned an incomplete installed plugin catalog");
            vec![
                "Codex could not load some installed plugins. Retry to reload the catalog."
                    .to_owned(),
            ]
        }
        Ok(_) => Vec::new(),
        Err(error) if error.is_missing_method() => Vec::new(),
        Err(error) => {
            tracing::warn!(%error, "Codex installed plugin discovery failed");
            vec!["Codex could not load installed plugins. Retry to reload the catalog.".to_owned()]
        }
    };
    let response = connection
        .request("skills/list", json!({"cwds":[cwd],"forceReload":true}))
        .await
        .map_err(|error| error.to_string())?;
    let entry = response
        .get("data")
        .and_then(Value::as_array)
        .and_then(|data| {
            data.iter()
                .find(|entry| entry["cwd"] == cwd)
                .or_else(|| (data.len() == 1).then(|| &data[0]))
        })
        .filter(|entry| entry["skills"].is_array())
        .ok_or("Codex returned an incomplete skill catalog")?;
    issues.extend(
        entry
            .get("errors")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|error| {
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|message| !message.is_empty())
                    .unwrap_or("Codex could not load a skill. Check its SKILL.md and retry.")
                    .to_owned()
            }),
    );
    let skills = codex::parse_skills_list_response(&response, cwd)?;
    Ok(ProviderCapabilities {
        skills: codex_skill_inventory(&skills),
        issues,
        ..ProviderCapabilities::default()
    })
}

/// `protocol` is known for a server BiBCode started; a configured Server URL is identified first.
async fn opencode_capabilities(
    endpoint: &str,
    password: Option<&str>,
    cwd: &Path,
    protocol: Option<opencode::OpenCodeProtocol>,
) -> Option<ProviderCapabilities> {
    let protocol = match protocol {
        Some(protocol) => protocol,
        None => opencode_server_protocol(endpoint, password).await.ok()?,
    };
    let client = reqwest::Client::builder()
        .timeout(LOCAL_OPENCODE_INVENTORY_TIMEOUT)
        .build()
        .ok()?;
    let endpoint = endpoint.trim_end_matches('/');
    let (commands, agents) = match protocol {
        opencode::OpenCodeProtocol::V1 => {
            let (commands, agents) = tokio::join!(
                get_opencode_json(&client, endpoint, "/command", password, Some(cwd)),
                get_opencode_json(&client, endpoint, "/agent", password, Some(cwd)),
            );
            (commands?, agents?)
        }
        opencode::OpenCodeProtocol::V2 => {
            // Only the slash-menu catalogs: a failing model list must not hide skills.
            let [agents, commands, skills] = read_opencode_v2_catalogs(
                &client,
                endpoint,
                password,
                Some(cwd),
                ["agent", "command", "skill"],
            )
            .await?;
            use opencode::v2::catalog;
            (
                catalog::commands(&commands, &skills),
                catalog::agents(&agents),
            )
        }
    };
    if !commands.is_array() || !agents.is_array() {
        return None;
    }
    let snapshot = opencode::build_inventory_snapshot(&json!({}), &agents, &commands, &[]);
    Some(ProviderCapabilities {
        slash_commands: snapshot.commands,
        skills: snapshot.skills,
        agents: snapshot.agents,
        ..ProviderCapabilities::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::test_support::TestSandbox;

    #[tokio::test]
    async fn a_cursor_scan_slower_than_the_timeout_keeps_the_skills_it_found() {
        let found = discover_cursor_within(Duration::from_millis(50), |found| {
            Box::pin(async move {
                found.skills.push(json!({"name": "early"}));
                std::future::pending::<()>().await;
            })
        })
        .await;
        assert_eq!(found.skills, [json!({"name": "early"})]);
        assert_eq!(found.issues.len(), 1, "{:?}", found.issues);
        assert!(found.issues[0].starts_with("Skill list is incomplete"));
    }

    #[tokio::test]
    async fn a_cursor_scan_that_finishes_in_time_adds_no_issue() {
        let found = discover_cursor_within(Duration::from_secs(5), |found| {
            Box::pin(async move { found.skills.push(json!({"name": "done"})) })
        })
        .await;
        assert_eq!(found.skills.len(), 1);
        assert!(found.issues.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_skill_catalog_includes_plugin_installs() {
        let sandbox = TestSandbox::new("codex-plugin-skills");
        let cwd = sandbox.path("workspace");
        let home = sandbox.path("home");
        let codex_home = home.join(".codex");
        let skill_path = codex_home.join(
            "plugins/cache/test-marketplace/superpowers/7.0.1/skills/systematic-debugging/SKILL.md",
        );
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(skill_path.parent().unwrap()).unwrap();
        std::fs::write(
            &skill_path,
            "---\nname: systematic-debugging\ndescription: Debug systematically\n---\n",
        )
        .unwrap();
        let binary = sandbox.executable_script(
            "codex",
            r#"
plugins_loaded=false
while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
    *'"method":"initialized"'*) ;;
    *'"method":"plugin/installed"'*)
      test -f "$CODEX_HOME/plugins/cache/test-marketplace/superpowers/7.0.1/skills/systematic-debugging/SKILL.md" || exit 9
      case "$PLUGIN_CATALOG" in
        unsupported) printf '{"id":%s,"error":{"code":-32601,"message":"Method not found"}}\n' "$id" ;;
        failed) printf '{"id":%s,"error":{"code":-32000,"message":"Plugin discovery failed"}}\n' "$id" ;;
        partial)
          plugins_loaded=true
          printf '{"id":%s,"result":{"marketplaces":[],"marketplaceLoadErrors":[{"message":"Marketplace unavailable"}]}}\n' "$id" ;;
        *)
          plugins_loaded=true
          printf '{"id":%s,"result":{"marketplaces":[],"marketplaceLoadErrors":[]}}\n' "$id" ;;
      esac ;;
    *'"method":"skills/list"'*)
      if $plugins_loaded; then skills=$(cat plugin-skills.json); else skills='[]'; fi
      printf '{"id":%s,"result":{"data":[{"cwd":"%s","skills":%s,"errors":[]}]}}\n' "$id" "$PWD" "$skills" ;;
    *) exit 10 ;;
  esac
done
"#,
            "",
        );
        std::fs::write(
            cwd.join("plugin-skills.json"),
            json!([{
                "name":"superpowers:systematic-debugging",
                "path":skill_path,"enabled":true,"scope":"user",
                "pluginId":"superpowers@test-marketplace"
            }])
            .to_string(),
        )
        .unwrap();
        for mode in ["installed", "unsupported", "failed", "partial"] {
            let settings = json!({"providerInstances":{"codex-plugins":{
                "driver":"codex","enabled":true,
                "config":{"binaryPath":binary,"homePath":codex_home},
                "environment":[{"name":"HOME","value":home},{"name":"USERPROFILE","value":home},
                    {"name":"PLUGIN_CATALOG","value":mode}]
            }}});
            let catalog = discover_capabilities(
                &settings,
                "codex-plugins",
                &cwd,
                None,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(
                catalog["skills"],
                if matches!(mode, "installed" | "partial") {
                    json!([{
                        "name":"superpowers:systematic-debugging",
                        "path":skill_path,"enabled":true,"scope":"user","invocation":"dollar"
                    }])
                } else {
                    json!([])
                },
                "{mode}"
            );
            assert_eq!(
                catalog["issues"].as_array().unwrap().is_empty(),
                matches!(mode, "installed" | "unsupported"),
                "{mode}: {catalog}"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn native_skill_catalogs_use_user_configuration_and_the_selected_workspace() {
        let sandbox = TestSandbox::new("native-skill-catalogs");
        let home = sandbox.path("user");
        let shared = sandbox.path("codex-shared");
        let shadow = sandbox.path("codex-shadow");
        let claude = sandbox.path("claude-config");
        for root in [&shared, &claude] {
            std::fs::create_dir_all(root.join("skills/personal")).unwrap();
            std::fs::write(root.join("skills/personal/SKILL.md"), "# Personal").unwrap();
        }
        std::fs::create_dir_all(&home).unwrap();
        let binary = sandbox.executable_script("catalog", r#"
while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
    *'"method":"plugin/installed"'*) printf '{"id":%s,"error":{"code":-32601,"message":"Method not found"}}\n' "$id" ;;
    *'"method":"skills/list"'*)
      test -f "$CODEX_HOME/skills/personal/SKILL.md" || exit 9
      case "$request" in *"$PWD"*) ;; *) exit 10 ;; esac
      printf '{"id":%s,"result":%s}\n' "$id" "$(cat codex-catalog.json)" ;;
    *'"subtype":"initialize"'*) printf '{"type":"control_response","response":{"subtype":"success","request_id":"bibcode-inventory","response":%s}}\n' "$(cat claude-commands.json)" ;;
    *'"subtype":"reload_skills"'*)
      test -f "$CLAUDE_CONFIG_DIR/skills/personal/SKILL.md" || exit 11
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"bibcode-skills","response":%s}}\n' "$(cat claude-catalog.json)" ;;
    *'"method":"initialized"'*) ;;
    *) exit 12 ;;
  esac
done
"#, "");
        for (driver, instance) in [
            ("codex", "codex-personal"),
            ("claudeAgent", "claude-personal"),
        ] {
            let settings = json!({"providerInstances": {instance: {
                "driver":driver,"enabled":true,
                "config":{"binaryPath":binary,"homePath":shared,"shadowHomePath":shadow},
                "environment":[{"name":"HOME","value":home},{"name":"CLAUDE_CONFIG_DIR","value":claude}]
            }}});
            for project_name in ["empty", "first", "second"] {
                let cwd = sandbox.path(project_name);
                std::fs::create_dir_all(&cwd).unwrap();
                // The child shell reports physical PWD; use that same fixture
                // spelling while still asserting the exact requested workspace.
                let cwd = std::fs::canonicalize(cwd).unwrap();
                let mut skills = vec![
                    json!({"name":"personal","path":shared.join("skills/personal/SKILL.md"),"enabled":true,"scope":"user"}),
                ];
                if project_name != "empty" {
                    skills.push(json!({"name":project_name,"path":cwd.join("SKILL.md"),"enabled":true,"scope":"repo"}));
                }
                std::fs::write(
                    cwd.join("codex-catalog.json"),
                    json!({"data":[{"cwd":cwd,"skills":skills,"errors":[{"message":"A separate skill could not load."}]}]}).to_string(),
                )
                .unwrap();
                let mut commands = skills
                    .iter()
                    .map(|skill| json!({"name":skill["name"]}))
                    .collect::<Vec<_>>();
                commands[0] = json!({"name":"personal","aliases":["plugin:personal"]});
                commands.push(json!({"name":"manual-only"}));
                std::fs::write(
                    cwd.join("claude-commands.json"),
                    json!({"commands":commands,"agents":[]}).to_string(),
                )
                .unwrap();
                skills[0]["name"] = json!("plugin:personal");
                skills.push(json!({"name":"hidden-model-skill"}));
                std::fs::write(
                    cwd.join("claude-catalog.json"),
                    json!({"skills":skills}).to_string(),
                )
                .unwrap();
                let catalog = super::super::discover_capabilities(
                    &settings,
                    instance,
                    &cwd,
                    None,
                    &CancellationToken::new(),
                )
                .await
                .unwrap();
                assert_eq!(
                    catalog["skills"].as_array().unwrap().len(),
                    if project_name == "empty" { 1 } else { 2 }
                );
                assert_eq!(catalog["skills"][0]["name"], "personal");
                if driver == "codex" {
                    assert_eq!(
                        catalog["issues"],
                        json!(["A separate skill could not load."])
                    );
                }
                if driver == "claudeAgent" {
                    assert!(
                        catalog["slashCommands"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|command| command["name"] == "manual-only")
                    );
                    assert!(
                        catalog["skills"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|skill| skill["name"] != "hidden-model-skill")
                    );
                    assert_eq!(
                        catalog["skills"][0]["path"],
                        "claude://skill/plugin:personal"
                    );
                }
                assert_eq!(
                    catalog["skills"][0]["invocation"],
                    if driver == "codex" { "dollar" } else { "slash" }
                );
            }
        }
    }

    #[tokio::test]
    async fn opencode_skill_catalogs_use_the_remote_workspace_directory() {
        use axum::{Json, Router, extract::Query, http::HeaderMap, routing::get};
        use std::collections::HashMap;
        let app = Router::new()
            .route(
                "/command",
                get(
                    |Query(query): Query<HashMap<String, String>>, headers: HeaderMap| async move {
                        assert_eq!(headers["authorization"], "Basic b3BlbmNvZGU6c2VjcmV0");
                        let cwd = query.get("directory").expect("workspace directory");
                        let name = Path::new(cwd).file_name().unwrap().to_str().unwrap();
                        let mut commands = vec![
                            json!({"name":"personal","source":"skill"}),
                            json!({"name":"review","source":"command"}),
                        ];
                        if name != "empty" {
                            commands.push(json!({"name":name,"source":"skill"}));
                        }
                        Json(json!(commands))
                    },
                ),
            )
            .route(
                "/agent",
                get(|Query(query): Query<HashMap<String, String>>| async move {
                    assert!(query.contains_key("directory"));
                    Json(json!([]))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let workspace = tempfile::tempdir().unwrap();
        let settings = json!({"providerInstances":{"remote":{"driver":"opencode","config":{"serverUrl":endpoint,"serverPassword":"secret"}}}});
        for project in ["empty", "first & #", "second"] {
            let cwd = workspace.path().join(project);
            tokio::fs::create_dir_all(&cwd).await.unwrap();
            let result = super::super::discover_capabilities(
                &settings,
                "remote",
                &cwd,
                None,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(result["skills"][0]["name"], "personal");
            assert_eq!(
                result["skills"].as_array().unwrap().len(),
                if project == "empty" { 1 } else { 2 }
            );
            if project != "empty" {
                assert_eq!(result["skills"][1]["name"], project);
            }
            assert_eq!(result["slashCommands"], json!([{"name":"review"}]));
        }
        server.abort();
        let _ = server.await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_opencode_skill_catalog_uses_the_configured_home_and_workspace() {
        const FIXTURE_PORT: &str = "BIBCODE_TEST_SKILLS_HTTP_PORT";
        if let Ok(port) = std::env::var(FIXTURE_PORT) {
            use axum::{Json, Router, extract::Query, http::HeaderMap, routing::get};
            use base64::Engine as _;
            let home = std::path::PathBuf::from(std::env::var_os("HOME").unwrap());
            assert!(home.join(".agents/skills/personal/SKILL.md").is_file());
            let app = Router::new()
                .route("/global/health", get(|| async { Json(json!({"healthy":true})) }))
                .route("/command", get(|Query(query): Query<HashMap<String, String>>, headers: HeaderMap| async move {
                    let cwd = std::env::current_dir().unwrap();
                    assert_eq!(query["directory"], cwd.to_string_lossy());
                    let password = std::env::var("OPENCODE_SERVER_PASSWORD").unwrap();
                    assert_eq!(headers["authorization"], format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}"))));
                    let name = cwd.file_name().unwrap().to_str().unwrap();
                    let mut commands = vec![json!({"name":"personal","source":"skill"})];
                    if name != "empty" {
                        commands.push(json!({"name":name,"source":"skill"}));
                    }
                    Json(json!(commands))
                }))
                .route("/agent", get(|Query(query): Query<HashMap<String, String>>| async move {
                    assert_eq!(query["directory"], std::env::current_dir().unwrap().to_string_lossy());
                    Json(json!([]))
                }));
            let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
                .await
                .unwrap();
            axum::serve(listener, app).await.unwrap();
            return;
        }
        let sandbox = TestSandbox::new("local-opencode-skills");
        let skill = sandbox.path("home/.agents/skills/personal");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "# Personal").unwrap();
        let binary = sandbox.executable_script("opencode", r#"
for argument in "$@"; do
  case "$argument" in --port=*) export BIBCODE_TEST_SKILLS_HTTP_PORT="${argument#--port=}" ;; esac
done
exec "$BIBCODE_TEST_EXECUTABLE" --exact production::provider_inventory::capabilities::tests::local_opencode_skill_catalog_uses_the_configured_home_and_workspace --nocapture
"#, "");
        let settings = json!({"providerInstances":{"local":{"driver":"opencode","config":{"binaryPath":binary},"environment":[
            {"name":"HOME","value":sandbox.path("home")},
            {"name":"BIBCODE_TEST_EXECUTABLE","value":std::env::current_exe().unwrap()}
        ]}}});
        for project in ["empty", "first & #", "second"] {
            let cwd = sandbox.path(project);
            std::fs::create_dir_all(&cwd).unwrap();
            // The local HTTP fixture compares against its process current_dir.
            let cwd = std::fs::canonicalize(cwd).unwrap();
            let result =
                discover_capabilities(&settings, "local", &cwd, None, &CancellationToken::new())
                    .await
                    .unwrap();
            assert_eq!(result["skills"][0]["name"], "personal");
            assert_eq!(
                result["skills"].as_array().unwrap().len(),
                if project == "empty" { 1 } else { 2 }
            );
            if project != "empty" {
                assert_eq!(result["skills"][1]["name"], project);
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_skill_discovery_reaps_each_native_probe() {
        for driver in ["codex", "claudeAgent", "opencode"] {
            let sandbox = TestSandbox::new("cancelled-skills");
            let pid_file = sandbox.path("pid");
            let binary = sandbox.executable_script(
                "slow-provider",
                "printf '%s' \"$$\" > \"$BIBCODE_TEST_PID\"\nexec sleep 60",
                "",
            );
            let settings = json!({"providerInstances":{"probe":{"driver":driver,"config":{"binaryPath":binary},"environment":[{"name":"HOME","value":sandbox.root()},{"name":"BIBCODE_TEST_PID","value":pid_file}]}}});
            let cancellation = CancellationToken::new();
            let task = tokio::spawn({
                let cancellation = cancellation.clone();
                let cwd = sandbox.root().to_path_buf();
                async move {
                    super::super::discover_capabilities(
                        &settings,
                        "probe",
                        &cwd,
                        None,
                        &cancellation,
                    )
                    .await
                }
            });
            let pid: libc::pid_t = timeout(Duration::from_secs(5), async {
                loop {
                    if let Ok(raw) = tokio::fs::read_to_string(&pid_file).await
                        && let Ok(pid) = raw.parse()
                    {
                        break pid;
                    }
                    sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("native probe started");
            cancellation.cancel();
            assert!(
                timeout(Duration::from_secs(5), task)
                    .await
                    .expect("probe stopped after cancellation")
                    .unwrap()
                    .is_err()
            );
            // SAFETY: signal 0 only checks the liveness of the fixture PID.
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                -1,
                "{driver} discovery child was not reaped"
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
        }
    }

    /// The slash menu of an OpenCode 2 server loads from its agent, command and skill lists alone,
    /// so a failing model list does not hide skills.
    #[tokio::test]
    async fn opencode_2_slash_catalogs_load_when_the_model_list_fails() {
        use axum::{Json, http::StatusCode, routing::get};
        let path = format!(
            "{}/tests/fixtures/opencode-v2/catalog.exchanges.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let exchanges: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("catalog fixture"))
                .expect("catalog JSON");
        let captured = |route: &str| {
            exchanges["exchanges"]
                .as_array()
                .unwrap()
                .iter()
                .find(|exchange| {
                    exchange["method"] == "GET"
                        && exchange["path"].as_str().unwrap().split('?').next() == Some(route)
                })
                .expect("captured catalog")["response"]
                .clone()
        };
        let mut app = opencode::server_fixtures::v2("secret").route(
            "/api/model",
            get(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
        );
        for route in ["/api/agent", "/api/command", "/api/skill"] {
            let response = captured(route);
            app = app.route(
                route,
                get(move || {
                    let response = response.clone();
                    async move { Json(response) }
                }),
            );
        }
        let (endpoint, server) = opencode::server_fixtures::serve(app).await;

        let capabilities =
            opencode_capabilities(&endpoint, Some("secret"), Path::new("/work/project"), None)
                .await;
        server.abort();

        let capabilities = capabilities.expect("the slash menu loads");
        assert!(
            capabilities
                .skills
                .iter()
                .any(|skill| skill["name"] == "report")
        );
        assert!(
            capabilities
                .slash_commands
                .iter()
                .any(|command| command["name"] == "review")
        );
    }

    #[cfg(unix)]
    fn antigravity_cap_settings(
        binary: &Path,
        home: &Path,
        enabled: bool,
        extra_env: Vec<Value>,
    ) -> Value {
        let mut environment = vec![
            json!({"name": "HOME", "value": home}),
            json!({"name": "USERPROFILE", "value": home}),
        ];
        environment.extend(extra_env);
        json!({
            "providerInstances": {
                "antigravity": {
                    "driver": "antigravity",
                    "enabled": enabled,
                    "config": { "binaryPath": binary },
                    "environment": environment,
                }
            }
        })
    }

    #[cfg(unix)]
    fn write_antigravity_skill(dir: &Path, name: &str, description: &str) {
        std::fs::create_dir_all(dir).expect("create skill dir");
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n# {name}\n"),
        )
        .expect("write SKILL.md");
    }

    #[cfg(unix)]
    fn antigravity_script(sandbox: &TestSandbox, name: &str, body: &str) -> std::path::PathBuf {
        sandbox.executable_script(name, body, "")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_skill_catalog_merges_commands_before_and_after_session_new_without_sending_prompt()
     {
        let sandbox = TestSandbox::new("antigravity-skills-before-after");
        let home = sandbox.path("home");
        let cwd = sandbox.path("workspace");
        std::fs::create_dir_all(cwd.join(".git")).expect("create .git");
        write_antigravity_skill(
            &cwd.join(".agents/skills/review-branch"),
            "review-branch",
            "Local review branch skill",
        );
        write_antigravity_skill(
            &cwd.join(".agents/skills/unused-local"),
            "unused-local",
            "Should be omitted when authoritative ACP catalog excludes it",
        );

        let before_requests = sandbox.path("before.requests");
        let before_update = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "session-before",
                "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [
                        { "name": "review-branch", "description": "ACP review branch skill" },
                        { "name": "plan", "description": "Plan changes", "input": { "hint": "goal" } }
                    ]
                }
            }
        });
        let before_bin = antigravity_script(
            &sandbox,
            "agy-before",
            &format!(
                r#"while IFS= read -r request; do
  printf '%s\n' "$request" >> '{requests}'
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,{init}}}\n' "$id" ;;
    *'"method":"session/new"'*)
      printf '%s\n' '{update}'
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"session-before"}}}}\n' "$id"
      ;;
    *'"method":"session/close"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
  esac
done"#,
                requests = before_requests.display(),
                init = super::super::tests::antigravity_initialize(1, "1.5.13", true),
                update = before_update,
            ),
        );

        let before_catalog = discover_capabilities(
            &antigravity_cap_settings(&before_bin, &home, true, vec![]),
            "antigravity",
            &cwd,
            None,
            &CancellationToken::new(),
        )
        .await
        .expect("before session/new catalog succeeds");
        assert_eq!(before_catalog["issues"], json!([]));
        assert_eq!(before_catalog["skills"].as_array().unwrap().len(), 1);
        assert_eq!(before_catalog["skills"][0]["name"], "review-branch");
        assert_eq!(
            before_catalog["skills"][0]["description"],
            "ACP review branch skill"
        );
        assert_eq!(before_catalog["skills"][0]["invocation"], "slash");
        assert_eq!(before_catalog["skills"][0]["scope"], "project");
        assert_eq!(before_catalog["slashCommands"].as_array().unwrap().len(), 1);
        assert_eq!(before_catalog["slashCommands"][0]["name"], "plan");
        assert_eq!(before_catalog["slashCommands"][0]["input"]["hint"], "goal");

        let recorded = super::super::tests::antigravity_requests(&before_requests);
        let methods: Vec<&str> = recorded
            .iter()
            .filter_map(|req| req.get("method").and_then(Value::as_str))
            .collect();
        assert_eq!(methods, vec!["initialize", "session/new", "session/close"]);
        assert_eq!(recorded[1]["params"]["cwd"], cwd.to_string_lossy().as_ref());
        assert!(!methods.iter().any(|m| m.contains("prompt")));

        // Subcase B: available_commands_update arrives shortly after session/new response without close.
        let after_update = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "session-after",
                "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [
                        { "name": "review-branch" },
                        { "name": "help", "description": "Show help" }
                    ]
                }
            }
        });
        let after_bin = antigravity_script(
            &sandbox,
            "agy-after",
            &format!(
                r#"while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,{init}}}\n' "$id" ;;
    *'"method":"session/new"'*)
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"session-after"}}}}\n' "$id"
      sleep 0.05
      printf '%s\n' '{update}'
      ;;
  esac
done"#,
                init = super::super::tests::antigravity_initialize(1, "1.5.13", false),
                update = after_update,
            ),
        );
        let after_catalog = discover_capabilities(
            &antigravity_cap_settings(&after_bin, &home, true, vec![]),
            "antigravity",
            &cwd,
            None,
            &CancellationToken::new(),
        )
        .await
        .expect("after session/new catalog succeeds");
        assert_eq!(after_catalog["skills"].as_array().unwrap().len(), 1);
        assert_eq!(after_catalog["skills"][0]["name"], "review-branch");
        assert_eq!(after_catalog["slashCommands"][0]["name"], "help");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_skill_catalog_drains_noisy_stderr_foreign_sessions_and_caps_overflow() {
        const SECRET: &str = "fixture-secret-drain-9a1b";
        let sandbox = TestSandbox::new("antigravity-skills-noisy-drain");
        let home = sandbox.path("home");
        let cwd = sandbox.path("workspace");
        std::fs::create_dir_all(cwd.join(".git")).expect("create .git");
        write_antigravity_skill(
            &cwd.join(".agents/skills/local-skill"),
            "local-skill",
            "Desc",
        );

        let target_update = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "target-session",
                "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [
                        { "name": "local-skill", "description": "Match local skill" },
                        { "name": "clean-cmd", "description": "Clean description" },
                        { "name": "tainted-cmd", "description": format!("Contains {SECRET} token") }
                    ]
                }
            }
        });
        let late_foreign = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "foreign-late",
                "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [{ "name": "foreign-late-cmd" }]
                }
            }
        });
        let bin = antigravity_script(
            &sandbox,
            "agy-noisy",
            &format!(
                r#"i=0
while [ "$i" -lt 400 ]; do
  printf 'stderr-noise-{secret}-padding-0123456789abcdef0123456789abcdef0123456789abcdef-%d\n' "$i" >&2
  i=$((i + 1))
done
while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*)
      printf '{{"jsonrpc":"2.0","method":"custom/unrelated","params":{{"payload":"noise"}}}}\n'
      printf '{{"jsonrpc":"2.0","id":9001,"method":"session/request_permission","params":{{}}}}\n'
      j=0
      while [ "$j" -lt 40 ]; do
        printf '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"foreign-%d","update":{{"sessionUpdate":"available_commands_update","availableCommands":[{{"name":"foreign-cmd-%d"}}]}}}}}}\n' "$j" "$j"
        j=$((j + 1))
      done
      printf '{{"jsonrpc":"2.0","id":%s,{init}}}\n' "$id"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' '{target_update}'
      printf '%s\n' '{late_foreign}'
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"target-session"}}}}\n' "$id"
      ;;
    *'"method":"session/close"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
  esac
done"#,
                secret = SECRET,
                init = super::super::tests::antigravity_initialize(1, "1.5.13", true),
                target_update = target_update,
                late_foreign = late_foreign,
            ),
        );

        let settings = antigravity_cap_settings(
            &bin,
            &home,
            true,
            vec![json!({"name": "ANTIGRAVITY_API_KEY", "value": SECRET, "sensitive": true})],
        );
        let catalog = discover_capabilities(
            &settings,
            "antigravity",
            &cwd,
            None,
            &CancellationToken::new(),
        )
        .await
        .expect("noisy probe succeeds cleanly");

        let serialized = catalog.to_string();
        assert!(
            !serialized.contains(SECRET),
            "configured secret leaked in catalog: {serialized}"
        );
        assert_eq!(catalog["skills"].as_array().unwrap().len(), 1);
        assert_eq!(catalog["skills"][0]["name"], "local-skill");
        let cmd_names: Vec<&str> = catalog["slashCommands"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|cmd| cmd["name"].as_str())
            .collect();
        assert_eq!(cmd_names, vec!["clean-cmd", "tainted-cmd"]);
        assert!(
            catalog["issues"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .any(|issue| issue.contains("truncated") || issue.contains("dropped")),
            "expected pre-response overflow notice in {:?}",
            catalog["issues"]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_skill_catalog_treats_authoritative_empty_list_as_empty() {
        let sandbox = TestSandbox::new("antigravity-skills-empty-auth");
        let home = sandbox.path("home");
        let cwd = sandbox.path("workspace");
        std::fs::create_dir_all(cwd.join(".git")).expect("create .git");
        write_antigravity_skill(&cwd.join(".agents/skills/local-only"), "local-only", "Desc");

        let empty_update = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "session-empty",
                "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": []
                }
            }
        });
        let bin = antigravity_script(
            &sandbox,
            "agy-empty-cmds",
            &format!(
                r#"while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,{init}}}\n' "$id" ;;
    *'"method":"session/new"'*)
      printf '%s\n' '{update}'
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"session-empty"}}}}\n' "$id"
      ;;
    *'"method":"session/close"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
  esac
done"#,
                init = super::super::tests::antigravity_initialize(1, "1.5.13", true),
                update = empty_update,
            ),
        );

        let catalog = discover_capabilities(
            &antigravity_cap_settings(&bin, &home, true, vec![]),
            "antigravity",
            &cwd,
            None,
            &CancellationToken::new(),
        )
        .await
        .expect("authoritative empty list succeeds");
        assert_eq!(catalog["skills"], json!([]));
        assert_eq!(catalog["slashCommands"], json!([]));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_skill_catalog_falls_back_to_local_skills_on_sign_out_old_cli_and_timeout()
    {
        const SECRET: &str = "fixture-secret-fallback-4c2d";
        let sandbox = TestSandbox::new("antigravity-skills-fallbacks");
        let home = sandbox.path("home");
        let cwd = sandbox.path("workspace");
        std::fs::create_dir_all(cwd.join(".git")).expect("create .git");
        write_antigravity_skill(
            &cwd.join(".agents/skills/local-skill"),
            "local-skill",
            "Desc",
        );

        // Case 1: -32000 Authentication required (tainted with secret in error data).
        let signed_out = antigravity_script(
            &sandbox,
            "agy-signed-out",
            &format!(
                r#"while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,{init}}}\n' "$id" ;;
    *'"method":"session/new"'*) printf '{{"jsonrpc":"2.0","id":%s,"error":{{"code":-32000,"message":"Authentication required","data":"{secret}"}}}}\n' "$id" ;;
  esac
done"#,
                init = super::super::tests::antigravity_initialize(1, "1.5.13", true),
                secret = SECRET,
            ),
        );
        let signed_out_catalog = discover_capabilities(
            &antigravity_cap_settings(
                &signed_out,
                &home,
                true,
                vec![json!({"name": "ANTIGRAVITY_API_KEY", "value": SECRET, "sensitive": true})],
            ),
            "antigravity",
            &cwd,
            None,
            &CancellationToken::new(),
        )
        .await
        .expect("signed-out falls back to local skills");
        assert_eq!(signed_out_catalog["skills"][0]["name"], "local-skill");
        assert_eq!(signed_out_catalog["skills"][0]["invocation"], "slash");
        assert!(
            !signed_out_catalog["issues"].as_array().unwrap().is_empty(),
            "expected sign-in notice in issues"
        );
        assert!(!signed_out_catalog.to_string().contains(SECRET));

        // Case 2: old CLI / immediate failure printing secret on stderr.
        let old_cli = antigravity_script(
            &sandbox,
            "agy-old-cli",
            &format!("printf 'secret=%s\\n' '{SECRET}' >&2\nexit 2"),
        );
        let old_catalog = discover_capabilities(
            &antigravity_cap_settings(
                &old_cli,
                &home,
                true,
                vec![json!({"name": "ANTIGRAVITY_API_KEY", "value": SECRET, "sensitive": true})],
            ),
            "antigravity",
            &cwd,
            None,
            &CancellationToken::new(),
        )
        .await
        .expect("old CLI falls back to local skills");
        assert_eq!(old_catalog["skills"][0]["name"], "local-skill");
        assert!(!old_catalog["issues"].as_array().unwrap().is_empty());
        assert!(!old_catalog.to_string().contains(SECRET));

        // Case 3: probe timeout stops child, releases attribution, and returns local fallback.
        let pid_file = sandbox.path("timeout.pid");
        let hanging_bin = antigravity_script(
            &sandbox,
            "agy-timeout",
            &format!(
                r#"printf '%s' "$$" > '{pid_file}'
while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,{init}}}\n' "$id" ;;
    *'"method":"session/new"'*) sleep 30 ;;
  esac
done"#,
                pid_file = pid_file.display(),
                init = super::super::tests::antigravity_initialize(1, "1.5.13", true),
            ),
        );
        let registry = ProcessAttributionRegistry::new();
        let env = vec![
            (OsString::from("HOME"), home.as_os_str().to_os_string()),
            (
                OsString::from("USERPROFILE"),
                home.as_os_str().to_os_string(),
            ),
        ];
        let timed_out = antigravity_capabilities_with_timeout(
            &hanging_bin,
            &cwd,
            &env,
            &[SECRET.to_owned()],
            Some(&registry),
            &CancellationToken::new(),
            Duration::from_millis(900),
        )
        .await
        .expect("timeout falls back to local skills");
        assert_eq!(timed_out.skills[0]["name"], "local-skill");
        assert!(
            timed_out
                .issues
                .iter()
                .any(|issue| issue.to_ascii_lowercase().contains("timed out")),
            "expected timeout issue: {:?}",
            timed_out.issues
        );
        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .expect("timeout pid written")
            .trim()
            .parse()
            .expect("valid pid");
        // SAFETY: signal 0 checks child process existence only.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert!(registry.registered_sources().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_skill_catalog_refuses_missing_executable_disabled_instance_and_missing_secret()
     {
        let sandbox = TestSandbox::new("antigravity-skills-refusals");
        let home = sandbox.path("home");
        let cwd = sandbox.path("workspace");
        std::fs::create_dir_all(&cwd).expect("create cwd");

        let ran_marker = sandbox.path("should-not-run");
        let valid_bin = antigravity_script(
            &sandbox,
            "agy-valid",
            &format!("touch '{}'\nexit 0", ran_marker.display()),
        );

        let missing_bin = sandbox.path("does-not-exist-agy");
        let err_missing = discover_capabilities(
            &antigravity_cap_settings(&missing_bin, &home, true, vec![]),
            "antigravity",
            &cwd,
            None,
            &CancellationToken::new(),
        )
        .await
        .expect_err("missing executable must error");
        assert!(err_missing.contains("executable"));

        let err_disabled = discover_capabilities(
            &antigravity_cap_settings(&valid_bin, &home, false, vec![]),
            "antigravity",
            &cwd,
            None,
            &CancellationToken::new(),
        )
        .await
        .expect_err("disabled instance must error");
        assert!(err_disabled.contains("disabled"));

        let err_secret = discover_capabilities(
            &antigravity_cap_settings(
                &valid_bin,
                &home,
                true,
                vec![json!({"name": "API_TOKEN", "value": "", "sensitive": true, "valueRedacted": true})],
            ),
            "antigravity",
            &cwd,
            None,
            &CancellationToken::new(),
        )
        .await
        .expect_err("missing secret must error");
        assert_eq!(err_secret, super::ANTIGRAVITY_MISSING_SECRET_MESSAGE);
        assert!(!ran_marker.exists(), "missing secret must not spawn CLI");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_skill_catalog_attributes_and_cleans_up_child_on_cancel_and_return() {
        let sandbox = TestSandbox::new("antigravity-skills-cancel-attr");
        let home = sandbox.path("home");
        let cwd = sandbox.path("workspace");
        std::fs::create_dir_all(&cwd).expect("create cwd");

        // Normal completion releases attribution registration.
        let ok_bin = antigravity_script(
            &sandbox,
            "agy-ok-attr",
            &format!(
                r#"while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,{init}}}\n' "$id" ;;
    *'"method":"session/new"'*)
      printf '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"available_commands_update","availableCommands":[]}}}}}}\n'
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"s1"}}}}\n' "$id"
      ;;
    *'"method":"session/close"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
  esac
done"#,
                init = super::super::tests::antigravity_initialize(1, "1.5.13", true),
            ),
        );
        let registry = ProcessAttributionRegistry::new();
        discover_capabilities(
            &antigravity_cap_settings(&ok_bin, &home, true, vec![]),
            "antigravity",
            &cwd,
            Some(&registry),
            &CancellationToken::new(),
        )
        .await
        .expect("normal discovery succeeds");
        assert!(
            registry.registered_sources().is_empty(),
            "attribution registration must drop on return: {:?}",
            registry.registered_sources()
        );

        // Cancellation reaps child and drops attribution registration.
        let pid_file = sandbox.path("cancel.pid");
        let hang_bin = antigravity_script(
            &sandbox,
            "agy-hang-cancel",
            &format!(
                "printf '%s' \"$$\" > '{}'\nexec sleep 60",
                pid_file.display()
            ),
        );
        let cancel_registry = Arc::new(ProcessAttributionRegistry::new());
        let cancellation = CancellationToken::new();
        let task = tokio::spawn({
            let settings = antigravity_cap_settings(&hang_bin, &home, true, vec![]);
            let cwd = cwd.clone();
            let registry = cancel_registry.clone();
            let cancellation = cancellation.clone();
            async move {
                discover_capabilities(
                    &settings,
                    "antigravity",
                    &cwd,
                    Some(&registry),
                    &cancellation,
                )
                .await
            }
        });
        let pid: libc::pid_t = timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(raw) = tokio::fs::read_to_string(&pid_file).await
                    && let Ok(pid) = raw.trim().parse::<u32>()
                    && cancel_registry
                        .registered_sources()
                        .iter()
                        .any(|(identity, source)| {
                            identity.pid == pid
                                && *source == crate::diagnostics::RegistrationSource::Provider
                        })
                {
                    break pid as libc::pid_t;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Antigravity capability child registered in attribution registry");

        cancellation.cancel();
        let outcome = timeout(Duration::from_secs(5), task)
            .await
            .expect("discovery exits after cancel")
            .expect("task joins");
        assert!(outcome.is_err(), "cancelled probe must return Err");
        // SAFETY: signal 0 checks child process existence only.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        assert!(
            cancel_registry.registered_sources().is_empty(),
            "attribution registration must clear on cancel: {:?}",
            cancel_registry.registered_sources()
        );
    }

    #[tokio::test]
    async fn antigravity_skill_catalog_cancels_and_bounds_local_skill_scan() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let err = timeout(
            Duration::from_millis(200),
            super::discover_antigravity_local_within(
                Duration::from_secs(15),
                &cancel,
                std::future::pending(),
            ),
        )
        .await
        .expect("cancelled local scan must return without stalling")
        .expect_err("cancelled local scan must return Err");
        assert!(err.to_ascii_lowercase().contains("cancel"));

        let timed_out = timeout(
            Duration::from_millis(250),
            super::discover_antigravity_local_within(
                Duration::from_millis(50),
                &CancellationToken::new(),
                std::future::pending(),
            ),
        )
        .await
        .expect("timed out local scan must return within bound")
        .expect("timed out local scan degrades cleanly with issue");
        assert!(timed_out.skills.is_empty());
        assert!(!timed_out.issues.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_skill_catalog_adds_issue_when_cli_omits_available_commands_update() {
        let sandbox = TestSandbox::new("antigravity-skills-missing-update");
        let home = sandbox.path("home");
        let cwd = sandbox.path("workspace");
        std::fs::create_dir_all(cwd.join(".git")).expect("create .git");
        write_antigravity_skill(
            &cwd.join(".agents/skills/local-skill"),
            "local-skill",
            "Desc",
        );

        let bin = antigravity_script(
            &sandbox,
            "agy-no-update",
            &format!(
                r#"while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,{init}}}\n' "$id" ;;
    *'"method":"session/new"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"s-no-update"}}}}\n' "$id" ;;
    *'"method":"session/close"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
  esac
done"#,
                init = super::super::tests::antigravity_initialize(1, "1.5.13", true),
            ),
        );

        let catalog = discover_capabilities(
            &antigravity_cap_settings(&bin, &home, true, vec![]),
            "antigravity",
            &cwd,
            None,
            &CancellationToken::new(),
        )
        .await
        .expect("omitted update still falls back cleanly");
        assert_eq!(catalog["skills"][0]["name"], "local-skill");
        let issues = catalog["issues"].as_array().unwrap();
        assert!(
            issues.iter().any(|issue| issue
                .as_str()
                .is_some_and(|s| s.contains("did not report its command list"))),
            "expected incomplete-catalog issue, got {issues:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_skill_catalog_retains_target_catalog_when_one_foreign_session_floods_updates()
     {
        let sandbox = TestSandbox::new("antigravity-skills-single-foreign-flood");
        let home = sandbox.path("home");
        let cwd = sandbox.path("workspace");
        std::fs::create_dir_all(cwd.join(".git")).expect("create .git");
        write_antigravity_skill(
            &cwd.join(".agents/skills/target-skill"),
            "target-skill",
            "Desc",
        );

        let target_update = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "target-session",
                "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [
                        { "name": "target-skill" },
                        { "name": "target-cmd" }
                    ]
                }
            }
        });
        let bin = antigravity_script(
            &sandbox,
            "agy-single-foreign-flood",
            &format!(
                r#"while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*)
      printf '%s\n' '{target_update}'
      j=0
      while [ "$j" -lt 40 ]; do
        printf '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"foreign-single","update":{{"sessionUpdate":"available_commands_update","availableCommands":[{{"name":"foreign-cmd-%d"}}]}}}}}}\n' "$j"
        j=$((j + 1))
      done
      printf '{{"jsonrpc":"2.0","id":%s,{init}}}\n' "$id"
      ;;
    *'"method":"session/new"'*)
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"target-session"}}}}\n' "$id"
      ;;
    *'"method":"session/close"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
  esac
done"#,
                target_update = target_update,
                init = super::super::tests::antigravity_initialize(1, "1.5.13", true),
            ),
        );

        let catalog = discover_capabilities(
            &antigravity_cap_settings(&bin, &home, true, vec![]),
            "antigravity",
            &cwd,
            None,
            &CancellationToken::new(),
        )
        .await
        .expect("single foreign flood does not evict target session");
        assert_eq!(catalog["skills"].as_array().unwrap().len(), 1);
        assert_eq!(catalog["skills"][0]["name"], "target-skill");
        assert_eq!(catalog["slashCommands"].as_array().unwrap().len(), 1);
        assert_eq!(catalog["slashCommands"][0]["name"], "target-cmd");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_skill_catalog_keeps_captured_catalog_if_session_close_stalls() {
        let sandbox = TestSandbox::new("antigravity-skills-close-stall");
        let home = sandbox.path("home");
        let cwd = sandbox.path("workspace");
        std::fs::create_dir_all(cwd.join(".git")).expect("create .git");
        write_antigravity_skill(&cwd.join(".agents/skills/fast-skill"), "fast-skill", "Desc");

        let update = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "fast-session",
                "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [
                        { "name": "fast-skill" },
                        { "name": "fast-cmd" }
                    ]
                }
            }
        });
        let bin = antigravity_script(
            &sandbox,
            "agy-close-stall",
            &format!(
                r#"while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,{init}}}\n' "$id" ;;
    *'"method":"session/new"'*)
      printf '%s\n' '{update}'
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"fast-session"}}}}\n' "$id"
      ;;
    *'"method":"session/close"'*) sleep 30 ;;
  esac
done"#,
                init = super::super::tests::antigravity_initialize(1, "1.5.13", true),
                update = update,
            ),
        );
        let env = vec![
            (OsString::from("HOME"), home.as_os_str().to_os_string()),
            (
                OsString::from("USERPROFILE"),
                home.as_os_str().to_os_string(),
            ),
        ];
        let capabilities = antigravity_capabilities_with_timeout(
            &bin,
            &cwd,
            &env,
            &[],
            None,
            &CancellationToken::new(),
            Duration::from_millis(900),
        )
        .await
        .expect("captured catalog survives stalled session/close");
        assert!(capabilities.issues.is_empty(), "{:?}", capabilities.issues);
        assert_eq!(capabilities.skills.len(), 1);
        assert_eq!(capabilities.skills[0]["name"], "fast-skill");
        assert_eq!(capabilities.slash_commands.len(), 1);
        assert_eq!(capabilities.slash_commands[0]["name"], "fast-cmd");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_skill_catalog_preserves_enum_fields_and_omits_secret_named_entries() {
        const SECRET_NAME: &str = "secret-cmd-name";
        let sandbox = TestSandbox::new("antigravity-skills-enum-scrub");
        let home = sandbox.path("home");
        let cwd = sandbox.path("workspace");
        std::fs::create_dir_all(cwd.join(".git")).expect("create .git");
        write_antigravity_skill(
            &cwd.join(".agents/skills/local-skill"),
            "local-skill",
            "Desc",
        );
        write_antigravity_skill(
            &cwd.join(format!(".agents/skills/{SECRET_NAME}")),
            SECRET_NAME,
            "Secret skill",
        );

        let update = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "enum-session",
                "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [
                        { "name": "local-skill", "description": "Match local skill" },
                        { "name": SECRET_NAME, "description": "Must be omitted" },
                        { "name": "safe-cmd", "description": format!("Uses {SECRET_NAME} safely"), "input": { "hint": SECRET_NAME } }
                    ]
                }
            }
        });
        let bin = antigravity_script(
            &sandbox,
            "agy-enum-scrub",
            &format!(
                r#"while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,{init}}}\n' "$id" ;;
    *'"method":"session/new"'*)
      printf '%s\n' '{update}'
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"enum-session"}}}}\n' "$id"
      ;;
    *'"method":"session/close"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
  esac
done"#,
                init = super::super::tests::antigravity_initialize(1, "1.5.13", true),
                update = update,
            ),
        );
        let settings = antigravity_cap_settings(
            &bin,
            &home,
            true,
            vec![
                json!({"name": "ENUM_LITERAL_SLASH", "value": "slash", "sensitive": true}),
                json!({"name": "ENUM_LITERAL_PROJECT", "value": "project", "sensitive": true}),
                json!({"name": "SECRET_CMD_TOKEN", "value": SECRET_NAME, "sensitive": true}),
            ],
        );
        let catalog = discover_capabilities(
            &settings,
            "antigravity",
            &cwd,
            None,
            &CancellationToken::new(),
        )
        .await
        .expect("enum scrub probe succeeds");

        assert_eq!(catalog["skills"].as_array().unwrap().len(), 1);
        assert_eq!(catalog["skills"][0]["name"], "local-skill");
        assert_eq!(catalog["skills"][0]["invocation"], "slash");
        assert_eq!(catalog["skills"][0]["scope"], "project");

        let commands = catalog["slashCommands"].as_array().unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["name"], "safe-cmd");
        assert!(!catalog.to_string().contains(SECRET_NAME));
    }
}
