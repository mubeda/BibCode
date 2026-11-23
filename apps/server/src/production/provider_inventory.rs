use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    future::Future,
    hash::{Hash, Hasher},
    path::Path,
    process::Stdio,
    sync::{Arc, PoisonError},
    time::Duration,
};

use process_wrap::tokio::{ChildWrapper, CommandWrap};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::Command,
    time::{sleep, timeout},
};
use tokio_util::sync::CancellationToken;

use crate::{
    diagnostics::profiler::exits::{self, Exited, Watch},
    diagnostics::{
        AttributionKind, AttributionScope, NativeProcessSampler, ProcessAttributionRegistry,
        ProcessRegistration, ProcessRegistrationMetadata, RegistrationSource,
    },
    git::{OutputPolicy, ProcessRequest, ProcessRunner},
    process::{
        Platform, configure_supervised_background_command_wrap,
        supervised::{
            StopPolicy, SupervisedOverflow, SupervisedRunRequest, log_cleanup_failures,
            run_supervised_with_spawn_observer, terminate_and_wait,
        },
    },
    production::provider_maintenance::{ProviderMaintenance, ProviderMaintenanceTarget},
    production::provider_runtime::{
        normalize_provider_environment, prepare_provider_launch,
        resolve_provider_executable_with_environment,
    },
    provider::{
        claude, codex, cursor, environment::sanitize_provider_subprocess_environment, grok,
        opencode,
    },
};

mod capabilities;
pub(crate) use capabilities::discover_capabilities;

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(not(test))]
const CURSOR_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(test)]
const CURSOR_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(6);
/// How long the session that reads Cursor's advertised model values may take; a CLI that does
/// not answer still publishes its model list.
#[cfg(not(test))]
const CURSOR_SESSION_READ_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const CURSOR_SESSION_READ_TIMEOUT: Duration = Duration::from_secs(2);
const ANTIGRAVITY_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
/// The close is courtesy: the catalog is already read and the child stops next.
const ANTIGRAVITY_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
/// BiBCode's own words: the CLI's error text never reaches the snapshot.
/// An instance whose stored sensitive value could not be read is not probed.
const ANTIGRAVITY_MISSING_SECRET_MESSAGE: &str = "A saved environment value of this instance could not be read, so it was not checked. Save the instance's environment again.";
const ANTIGRAVITY_SIGN_IN_MESSAGE: &str = "Antigravity is not signed in. Open an Antigravity Terminal and run `agy`, or run `agy acp --login`.";
const CLAUDE_CAPABILITIES_TIMEOUT: Duration = Duration::from_secs(45);
const CLAUDE_SKILLS_TIMEOUT: Duration = Duration::from_secs(10);
const CLAUDE_CAPABILITY_PROBE_ARGS: [&str; 12] = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--setting-sources=user,project,local",
    "--settings",
    r#"{"disableAllHooks":true}"#,
    "--permission-mode",
    "default",
    "--no-session-persistence",
];
const LOCAL_OPENCODE_HEALTH_TIMEOUT: Duration = Duration::from_millis(250);
const LOCAL_OPENCODE_INVENTORY_TIMEOUT: Duration = Duration::from_secs(30);
const LOCAL_OPENCODE_STARTUP_ATTEMPTS: usize = 50;
/// A configured OpenCode 2 server answered, but its catalogs could not be read.
const OPENCODE_2_CATALOG_UNREADABLE: &str = "BiBCode couldn't read this OpenCode server's models, agents and commands, so chats use its default model. They are read again at the next provider check.";
const PROBE_OUTPUT_LIMIT: usize = 256 * 1024;

#[derive(Clone)]
struct ProviderDefinition {
    instance_id: String,
    driver: String,
    display_name: Option<String>,
    enabled: bool,
    binary_path: String,
    available: bool,
    custom_models: Vec<String>,
    configured_model: Option<String>,
    configured_effort: Option<String>,
    configured_service_tier: Option<String>,
    endpoint: Option<String>,
    server_password: Option<String>,
    environment: Vec<(OsString, OsString)>,
    /// A sensitive variable is still redacted: its stored value could not be supplied.
    missing_secret: bool,
    /// The supplied values of sensitive variables: never part of a published version.
    secret_values: Vec<String>,
}

struct ProviderSessionDefaults {
    model: Option<String>,
    effort: Option<String>,
    service_tier: Option<String>,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCapabilities {
    slash_commands: Vec<Value>,
    skills: Vec<Value>,
    agents: Vec<Value>,
    issues: Vec<String>,
    /// The instance's chats report context-window usage. Codex and Claude always do; OpenCode
    /// only from version 2, which only a full probe can tell. Published as the provider
    /// snapshot's `supportsContextWindowUsage`, never with the workspace capabilities.
    #[serde(skip)]
    context_window_usage: bool,
}

struct ClaudeProbeMetadata {
    capabilities: ProviderCapabilities,
    models: Option<Vec<Value>>,
    skills_loaded: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum RichMetadataOutcome {
    #[default]
    NotRequested,
    Succeeded,
    Failed,
}

/// What a probe learned about the reads only an Antigravity session gives (sign-in, its
/// message, the probed catalog).
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum SessionReads {
    /// No session was opened (a quick probe, a reused catalog): the last reads stay, while the
    /// launch inputs are those they were read with.
    #[default]
    NotRead,
    /// A session answered: its reads replace the last ones.
    Read,
    /// The CLI failed its version check, a session could not be opened, or the launch inputs
    /// changed: nothing from the last reads stays.
    Lost,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ProviderProbeResult {
    pub(crate) snapshot: Value,
    pub(crate) rich_metadata: RichMetadataOutcome,
    pub(crate) models_authoritative: bool,
    pub(crate) session_reads: SessionReads,
    /// A digest of the binary path and environment the probe launched with.
    pub(crate) launch_inputs: u64,
    /// [`Self::launch_inputs`] with the configured custom models: what a reused catalog keys on.
    pub(crate) catalog_inputs: u64,
}

impl ProviderProbeResult {
    fn new(snapshot: Value, rich_metadata: RichMetadataOutcome) -> Self {
        Self {
            snapshot,
            rich_metadata,
            models_authoritative: rich_metadata == RichMetadataOutcome::Succeeded,
            ..Self::default()
        }
    }

    fn with_authoritative_models(mut self) -> Self {
        self.models_authoritative = true;
        self
    }
}

pub(crate) async fn probe(
    settings: &Value,
    selected: Option<&str>,
    cwd: &Path,
    maintenance: &ProviderMaintenance,
) -> Vec<ProviderProbeResult> {
    probe_inner(
        settings,
        selected,
        cwd,
        false,
        maintenance,
        None,
        &HashSet::new(),
    )
    .await
}

/// Probes with the slow capabilities too. `attribution` attributes the processes the probe
/// starts, when the runtime has attached a registry.
pub(crate) async fn probe_full(
    settings: &Value,
    selected: Option<&str>,
    cwd: &Path,
    maintenance: &ProviderMaintenance,
    attribution: Option<&ProcessAttributionRegistry>,
) -> Vec<ProviderProbeResult> {
    probe_full_reusing(
        settings,
        selected,
        cwd,
        maintenance,
        attribution,
        &HashSet::new(),
    )
    .await
}

/// [`probe_full`] that keeps the last ACP catalog of the instances in `reuse` instead of
/// probing it again (see [`antigravity_catalog_inputs`]).
pub(crate) async fn probe_full_reusing(
    settings: &Value,
    selected: Option<&str>,
    cwd: &Path,
    maintenance: &ProviderMaintenance,
    attribution: Option<&ProcessAttributionRegistry>,
    reuse: &HashSet<String>,
) -> Vec<ProviderProbeResult> {
    probe_inner(
        settings,
        selected,
        cwd,
        true,
        maintenance,
        attribution,
        reuse,
    )
    .await
}

/// The enabled Antigravity instances, each with the inputs of its catalog read (a digest: the
/// environment carries the stored secrets). An Antigravity probe opens a session in the user's
/// account, so after a signed-in read with these same inputs a full refresh within the refresh
/// TTL may reuse its catalog. Cursor's model list is always read again; the session it opens to
/// read the advertised model values is opened once per CLI and model list.
pub(crate) fn antigravity_catalog_inputs(settings: &Value) -> HashMap<String, u64> {
    definitions(settings)
        .into_iter()
        .filter(|definition| definition.driver == "antigravity" && definition.enabled)
        .map(|definition| {
            let inputs = catalog_inputs(&definition);
            (definition.instance_id, inputs)
        })
        .collect()
}

async fn probe_inner(
    settings: &Value,
    selected: Option<&str>,
    cwd: &Path,
    include_slow_capabilities: bool,
    maintenance: &ProviderMaintenance,
    attribution: Option<&ProcessAttributionRegistry>,
    reuse: &HashSet<String>,
) -> Vec<ProviderProbeResult> {
    let checks_enabled = settings
        .get("enableProviderUpdateChecks")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    futures_util::future::join_all(
        definitions(settings)
            .into_iter()
            .filter(|definition| selected.is_none_or(|id| id == definition.instance_id))
            .map(|definition| {
                let reuse_catalog = reuse.contains(&definition.instance_id);
                probe_one(
                    definition,
                    cwd,
                    include_slow_capabilities,
                    checks_enabled,
                    maintenance,
                    attribution,
                    reuse_catalog,
                )
            }),
    )
    .await
}

fn provider_is_enabled(driver: &str, configured: bool) -> bool {
    configured && driver != "grok"
}

fn default_provider_binary(driver: &str) -> &str {
    match driver {
        "cursor" => "cursor-agent",
        "antigravity" => "agy",
        other => other,
    }
}

/// The custom models a provider instance offers, read the way the catalog reads them: the
/// instance's own `customModels`, otherwise its driver's legacy provider settings. A launch
/// validates a turn's options with this list, so a custom model the catalog offers is accepted
/// the same way.
pub(crate) fn instance_custom_models(settings: &Value, instance_id: &str) -> Vec<String> {
    definitions(settings)
        .into_iter()
        .find(|definition| definition.instance_id == instance_id)
        .map(|definition| definition.custom_models)
        .unwrap_or_default()
}

/// The OpenCode instances that point at a server URL: their sessions run on a server the user
/// runs rather than on BiBCode's own child.
pub(crate) fn opencode_instances_with_server_url(settings: &Value) -> Vec<String> {
    definitions(settings)
        .into_iter()
        .filter(|definition| definition.driver == "opencode" && definition.endpoint.is_some())
        .map(|definition| definition.instance_id)
        .collect()
}

fn definitions(settings: &Value) -> Vec<ProviderDefinition> {
    let legacy = settings.get("providers").and_then(Value::as_object);
    let instances = settings.get("providerInstances").and_then(Value::as_object);
    let mut definitions = instances
        .filter(|instances| !instances.is_empty())
        .map(|instances| {
            instances
                .iter()
                .map(|(instance_id, instance)| {
                    let driver = instance
                        .get("driver")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    let legacy_settings = legacy.and_then(|providers| providers.get(driver));
                    let session_defaults = provider_session_defaults(settings, driver);
                    let config = instance.get("config");
                    ProviderDefinition {
                        instance_id: instance_id.clone(),
                        driver: driver.to_owned(),
                        display_name: instance
                            .get("displayName")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        enabled: provider_is_enabled(
                            driver,
                            crate::server_settings::provider_instance_enabled(
                                settings,
                                instance_id,
                            ),
                        ),
                        binary_path: string_setting(config, "binaryPath")
                            .or_else(|| string_setting(legacy_settings, "binaryPath"))
                            .unwrap_or_else(|| default_provider_binary(driver))
                            .to_owned(),
                        available: is_builtin_driver(driver),
                        custom_models: string_array(config, "customModels")
                            .or_else(|| string_array(legacy_settings, "customModels"))
                            .unwrap_or_default(),
                        configured_model: session_defaults.model,
                        configured_effort: session_defaults.effort,
                        configured_service_tier: session_defaults.service_tier,
                        endpoint: string_setting(config, "serverUrl")
                            .or_else(|| string_setting(config, "apiEndpoint"))
                            .or_else(|| string_setting(legacy_settings, "serverUrl"))
                            .or_else(|| string_setting(legacy_settings, "apiEndpoint"))
                            .filter(|value| !value.trim().is_empty())
                            .map(str::to_owned),
                        server_password: string_setting(config, "serverPassword")
                            .or_else(|| string_setting(legacy_settings, "serverPassword"))
                            .filter(|value| !value.is_empty())
                            .map(str::to_owned),
                        environment: provider_environment(instance),
                        missing_secret: instance
                            .get("environment")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .any(|entry| entry["valueRedacted"] == true),
                        secret_values: secret_values(instance),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for driver in [
        "codex",
        "claudeAgent",
        "cursor",
        "grok",
        "opencode",
        "antigravity",
    ] {
        // A configured instance may own a built-in's id from before that driver existed.
        if definitions
            .iter()
            .any(|definition| definition.driver == driver || definition.instance_id == driver)
        {
            continue;
        }
        let driver_settings = legacy.and_then(|providers| providers.get(driver));
        let session_defaults = provider_session_defaults(settings, driver);
        definitions.push(ProviderDefinition {
            instance_id: driver.to_owned(),
            driver: driver.to_owned(),
            display_name: None,
            // Raw settings carry no defaults; Antigravity must stay off until enabled.
            enabled: provider_is_enabled(
                driver,
                crate::server_settings::provider_instance_enabled(settings, driver),
            ),
            binary_path: string_setting(driver_settings, "binaryPath")
                .unwrap_or_else(|| default_provider_binary(driver))
                .to_owned(),
            available: true,
            custom_models: string_array(driver_settings, "customModels").unwrap_or_default(),
            configured_model: session_defaults.model,
            configured_effort: session_defaults.effort,
            configured_service_tier: session_defaults.service_tier,
            endpoint: string_setting(driver_settings, "serverUrl")
                .or_else(|| string_setting(driver_settings, "apiEndpoint"))
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned),
            server_password: string_setting(driver_settings, "serverPassword")
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            environment: Vec::new(),
            missing_secret: false,
            secret_values: Vec::new(),
        });
    }
    definitions
}

fn provider_session_defaults(settings: &Value, driver: &str) -> ProviderSessionDefaults {
    let session_default = settings
        .get("providerSessionDefaults")
        .and_then(Value::as_object)
        .and_then(|defaults| defaults.get(driver));
    let effort = ["reasoningEffort", "effort", "reasoning"]
        .into_iter()
        .find_map(|id| provider_option_value(session_default, id))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let service_tier = provider_option_value(session_default, "serviceTier")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            provider_option_value(session_default, "fastMode")
                .and_then(Value::as_bool)
                .map(|fast| if fast { "fast" } else { "default" }.to_owned())
        });
    ProviderSessionDefaults {
        model: session_default
            .and_then(|value| value.get("model"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        effort,
        service_tier,
    }
}

fn provider_option_value<'a>(session_default: Option<&'a Value>, id: &str) -> Option<&'a Value> {
    let options = session_default?.get("options")?;
    if let Some(selections) = options.as_array() {
        return selections
            .iter()
            .find(|selection| selection.get("id").and_then(Value::as_str) == Some(id))
            .and_then(|selection| selection.get("value"));
    }
    options.as_object()?.get(id)
}

fn string_setting<'a>(value: Option<&'a Value>, name: &str) -> Option<&'a str> {
    value?.get(name)?.as_str()
}

fn string_array(value: Option<&Value>, name: &str) -> Option<Vec<String>> {
    Some(
        value?
            .get(name)?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

/// The values of the instance's sensitive variables that were supplied (not redacted).
fn secret_values(instance: &Value) -> Vec<String> {
    instance
        .get("environment")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| entry["sensitive"] == true && entry["valueRedacted"] != true)
        .filter_map(|entry| entry.get("value").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn provider_environment(instance: &Value) -> Vec<(OsString, OsString)> {
    let environment = instance
        .get("environment")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| {
            !entry
                .get("valueRedacted")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let name = entry.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() {
                return None;
            }
            Some((
                OsString::from(name),
                OsString::from(
                    entry
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ),
            ))
        })
        .collect::<Vec<_>>();
    normalize_provider_environment(
        environment
            .iter()
            .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
    )
}

async fn probe_one(
    definition: ProviderDefinition,
    cwd: &Path,
    include_slow_capabilities: bool,
    checks_enabled: bool,
    maintenance: &ProviderMaintenance,
    attribution: Option<&ProcessAttributionRegistry>,
    reuse_catalog: bool,
) -> ProviderProbeResult {
    // A driver this build does not ship has no binary to look up or version to advise on.
    if !definition.available {
        return unavailable_result(&definition);
    }
    let target = maintenance_target_from_definition(&definition);
    let mut result = probe_one_snapshot(
        &definition,
        cwd,
        include_slow_capabilities,
        attribution,
        reuse_catalog,
    )
    .await;
    result.launch_inputs = launch_inputs(&definition);
    result.catalog_inputs = catalog_inputs(&definition);
    maintenance
        .enrich_snapshot(&target, &mut result.snapshot, checks_enabled)
        .await;
    result
}

/// A digest of what a probe and a chat launch with: the binary path and the environment.
fn launch_inputs(definition: &ProviderDefinition) -> u64 {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    (&definition.binary_path, &definition.environment).hash(&mut hasher);
    hasher.finish()
}

/// The launch inputs and the custom models: a catalog read with other ones is read again.
fn catalog_inputs(definition: &ProviderDefinition) -> u64 {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    (launch_inputs(definition), &definition.custom_models).hash(&mut hasher);
    hasher.finish()
}

fn maintenance_target_from_definition(
    definition: &ProviderDefinition,
) -> ProviderMaintenanceTarget {
    ProviderMaintenanceTarget {
        instance_id: definition.instance_id.clone(),
        driver: definition.driver.clone(),
        binary_path: definition.binary_path.clone(),
        environment: definition.environment.clone(),
    }
}

#[allow(dead_code)] // Used by Task 2 before running a provider update command.
pub(crate) fn maintenance_target(
    settings: &Value,
    provider: &str,
    instance_id: Option<&str>,
) -> Option<ProviderMaintenanceTarget> {
    definitions(settings)
        .into_iter()
        .find(|definition| {
            definition.driver == provider
                && instance_id.is_none_or(|id| id == definition.instance_id)
        })
        .as_ref()
        .map(maintenance_target_from_definition)
}

pub(crate) async fn probe_maintenance_target_version(
    target: &ProviderMaintenanceTarget,
    cwd: &Path,
) -> Option<String> {
    let executable = resolve_provider_executable_with_environment(
        &target.binary_path,
        target
            .environment
            .iter()
            .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
    )?;
    let version_probe = run_command(&executable, &["--version"], cwd, &target.environment);
    let about_probe = async {
        if target.driver == "cursor" {
            run_command(&executable, &["about"], cwd, &target.environment).await
        } else {
            None
        }
    };
    let (version_output, about_output) = tokio::join!(version_probe, about_probe);
    let version = normalize_provider_version(
        &target.driver,
        version_output
            .as_ref()
            .filter(|output| output.success)
            .and_then(|output| version_line(&target.driver, output)),
    );
    if target.driver != "cursor" {
        return version;
    }
    let about = about_output
        .filter(|output| output.success)
        .map(|output| cursor::parse_about_output(output.code, &output.stdout, &output.stderr));
    about.and_then(|about| about.version).or(version)
}

fn unavailable_result(definition: &ProviderDefinition) -> ProviderProbeResult {
    ProviderProbeResult::new(
        snapshot(
            definition,
            false,
            None,
            "disabled",
            json!({ "status": "unknown" }),
            provider_models_without_version(definition),
            ProviderCapabilities::default(),
            Some("Provider driver is unavailable in this build."),
            super::control::now_iso(),
            "unavailable",
        ),
        RichMetadataOutcome::NotRequested,
    )
}

/// The configured instances whose driver this build does not ship, as their snapshots. They
/// need no probe, so a settings change publishes them before the settings themselves (#347).
pub(crate) fn unsupported_instances(settings: &Value) -> Vec<ProviderProbeResult> {
    definitions(settings)
        .iter()
        .filter(|definition| !definition.available)
        .map(unavailable_result)
        .collect()
}

/// `reuse_catalog` skips Antigravity's session probe:
/// the last one stays through the merge.
async fn probe_one_snapshot(
    definition: &ProviderDefinition,
    cwd: &Path,
    include_slow_capabilities: bool,
    attribution: Option<&ProcessAttributionRegistry>,
    reuse_catalog: bool,
) -> ProviderProbeResult {
    if !definition.available {
        return unavailable_result(definition);
    }
    let checked_at = super::control::now_iso();
    let default_models = provider_models_without_version(definition);
    if !definition.enabled {
        return ProviderProbeResult::new(
            snapshot(
                definition,
                false,
                None,
                "disabled",
                json!({ "status": "unknown" }),
                default_models,
                ProviderCapabilities::default(),
                None,
                checked_at,
                "available",
            ),
            RichMetadataOutcome::NotRequested,
        );
    }
    if !include_slow_capabilities
        && definition.driver == "opencode"
        && definition.endpoint.is_some()
    {
        return ProviderProbeResult::new(
            snapshot(
                definition,
                true,
                None,
                "ready",
                json!({ "status": "unknown" }),
                default_models,
                ProviderCapabilities::default(),
                None,
                checked_at,
                "available",
            ),
            RichMetadataOutcome::NotRequested,
        );
    }
    if include_slow_capabilities
        && definition.driver == "opencode"
        && let Some(endpoint) = definition.endpoint.as_deref()
    {
        let protocol =
            match opencode_server_protocol(endpoint, definition.server_password.as_deref()).await {
                Ok(protocol) => protocol,
                Err(version) => {
                    return ProviderProbeResult::new(
                        snapshot(
                            definition,
                            true,
                            None,
                            "error",
                            json!({ "status": "unknown" }),
                            default_models,
                            ProviderCapabilities::default(),
                            Some(&opencode::unsupported_server_message(&version, false)),
                            checked_at,
                            "available",
                        ),
                        RichMetadataOutcome::Failed,
                    );
                }
            };
        if let Some(inventory) = probe_opencode(
            endpoint,
            definition.server_password.as_deref(),
            &definition.custom_models,
            protocol,
            cwd,
        )
        .await
        {
            let models = serde_json::to_value(inventory.models)
                .ok()
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_else(|| custom_models(&definition.custom_models));
            let capabilities = ProviderCapabilities {
                slash_commands: inventory.commands,
                skills: inventory.skills,
                agents: inventory.agents,
                context_window_usage: protocol == opencode::OpenCodeProtocol::V2,
                ..ProviderCapabilities::default()
            };
            return ProviderProbeResult::new(
                snapshot(
                    definition,
                    true,
                    None,
                    "ready",
                    inventory.auth,
                    models,
                    capabilities,
                    None,
                    checked_at,
                    "available",
                ),
                RichMetadataOutcome::Succeeded,
            );
        }
        if protocol == opencode::OpenCodeProtocol::V2 {
            // The server answered as OpenCode 2, so chats work without its catalogs; a local CLI
            // says nothing about it.
            return ProviderProbeResult::new(
                snapshot(
                    definition,
                    true,
                    None,
                    "ready",
                    json!({ "status": "unknown" }),
                    default_models,
                    ProviderCapabilities {
                        context_window_usage: true,
                        ..ProviderCapabilities::default()
                    },
                    Some(OPENCODE_2_CATALOG_UNREADABLE),
                    checked_at,
                    "available",
                ),
                RichMetadataOutcome::Failed,
            );
        }
    }
    let mut rich_metadata = if include_slow_capabilities {
        RichMetadataOutcome::Failed
    } else {
        RichMetadataOutcome::NotRequested
    };
    let Some(executable) = resolve_provider_executable_with_environment(
        &definition.binary_path,
        definition
            .environment
            .iter()
            .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
    ) else {
        return ProviderProbeResult::new(
            snapshot(
                definition,
                false,
                None,
                "error",
                json!({ "status": "unknown" }),
                default_models,
                ProviderCapabilities::default(),
                Some("Provider executable was not found."),
                checked_at,
                "available",
            ),
            rich_metadata,
        );
    };
    if !include_slow_capabilities {
        // A version BiBCode cannot drive must not read Ready until the full probe runs.
        if definition.driver == "opencode" {
            let output =
                run_command(&executable, &["--version"], cwd, &definition.environment).await;
            let version = normalize_provider_version(
                &definition.driver,
                output
                    .as_ref()
                    .and_then(|output| first_line(&output.stdout, &output.stderr)),
            );
            if let Some(opencode::OpenCodeCliSupport::Unsupported(unsupported)) =
                version.as_deref().map(opencode::cli_support)
            {
                return ProviderProbeResult::new(
                    snapshot(
                        definition,
                        true,
                        redact_secret_version(version, &definition.secret_values),
                        "error",
                        json!({ "status": "unknown" }),
                        default_models,
                        ProviderCapabilities::default(),
                        Some(unsupported),
                        checked_at,
                        "available",
                    ),
                    rich_metadata,
                );
            }
        }
        return ProviderProbeResult::new(
            snapshot(
                definition,
                true,
                None,
                "ready",
                json!({ "status": "unknown" }),
                default_models,
                ProviderCapabilities {
                    slash_commands: built_in_slash_commands(&definition.driver),
                    ..ProviderCapabilities::default()
                },
                None,
                checked_at,
                "available",
            ),
            rich_metadata,
        );
    }

    let version_output = if definition.driver == "antigravity" {
        run_antigravity_version(&executable, cwd, &definition.environment, attribution).await
    } else {
        run_command(&executable, &["--version"], cwd, &definition.environment).await
    };
    let version = version_output
        .as_ref()
        // A failed Antigravity `--version` may print anything, an account included.
        .filter(|output| output.success || definition.driver != "antigravity")
        .and_then(|output| version_line(&definition.driver, output));
    // The peer's own text, before any parsing could strip what identifies a stored secret.
    let mut raw_versions = version.iter().cloned().collect::<Vec<_>>();
    let mut version = normalize_provider_version(&definition.driver, version);
    let mut installed = version_output.is_some();
    let mut status = match version_output.as_ref() {
        Some(output) if output.success => "ready",
        Some(_) => "warning",
        None => "error",
    };
    let mut auth = json!({ "status": "unknown" });
    let mut models = default_models;
    let mut capabilities = ProviderCapabilities {
        slash_commands: built_in_slash_commands(&definition.driver),
        ..ProviderCapabilities::default()
    };
    let mut message = match version_output.as_ref() {
        Some(output) if !output.success => Some("Provider executable returned a non-zero status."),
        None => Some("Provider executable could not be started."),
        Some(_) => None,
    };

    let mut versioned_model_catalog = false;
    // A CLI that fails its version check keeps nothing an earlier session read.
    let mut session_reads = if version_output.as_ref().is_some_and(|output| output.success) {
        SessionReads::NotRead
    } else {
        SessionReads::Lost
    };
    match definition.driver.as_str() {
        "codex" => {
            if include_slow_capabilities
                && let Some(inventory) = probe_codex(
                    &definition.instance_id,
                    &executable,
                    cwd,
                    &definition.custom_models,
                    &definition.environment,
                )
                .await
            {
                installed = true;
                rich_metadata = RichMetadataOutcome::Succeeded;
                (status, auth, message) = codex_probe_health(&inventory.account);
                models = serde_json::to_value(inventory.models)
                    .ok()
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or(models);
                capabilities.skills = codex_skill_inventory(&inventory.skills);
            }
        }
        "cursor" => {
            if let Some(output) =
                run_command(&executable, &["about"], cwd, &definition.environment).await
            {
                let about = cursor::parse_about_output(output.code, &output.stdout, &output.stderr);
                installed = true;
                status = if about.status == "ready" {
                    "ready"
                } else {
                    "error"
                };
                auth = about.auth;
                let workspace_capabilities =
                    cursor::discover_workspace_capabilities_with_environment(
                        cwd,
                        &definition.environment,
                    )
                    .await;
                capabilities.slash_commands = merge_slash_commands(
                    workspace_capabilities.slash_commands,
                    capabilities.slash_commands,
                );
                capabilities.skills = workspace_capabilities.skills;
                capabilities.agents = workspace_capabilities.agents;
                if include_slow_capabilities
                    && let Some(discovered) = probe_cursor_models(
                        &executable,
                        about.version.as_deref(),
                        definition.endpoint.as_deref(),
                        &definition.custom_models,
                        cwd,
                        &definition.environment,
                    )
                    .await
                {
                    models = discovered;
                    rich_metadata = RichMetadataOutcome::Succeeded;
                }
                // `about` returns before the shared check below. Its version, or the
                // `--version` line when `about` has none, is still a published field.
                let published_version =
                    redact_secret_version(about.version.or(version), &definition.secret_values);
                return ProviderProbeResult::new(
                    snapshot_owned_message(
                        definition,
                        installed,
                        published_version,
                        status,
                        auth,
                        models,
                        capabilities,
                        about.message,
                        checked_at,
                    ),
                    rich_metadata,
                );
            }
        }
        "claudeAgent" => {
            let mut model_catalog_complete = false;
            if version_output.as_ref().is_some_and(|output| output.success)
                && let Some(version) = version.as_deref()
            {
                models = claude::model::models_for_version(version, &definition.custom_models);
                model_catalog_complete = true;
                versioned_model_catalog = true;
            }
            if let Some(output) = run_command(
                &executable,
                &["auth", "status", "--json"],
                cwd,
                &definition.environment,
            )
            .await
            {
                auth = claude_auth(&output.stdout);
                if auth["status"] == "unauthenticated" {
                    status = "warning";
                    message = Some("Claude is installed but not authenticated.");
                }
            }
            if include_slow_capabilities
                && let Some(mut discovered) = probe_claude_metadata(
                    &executable,
                    cwd,
                    &definition.environment,
                    &definition.custom_models,
                )
                .await
            {
                if let Some(discovered_models) = discovered.models.take() {
                    models = discovered_models;
                    model_catalog_complete = true;
                    versioned_model_catalog = true;
                }
                capabilities = discovered.capabilities;
                capabilities.slash_commands = merge_slash_commands(
                    capabilities.slash_commands,
                    built_in_slash_commands(&definition.driver),
                );
                apply_agent_options(&mut models, &capabilities.agents);
                if model_catalog_complete && discovered.skills_loaded {
                    rich_metadata = RichMetadataOutcome::Succeeded;
                }
            }
        }
        "opencode" => {
            // Chats with a Server URL run on that server, whose own API answered above.
            capabilities.context_window_usage = definition.endpoint.is_none()
                && matches!(
                    version.as_deref().map(opencode::cli_support),
                    Some(opencode::OpenCodeCliSupport::Supported(
                        opencode::OpenCodeProtocol::V2
                    ))
                );
            // A version BiBCode cannot drive is reported without starting its server.
            if let Some(opencode::OpenCodeCliSupport::Unsupported(unsupported)) =
                version.as_deref().map(opencode::cli_support)
            {
                status = "error";
                message = Some(unsupported);
            } else if include_slow_capabilities
                && let Some(inventory) = probe_local_opencode(
                    &executable,
                    cwd,
                    &definition.custom_models,
                    &definition.environment,
                )
                .await
            {
                rich_metadata = RichMetadataOutcome::Succeeded;
                status = "ready";
                auth = inventory.auth;
                models = serde_json::to_value(inventory.models)
                    .ok()
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or(models);
                capabilities.slash_commands = inventory.commands;
                capabilities.agents = inventory.agents;
                capabilities.skills = inventory.skills;
                message = None;
            }
        }
        "grok" if version_output.as_ref().is_some_and(|output| output.success) => {
            rich_metadata = RichMetadataOutcome::Succeeded;
        }
        "antigravity"
            if include_slow_capabilities
                && !reuse_catalog
                && version_output.as_ref().is_some_and(|output| output.success) =>
        {
            // A stored secret that could not be read: probing without it would read another
            // account than the chat launches with (which refuses to start), so nothing is read.
            let catalog = if definition.missing_secret {
                message = Some(ANTIGRAVITY_MISSING_SECRET_MESSAGE);
                None
            } else {
                probe_antigravity_catalog(
                    &definition.instance_id,
                    &executable,
                    &definition.custom_models,
                    &definition.environment,
                    attribution,
                )
                .await
            };
            // A session that could not be opened or answered keeps nothing an earlier one read.
            session_reads = if catalog.is_some() {
                SessionReads::Read
            } else {
                SessionReads::Lost
            };
            match catalog {
                Some(AntigravityCatalog::Session {
                    models: discovered,
                    version: agent_version,
                }) => {
                    auth = json!({ "status": "authenticated" });
                    if let Some(agent_version) = agent_version {
                        if let Some(release) = release_version(&agent_version) {
                            version = Some(release);
                        }
                        raw_versions.push(agent_version);
                    }
                    // A reply that listed no model keeps the last catalog until the next probe.
                    if let Some(discovered) = discovered {
                        models = discovered;
                        rich_metadata = RichMetadataOutcome::Succeeded;
                    }
                }
                Some(AntigravityCatalog::SignInRequired) => {
                    // Still ready: the terminal is where the user signs in.
                    auth = json!({ "status": "unauthenticated" });
                    message = Some(ANTIGRAVITY_SIGN_IN_MESSAGE);
                    // The signed-out account's catalog is gone with it.
                    versioned_model_catalog = true;
                }
                None => {}
            }
        }
        _ => {}
    }

    // A CLI that echoes its environment can print a secret shaped like a release number. The
    // raw text is checked, since the parser drops a leading `v` (`v1.2.3` publishes `1.2.3`).
    let leaks_secret = raw_versions
        .iter()
        .any(|raw| text_holds_secret(raw, &definition.secret_values));
    let version = version.filter(|_| !leaks_secret);
    let mut result = ProviderProbeResult::new(
        snapshot(
            definition,
            installed,
            version,
            status,
            auth,
            models,
            capabilities,
            message,
            checked_at,
            "available",
        ),
        rich_metadata,
    );
    result.session_reads = session_reads;
    if versioned_model_catalog {
        result.with_authoritative_models()
    } else {
        result
    }
}

fn provider_models_without_version(definition: &ProviderDefinition) -> Vec<Value> {
    match definition.driver.as_str() {
        "codex" => codex::model::fallback_models(
            definition.configured_model.as_deref(),
            definition.configured_effort.as_deref(),
            definition.configured_service_tier.as_deref(),
            &definition.custom_models,
        ),
        "claudeAgent" => claude::model::all_models(&definition.custom_models),
        "grok" => serde_json::to_value(grok::model::default_models(&definition.custom_models))
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_else(|| custom_models(&definition.custom_models)),
        _ => custom_models(&definition.custom_models),
    }
}

fn codex_skill_inventory(skills: &[codex::CodexProviderSkill]) -> Vec<Value> {
    skills
        .iter()
        .filter_map(|skill| serde_json::to_value(skill).ok())
        .map(|mut skill| {
            skill["invocation"] = json!("dollar");
            skill
        })
        .collect()
}

fn built_in_slash_commands(driver: &str) -> Vec<Value> {
    match driver {
        "codex" => vec![
            slash_command(
                "goal",
                "Set a completion condition and keep working until it is met",
                Some("<condition>"),
            ),
            slash_command(
                "compact",
                "Compact the conversation to free up context",
                None,
            ),
        ],
        "claudeAgent" => vec![
            slash_command(
                "goal",
                "Set a completion condition and keep working until it is met",
                Some("[condition|clear]"),
            ),
            slash_command(
                "loop",
                "Run a prompt repeatedly while the session stays open",
                Some("[interval] [prompt]"),
            ),
        ],
        "cursor" => vec![
            slash_command("models", "List and switch Cursor models", None),
            slash_command(
                "auto-run",
                "Configure automatic command execution",
                Some("[on|off|status]"),
            ),
            slash_command("new-chat", "Start a new Cursor chat", None),
            slash_command("vim", "Toggle Vim keys", None),
            slash_command("help", "Show Cursor command help", Some("[command]")),
            slash_command("feedback", "Send feedback to Cursor", Some("<message>")),
            slash_command("resume", "Resume a Cursor chat", Some("<chat>")),
            slash_command("copy-req-id", "Copy the last Cursor request ID", None),
            slash_command("rules", "Create or edit Cursor rules", None),
            slash_command("commands", "Create or edit Cursor commands", None),
            slash_command("mcp", "Manage Cursor MCP servers", Some("[enable|disable]")),
            slash_command("max-mode", "Toggle Cursor max mode", Some("[on|off]")),
            slash_command("compress", "Compress the current Cursor context", None),
            slash_command("add-plugin", "Install a Cursor plugin", None),
            slash_command("logout", "Sign out from Cursor", None),
            slash_command("quit", "Exit the Cursor session", None),
        ],
        "grok" => vec![
            slash_command("loop", "Run a prompt repeatedly", Some("[prompt]")),
            slash_command("agents", "List and manage Grok agents", None),
            slash_command("skills", "List available Grok skills", None),
        ],
        _ => Vec::new(),
    }
}

fn slash_command(name: &str, description: &str, hint: Option<&str>) -> Value {
    let mut command = json!({
        "name": name,
        "description": description,
    });
    if let Some(hint) = hint.filter(|value| !value.trim().is_empty()) {
        command["input"] = json!({ "hint": hint });
    }
    command
}

fn parse_claude_initialization_response(
    response: &Value,
    custom_models: &[String],
) -> ClaudeProbeMetadata {
    ClaudeProbeMetadata {
        capabilities: ProviderCapabilities {
            slash_commands: parse_command_values(response.get("commands")),
            skills: Vec::new(),
            agents: response
                .get("agents")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|agent| {
                    let name = agent.get("name")?.as_str()?.trim();
                    if name.is_empty() {
                        return None;
                    }
                    let mut result = json!({ "name": name });
                    copy_non_empty_string(agent, &mut result, "description");
                    copy_non_empty_string(agent, &mut result, "model");
                    Some(result)
                })
                .collect(),
            ..ProviderCapabilities::default()
        },
        models: claude::model::models_from_initialization(response, custom_models),
        skills_loaded: false,
    }
}

fn parse_claude_skills_response(response: &Value, initialization: &Value) -> Option<Vec<Value>> {
    // reload_skills includes model-only skills; initialize is the native user-visible menu.
    let mut visible = HashMap::new();
    let mut aliases = HashMap::new();
    for command in initialization.get("commands")?.as_array()? {
        let Some(name) = command.get("name").and_then(Value::as_str) else {
            continue;
        };
        let name = name.trim().trim_start_matches('/');
        if name.is_empty() {
            continue;
        }
        visible.entry(name.to_ascii_lowercase()).or_insert(name);
        for alias in command
            .get("aliases")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            aliases
                .entry(alias.trim().trim_start_matches('/').to_ascii_lowercase())
                .or_insert(name);
        }
    }
    let mut seen = HashSet::new();
    Some(
        response
            .get("skills")?
            .as_array()?
            .iter()
            .filter_map(|skill| {
                let id = skill.get("name")?.as_str()?.trim().trim_start_matches('/');
                let key = id.to_ascii_lowercase();
                // Native command lookup prefers every primary name over any alias.
                let name = visible.get(&key).or_else(|| aliases.get(&key))?;
                if !seen.insert(name.to_ascii_lowercase()) {
                    return None;
                }
                let mut result = json!({
                    "name": name,
                    "path": format!("claude://skill/{id}"),
                    "scope": "provider",
                    "enabled": true,
                    "invocation": "slash",
                });
                copy_non_empty_string(skill, &mut result, "description");
                Some(result)
            })
            .collect(),
    )
}

fn parse_command_values(value: Option<&Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|command| {
            let name = command
                .get("name")?
                .as_str()?
                .trim()
                .trim_start_matches('/');
            if name.is_empty() || !seen.insert(name.to_ascii_lowercase()) {
                return None;
            }
            let mut result = json!({ "name": name });
            copy_non_empty_string(command, &mut result, "description");
            if let Some(hint) = command
                .get("argumentHint")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|hint| !hint.is_empty())
            {
                result["input"] = json!({ "hint": hint });
            }
            Some(result)
        })
        .collect()
}

fn merge_slash_commands(mut commands: Vec<Value>, fallbacks: Vec<Value>) -> Vec<Value> {
    let mut seen = commands
        .iter()
        .filter_map(|command| command.get("name").and_then(Value::as_str))
        .map(str::to_ascii_lowercase)
        .collect::<HashSet<_>>();
    commands.extend(fallbacks.into_iter().filter(|command| {
        command
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| seen.insert(name.to_ascii_lowercase()))
    }));
    commands
}

fn copy_non_empty_string(source: &Value, target: &mut Value, key: &str) {
    if let Some(value) = source
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        target[key] = json!(value);
    }
}

fn apply_agent_options(models: &mut [Value], agents: &[Value]) {
    let default_agent = agents
        .iter()
        .find(|agent| agent["name"] == crate::provider::claude::model::DEFAULT_AGENT)
        .or_else(|| agents.first())
        .and_then(|agent| agent.get("name"))
        .and_then(Value::as_str);
    let options = agents
        .iter()
        .filter_map(|agent| {
            let name = agent.get("name")?.as_str()?;
            let mut option = json!({
                "id": name,
                "label": name,
            });
            if Some(name) == default_agent {
                option["isDefault"] = json!(true);
            }
            Some(option)
        })
        .collect::<Vec<_>>();
    if options.is_empty() {
        return;
    }
    for model in models {
        let capabilities = model
            .as_object_mut()
            .and_then(|model| model.get_mut("capabilities"))
            .and_then(Value::as_object_mut);
        let Some(capabilities) = capabilities else {
            continue;
        };
        let descriptors = capabilities
            .entry("optionDescriptors")
            .or_insert_with(|| json!([]));
        let Some(descriptors) = descriptors.as_array_mut() else {
            continue;
        };
        descriptors.retain(|descriptor| descriptor["id"] != "agent");
        descriptors.push(json!({
            "id": "agent",
            "label": "Agent",
            "type": "select",
            "options": options.clone(),
            "currentValue": default_agent,
        }));
    }
}

async fn probe_claude_metadata(
    executable: &Path,
    cwd: &Path,
    environment: &[(OsString, OsString)],
    custom_models: &[String],
) -> Option<ClaudeProbeMetadata> {
    probe_claude_metadata_with_cancellation(
        executable,
        cwd,
        environment,
        custom_models,
        &CancellationToken::new(),
    )
    .await
}

async fn probe_claude_metadata_with_cancellation(
    executable: &Path,
    cwd: &Path,
    environment: &[(OsString, OsString)],
    custom_models: &[String],
    cancellation: &CancellationToken,
) -> Option<ClaudeProbeMetadata> {
    let launch = prepare_provider_launch(executable, CLAUDE_CAPABILITY_PROBE_ARGS).ok()?;
    let mut command = Command::new(launch.program);
    command
        .args(launch.args)
        .current_dir(cwd)
        .envs(environment.iter().cloned())
        .env("CLAUDE_CODE_ENTRYPOINT", "sdk-rust")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    sanitize_provider_subprocess_environment(&mut command);
    let mut child = supervised_command(command).spawn().ok()?;
    let probe = async {
        let mut stdin = child.stdin().take()?;
        let stdout = child.stdout().take()?;
        let mut lines = BufReader::new(stdout).lines();

        write_claude_control_request(&mut stdin, "bibcode-inventory", "initialize")
            .await
            .ok()?;
        let initialization = timeout(
            CLAUDE_CAPABILITIES_TIMEOUT,
            read_claude_control_response(&mut lines, "bibcode-inventory"),
        )
        .await
        .ok()
        .flatten()?;
        let mut metadata = parse_claude_initialization_response(&initialization, custom_models);

        let skills = if write_claude_control_request(&mut stdin, "bibcode-skills", "reload_skills")
            .await
            .is_ok()
        {
            timeout(
                CLAUDE_SKILLS_TIMEOUT,
                read_claude_control_response(&mut lines, "bibcode-skills"),
            )
            .await
            .ok()
            .flatten()
            .and_then(|response| parse_claude_skills_response(&response, &initialization))
        } else {
            None
        };
        let _ = stdin.shutdown().await;
        if let Some(skills) = skills {
            metadata.capabilities.skills = skills;
            metadata.skills_loaded = true;
        }
        Some(metadata)
    };
    let result = tokio::select! {
        biased;
        () = cancellation.cancelled() => None,
        result = probe => result,
    };
    stop_supervised_child(&mut *child).await;
    result
}

async fn write_claude_control_request(
    stdin: &mut tokio::process::ChildStdin,
    request_id: &str,
    subtype: &str,
) -> std::io::Result<()> {
    let mut bytes = serde_json::to_vec(&json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": subtype },
    }))
    .map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    stdin.write_all(&bytes).await?;
    stdin.flush().await
}

async fn read_claude_control_response<R: AsyncBufRead + Unpin>(
    lines: &mut Lines<R>,
    request_id: &str,
) -> Option<Value> {
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(response) = value.get("response") else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("control_response")
            && response.get("request_id").and_then(Value::as_str) == Some(request_id)
            && response.get("subtype").and_then(Value::as_str) == Some("success")
        {
            return response.get("response").cloned();
        }
    }
    None
}

struct CommandOutput {
    success: bool,
    code: i32,
    stdout: String,
    stderr: String,
}

async fn run_command(
    executable: &Path,
    args: &[&str],
    cwd: &Path,
    environment: &[(OsString, OsString)],
) -> Option<CommandOutput> {
    let launch = prepare_provider_launch(executable, args).ok()?;
    let environment = normalize_provider_environment(
        environment
            .iter()
            .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
    );
    let output = ProcessRunner
        .run(
            ProcessRequest {
                operation: "provider.inventory.probe".to_owned(),
                command: launch.program,
                args: launch.args,
                cwd: cwd.to_path_buf(),
                env: environment,
                stdin: None,
                timeout: PROBE_TIMEOUT,
                max_output_bytes: PROBE_OUTPUT_LIMIT,
                output_policy: OutputPolicy::Truncate,
                append_truncation_marker: true,
                allow_non_zero_exit: true,
            },
            &CancellationToken::new(),
        )
        .await
        .ok()?;
    Some(CommandOutput {
        success: output.exit_code == 0,
        code: output.exit_code,
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

/// Logs why a Codex inventory probe learned no sign-in type: the step and the kind of failure,
/// never the reply, the account or its email. A launch then cannot tell whether a stored model
/// is retired under a ChatGPT sign-in.
fn warn_codex_sign_in_unknown(instance_id: &str, step: &str, failure: &str) {
    tracing::warn!(
        instance_id,
        step,
        failure,
        "the Codex inventory probe learned no sign-in type"
    );
}

/// The step a Codex inventory probe failed at and the kind of failure, without the reply.
fn codex_probe_failure(error: &codex::runtime::RuntimeError) -> (String, String) {
    use codex::ProtocolError;
    use codex::runtime::RuntimeError;
    match error {
        RuntimeError::Protocol(ProtocolError::RemoteRequest { method, code, .. }) => {
            (method.clone(), format!("error {code}"))
        }
        RuntimeError::Protocol(ProtocolError::Closed { .. }) => {
            ("probe".to_owned(), "connection closed".to_owned())
        }
        RuntimeError::Protocol(_) => ("probe".to_owned(), "protocol failure".to_owned()),
        RuntimeError::InvalidPayload { .. } => ("probe".to_owned(), "invalid reply".to_owned()),
        _ => ("probe".to_owned(), "failed".to_owned()),
    }
}

async fn probe_codex(
    instance_id: &str,
    executable: &Path,
    cwd: &Path,
    custom_models: &[String],
    environment: &[(OsString, OsString)],
) -> Option<codex::CodexProviderSnapshot> {
    let launch = prepare_provider_launch(executable, ["app-server"]).ok()?;
    let mut command = Command::new(launch.program);
    command.current_dir(cwd).envs(environment.iter().cloned());
    sanitize_provider_subprocess_environment(&mut command);
    command
        .args(launch.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The launch error names local paths, so only the kind of failure is logged.
    let Ok(mut child) = supervised_command(command).spawn() else {
        warn_codex_sign_in_unknown(instance_id, "launch", "could not start");
        return None;
    };
    let stdout = child.stdout().take()?;
    let stdin = child.stdin().take()?;
    let stderr = child.stderr().take()?;
    let (connection, _incoming) =
        codex::JsonRpcConnection::spawn(stdout, stdin, stderr, codex::ConnectionConfig::default());
    let cwd = cwd.to_string_lossy().into_owned();
    let result = match timeout(
        PROBE_TIMEOUT,
        codex::probe_provider(&connection, env!("CARGO_PKG_VERSION"), &cwd, custom_models),
    )
    .await
    {
        Ok(Ok(snapshot)) => {
            let auth = codex_auth(&snapshot.account);
            if auth.get("type").is_none() {
                let failure = if auth["status"] == "authenticated" {
                    "no sign-in type in the reply"
                } else {
                    "no account in the reply"
                };
                warn_codex_sign_in_unknown(instance_id, "account/read", failure);
            }
            Some(snapshot)
        }
        Ok(Err(error)) => {
            let (step, failure) = codex_probe_failure(&error);
            warn_codex_sign_in_unknown(instance_id, &step, &failure);
            None
        }
        Err(_) => {
            warn_codex_sign_in_unknown(instance_id, "probe", "timed out");
            None
        }
    };
    connection.close().await;
    stop_supervised_child(&mut *child).await;
    result
}

enum AntigravityCatalog {
    /// A session opened, so the CLI is signed in. `models` is `None` when the reply listed no
    /// model; `version` is the handshake's raw `agentInfo.version`, checked against the stored
    /// secrets before it is parsed.
    Session {
        models: Option<Vec<Value>>,
        version: Option<String>,
    },
    SignInRequired,
}

/// An inventory probe's child, stopped and reaped however the probe ends. A probe dropped
/// mid-way signals the whole process group at once and hands only the reap to the runtime, so
/// a reap task dropped unpolled, or no runtime at all, leaves no descendant running. The
/// attribution ends after the reap.
struct ProbeChild {
    child: Option<Box<dyn ChildWrapper>>,
    registration: Option<ProcessRegistration>,
}

impl ProbeChild {
    async fn stop(mut self) {
        // Kept in place while it stops: a cancelled stop leaves the reap to `Drop`.
        if let Some(child) = self.child.as_mut() {
            stop_supervised_child(&mut **child).await;
        }
        self.child = None;
    }

    /// The exit status of a child that ended on its own, waiting up to a second for it; `None`
    /// while it runs.
    async fn exited_on_its_own(&self) -> Option<std::process::ExitStatus> {
        let child = self.child.as_deref()?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        loop {
            if let Some(status) = crate::process::exited_status(child) {
                return Some(status);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            sleep(Duration::from_millis(20)).await;
        }
    }
}

impl Drop for ProbeChild {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        // The group kill, sent here rather than from a task that may never run.
        let _ = child.start_kill();
        let registration = self.registration.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                stop_supervised_child(&mut *child).await;
                drop(registration);
            });
        }
    }
}

/// Ends an ACP probe's transport however the probe ends: the writer task, which owns the
/// agent's stdin, stops at once, and the readers end when the agent's output closes.
struct AcpProbeTransport(cursor::AcpJsonRpcConnection);

impl AcpProbeTransport {
    /// Spawns the transport and discards the agent's notifications, requests and stderr as
    /// they arrive: the probe reads only responses.
    fn spawn<R, W, E>(stdout: R, stdin: W, stderr: E) -> Self
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
        tokio::spawn(async move { while incoming.recv().await.is_some() {} });
        Self(connection)
    }
}

impl Drop for AcpProbeTransport {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

fn warn_antigravity_probe(instance_id: &str, step: &str, failure: &str) {
    tracing::warn!(
        instance_id,
        step,
        failure,
        "the Antigravity inventory probe read no models"
    );
}

/// The process attribution of an Antigravity inventory child, `None` when the registry refuses.
fn register_antigravity_probe(
    registry: &ProcessAttributionRegistry,
    pid: u32,
    label: &str,
) -> Option<ProcessRegistration> {
    let identity = NativeProcessSampler::process_identity(pid).ok()?;
    registry
        .register_identity(
            identity,
            ProcessRegistrationMetadata {
                scope: AttributionScope::External,
                kind: AttributionKind::Provider,
                label: label.to_owned(),
                source: RegistrationSource::Provider,
                driver: Some("antigravity".to_owned()),
                survives_shutdown: false,
            },
        )
        .ok()
}

/// `agy --version`, supervised and attributed while it runs.
async fn run_antigravity_version(
    executable: &Path,
    cwd: &Path,
    environment: &[(OsString, OsString)],
    attribution: Option<&ProcessAttributionRegistry>,
) -> Option<CommandOutput> {
    let launch = prepare_provider_launch(executable, ["--version"]).ok()?;
    let mut command = Command::new(launch.program);
    command
        .args(launch.args)
        .current_dir(cwd)
        .envs(environment.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sanitize_provider_subprocess_environment(&mut command);
    let registration = std::sync::Mutex::new(None);
    let output = run_supervised_with_spawn_observer(
        SupervisedRunRequest {
            command,
            stdin: None,
            timeout: PROBE_TIMEOUT,
            cleanup_timeout: Duration::from_secs(2),
            max_output_bytes: PROBE_OUTPUT_LIMIT,
            overflow: SupervisedOverflow::Truncate,
            stop_policy: StopPolicy::Force,
        },
        &CancellationToken::new(),
        |pid| {
            if let (Some(registry), Some(pid)) = (attribution, pid) {
                *registration.lock().unwrap_or_else(PoisonError::into_inner) =
                    register_antigravity_probe(registry, pid, "Antigravity version check");
            }
        },
    )
    .await
    .ok()?;
    let code = output.status.code().unwrap_or(-1);
    Some(CommandOutput {
        success: output.status.success(),
        code,
        stdout: String::from_utf8_lossy(&output.stdout.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr.bytes).into_owned(),
    })
}

/// Opens and closes one empty ACP session to read the models, thinking levels, sign-in state
/// and version. No prompt is sent. A peer that answers another protocol version than 1 gets no
/// session. Logs carry the step and the error code, never the CLI's text.
async fn probe_antigravity_catalog(
    instance_id: &str,
    executable: &Path,
    configured_models: &[String],
    environment: &[(OsString, OsString)],
    attribution: Option<&ProcessAttributionRegistry>,
) -> Option<AntigravityCatalog> {
    // A neutral directory: the probe session must not open a user's checkout.
    let session_cwd = std::env::temp_dir();
    let launch = prepare_provider_launch(executable, ["acp"]).ok()?;
    let mut command = Command::new(launch.program);
    command
        .args(launch.args)
        .current_dir(&session_cwd)
        .envs(environment.iter().cloned())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sanitize_provider_subprocess_environment(&mut command);
    let Ok(mut spawned) = supervised_command(command).spawn() else {
        warn_antigravity_probe(instance_id, "launch", "could not start");
        return None;
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
                register_antigravity_probe(registry, pid, "Antigravity inventory probe")
            });
            if registration.is_none() {
                stop_supervised_child(&mut *spawned).await;
                warn_antigravity_probe(instance_id, "launch", "could not attribute the process");
                return None;
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
        return None;
    };
    let transport = AcpProbeTransport::spawn(stdout, stdin, stderr);
    let connection = &transport.0;
    let handshake = timeout(ANTIGRAVITY_DISCOVERY_TIMEOUT, async {
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
            return Ok(None);
        }
        let session = connection
            .request(
                "session/new",
                json!({ "cwd": session_cwd.to_string_lossy(), "mcpServers": [] }),
            )
            .await?;
        Ok::<_, cursor::acp::AcpProtocolError>(Some((initialize, session)))
    })
    .await;
    let catalog = match handshake {
        Ok(Ok(Some((initialize, session)))) => {
            // The catalog is read; the close gets its own short step and never costs it.
            if let Some(session_id) = session.get("sessionId").and_then(Value::as_str)
                && antigravity_advertises_close(&initialize)
            {
                let close = connection.request("session/close", json!({ "sessionId": session_id }));
                if timeout(ANTIGRAVITY_CLOSE_TIMEOUT, close).await.is_err() {
                    warn_antigravity_probe(instance_id, "session/close", "timed out");
                }
            }
            let models = antigravity_models(&session, configured_models);
            if models.is_none() {
                warn_antigravity_probe(instance_id, "session/new", "no models in the reply");
            }
            Some(AntigravityCatalog::Session {
                models,
                version: initialize
                    .pointer("/agentInfo/version")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        }
        Ok(Ok(None)) => {
            warn_antigravity_probe(instance_id, "initialize", "unsupported protocol version");
            None
        }
        Ok(Err(cursor::acp::AcpProtocolError::RemoteRequest {
            code: -32000,
            message,
            ..
        })) if message
            .trim()
            .eq_ignore_ascii_case("authentication required") =>
        {
            Some(AntigravityCatalog::SignInRequired)
        }
        Ok(Err(cursor::acp::AcpProtocolError::RemoteRequest { method, code, .. })) => {
            warn_antigravity_probe(instance_id, &method, &format!("error {code}"));
            None
        }
        Ok(Err(_)) => {
            warn_antigravity_probe(instance_id, "probe", "connection failed");
            // The connection fails when the child dies; one that died on its own is a crash.
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
            None
        }
        Err(_) => {
            warn_antigravity_probe(instance_id, "probe", "timed out");
            None
        }
    };
    drop(transport);
    child.stop().await;
    catalog
}

/// Whether `initialize` advertises `session/close`, under either key spelling the CLI writes.
fn antigravity_advertises_close(initialize: &Value) -> bool {
    let capabilities = initialize
        .get("agentCapabilities")
        .or_else(|| initialize.get("agent_capabilities"));
    ["sessionCapabilities", "session_capabilities"]
        .iter()
        .filter_map(|key| capabilities?.get(key)?.get("close"))
        .any(|close| !close.is_null() && close != &Value::Bool(false))
}

/// The first `major.minor.patch` in peer text, `None` when it holds none.
fn release_version(text: &str) -> Option<String> {
    text.split(|character: char| !character.is_ascii_digit() && character != '.')
        .find_map(|token| {
            let parts = token.split('.').take(3).collect::<Vec<_>>();
            (parts.len() == 3 && parts.iter().all(|part| !part.is_empty())).then(|| parts.join("."))
        })
}

/// The models a `session/new` answer advertises, in the CLI's order with its current model
/// first (the web picker's default is the first model), then the configured custom models it
/// does not list. Each model carries its own `reasoning` options: the current model's from the
/// `thought_level` option, the others' from their effort-suffixed `availableModels` ids, with a
/// default only where the CLI names one. Without model options the `availableModels` ids are
/// published unchanged. Repeated models and levels are listed once. `None` when the answer
/// lists no model.
fn antigravity_models(session: &Value, configured_models: &[String]) -> Option<Vec<Value>> {
    let options = session
        .get("configOptions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    // The chat runtime's lookup: what is published here is what a turn can select.
    let option = |category: &str| {
        crate::provider::antigravity::runtime::option_by_category(options, category)
    };
    let available = unique(
        session
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model.get("modelId")?.as_str()?;
                Some((id, model.get("name").and_then(Value::as_str).unwrap_or(id)))
            }),
    );
    let model = option("model");
    let values = unique(
        model
            .and_then(|model| model.get("options"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|option| {
                let value = option.get("value")?.as_str()?;
                Some((
                    value,
                    option.get("name").and_then(Value::as_str).unwrap_or(value),
                ))
            }),
    );
    let (mut models, current) = if values.is_empty() {
        (
            available
                .iter()
                .map(|&(id, name)| antigravity_model(id, name, None, &[]))
                .collect::<Vec<_>>(),
            session
                .pointer("/models/currentModelId")
                .and_then(Value::as_str),
        )
    } else {
        let thought = option("thought_level");
        let label = thought
            .and_then(|thought| thought.get("name"))
            .and_then(Value::as_str);
        let known = unique(
            thought
                .and_then(|thought| thought.get("options"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|option| {
                    let value = option.get("value")?.as_str()?;
                    Some((
                        value,
                        option.get("name").and_then(Value::as_str).unwrap_or(value),
                    ))
                }),
        );
        let current_level = thought
            .and_then(|thought| thought.get("currentValue"))
            .and_then(Value::as_str);
        let current = model
            .and_then(|model| model.get("currentValue"))
            .and_then(Value::as_str);
        let models = values
            .iter()
            .map(|&(value, name)| {
                let levels = if Some(value) == current && !known.is_empty() {
                    known
                        .iter()
                        .map(|&(level, label)| (level, label, Some(level) == current_level))
                        .collect()
                } else {
                    antigravity_model_levels(value, &values, &available, &known)
                };
                antigravity_model(value, name, label, &levels)
            })
            .collect();
        (models, current)
    };
    if models.is_empty() {
        return None;
    }
    if let Some(position) = models
        .iter()
        .position(|model| model["slug"].as_str() == current)
    {
        models[..=position].rotate_right(1);
    }
    let listed = models
        .iter()
        .filter_map(|model| model["slug"].as_str().map(str::to_owned))
        .collect::<HashSet<_>>();
    let unlisted = configured_models
        .iter()
        .filter(|slug| !listed.contains(slug.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    models.extend(custom_models(&unlisted));
    Some(models)
}

/// The `(id, name)` pairs in order, each id once.
fn unique<'a>(pairs: impl Iterator<Item = (&'a str, &'a str)>) -> Vec<(&'a str, &'a str)> {
    let mut seen = HashSet::new();
    pairs.filter(|(id, _)| seen.insert(*id)).collect()
}

/// One catalog model, its thinking levels published as the `reasoning` option under the CLI's
/// own ids, which a chat sends back as ACP `thought_level` unchanged.
fn antigravity_model(
    slug: &str,
    name: &str,
    label: Option<&str>,
    levels: &[(&str, &str, bool)],
) -> Value {
    let descriptors = if levels.is_empty() {
        Vec::new()
    } else {
        vec![json!({
            "id": "reasoning",
            "label": label.unwrap_or(cursor::model::REASONING_LABEL),
            "type": "select",
            "options": levels.iter().map(|&(id, label, default)| if default {
                json!({ "id": id, "label": label, "isDefault": true })
            } else {
                json!({ "id": id, "label": label })
            }).collect::<Vec<_>>(),
        })]
    };
    json!({
        "slug": slug,
        "name": name,
        "isCustom": false,
        "capabilities": { "optionDescriptors": descriptors },
    })
}

/// A model's thinking levels, read from the `availableModels` ids made of its value, `-` and a
/// level. An id that is itself a model value is that model, never a level. Any other id belongs
/// to the longest model value it extends, so `alpha-pro-high` is a level of `alpha-pro`, not of
/// `alpha`. Levels the `thought_level` option lists keep its order and names; others follow in
/// the CLI's order under their own id. No level is a default.
fn antigravity_model_levels<'a>(
    value: &str,
    values: &[(&'a str, &'a str)],
    available: &[(&'a str, &'a str)],
    known: &[(&'a str, &'a str)],
) -> Vec<(&'a str, &'a str, bool)> {
    let owner = |id: &str| {
        if values.iter().any(|&(value, _)| value == id) {
            return None;
        }
        values
            .iter()
            .map(|&(value, _)| value)
            .filter(|value| {
                id.strip_prefix(value)
                    .is_some_and(|rest| rest.len() > 1 && rest.starts_with('-'))
            })
            .max_by_key(|value| value.len())
    };
    let known_index = |level: &str| known.iter().position(|&(known, _)| known == level);
    let mut levels = available
        .iter()
        .map(|&(id, _)| id)
        .filter(|id| owner(id) == Some(value))
        .map(|id| &id[value.len() + 1..])
        .collect::<Vec<_>>();
    levels.sort_by_key(|level| known_index(level).unwrap_or(usize::MAX));
    levels
        .into_iter()
        .map(|level| {
            let name = known_index(level).map_or(level, |index| known[index].1);
            (level, name, false)
        })
        .collect()
}

/// How long a failed read of Cursor's advertised model values is remembered before a refresh
/// opens another session.
const CURSOR_SESSION_READ_BACKOFF: Duration = Duration::from_secs(5 * 60);

/// One launch environment's read of the model values Cursor advertises in a session.
enum CursorSessionRead {
    Read(Vec<String>),
    Failed(tokio::time::Instant),
}

/// The model values each Cursor launch environment advertises in a session, by executable,
/// version, endpoint, model list and instance environment. Reading them opens a session in the
/// user's Cursor account that ACP cannot close (an empty one, which Cursor does not list), so it
/// is read once per key: a refresh that finds a read in flight waits for it, and a failed read is
/// remembered for [`CURSOR_SESSION_READ_BACKOFF`].
type CursorSessionReads =
    std::sync::Mutex<HashMap<u64, Arc<tokio::sync::Mutex<Option<CursorSessionRead>>>>>;
static CURSOR_ADVERTISED_MODEL_VALUES: std::sync::OnceLock<CursorSessionReads> =
    std::sync::OnceLock::new();

/// The advertised values for `key`, read by `read` at most once per key at a time.
async fn shared_cursor_session_read<F>(key: u64, read: F) -> Vec<String>
where
    F: Future<Output = Option<Vec<String>>>,
{
    let slot = CURSOR_ADVERTISED_MODEL_VALUES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .entry(key)
        .or_default()
        .clone();
    let mut slot = slot.lock().await;
    match &*slot {
        Some(CursorSessionRead::Read(advertised)) => return advertised.clone(),
        Some(CursorSessionRead::Failed(at)) if at.elapsed() < CURSOR_SESSION_READ_BACKOFF => {
            return Vec::new();
        }
        _ => {}
    }
    match timeout(CURSOR_SESSION_READ_TIMEOUT, read).await {
        Ok(Some(advertised)) => {
            *slot = Some(CursorSessionRead::Read(advertised.clone()));
            advertised
        }
        // A session that cannot be read publishes the list as is.
        _ => {
            *slot = Some(CursorSessionRead::Failed(tokio::time::Instant::now()));
            Vec::new()
        }
    }
}

async fn probe_cursor_models(
    executable: &Path,
    version: Option<&str>,
    endpoint: Option<&str>,
    custom_models: &[String],
    cwd: &Path,
    environment: &[(OsString, OsString)],
) -> Option<Vec<Value>> {
    let mut arguments = Vec::new();
    if let Some(endpoint) = endpoint.filter(|value| !value.trim().is_empty()) {
        arguments.extend([OsString::from("-e"), OsString::from(endpoint)]);
    }
    arguments.push(OsString::from("acp"));
    let launch = prepare_provider_launch(executable, &arguments).ok()?;
    let mut command = Command::new(launch.program);
    command
        .args(launch.args)
        .current_dir(cwd)
        .envs(environment.iter().cloned());
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sanitize_provider_subprocess_environment(&mut command);
    let mut spawned = supervised_command(command).spawn().ok()?;
    let pipes = (
        spawned.stdout().take(),
        spawned.stdin().take(),
        spawned.stderr().take(),
    );
    // A refresh that drops this probe still stops the whole group.
    let child = ProbeChild {
        child: Some(spawned),
        registration: None,
    };
    let (Some(stdout), Some(stdin), Some(stderr)) = pipes else {
        child.stop().await;
        return None;
    };
    let transport = AcpProbeTransport::spawn(stdout, stdin, stderr);
    let connection = &transport.0;
    let list = timeout(CURSOR_DISCOVERY_TIMEOUT, async {
        connection
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false,
                        // As the runtime asks, so the session read sees the values it will use.
                        "_meta": { "parameterizedModelPicker": true },
                    },
                    "clientInfo": { "name": "bibcode-rust", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
            .await
            .ok()?;
        connection
            .request("authenticate", json!({ "methodId": "cursor_login" }))
            .await
            .ok()?;
        connection
            .request("cursor/list_available_models", json!({}))
            .await
            .ok()
    })
    .await
    .ok()
    .flatten();
    // The optional session read starts only once the list is in hand, under its own deadline.
    let response = match list {
        Some(list) => {
            let mut listed = list
                .get("models")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|model| model.get("value").and_then(Value::as_str))
                .collect::<Vec<_>>();
            listed.sort_unstable();
            let mut environment = environment.to_vec();
            environment.sort();
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            (executable, version, endpoint, listed, environment).hash(&mut hasher);
            let advertised = shared_cursor_session_read(hasher.finish(), async {
                connection
                    .request(
                        "session/new",
                        json!({ "cwd": cwd.to_string_lossy(), "mcpServers": [] }),
                    )
                    .await
                    .ok()
                    .map(|session| cursor::advertised_model_values(&session))
            })
            .await;
            Some((list, advertised))
        }
        None => None,
    };
    drop(transport);
    child.stop().await;
    let (list, advertised) = response?;
    let models =
        cursor::discover_models_with_advertised_values(&list, custom_models, &advertised).ok()?;
    serde_json::to_value(models)
        .ok()
        .and_then(|value| value.as_array().cloned())
}

/// The wire a configured OpenCode server speaks, or the version it reports when BiBCode cannot
/// drive it. A server that does not answer is read as OpenCode 1, as before.
pub(super) async fn opencode_server_protocol(
    endpoint: &str,
    server_password: Option<&str>,
) -> Result<opencode::OpenCodeProtocol, String> {
    let Ok(client) = reqwest::Client::builder()
        .timeout(opencode::API_PROBE_TIMEOUT)
        .build()
    else {
        return Ok(opencode::OpenCodeProtocol::V1);
    };
    match opencode::probe_server_api(&client, endpoint, server_password).await {
        opencode::OpenCodeServerApi::V2 { .. } => Ok(opencode::OpenCodeProtocol::V2),
        opencode::OpenCodeServerApi::Unsupported { version } => Err(version),
        opencode::OpenCodeServerApi::V1 | opencode::OpenCodeServerApi::Unavailable => {
            Ok(opencode::OpenCodeProtocol::V1)
        }
    }
}

async fn probe_opencode(
    endpoint: &str,
    server_password: Option<&str>,
    custom_models: &[String],
    protocol: opencode::OpenCodeProtocol,
    cwd: &Path,
) -> Option<opencode::OpenCodeInventorySnapshot> {
    probe_opencode_with_timeout(
        endpoint,
        server_password,
        custom_models,
        PROBE_TIMEOUT,
        protocol,
        cwd,
    )
    .await
}

/// OpenCode 2 catalogs are read for `cwd`, the directory BiBCode's sessions use; OpenCode 1
/// inventory reads stay unscoped, as they always were.
async fn probe_opencode_with_timeout(
    endpoint: &str,
    server_password: Option<&str>,
    custom_models: &[String],
    request_timeout: Duration,
    protocol: opencode::OpenCodeProtocol,
    cwd: &Path,
) -> Option<opencode::OpenCodeInventorySnapshot> {
    let client = reqwest::Client::builder()
        .timeout(request_timeout)
        .build()
        .ok()?;
    let scope = (protocol == opencode::OpenCodeProtocol::V2).then_some(cwd);
    let (providers, agents, commands) =
        fetch_opencode_catalog(&client, endpoint, server_password, scope, protocol).await?;
    Some(opencode::build_inventory_snapshot(
        &providers,
        &agents,
        &commands,
        custom_models,
    ))
}

/// An OpenCode server's provider list, agents and commands (skills included) in the OpenCode 1
/// shapes `build_inventory_snapshot` reads. `cwd` scopes the agent and command catalogs.
async fn fetch_opencode_catalog(
    client: &reqwest::Client,
    endpoint: &str,
    server_password: Option<&str>,
    cwd: Option<&Path>,
    protocol: opencode::OpenCodeProtocol,
) -> Option<(Value, Value, Value)> {
    let endpoint = endpoint.trim_end_matches('/');
    match protocol {
        opencode::OpenCodeProtocol::V1 => {
            let (providers, agents, commands) = tokio::join!(
                get_opencode_json(client, endpoint, "/provider", server_password, None),
                get_opencode_json(client, endpoint, "/agent", server_password, cwd),
                get_opencode_json(client, endpoint, "/command", server_password, cwd),
            );
            Some((providers?, agents?, commands?))
        }
        opencode::OpenCodeProtocol::V2 => {
            let [providers, models, agents, commands, skills] = read_opencode_v2_catalogs(
                client,
                endpoint,
                server_password,
                cwd,
                ["provider", "model", "agent", "command", "skill"],
            )
            .await?;
            use opencode::v2::catalog;
            Some((
                catalog::provider_list(&providers, &models),
                catalog::agents(&agents),
                catalog::commands(&commands, &skills),
            ))
        }
    }
}

/// Waits before each re-read of a just-started OpenCode 2 server's catalogs: 1.5 s in all.
const OPENCODE_2_CATALOG_RETRY_DELAYS: [Duration; 4] = [
    Duration::from_millis(100),
    Duration::from_millis(200),
    Duration::from_millis(400),
    Duration::from_millis(800),
];

/// Reads OpenCode 2 catalogs together (`routes` must include `agent`). A just-started server
/// answers before it has loaded them: its agent list, which always holds the built-in agents,
/// reads empty for about 100 ms (seen on 2.0.29). So an empty agent list is read again, after a
/// bounded backoff, rather than published as no agents.
pub(super) async fn read_opencode_v2_catalogs<const N: usize>(
    client: &reqwest::Client,
    endpoint: &str,
    server_password: Option<&str>,
    cwd: Option<&Path>,
    routes: [&'static str; N],
) -> Option<[Value; N]> {
    let agent = routes.iter().position(|route| *route == "agent");
    let mut delays = OPENCODE_2_CATALOG_RETRY_DELAYS.iter();
    loop {
        let reads = futures_util::future::join_all(
            routes.map(|route| get_opencode_v2_json(client, endpoint, route, server_password, cwd)),
        )
        .await;
        let catalogs: [Value; N] = reads
            .into_iter()
            .collect::<Option<Vec<_>>>()?
            .try_into()
            .ok()?;
        let agents_loaded = agent.is_none_or(|agent| {
            catalogs[agent]
                .get("data")
                .and_then(Value::as_array)
                .is_none_or(|agents| !agents.is_empty())
        });
        match delays.next() {
            Some(delay) if !agents_loaded => tokio::time::sleep(*delay).await,
            _ => return Some(catalogs),
        }
    }
}

async fn get_opencode_v2_json(
    client: &reqwest::Client,
    endpoint: &str,
    route: &str,
    server_password: Option<&str>,
    cwd: Option<&Path>,
) -> Option<Value> {
    let mut url = reqwest::Url::parse(&format!("{endpoint}/api/{route}")).ok()?;
    if let Some(cwd) = cwd {
        url.query_pairs_mut()
            .append_pair("location[directory]", &cwd.to_string_lossy());
    }
    let request = client.get(url);
    let request = match server_password.filter(|value| !value.is_empty()) {
        Some(password) => request.basic_auth("opencode", Some(password)),
        None => request,
    };
    let value = request
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<Value>()
        .await
        .ok()?;
    value.get("data").is_some().then_some(value)
}

async fn get_opencode_json(
    client: &reqwest::Client,
    endpoint: &str,
    path: &str,
    server_password: Option<&str>,
    cwd: Option<&Path>,
) -> Option<Value> {
    let mut url = reqwest::Url::parse(&format!("{endpoint}{path}")).ok()?;
    if let Some(cwd) = cwd {
        url.query_pairs_mut()
            .append_pair("directory", &cwd.to_string_lossy());
    }
    let request = client.get(url);
    let request = match server_password.filter(|value| !value.is_empty()) {
        Some(password) => request.basic_auth("opencode", Some(password)),
        None => request,
    };
    request
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<Value>()
        .await
        .ok()
}

async fn local_opencode_api(
    endpoint: &str,
    server_password: Option<&str>,
) -> opencode::OpenCodeServerApi {
    let Ok(client) = reqwest::Client::builder()
        .timeout(LOCAL_OPENCODE_HEALTH_TIMEOUT)
        .build()
    else {
        return opencode::OpenCodeServerApi::Unavailable;
    };
    opencode::probe_server_api(&client, endpoint, server_password).await
}

async fn probe_local_opencode(
    executable: &Path,
    cwd: &Path,
    custom_models: &[String],
    environment: &[(OsString, OsString)],
) -> Option<opencode::OpenCodeInventorySnapshot> {
    with_local_opencode(
        executable,
        cwd,
        environment,
        &CancellationToken::new(),
        |endpoint, password, protocol| async move {
            probe_opencode_with_timeout(
                &endpoint,
                Some(&password),
                custom_models,
                LOCAL_OPENCODE_INVENTORY_TIMEOUT,
                protocol,
                cwd,
            )
            .await
        },
    )
    .await
}

async fn with_local_opencode<T, F, Fut>(
    executable: &Path,
    cwd: &Path,
    environment: &[(OsString, OsString)],
    cancellation: &CancellationToken,
    discover: F,
) -> Option<T>
where
    F: FnOnce(String, String, opencode::OpenCodeProtocol) -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let executable = opencode::resolve_owned_executable(Platform::current(), executable);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.ok()?;
    let port = listener.local_addr().ok()?.port();
    drop(listener);
    let endpoint = format!("http://127.0.0.1:{port}");
    let port_argument = format!("--port={port}");
    let launch = prepare_provider_launch(
        &executable,
        ["serve", "--hostname=127.0.0.1", port_argument.as_str()],
    )
    .ok()?;
    let mut command = Command::new(launch.program);
    command
        .args(launch.args)
        .current_dir(cwd)
        .envs(environment.iter().cloned())
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let local_password = uuid::Uuid::new_v4().to_string();
    // OpenCode 2 prefers an inherited `OPENCODE_PASSWORD` to `OPENCODE_SERVER_PASSWORD`.
    command.env("OPENCODE_SERVER_PASSWORD", &local_password);
    command.env("OPENCODE_PASSWORD", &local_password);
    sanitize_provider_subprocess_environment(&mut command);
    let mut child = supervised_command(command).spawn().ok()?;
    let inventory = tokio::select! {
        biased;
        () = cancellation.cancelled() => None,
        result = async {
            for _ in 0..LOCAL_OPENCODE_STARTUP_ATTEMPTS {
                if child.try_wait().ok().flatten().is_some() { return None; }
                let protocol = match local_opencode_api(&endpoint, Some(&local_password)).await {
                    opencode::OpenCodeServerApi::V1 => opencode::OpenCodeProtocol::V1,
                    opencode::OpenCodeServerApi::V2 { .. } => opencode::OpenCodeProtocol::V2,
                    // BiBCode cannot read these catalogs: stop now instead of waiting it out.
                    opencode::OpenCodeServerApi::Unsupported { .. } => return None,
                    opencode::OpenCodeServerApi::Unavailable => {
                        sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let snapshot = discover(endpoint, local_password, protocol).await;
                return child.try_wait().ok().flatten().is_none().then_some(snapshot).flatten();
            }
            None
        } => result,
    };
    stop_supervised_child(&mut *child).await;
    inventory
}

fn supervised_command(command: Command) -> CommandWrap {
    let mut command = CommandWrap::from(command);
    configure_supervised_background_command_wrap(&mut command);
    command
}

async fn stop_supervised_child(child: &mut dyn ChildWrapper) {
    let report = terminate_and_wait(child).await;
    log_cleanup_failures("provider inventory probe", &report);
}

fn first_line(stdout: &str, stderr: &str) -> Option<String> {
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

/// A stored secret, or the remainder of one after a leading `v`, inside text that would be
/// published. The leading `v` is included because a version parser may drop it.
fn text_holds_secret(raw: &str, secrets: &[String]) -> bool {
    secrets.iter().any(|secret| {
        raw.contains(secret.as_str())
            || secret
                .strip_prefix('v')
                .is_some_and(|bare| !bare.is_empty() && raw.contains(bare))
    })
}

fn redact_secret_version(version: Option<String>, secrets: &[String]) -> Option<String> {
    version.filter(|value| !text_holds_secret(value, secrets))
}

/// The first line of a version check. Antigravity's never comes from stderr, where the CLI
/// may write anything.
fn version_line(driver: &str, output: &CommandOutput) -> Option<String> {
    let stderr = if driver == "antigravity" {
        ""
    } else {
        &output.stderr
    };
    first_line(&output.stdout, stderr)
}

fn normalize_provider_version(driver: &str, version: Option<String>) -> Option<String> {
    let version = version?;
    // Only a release number is published: a CLI that prints anything else (its environment,
    // a stored secret among it) publishes no version.
    if driver == "antigravity" {
        return release_version(&version);
    }
    if driver != "codex" {
        return Some(version);
    }
    version
        .split_whitespace()
        .find(|part| {
            part.chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
                && part.contains('.')
        })
        .map(str::to_owned)
        .or(Some(version))
}

fn codex_probe_health(account: &Value) -> (&'static str, Value, Option<&'static str>) {
    let auth = codex_auth(account);
    let requires_openai_auth = account
        .get("requiresOpenaiAuth")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let has_account = account.get("account").is_some_and(|value| !value.is_null());
    if requires_openai_auth && !has_account {
        return (
            "error",
            auth,
            Some("Codex is installed but requires authentication."),
        );
    }
    ("ready", auth, None)
}

fn codex_auth(account: &Value) -> Value {
    let Some(account) = account.get("account").and_then(Value::as_object) else {
        return json!({ "status": "unauthenticated" });
    };
    let mut auth = json!({ "status": "authenticated" });
    if let Some(account_type) = account.get("type").and_then(Value::as_str) {
        auth["type"] = json!(account_type);
    }
    if let Some(email) = account.get("email").and_then(Value::as_str) {
        auth["email"] = json!(email);
    }
    auth
}

fn claude_auth(stdout: &str) -> Value {
    let Ok(value) = serde_json::from_str::<Value>(stdout) else {
        return json!({ "status": "unknown" });
    };
    let authenticated = value
        .get("loggedIn")
        .and_then(Value::as_bool)
        .or_else(|| value.get("authenticated").and_then(Value::as_bool));
    let mut auth = json!({
        "status": match authenticated {
            Some(true) => "authenticated",
            Some(false) => "unauthenticated",
            None => "unknown",
        }
    });
    if let Some(method) = value
        .get("authMethod")
        .or_else(|| value.get("subscriptionType"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        auth["type"] = json!(method);
    }
    if let Some(email) = value
        .get("email")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        auth["email"] = json!(email);
    }
    auth
}

fn custom_models(slugs: &[String]) -> Vec<Value> {
    slugs
        .iter()
        .map(|slug| {
            json!({
                "slug": slug,
                "name": slug,
                "isCustom": true,
                "capabilities": null,
            })
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn snapshot(
    definition: &ProviderDefinition,
    installed: bool,
    version: Option<String>,
    status: &str,
    auth: Value,
    models: Vec<Value>,
    capabilities: ProviderCapabilities,
    message: Option<&str>,
    checked_at: String,
    availability: &str,
) -> Value {
    let mut result = snapshot_owned_message(
        definition,
        installed,
        version,
        status,
        auth,
        models,
        capabilities,
        message.map(str::to_owned),
        checked_at,
    );
    result["availability"] = json!(availability);
    if availability == "unavailable" {
        result["unavailableReason"] = json!("Provider driver is unavailable in this build.");
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn snapshot_owned_message(
    definition: &ProviderDefinition,
    installed: bool,
    version: Option<String>,
    status: &str,
    auth: Value,
    models: Vec<Value>,
    capabilities: ProviderCapabilities,
    message: Option<String>,
    checked_at: String,
) -> Value {
    let mut result = json!({
        "instanceId": definition.instance_id,
        "driver": definition.driver,
        "displayName": super::provider_runtime::instance_label(
            &definition.instance_id,
            definition.display_name.as_deref(),
            &definition.driver,
        ),
        "enabled": definition.enabled && definition.available,
        "installed": installed,
        "version": version,
        "status": status,
        "auth": auth,
        "checkedAt": checked_at,
        "availability": "available",
        "models": models,
        "slashCommands": capabilities.slash_commands,
        "skills": capabilities.skills,
        "agents": capabilities.agents,
    });
    if let Some(message) = message {
        result["message"] = json!(message);
    }
    if crate::provider::supports_turn_steer(&definition.driver) {
        result["supportsTurnSteer"] = json!(true);
    }
    // Always present: a client reads an absent flag (an older server) as unknown.
    result["supportsConversationRewind"] = json!(crate::provider::supports_conversation_rewind(
        &definition.driver
    ));
    if matches!(definition.driver.as_str(), "codex" | "claudeAgent") {
        result["supportsMcpStatus"] = json!(true);
    }
    // Antigravity chats report ACP `usage_update` on every CLI the chat accepts.
    if matches!(
        definition.driver.as_str(),
        "codex" | "claudeAgent" | "antigravity"
    ) || capabilities.context_window_usage
    {
        result["supportsContextWindowUsage"] = json!(true);
    }
    if crate::provider::supports_compaction(&definition.driver) {
        result["supportsCompaction"] = json!(true);
    }
    result
}

fn is_builtin_driver(driver: &str) -> bool {
    matches!(
        driver,
        "codex" | "claudeAgent" | "cursor" | "grok" | "opencode" | "antigravity"
    )
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    #[cfg(unix)]
    use crate::test_support::TestSandbox;

    /// A local OpenCode instance beside one on a server the user runs: only the latter counts
    /// as external, so a legacy thread on the local one settles at startup (#206).
    #[test]
    fn only_opencode_instances_with_a_server_url_run_on_a_users_server() {
        let settings = json!({
            "providerInstances": {
                "local-opencode": { "driver": "opencode", "config": { "serverUrl": "" } },
                "remote-opencode": {
                    "driver": "opencode",
                    "config": { "serverUrl": "http://192.0.2.10:4096" }
                },
                "codex": { "driver": "codex", "config": { "apiEndpoint": "http://192.0.2.11" } }
            }
        });
        assert_eq!(
            opencode_instances_with_server_url(&settings),
            vec!["remote-opencode".to_owned()]
        );
        let ownership = crate::orchestration::StartupProcessOwnership::new(
            [(
                "local-thread",
                Some("local-opencode"),
                Some(&json!({ "transport": "http" })),
            )],
            opencode_instances_with_server_url(&settings),
        );
        assert!(!ownership.work_may_outlive_bibcode("local-thread", "opencode", None));
    }
    use axum::{Json, Router, routing::get};

    #[cfg(target_os = "linux")]
    fn check_inventory_probe_appimage_environment<F, R>(test_name: &str, run_probe: F)
    where
        F: FnOnce(std::path::PathBuf, std::path::PathBuf, Vec<(OsString, OsString)>) -> R,
        R: std::future::Future<Output = bool>,
    {
        use crate::test_support::{
            ISOLATING_AND_NO_OP_CASES,
            appimage_environment::{assert_child_environment, check_inherited_environment},
        };

        check_inherited_environment(test_name, ISOLATING_AND_NO_OP_CASES, |expected| {
            let sandbox = TestSandbox::new("inventory-appimage-environment");
            let output_path = sandbox.path("environment");
            // Read a protocol request before closing the pipes. OpenCode uses
            // null stdin, so its read completes immediately without a request.
            let executable = sandbox.executable_script(
                "inventory-probe",
                "IFS= read -r request\n/usr/bin/env -0 > \"$BIBCODE_TEST_PROVIDER_ENVIRONMENT_FILE\"",
                "",
            );
            let environment = vec![(
                OsString::from("BIBCODE_TEST_PROVIDER_ENVIRONMENT_FILE"),
                output_path.as_os_str().to_owned(),
            )];
            // The fixture records the launched environment, then closes the
            // native discovery protocol without advertising provider data.
            let discovered = crate::test_support::run_on_current_thread(run_probe(
                executable,
                sandbox.root().to_owned(),
                environment,
            ));
            assert!(!discovered, "fixture cannot supply inventory: {test_name}");
            let environment = std::fs::read(&output_path)
                .unwrap_or_else(|error| panic!("inventory probe did not run: {error}"));
            assert_child_environment(&environment, expected);
        });
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn claude_inventory_probe_ignores_appimage_environment() {
        check_inventory_probe_appimage_environment(
            "production::provider_inventory::tests::claude_inventory_probe_ignores_appimage_environment",
            |executable, cwd, environment| async move {
                probe_claude_metadata(&executable, &cwd, &environment, &[])
                    .await
                    .is_some()
            },
        );
    }

    /// In a process of its own, so no sibling test can turn the callsite off for this capture.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_codex_probe_that_learns_no_sign_in_logs_why_without_the_account() {
        let Some(child) = crate::test_support::in_own_process(
            "production::provider_inventory::tests::a_codex_probe_that_learns_no_sign_in_logs_why_without_the_account",
        ) else {
            return;
        };
        #[derive(Clone, Default)]
        struct Captured(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Captured {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let log = Captured::default();
        let _logging = tracing::subscriber::set_default(
            tracing_subscriber::fmt()
                .with_ansi(false)
                .with_max_level(tracing::Level::WARN)
                .with_writer({
                    let log = log.clone();
                    move || log.clone()
                })
                .finish(),
        );
        const EMAIL: &str = "secret-person@example.test";
        let sandbox = crate::test_support::TestSandbox::new("codex-sign-in-log");
        // `account/read` answers with `$1`: an error, nothing at all, or a reply without account.
        let fake = |name: &str, account_reply: &str| {
            sandbox.executable_script(
                name,
                &format!(
                    r#"
while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialized"'*) ;;
    *'"method":"account/read"'*) {account_reply} ;;
    *'"method":"model/list"'*) printf '{{"id":%s,"result":{{"data":[{{"model":"gpt-6.2-sol","displayName":"gpt-6.2-sol","supportedReasoningEfforts":[{{"reasoningEffort":"medium"}}],"defaultReasoningEffort":"medium"}}],"nextCursor":null}}}}\n' "$id" ;;
    *'"method":"skills/list"'*) printf '{{"id":%s,"result":{{"data":[]}}}}\n' "$id" ;;
    *) printf '{{"id":%s,"result":{{}}}}\n' "$id" ;;
  esac
done
"#
                ),
                "",
            )
        };
        let refused = fake(
            "codex-refused",
            &format!(
                r#"printf '{{"id":%s,"error":{{"code":-32001,"message":"cannot read {EMAIL}"}}}}\n' "$id""#
            ),
        );
        let silent = fake("codex-silent", ":");
        let no_account = fake(
            "codex-no-account",
            r#"printf '{"id":%s,"result":{"account":null,"requiresOpenaiAuth":false}}\n' "$id""#,
        );
        // Resolves and is executable, but its interpreter does not exist, so it cannot start.
        let unstartable = sandbox.path("codex-unstartable");
        crate::test_support::TestSandbox::write_executable(
            &unstartable,
            "#!/nonexistent/interpreter\n",
        );
        let cwd = sandbox.root().to_path_buf();
        assert!(
            probe_codex("codex-unstartable", &unstartable, &cwd, &[], &[])
                .await
                .is_none()
        );
        assert!(
            probe_codex("codex-refused", &refused, &cwd, &[], &[])
                .await
                .is_none()
        );
        assert!(
            probe_codex("codex-silent", &silent, &cwd, &[], &[])
                .await
                .is_none()
        );
        let answered = probe_codex("codex-no-account", &no_account, &cwd, &[], &[])
            .await
            .is_some();
        let text = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
        assert!(answered, "{text}");

        for (instance, step, failure) in [
            ("codex-unstartable", "launch", "could not start"),
            ("codex-refused", "account/read", "error -32001"),
            ("codex-silent", "probe", "timed out"),
            (
                "codex-no-account",
                "account/read",
                "no account in the reply",
            ),
        ] {
            assert!(
                text.lines()
                    .any(|line| line.contains("learned no sign-in type")
                        && line.contains(&format!("instance_id=\"{instance}\""))
                        && line.contains(&format!("step=\"{step}\""))
                        && line.contains(&format!("failure=\"{failure}\""))),
                "{instance}: {text}"
            );
        }
        assert!(!text.contains(EMAIL), "{text}");
        assert!(!text.contains("cannot read"), "{text}");
        child.complete();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn codex_inventory_probe_ignores_appimage_environment() {
        check_inventory_probe_appimage_environment(
            "production::provider_inventory::tests::codex_inventory_probe_ignores_appimage_environment",
            |executable, cwd, environment| async move {
                probe_codex("codex", &executable, &cwd, &[], &environment)
                    .await
                    .is_some()
            },
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cursor_inventory_probe_ignores_appimage_environment() {
        check_inventory_probe_appimage_environment(
            "production::provider_inventory::tests::cursor_inventory_probe_ignores_appimage_environment",
            |executable, cwd, environment| async move {
                probe_cursor_models(&executable, None, None, &[], &cwd, &environment)
                    .await
                    .is_some()
            },
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn opencode_inventory_probe_ignores_appimage_environment() {
        check_inventory_probe_appimage_environment(
            "production::provider_inventory::tests::opencode_inventory_probe_ignores_appimage_environment",
            |executable, cwd, environment| async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .unwrap_or_else(|error| {
                        panic!("OpenCode inventory probe requires a loopback listener: {error:?}")
                    });
                drop(listener);
                probe_local_opencode(&executable, &cwd, &[], &environment)
                    .await
                    .is_some()
            },
        );
    }

    /// A Cursor CLI that folds options into bracketed model values: the inventory publishes only
    /// what a session advertises, and opens that session once, not on every refresh.
    #[cfg(unix)]
    #[tokio::test]
    async fn cursor_inventory_publishes_only_advertised_values_and_opens_one_session() {
        let temp = tempfile::TempDir::new().expect("fixture directory");
        let sessions = temp.path().join("sessions");
        let executable = temp.path().join("cursor-agent");
        crate::test_support::executable_fixture::write_executable(
            &executable,
            format!(
                r#"#!/bin/sh
while IFS= read -r line; do
  id=${{line#*\"id\":}}; id=${{id%%[!0-9]*}}
  case "$line" in
    *'"method":"initialize"'*|*'"method":"authenticate"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
    *'"method":"cursor/list_available_models"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"models":[{{"value":"m","name":"M","configOptions":[{{"id":"effort","category":"thought_level","type":"select","currentValue":"low","options":[{{"value":"low"}},{{"value":"high"}}]}}]}},{{"value":"gone","name":"Gone","configOptions":[]}}]}}}}\n' "$id" ;;
    *'"method":"session/new"'*) printf 'opened\n' >> '{}'; printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"s","configOptions":[{{"id":"model","category":"model","type":"select","currentValue":"m[effort=high]","options":[{{"value":"m[effort=high]"}}]}}]}}}}\n' "$id" ;;
  esac
done
"#,
                sessions.display()
            ),
        );
        let custom = ["mine".to_owned()];
        for _ in 0..2 {
            let models = probe_cursor_models(
                &executable,
                Some("2026.11.22"),
                None,
                &custom,
                temp.path(),
                &[],
            )
            .await
            .expect("the fixture lists models");
            assert_eq!(models.len(), 1, "{models:?}");
            assert_eq!(models[0]["slug"], "m");
            let reasoning = &models[0]["capabilities"]["optionDescriptors"][0];
            assert_eq!(reasoning["id"], "reasoning");
            assert_eq!(
                reasoning["options"],
                json!([{ "id": "high", "label": "high", "isDefault": true }])
            );
        }
        assert_eq!(
            std::fs::read_to_string(&sessions).expect("a session was opened"),
            "opened\n"
        );
    }

    /// A Cursor CLI that switches to plain model names and separate options when BiBCode asks for
    /// its parameterized model picker: Grok 4.7 publishes every Reasoning and Context value and
    /// Fast. Without the request the CLI folds one combination into the model value.
    #[cfg(unix)]
    #[tokio::test]
    async fn cursor_inventory_publishes_every_grok_option_from_a_parameterized_session() {
        let temp = tempfile::TempDir::new().expect("fixture directory");
        let executable = temp.path().join("cursor-agent");
        crate::test_support::executable_fixture::write_executable(
            &executable,
            r#"#!/bin/sh
picker=no
while IFS= read -r line; do
  id=${line#*\"id\":}; id=${id%%[!0-9]*}
  case "$line" in
    *'"method":"initialize"'*'"parameterizedModelPicker":true'*) picker=yes; printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"method":"initialize"'*|*'"method":"authenticate"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"method":"cursor/list_available_models"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"models":[{"value":"grok-4.7","name":"Grok 4.7","configOptions":[{"id":"context","category":"model_config","type":"select","currentValue":"256k","options":[{"value":"256k"},{"value":"500k"}]},{"id":"reasoning_effort","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"low"},{"value":"medium"},{"value":"high"},{"value":"xhigh"}]},{"id":"fast","category":"model_config","type":"select","currentValue":"true","options":[{"value":"false"},{"value":"true"}]}]}]}}\n' "$id" ;;
    *'"method":"session/new"'*)
      if [ "$picker" = yes ]; then value='grok-4.7'; else value='grok-4.7[context=256k,reasoning_effort=high,fast=true]'; fi
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"s","configOptions":[{"id":"model","category":"model","type":"select","currentValue":"default","options":[{"value":"default"},{"value":"%s"}]}]}}\n' "$id" "$value" ;;
  esac
done
"#,
        );
        let models =
            probe_cursor_models(&executable, Some("2026.11.22"), None, &[], temp.path(), &[])
                .await
                .expect("the fixture lists models");
        assert_eq!(models.len(), 1, "{models:?}");
        assert_eq!(models[0]["slug"], "grok-4.7");
        let descriptors = &models[0]["capabilities"]["optionDescriptors"];
        let ids = |descriptor: &Value| {
            descriptor["options"]
                .as_array()
                .unwrap()
                .iter()
                .map(|choice| choice["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(descriptors[0]["id"], "reasoning", "{descriptors}");
        assert_eq!(ids(&descriptors[0]), ["low", "medium", "high", "xhigh"]);
        assert_eq!(descriptors[1]["id"], "contextWindow", "{descriptors}");
        assert_eq!(ids(&descriptors[1]), ["256k", "500k"]);
        assert_eq!(descriptors[2]["id"], "fastMode", "{descriptors}");

        // A custom model saved bracketed is not listed again beside its plain base model; one
        // with no plain equivalent stays the user's entry.
        let custom = [
            "grok-4.7[context=256k,reasoning_effort=high,fast=true]".to_owned(),
            "mine[reasoning=high]".to_owned(),
        ];
        let models = probe_cursor_models(
            &executable,
            Some("2026.11.22"),
            None,
            &custom,
            temp.path(),
            &[],
        )
        .await
        .expect("the fixture lists models");
        let listed = models
            .iter()
            .map(|model| (model["slug"].as_str(), model["isCustom"].as_bool()))
            .collect::<Vec<_>>();
        assert_eq!(
            listed,
            [
                (Some("grok-4.7"), Some(false)),
                (Some("mine[reasoning=high]"), Some(true))
            ],
            "{models:?}"
        );
    }

    /// A CLI that never answers the session read still publishes its model list, unnarrowed.
    #[cfg(unix)]
    #[tokio::test]
    async fn cursor_inventory_keeps_the_list_when_the_session_read_hangs() {
        let temp = tempfile::TempDir::new().expect("fixture directory");
        let executable = temp.path().join("cursor-agent");
        crate::test_support::executable_fixture::write_executable(
            &executable,
            r#"#!/bin/sh
while IFS= read -r line; do
  id=${line#*\"id\":}; id=${id%%[!0-9]*}
  case "$line" in
    *'"method":"initialize"'*|*'"method":"authenticate"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"method":"cursor/list_available_models"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"models":[{"value":"m","name":"M","configOptions":[{"id":"effort","category":"thought_level","type":"select","currentValue":"low","options":[{"value":"low"},{"value":"high"}]}]}]}}\n' "$id" ;;
  esac
done
"#,
        );
        let models = probe_cursor_models(&executable, None, None, &[], temp.path(), &[])
            .await
            .expect("the list is published without the session read");
        assert_eq!(models.len(), 1);
        assert_eq!(
            models[0]["capabilities"]["optionDescriptors"][0]["options"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    /// A Cursor fixture whose `session/new` runs `session` (shell) and counts each call.
    #[cfg(unix)]
    fn cursor_session_fixture(
        directory: &Path,
        list_delay: &str,
        session: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let sessions = directory.join("sessions");
        let executable = directory.join("cursor-agent");
        crate::test_support::executable_fixture::write_executable(
            &executable,
            format!(
                r#"#!/bin/sh
while IFS= read -r line; do
  id=${{line#*\"id\":}}; id=${{id%%[!0-9]*}}
  case "$line" in
    *'"method":"initialize"'*|*'"method":"authenticate"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
    *'"method":"cursor/list_available_models"'*) sleep {list_delay}; printf '{{"jsonrpc":"2.0","id":%s,"result":{{"models":[{{"value":"m","name":"M","configOptions":[{{"id":"effort","category":"thought_level","type":"select","currentValue":"low","options":[{{"value":"low"}},{{"value":"high"}}]}}]}}]}}}}\n' "$id" ;;
    *'"method":"session/new"'*) printf 'opened\n' >> '{sessions}'; {session} ;;
  esac
done
"#,
                sessions = sessions.display(),
            ),
        );
        (executable, sessions)
    }

    #[cfg(unix)]
    const ADVERTISE_HIGH: &str = r#"sleep 0.3; printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"s","configOptions":[{"id":"model","category":"model","currentValue":"m[effort=high]","options":[{"value":"m[effort=high]"}]}]}}\n' "$id""#;

    #[cfg(unix)]
    fn opened(sessions: &Path) -> usize {
        std::fs::read_to_string(sessions).map_or(0, |text| text.lines().count())
    }

    /// Two refreshes of one Cursor read one session between them; an instance with another
    /// environment reads its own, and never gets the first one's options.
    #[cfg(unix)]
    #[tokio::test]
    async fn cursor_session_reads_are_shared_per_launch_environment() {
        let temp = tempfile::TempDir::new().expect("fixture directory");
        let (executable, sessions) = cursor_session_fixture(temp.path(), "0", ADVERTISE_HIGH);
        let probe = |environment: Vec<(OsString, OsString)>| {
            let executable = executable.clone();
            let cwd = temp.path().to_path_buf();
            async move {
                probe_cursor_models(&executable, Some("shared"), None, &[], &cwd, &environment)
                    .await
                    .expect("the fixture lists models")
            }
        };
        let account = |name: &str| vec![(OsString::from("CURSOR_ACCOUNT"), OsString::from(name))];
        let (first, second) = tokio::join!(probe(account("a")), probe(account("a")));
        assert_eq!(opened(&sessions), 1, "concurrent refreshes share one read");
        for models in [first, second] {
            assert_eq!(
                models[0]["capabilities"]["optionDescriptors"][0]["options"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
        }
        probe(account("b")).await;
        assert_eq!(
            opened(&sessions),
            2,
            "another environment reads its own session"
        );
    }

    /// A failed session read is remembered for a while instead of opening a session on every
    /// refresh; the model list is published meanwhile.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_cursor_session_read_is_not_retried_on_every_refresh() {
        let temp = tempfile::TempDir::new().expect("fixture directory");
        let (executable, sessions) = cursor_session_fixture(
            temp.path(),
            "0",
            r#"printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32603,"message":"no"}}\n' "$id""#,
        );
        for _ in 0..2 {
            let models =
                probe_cursor_models(&executable, Some("failing"), None, &[], temp.path(), &[])
                    .await
                    .expect("the list is published");
            assert_eq!(models.len(), 1);
        }
        assert_eq!(opened(&sessions), 1);
    }

    /// A model list that arrives late is kept even when the session read then hangs: the read
    /// starts only once the list is in hand, under its own deadline.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_hung_cursor_session_read_never_discards_a_late_model_list() {
        let temp = tempfile::TempDir::new().expect("fixture directory");
        let (executable, _sessions) = cursor_session_fixture(temp.path(), "4.5", ":");
        let models = probe_cursor_models(&executable, Some("late"), None, &[], temp.path(), &[])
            .await
            .expect("the late list is published");
        assert_eq!(models.len(), 1);
    }

    /// A Cursor that answers nothing at all, as when one of its MCP servers never connects, is
    /// given up at the discovery deadline: the probe yields no list, so the snapshot keeps the
    /// plain fallback models instead of waiting on it.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cursor_that_never_answers_leaves_the_fallback_models() {
        let temp = tempfile::TempDir::new().expect("fixture directory");
        let executable = temp.path().join("cursor-agent");
        crate::test_support::executable_fixture::write_executable(
            &executable,
            "#!/bin/sh\nwhile IFS= read -r line; do :; done\n",
        );
        let models = timeout(
            CURSOR_DISCOVERY_TIMEOUT + Duration::from_secs(5),
            probe_cursor_models(&executable, Some("silent"), None, &[], temp.path(), &[]),
        )
        .await
        .expect("the discovery deadline ends the probe");
        assert!(models.is_none(), "{models:?}");
    }

    #[cfg(unix)]
    fn write_version_fixture(directory: &Path, name: &str, version: &str) -> std::path::PathBuf {
        let executable = directory.join(name);
        crate::test_support::executable_fixture::write_executable(
            &executable,
            format!(
                "#!/bin/sh\nif [ \"$1\" = about ]; then printf '%s\\n' '{{\"cliVersion\":\"{version}\"}}'; else printf '%s\\n' '{version}'; fi\n"
            ),
        );
        executable
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn inventory_instance_path_outranks_ambient_path_in_an_isolated_process() {
        const CASE: &str = "provider-inventory-path-precedence";
        const TEST_NAME: &str = "production::provider_inventory::tests::inventory_instance_path_outranks_ambient_path_in_an_isolated_process";
        const SENTINEL: &str = "BIBCODE_TEST_ISOLATED_CASE_DONE=provider-inventory-path-precedence";

        if TestSandbox::is_isolated_case(CASE, TEST_NAME) {
            let instance = std::path::PathBuf::from(
                std::env::var_os("BIBCODE_TEST_INSTANCE_PATH").expect("isolated instance PATH"),
            );
            let root = std::path::PathBuf::from(
                std::env::var_os("BIBCODE_TEST_ROOT").expect("isolated inventory root"),
            );
            let ambient_executable = std::path::PathBuf::from(
                std::env::var_os("BIBCODE_TEST_AMBIENT_EXECUTABLE")
                    .expect("isolated ambient executable"),
            );
            assert_eq!(
                resolve_provider_executable_with_environment(
                    "cursor-agent",
                    std::iter::empty::<(&std::ffi::OsStr, &std::ffi::OsStr)>(),
                ),
                Some(ambient_executable),
                "the child must have a competing ambient provider executable"
            );
            let settings = json!({
                "enableProviderUpdateChecks": false,
                "providerInstances": {
                    "cursor-work": {
                        "driver": "cursor",
                        "enabled": true,
                        "config": { "binaryPath": "cursor-agent" },
                        "environment": [
                            { "name": "pAtH", "value": instance, "valueRedacted": false }
                        ]
                    }
                }
            });

            let providers = probe_full(
                &settings,
                Some("cursor-work"),
                &root,
                &ProviderMaintenance::new(),
                None,
            )
            .await;

            assert_eq!(providers[0].snapshot["version"], "2026.03.04-instance");
            println!("{SENTINEL}");
            return;
        }

        let sandbox = TestSandbox::new("provider-inventory-path");
        let ambient = sandbox.path("ambient");
        let instance = sandbox.path("instance");
        std::fs::create_dir(&ambient).expect("ambient executable directory");
        std::fs::create_dir(&instance).expect("instance executable directory");
        let ambient_executable =
            write_version_fixture(&ambient, "cursor-agent", "2026.01.02-ambient");
        write_version_fixture(&instance, "cursor-agent", "2026.03.04-instance");
        let output = sandbox.run_isolated_case(
            CASE,
            TEST_NAME,
            &[
                ("PATH", ambient.as_os_str()),
                ("BIBCODE_TEST_INSTANCE_PATH", instance.as_os_str()),
                ("BIBCODE_TEST_ROOT", sandbox.root().as_os_str()),
                (
                    "BIBCODE_TEST_AMBIENT_EXECUTABLE",
                    ambient_executable.as_os_str(),
                ),
            ],
        );
        assert!(
            output.status.success(),
            "isolated inventory PATH precedence case failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains(SENTINEL));
    }

    /// Reads the catalogs of a real OpenCode 2 server (see `live_opencode_2_round_trip` in
    /// `provider::opencode` for the environment).
    #[tokio::test]
    #[ignore = "needs a live OpenCode 2 server"]
    async fn live_opencode_2_inventory() {
        let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
        let endpoint = var("BIBCODE_OPENCODE_V2_LIVE");
        let password = var("BIBCODE_OPENCODE_V2_PASSWORD");
        assert_eq!(
            opencode_server_protocol(&endpoint, Some(&password)).await,
            Ok(opencode::OpenCodeProtocol::V2)
        );
        let inventory = probe_opencode(
            &endpoint,
            Some(&password),
            &[],
            opencode::OpenCodeProtocol::V2,
            Path::new(&var("BIBCODE_OPENCODE_V2_DIRECTORY")),
        )
        .await
        .expect("catalogs");
        assert!(
            inventory
                .models
                .iter()
                .any(|model| model.slug == var("BIBCODE_OPENCODE_V2_MODEL"))
        );
        assert!(
            inventory
                .agents
                .iter()
                .any(|agent| agent["name"] == "build")
        );
        assert!(!inventory.skills.is_empty());
    }

    /// Starts a real OpenCode 2 binary the way inventory does and reads its catalogs. Set
    /// `BIBCODE_OPENCODE_V2_BINARY` (a copy under the temporary directory, which the hermetic
    /// test guard allows), `BIBCODE_OPENCODE_V2_HOME` (a scratch home whose configuration points
    /// the default model at a scripted local endpoint), `BIBCODE_OPENCODE_V2_DIRECTORY` and
    /// `BIBCODE_OPENCODE_V2_MODEL`.
    #[tokio::test]
    #[ignore = "needs a live OpenCode 2 binary"]
    async fn live_opencode_2_local_inventory() {
        let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
        let home = std::path::PathBuf::from(var("BIBCODE_OPENCODE_V2_HOME"));
        let environment = [
            ("HOME", home.clone()),
            ("XDG_CONFIG_HOME", home.join(".config")),
            ("XDG_DATA_HOME", home.join(".local/share")),
            ("XDG_STATE_HOME", home.join(".local/state")),
            ("XDG_CACHE_HOME", home.join(".cache")),
        ]
        .map(|(name, value)| (OsString::from(name), value.into_os_string()));
        let inventory = probe_local_opencode(
            Path::new(&var("BIBCODE_OPENCODE_V2_BINARY")),
            Path::new(&var("BIBCODE_OPENCODE_V2_DIRECTORY")),
            &[],
            &environment,
        )
        .await
        .expect("the managed OpenCode 2 server answers its catalogs");
        assert!(
            inventory
                .models
                .iter()
                .any(|model| model.slug == var("BIBCODE_OPENCODE_V2_MODEL"))
        );
    }

    /// A CLI whose version BiBCode cannot drive is reported without starting its server.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_unknown_opencode_cli_version_is_reported_without_starting_a_server() {
        let root = tempfile::tempdir().expect("inventory root");
        let marker = root.path().join("served");
        let executable = root.path().join("opencode");
        crate::test_support::executable_fixture::write_executable(
            &executable,
            format!(
                "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'opencode v3.0.0\\n'; exit 0; fi\n: > '{}'\nexit 1\n",
                marker.to_string_lossy()
            ),
        );
        let settings = json!({
            "enableProviderUpdateChecks": false,
            "providerInstances": {
                "opencode": {
                    "driver": "opencode",
                    "enabled": true,
                    "config": { "binaryPath": executable }
                }
            }
        });

        let providers = probe_full(
            &settings,
            Some("opencode"),
            root.path(),
            &ProviderMaintenance::new(),
            None,
        )
        .await;

        let snapshot = &providers[0].snapshot;
        assert_eq!(snapshot["version"], "opencode v3.0.0");
        assert_eq!(snapshot["status"], "error");
        assert_eq!(
            snapshot["message"],
            "This OpenCode version isn't supported yet. In Settings → Providers, set Binary path to an OpenCode 1.x or 2.x executable."
        );
        assert!(!marker.exists(), "no server may be started");
    }

    /// The quick probe reads OpenCode's `--version` too, so a version BiBCode cannot drive never
    /// reads Ready, while a supported one stays ready.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_quick_probe_reports_an_unknown_opencode_version() {
        for (version, status) in [("opencode v3.0.0", "error"), ("opencode v2.0.29", "ready")] {
            let root = tempfile::tempdir().expect("inventory root");
            let executable = root.path().join("opencode");
            crate::test_support::executable_fixture::write_executable(
                &executable,
                format!(
                    "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '{version}\\n'; exit 0; fi\nexit 1\n"
                ),
            );
            let settings = json!({
                "enableProviderUpdateChecks": false,
                "providerInstances": {
                    "opencode": {
                        "driver": "opencode",
                        "enabled": true,
                        "config": { "binaryPath": executable }
                    }
                }
            });

            let providers = probe(
                &settings,
                Some("opencode"),
                root.path(),
                &ProviderMaintenance::new(),
            )
            .await;

            let snapshot = &providers[0].snapshot;
            assert_eq!(snapshot["status"], status, "{version}");
            if status == "error" {
                assert_eq!(snapshot["version"], version);
                assert_eq!(
                    snapshot["message"],
                    "This OpenCode version isn't supported yet. In Settings → Providers, set Binary path to an OpenCode 1.x or 2.x executable."
                );
            }
        }
    }

    /// Cursor's `about` probe returns before the shared version check. A CLI that prints a
    /// stored secret as `cliVersion`, or as `--version` when `about` has no version, must not
    /// publish it. A real `cliVersion` is kept when only `--version` echoes the secret.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cursor_probe_does_not_publish_a_version_that_holds_a_stored_secret() {
        const MARKER: &str = "test-marker-secret-4417";
        const DOTTED: &str = "v987.654.321";
        let root = tempfile::tempdir().expect("inventory root");
        let home = root.path().join("home");
        std::fs::create_dir_all(&home).expect("home");
        let cases = [
            (
                "about-version",
                MARKER,
                format!(
                    "#!/bin/sh\ncase \"$1\" in\n  --version) printf '%s\\n' '2026.11.23'; exit 0 ;;\n  about) printf '%s\\n' '{{\"cliVersion\":\"'$CURSOR_KEY'\",\"userEmail\":\"user@example.test\"}}'; exit 0 ;;\nesac\nexit 1\n"
                ),
                None,
            ),
            (
                "version-fallback",
                MARKER,
                "#!/bin/sh\ncase \"$1\" in\n  --version) printf '%s\\n' \"$CURSOR_KEY\"; exit 0 ;;\n  about) printf '%s\\n' 'User Email user@example.test'; exit 0 ;;\nesac\nexit 1\n".to_owned(),
                None,
            ),
            (
                "clean-about",
                MARKER,
                "#!/bin/sh\ncase \"$1\" in\n  --version) printf '%s\\n' \"$CURSOR_KEY\"; exit 0 ;;\n  about) printf '%s\\n' '{\"cliVersion\":\"2026.11.23\",\"userEmail\":\"user@example.test\"}'; exit 0 ;;\nesac\nexit 1\n".to_owned(),
                Some("2026.11.23"),
            ),
            (
                "v-prefixed",
                DOTTED,
                "#!/bin/sh\ncase \"$1\" in\n  --version) printf '%s\\n' '2026.11.23'; exit 0 ;;\n  about) printf '%s\\n' '{\"cliVersion\":\"'$CURSOR_KEY'\",\"userEmail\":\"user@example.test\"}'; exit 0 ;;\nesac\nexit 1\n".to_owned(),
                None,
            ),
        ];
        for (name, secret, script, expected_version) in cases {
            let executable = root.path().join(format!("cursor-agent-{name}"));
            crate::test_support::executable_fixture::write_executable(&executable, &script);
            let settings = json!({
                "enableProviderUpdateChecks": false,
                "providerInstances": {
                    "cursor": {
                        "driver": "cursor",
                        "enabled": true,
                        "config": { "binaryPath": executable },
                        "environment": [
                            { "name": "CURSOR_KEY", "value": secret, "sensitive": true },
                            { "name": "HOME", "value": home, "sensitive": false }
                        ]
                    }
                }
            });
            for providers in [
                probe(
                    &settings,
                    Some("cursor"),
                    root.path(),
                    &ProviderMaintenance::new(),
                )
                .await,
                probe_full(
                    &settings,
                    Some("cursor"),
                    root.path(),
                    &ProviderMaintenance::new(),
                    None,
                )
                .await,
            ] {
                let published = serde_json::to_string(&providers[0].snapshot).expect("snapshot");
                assert!(
                    !published.contains(secret),
                    "{name}: a stored secret was published: {published}"
                );
                if secret.starts_with('v') {
                    let bare = &secret[1..];
                    assert!(
                        !bare.is_empty() && !published.contains(bare),
                        "{name}: a stored secret was published without its leading v: {published}"
                    );
                }
                assert_eq!(
                    providers[0].snapshot["version"].as_str(),
                    expected_version,
                    "{name}"
                );
            }
        }
    }

    /// The quick OpenCode probe returns an unsupported version before the shared check. A
    /// secret shaped like a release number (`123.456.789`, major 123) must not be published.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_quick_opencode_probe_does_not_publish_a_version_that_holds_a_stored_secret() {
        const DOTTED: &str = "123.456.789";
        let root = tempfile::tempdir().expect("inventory root");
        let executable = root.path().join("opencode");
        crate::test_support::executable_fixture::write_executable(
            &executable,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '%s\\n' \"$OPENCODE_KEY\"; exit 0; fi\nexit 1\n",
        );
        let settings = json!({
            "enableProviderUpdateChecks": false,
            "providerInstances": {
                "opencode": {
                    "driver": "opencode",
                    "enabled": true,
                    "config": { "binaryPath": executable },
                    "environment": [{ "name": "OPENCODE_KEY", "value": DOTTED, "sensitive": true }]
                }
            }
        });
        let providers = probe(
            &settings,
            Some("opencode"),
            root.path(),
            &ProviderMaintenance::new(),
        )
        .await;
        let snapshot = &providers[0].snapshot;
        let published = serde_json::to_string(snapshot).expect("snapshot");
        assert!(
            !published.contains(DOTTED),
            "a stored secret was published: {published}"
        );
        assert!(snapshot["version"].is_null(), "{snapshot}");
        assert_eq!(snapshot["status"], "error");
    }

    /// An OpenCode 2 server's catalogs, as captured from 2.0.29, behind its `/api/info`.
    fn opencode_2_catalog_server() -> axum::Router {
        opencode_2_catalog_server_with_cold_agents(0)
    }

    /// As `opencode_2_catalog_server`, but its first `cold` agent lists are empty, as a
    /// just-started OpenCode 2 server answers before it has loaded its agents.
    fn opencode_2_catalog_server_with_cold_agents(cold: usize) -> axum::Router {
        use axum::{extract::OriginalUri, http::HeaderMap, routing::any};
        let agent_reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let path = format!(
            "{}/tests/fixtures/opencode-v2/catalog.exchanges.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let exchanges: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("catalog fixture"))
                .expect("catalog JSON");
        let app = crate::provider::opencode::server_fixtures::v2("secret");
        app.route(
            "/api/{route}",
            any(move |uri: OriginalUri, headers: HeaderMap| {
                let exchanges = exchanges.clone();
                let agent_reads = agent_reads.clone();
                async move {
                    let expected = format!(
                        "Basic {}",
                        base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            "opencode:secret"
                        )
                    );
                    assert_eq!(headers["authorization"], expected.as_str());
                    assert!(
                        uri.0
                            .query()
                            .is_some_and(|query| query.starts_with("location%5Bdirectory%5D=")),
                        "catalogs are read for the session directory: {}",
                        uri.0
                    );
                    let route = uri.0.path().to_owned();
                    if route == "/api/agent"
                        && agent_reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < cold
                    {
                        return Json(json!({ "data": [] }));
                    }
                    Json(
                        exchanges["exchanges"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|exchange| {
                                exchange["method"] == "GET"
                                    && exchange["path"].as_str().unwrap().split('?').next()
                                        == Some(route.as_str())
                            })
                            .map(|exchange| exchange["response"].clone())
                            .unwrap_or_else(|| json!({ "data": [] })),
                    )
                }
            }),
        )
    }

    /// A just-started OpenCode 2 server lists no agents for its first ~100 ms (seen on 2.0.29),
    /// though it always has built-in ones; its catalogs are read again until they are listed.
    #[tokio::test]
    async fn a_just_started_opencode_2_server_is_read_again_until_its_agents_load() {
        use crate::provider::opencode::server_fixtures;
        let sandbox = tempfile::tempdir().unwrap();
        let missing =
            crate::test_support::hermetic_providers::missing_provider_executable(sandbox.path());
        let (endpoint, server) =
            server_fixtures::serve(opencode_2_catalog_server_with_cold_agents(2)).await;
        let settings = json!({
            "enableProviderUpdateChecks": false,
            "providerInstances": {
                "remote": {
                    "driver": "opencode",
                    "enabled": true,
                    "config": {
                        "binaryPath": missing,
                        "serverUrl": endpoint,
                        "serverPassword": "secret"
                    }
                }
            }
        });

        let providers = probe_full(
            &settings,
            Some("remote"),
            sandbox.path(),
            &ProviderMaintenance::new(),
            None,
        )
        .await;
        server.abort();

        let agents = providers[0].snapshot["agents"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(
            agents.iter().any(|agent| agent["name"] == "build"),
            "{agents:?}"
        );
    }

    #[tokio::test]
    async fn opencode_server_urls_report_their_catalogs_or_an_unsupported_version() {
        use crate::provider::opencode::server_fixtures;
        let sandbox = tempfile::tempdir().unwrap();
        let missing =
            crate::test_support::hermetic_providers::missing_provider_executable(sandbox.path());
        for (app, version) in [
            (opencode_2_catalog_server(), "2.0.29"),
            // Answers `/api/info` but none of the catalogs.
            (server_fixtures::v2("secret"), "2 without catalogs"),
            (server_fixtures::api_server("secret", "3.0.0"), "3.0.0"),
        ] {
            let (endpoint, server) = server_fixtures::serve(app).await;
            let settings = json!({
                "enableProviderUpdateChecks": false,
                "providerInstances": {
                    "remote": {
                        "driver": "opencode",
                        "enabled": true,
                        "config": {
                            "binaryPath": missing,
                            "serverUrl": endpoint,
                            "serverPassword": "secret"
                        }
                    }
                }
            });

            let providers = probe_full(
                &settings,
                Some("remote"),
                sandbox.path(),
                &ProviderMaintenance::new(),
                None,
            )
            .await;
            server.abort();

            let snapshot = &providers[0].snapshot;
            if version == "2.0.29" {
                assert_eq!(snapshot["status"], "ready");
                assert!(snapshot.get("message").is_none_or(Value::is_null));
                assert_eq!(snapshot["models"][0]["slug"], "mock/mock-model");
                let skills = snapshot["skills"].as_array().expect("skills");
                assert!(skills.iter().any(|skill| skill["name"] == "report"));
                let commands = snapshot["slashCommands"].as_array().expect("commands");
                assert!(commands.iter().any(|command| command["name"] == "compact"));
                assert_eq!(snapshot["supportsContextWindowUsage"], true);
                assert!(snapshot.get("supportsCompaction").is_none());
            } else if version == "2 without catalogs" {
                assert_eq!(snapshot["installed"], true);
                assert_eq!(snapshot["status"], "ready");
                assert_eq!(snapshot["message"], OPENCODE_2_CATALOG_UNREADABLE);
                assert_eq!(snapshot["supportsContextWindowUsage"], true);
            } else {
                assert!(snapshot.get("supportsContextWindowUsage").is_none());
                assert!(snapshot.get("supportsCompaction").is_none());
                assert_eq!(snapshot["status"], "error");
                assert_eq!(
                    snapshot["message"],
                    "The OpenCode server at Server URL runs 3.0.0, which isn't supported yet. In Settings → Providers, point Server URL at an OpenCode 1.x or 2.x server."
                );
            }
        }
    }

    /// Chats with a Server URL run on that server, so only its API tells whether they report
    /// context usage: an OpenCode 1 server whose catalogs cannot be read falls back to the local
    /// CLI, but a local OpenCode 2 CLI does not make that server's chats report usage.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_server_url_reports_context_usage_from_its_own_version_not_the_local_cli() {
        use crate::provider::opencode::server_fixtures;
        let root = tempfile::tempdir().expect("inventory root");
        let executable = root.path().join("opencode");
        crate::test_support::executable_fixture::write_executable(
            &executable,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'opencode v2.0.29\\n'; exit 0; fi\nexit 1\n",
        );
        let (endpoint, server) = server_fixtures::serve(server_fixtures::v1("secret")).await;
        let settings = json!({
            "enableProviderUpdateChecks": false,
            "providerInstances": {
                "remote": {
                    "driver": "opencode",
                    "enabled": true,
                    "config": {
                        "binaryPath": executable,
                        "serverUrl": endpoint,
                        "serverPassword": "secret"
                    }
                }
            }
        });

        let providers = probe_full(
            &settings,
            Some("remote"),
            root.path(),
            &ProviderMaintenance::new(),
            None,
        )
        .await;
        server.abort();

        let snapshot = &providers[0].snapshot;
        assert_eq!(snapshot["version"], "opencode v2.0.29", "{snapshot:#}");
        assert!(
            snapshot.get("supportsContextWindowUsage").is_none(),
            "{snapshot:#}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exact_target_probe_applies_the_same_case_variant_path_used_for_resolution() {
        let root = tempfile::tempdir().expect("inventory PATH root");
        let first = root.path().join("first");
        let second = root.path().join("second");
        std::fs::create_dir_all(&first).expect("first PATH directory");
        std::fs::create_dir_all(&second).expect("second PATH directory");
        let executable = first.join("codex");
        crate::test_support::executable_fixture::write_executable(
            &executable,
            format!(
                "#!/bin/sh\nif [ \"$PATH\" = '{}' ]; then printf '1.2.3\\n'; else printf '9.9.9\\n'; fi\n",
                first.to_string_lossy()
            ),
        );
        let target = ProviderMaintenanceTarget {
            instance_id: "codex-work".to_owned(),
            driver: "codex".to_owned(),
            binary_path: "codex".to_owned(),
            environment: vec![
                ("pAtH".into(), first.as_os_str().to_owned()),
                ("PATH".into(), second.as_os_str().to_owned()),
            ],
        };

        assert_eq!(
            probe_maintenance_target_version(&target, root.path()).await,
            Some("1.2.3".to_owned())
        );
    }

    #[test]
    fn maintenance_target_rejects_mismatched_instance_driver_pairs() {
        let settings = json!({
            "providerInstances": {
                "configured-codex": {
                    "driver": "codex",
                    "config": { "binaryPath": "custom-codex" }
                }
            }
        });

        let target = maintenance_target(&settings, "codex", Some("configured-codex"))
            .expect("matching provider target");
        assert_eq!(target.binary_path, "custom-codex");
        assert!(maintenance_target(&settings, "claudeAgent", Some("configured-codex")).is_none());
    }

    #[tokio::test]
    async fn quick_and_full_disabled_probes_attach_unknown_advisories() {
        let sandbox = tempfile::tempdir().unwrap();
        let missing =
            crate::test_support::hermetic_providers::missing_provider_executable(sandbox.path());
        let settings = json!({
            "providerInstances": {
                "codex": { "driver": "codex", "enabled": false, "config": {"binaryPath": missing} }
            }
        });
        let maintenance = ProviderMaintenance::new();
        let quick = probe(&settings, Some("codex"), Path::new("."), &maintenance).await;
        let full = probe_full(&settings, Some("codex"), Path::new("."), &maintenance, None).await;

        for result in [quick, full] {
            assert_eq!(result[0].rich_metadata, RichMetadataOutcome::NotRequested);
            assert!(!result[0].snapshot["models"].as_array().unwrap().is_empty());
            assert_eq!(result[0].snapshot["versionAdvisory"]["status"], "unknown");
            assert!(result[0].snapshot["versionAdvisory"]["canUpdate"].is_boolean());
            assert!(result[0].snapshot["versionAdvisory"]["currentVersion"].is_null());
            assert!(result[0].snapshot["versionAdvisory"]["latestVersion"].is_null());
        }
    }

    #[test]
    fn provider_probe_timeouts_allow_slow_windows_cli_startup() {
        assert!(PROBE_TIMEOUT >= Duration::from_secs(10));
        assert!(LOCAL_OPENCODE_INVENTORY_TIMEOUT >= Duration::from_secs(30));
    }

    #[test]
    fn fresh_cursor_inventory_is_enabled_with_the_supported_binary() {
        let fresh_definitions = definitions(&json!({}));
        let cursor = fresh_definitions
            .iter()
            .find(|definition| definition.instance_id == "cursor")
            .expect("built-in Cursor definition");

        assert!(cursor.enabled);
        assert_eq!(cursor.binary_path, "cursor-agent");

        let explicit = definitions(&json!({
            "providerInstances": {
                "cursor": {
                    "driver": "cursor",
                    "enabled": true,
                    "config": {}
                }
            }
        }));
        let explicit_cursor = explicit
            .iter()
            .find(|definition| definition.instance_id == "cursor")
            .expect("explicit Cursor definition");
        assert_eq!(explicit_cursor.binary_path, "cursor-agent");
    }

    /// An instance saved without `enabled` is off for the inventory, a chat launch and a
    /// terminal launch alike when the legacy entry is off or absent (Antigravity's default).
    #[tokio::test]
    async fn an_antigravity_instance_without_enabled_is_off_for_every_launch() {
        let sandbox = crate::test_support::TestSandbox::new("antigravity-enabled-rule");
        let binary = sandbox.executable_script("agy", "exit 0", "");
        let instance = json!({
            "driver": "antigravity",
            "config": { "binaryPath": binary.to_string_lossy() }
        });
        let root = sandbox.path("settings");
        std::fs::create_dir_all(&root).expect("settings root");
        for document in [
            json!({
                "providers": { "antigravity": { "enabled": false } },
                "providerInstances": { "antigravity": instance.clone() }
            }),
            json!({ "providerInstances": { "antigravity": instance.clone() } }),
        ] {
            std::fs::write(root.join("settings.json"), document.to_string()).expect("settings");
            let inventory = definitions(&document);
            let listed = inventory
                .iter()
                .find(|definition| definition.instance_id == "antigravity")
                .expect("the instance");
            assert!(!listed.enabled, "inventory: {document}");
            let chat = super::super::provider_runtime::resolve_provider_route_settings(
                &root,
                "antigravity",
                None,
            )
            .await;
            assert!(chat.is_err(), "chat launch: {document}");
            let typed = crate::server_settings::ProviderSettingsStore::new(&root)
                .get()
                .await
                .expect("typed settings");
            let terminal =
                crate::provider_terminal::ProviderTerminalInventory::from_settings(&typed);
            assert!(
                !terminal.get("antigravity").expect("terminal entry").enabled,
                "terminal launch: {document}"
            );
        }
    }

    /// Other drivers read a missing instance `enabled` exactly as before: the inventory falls
    /// back to the legacy entry, while the typed settings (chat and terminal launches) read on.
    #[tokio::test]
    async fn a_custom_codex_instance_without_enabled_resolves_as_before() {
        let sandbox = crate::test_support::TestSandbox::new("codex-enabled-unchanged");
        let binary = sandbox.executable_script("codex", "exit 0", "");
        let root = sandbox.path("settings");
        std::fs::create_dir_all(&root).expect("settings root");
        let document = json!({
            "providers": { "codex": { "enabled": false } },
            "providerInstances": { "codex-work": {
                "driver": "codex",
                "config": { "binaryPath": binary.to_string_lossy() }
            } }
        });
        std::fs::write(root.join("settings.json"), document.to_string()).expect("settings");
        let inventory = definitions(&document);
        let listed = inventory
            .iter()
            .find(|definition| definition.instance_id == "codex-work")
            .expect("the instance");
        assert!(!listed.enabled, "the inventory reads the legacy entry");
        let chat = super::super::provider_runtime::resolve_provider_route_settings(
            &root,
            "codex-work",
            None,
        )
        .await;
        assert!(chat.is_ok(), "a chat launch reads it on");
        let typed = crate::server_settings::ProviderSettingsStore::new(&root)
            .get()
            .await
            .expect("typed settings");
        assert!(typed.provider_instances["codex-work"].enabled);
        let terminal = crate::provider_terminal::ProviderTerminalInventory::from_settings(&typed);
        assert!(terminal.get("codex-work").expect("terminal entry").enabled);
    }

    #[test]
    fn fresh_antigravity_inventory_is_disabled_and_runs_agy_not_its_slug() {
        let fresh = definitions(&json!({}));
        let antigravity = fresh
            .iter()
            .find(|definition| definition.instance_id == "antigravity")
            .expect("built-in Antigravity definition");
        assert!(!antigravity.enabled);
        assert!(antigravity.available);
        assert_eq!(antigravity.binary_path, "agy");
        assert_eq!(default_provider_binary("antigravity"), "agy");

        let custom = definitions(&json!({
            "providerInstances": {
                "antigravity_work": { "driver": "antigravity", "enabled": true, "config": {} }
            }
        }));
        let custom = custom
            .iter()
            .find(|definition| definition.instance_id == "antigravity_work")
            .expect("custom Antigravity definition");
        assert!(custom.enabled);
        assert!(custom.available, "antigravity is a driver this build ships");
        assert_eq!(custom.binary_path, "agy");
    }

    /// Settings with one Antigravity instance whose binary is `binary`, every other built-in
    /// pinned to an absent executable so the probe touches nothing else.
    #[cfg(unix)]
    fn antigravity_probe_settings(sandbox: &Path, binary: &Path, enabled: bool) -> Value {
        let missing = crate::test_support::hermetic_providers::missing_provider_executable(sandbox);
        let mut settings =
            crate::test_support::hermetic_providers::hermetic_provider_settings(sandbox);
        settings["providerInstances"] = json!({
            "antigravity": {
                "driver": "antigravity",
                "enabled": enabled,
                "config": { "binaryPath": binary }
            },
            "codex": { "driver": "codex", "enabled": false, "config": { "binaryPath": missing } }
        });
        settings
    }

    #[cfg(unix)]
    async fn probe_antigravity_result(
        sandbox: &TestSandbox,
        settings: &Value,
    ) -> ProviderProbeResult {
        probe_full(
            settings,
            Some("antigravity"),
            sandbox.root(),
            &ProviderMaintenance::new(),
            None,
        )
        .await
        .into_iter()
        .next()
        .expect("the Antigravity snapshot")
    }

    #[cfg(unix)]
    async fn probe_antigravity(sandbox: &TestSandbox, settings: &Value) -> Value {
        probe_antigravity_result(sandbox, settings).await.snapshot
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_enabled_antigravity_instance_is_probed_with_version_then_acp() {
        let sandbox = TestSandbox::new("antigravity-probe");
        let arguments = sandbox.path("arguments");
        let binary = sandbox.path("antigravity-cli-fixture");
        crate::test_support::executable_fixture::write_executable(
            &binary,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\nprintf '%s\\n' '1.5.13'\n",
                arguments.display()
            ),
        );

        let snapshot = probe_antigravity(
            &sandbox,
            &antigravity_probe_settings(sandbox.root(), &binary, true),
        )
        .await;

        assert_eq!(snapshot["driver"], "antigravity");
        assert_eq!(snapshot["displayName"], "Antigravity");
        assert_eq!(snapshot["installed"], true);
        assert_eq!(snapshot["status"], "ready");
        assert_eq!(snapshot["version"], "1.5.13");
        assert_eq!(
            std::fs::read_to_string(&arguments).expect("the probe ran the binary"),
            "--version\nacp\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_disabled_antigravity_instance_is_not_probed() {
        let sandbox = TestSandbox::new("antigravity-disabled");
        let ran = sandbox.path("ran");
        let binary = sandbox.path("antigravity-cli-fixture");
        crate::test_support::executable_fixture::write_executable(
            &binary,
            format!("#!/bin/sh\ntouch '{}'\n", ran.display()),
        );

        let snapshot = probe_antigravity(
            &sandbox,
            &antigravity_probe_settings(sandbox.root(), &binary, false),
        )
        .await;

        assert_eq!(snapshot["driver"], "antigravity");
        assert_eq!(snapshot["enabled"], false);
        assert!(
            !ran.exists(),
            "a disabled instance must not start its binary"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_probe_failures_follow_the_inventory_rules() {
        let sandbox = TestSandbox::new("antigravity-probe-failures");
        let failing = sandbox.path("antigravity-cli-failing");
        crate::test_support::executable_fixture::write_executable(
            &failing,
            format!("#!/bin/sh\nprintf '%s\\n' 'account-{ANTIGRAVITY_MARKER}'\nexit 3\n"),
        );
        let failing_snapshot = probe_antigravity(
            &sandbox,
            &antigravity_probe_settings(sandbox.root(), &failing, true),
        )
        .await;
        assert_eq!(failing_snapshot["driver"], "antigravity");
        assert_eq!(failing_snapshot["installed"], true);
        assert_eq!(failing_snapshot["status"], "warning");
        // A failed `--version` printed no version, whatever its output says.
        assert_eq!(failing_snapshot["version"], Value::Null);
        assert!(!failing_snapshot.to_string().contains(ANTIGRAVITY_MARKER));

        let inert = sandbox.path("antigravity-cli-inert");
        std::fs::write(&inert, "not executable").expect("inert fixture");
        let inert_snapshot = probe_antigravity(
            &sandbox,
            &antigravity_probe_settings(sandbox.root(), &inert, true),
        )
        .await;
        assert_eq!(inert_snapshot["driver"], "antigravity");
        assert_eq!(inert_snapshot["installed"], false);
    }

    /// Every account value and stray output of the scripted Antigravity peer carries this text,
    /// so one search proves none of it reached a snapshot or a log.
    const ANTIGRAVITY_MARKER: &str = "7f3a-secret";

    /// A `session/new` answer shaped like the one measured on CLI 1.5.13, with made-up models:
    /// a model value that is a prefix of another (`alpha`, `alpha-pro`), effort suffixes out of
    /// order, a model with no suffixed variant, a model value that ends in a level word, an
    /// unknown level, a model whose own id reads as another model's level (`epsilon-high`), and
    /// a repeated model and level. The current model is not listed first.
    fn antigravity_session() -> Value {
        json!({
            "sessionId": "session-1",
            "models": {
                "availableModels": [
                    { "modelId": "alpha-high", "name": "Alpha (High)" },
                    { "modelId": "alpha-low", "name": "Alpha (Low)" },
                    { "modelId": "alpha-medium", "name": "Alpha (Medium)" },
                    { "modelId": "alpha-pro-high", "name": "Alpha Pro (High)" },
                    { "modelId": "alpha-pro-xhigh", "name": "Alpha Pro (Extra)" },
                    { "modelId": "alpha-pro-medium", "name": "Alpha Pro (Medium)" },
                    { "modelId": "alpha-pro-low", "name": "Alpha Pro (Low)" },
                    { "modelId": "beta-orchestrator", "name": "Beta Orchestrator" },
                    { "modelId": "gamma-120b-medium", "name": "Gamma 120B (Medium)" },
                    { "modelId": "delta-max", "name": "Delta (Max)" },
                    { "modelId": "delta-low", "name": "Delta (Low)" },
                    { "modelId": "delta-low", "name": "Delta (Low)" },
                    { "modelId": "epsilon-high", "name": "Epsilon High" },
                    { "modelId": "epsilon-low", "name": "Epsilon (Low)" }
                ],
                "currentModelId": "alpha-pro-high"
            },
            "modes": {
                "currentModeId": "default",
                "availableModes": [{ "id": "default", "name": "Default" }]
            },
            "configOptions": [
                {
                    "id": "model", "name": "Model", "category": "model", "type": "select",
                    "currentValue": "alpha-pro",
                    "options": [
                        { "value": "alpha", "name": "Alpha" },
                        { "value": "alpha-pro", "name": "Alpha Pro" },
                        { "value": "beta-orchestrator", "name": "Beta Orchestrator" },
                        { "value": "gamma-120b-medium", "name": "Gamma 120B (Medium)" },
                        { "value": "delta", "name": "Delta" },
                        { "value": "delta", "name": "Delta" },
                        { "value": "epsilon", "name": "Epsilon" },
                        { "value": "epsilon-high", "name": "Epsilon High" }
                    ]
                },
                {
                    "id": "thought_level", "name": "Thinking Level", "category": "thought_level",
                    "type": "select", "currentValue": "high",
                    "options": [
                        { "value": "low", "name": "Low" },
                        { "value": "medium", "name": "Medium" },
                        { "value": "high", "name": "High" },
                        { "value": "xhigh", "name": "Extra" }
                    ]
                },
                {
                    "id": "mode", "name": "Mode", "category": "mode", "type": "select",
                    "currentValue": "default",
                    "options": [{ "value": "default", "name": "Default" }]
                }
            ],
            "_meta": { "antigravity": { "tier": { "name": format!("plan-{ANTIGRAVITY_MARKER}") } } }
        })
    }

    #[cfg(unix)]
    fn reasoning(options: Value) -> Value {
        json!({ "optionDescriptors": [
            { "id": "reasoning", "label": "Thinking Level", "type": "select", "options": options }
        ] })
    }

    /// The catalog `antigravity_session` advertises: the current model first, each model with
    /// its own thinking levels, a default only where the CLI names one.
    #[cfg(unix)]
    fn expected_antigravity_models() -> Vec<Value> {
        let none = json!({ "optionDescriptors": [] });
        vec![
            json!({ "slug": "alpha-pro", "name": "Alpha Pro", "isCustom": false,
                "capabilities": reasoning(json!([
                    { "id": "low", "label": "Low" },
                    { "id": "medium", "label": "Medium" },
                    { "id": "high", "label": "High", "isDefault": true },
                    { "id": "xhigh", "label": "Extra" }
                ])) }),
            json!({ "slug": "alpha", "name": "Alpha", "isCustom": false,
                "capabilities": reasoning(json!([
                    { "id": "low", "label": "Low" },
                    { "id": "medium", "label": "Medium" },
                    { "id": "high", "label": "High" }
                ])) }),
            json!({ "slug": "beta-orchestrator", "name": "Beta Orchestrator", "isCustom": false,
                "capabilities": none }),
            json!({ "slug": "gamma-120b-medium", "name": "Gamma 120B (Medium)", "isCustom": false,
                "capabilities": none }),
            json!({ "slug": "delta", "name": "Delta", "isCustom": false,
                "capabilities": reasoning(json!([
                    { "id": "low", "label": "Low" },
                    { "id": "max", "label": "max" }
                ])) }),
            json!({ "slug": "epsilon", "name": "Epsilon", "isCustom": false,
                "capabilities": reasoning(json!([{ "id": "low", "label": "Low" }])) }),
            json!({ "slug": "epsilon-high", "name": "Epsilon High", "isCustom": false,
                "capabilities": none }),
        ]
    }

    /// A scripted `agy`: `--version` prints `version` with a marker on stderr, and `acp` answers
    /// `initialize` as measured on 1.5.13 (protocol 1, `session/close` advertised under both key
    /// spellings), then `session/new` with the JSON-RPC member `session_new` (a `result` or an
    /// `error`), and every other request with an empty result. It logs each request it reads.
    #[cfg(unix)]
    pub(crate) fn antigravity_acp_fixture(
        sandbox: &TestSandbox,
        name: &str,
        version: &str,
        session_new: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        antigravity_acp_peer(
            sandbox,
            name,
            version,
            &antigravity_initialize(1, "1.5.13", true),
            session_new,
            r#""result":{}"#,
        )
    }

    /// The JSON-RPC member of an `initialize` answer: `protocol`, `agent_version` as
    /// `agentInfo.version`, and `session/close` advertised only when `close` is set.
    #[cfg(unix)]
    pub(crate) fn antigravity_initialize(
        protocol: u64,
        agent_version: &str,
        close: bool,
    ) -> String {
        let session_capabilities = if close {
            json!({ "close": {}, "resume": {} })
        } else {
            json!({ "resume": {} })
        };
        format!(
            r#""result":{}"#,
            json!({
                "protocolVersion": protocol,
                "agentCapabilities": {
                    "loadSession": true,
                    "sessionCapabilities": session_capabilities,
                    "session_capabilities": session_capabilities,
                },
                "agentInfo": { "name": "antigravity", "version": agent_version },
                "authMethods": [],
                "_meta": { "tier": format!("plan-{ANTIGRAVITY_MARKER}") }
            })
        )
    }

    /// [`antigravity_acp_fixture`] with its `initialize` and `session/close` answers given; an
    /// empty `close` never answers `session/close`.
    #[cfg(unix)]
    pub(crate) fn antigravity_acp_peer(
        sandbox: &TestSandbox,
        name: &str,
        version: &str,
        initialize: &str,
        session_new: &str,
        close: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let binary = sandbox.path(name);
        let requests = sandbox.path(format!("{name}.requests"));
        let close = if close.is_empty() {
            "sleep 30".to_owned()
        } else {
            format!("body='{close}'")
        };
        crate::test_support::executable_fixture::write_executable(
            &binary,
            format!(
                r#"#!/bin/sh
case "$1" in
  --version) printf '%s\n' '{version}'; printf '%s\n' 'stderr-{ANTIGRAVITY_MARKER}' >&2; exit 0 ;;
esac
printf '%s\n' 'stderr-{ANTIGRAVITY_MARKER}' >&2
while IFS= read -r request; do
  printf '%s\n' "$request" >> '{requests}'
  id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*) body='{initialize}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"update":"{ANTIGRAVITY_MARKER}"}}}}'; body='{session_new}' ;;
    *'"method":"session/close"'*) {close} ;;
    *) body='"result":{{}}' ;;
  esac
  printf '{{"jsonrpc":"2.0","id":%s,%s}}\n' "$id" "$body"
done
"#,
                requests = requests.display(),
            ),
        );
        (binary, requests)
    }

    #[cfg(unix)]
    pub(crate) fn antigravity_requests(requests: &Path) -> Vec<Value> {
        std::fs::read_to_string(requests)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("a JSON-RPC request"))
            .collect()
    }

    #[cfg(unix)]
    fn antigravity_methods(requests: &Path) -> Vec<String> {
        antigravity_requests(requests)
            .iter()
            .map(|request| request["method"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    /// Each ACP probe ends its transport with it: the writer task that owns the agent's stdin,
    /// the readers and the drain of unused messages. Cursor's probe uses the same transport.
    #[cfg(unix)]
    #[tokio::test]
    async fn repeated_acp_probes_leave_no_transport_task_behind() {
        let sandbox = TestSandbox::new("antigravity-transport");
        let (binary, _) = antigravity_acp_fixture(
            &sandbox,
            "antigravity-cli-transport",
            "1.5.13",
            &format!(r#""result":{}"#, antigravity_session()),
        );
        let settings = antigravity_probe_settings(sandbox.root(), &binary, true);
        let metrics = tokio::runtime::Handle::current().metrics();
        let baseline = metrics.num_alive_tasks();
        for _ in 0..5 {
            let snapshot = probe_antigravity(&sandbox, &settings).await;
            assert_eq!(snapshot["auth"], json!({ "status": "authenticated" }));
            let _ = probe_cursor_models(&binary, None, None, &[], sandbox.root(), &[]).await;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while metrics.num_alive_tasks() > baseline {
            assert!(
                tokio::time::Instant::now() < deadline,
                "{} tasks alive after the probes, {baseline} before",
                metrics.num_alive_tasks()
            );
            sleep(Duration::from_millis(20)).await;
        }
    }

    /// A probe child dropped where no runtime runs still has its whole process group stopped:
    /// `Drop` signals the group itself and hands off only the reap.
    #[cfg(unix)]
    #[test]
    fn a_probe_child_dropped_outside_a_runtime_leaves_no_descendant() {
        let sandbox = TestSandbox::new("antigravity-drop-outside");
        let pids = sandbox.path("pids");
        let script = sandbox.path("antigravity-cli-hangs");
        crate::test_support::executable_fixture::write_executable(
            &script,
            format!(
                "#!/bin/sh\nsleep 30 &\nprintf '%s\\n' \"$!\" > '{0}.tmp'\nmv '{0}.tmp' '{0}'\nwait\n",
                pids.display()
            ),
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime");
        let (child, grandchild) = runtime.block_on(async {
            let mut command = Command::new(&script);
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let spawned = supervised_command(command)
                .spawn()
                .expect("the fixture starts");
            let grandchild = loop {
                if let Ok(text) = std::fs::read_to_string(&pids)
                    && let Ok(pid) = text.trim().parse::<u32>()
                {
                    break pid;
                }
                sleep(Duration::from_millis(20)).await;
            };
            (
                ProbeChild {
                    child: Some(spawned),
                    registration: None,
                },
                grandchild,
            )
        });
        std::thread::spawn(move || drop(child))
            .join()
            .expect("the drop thread");
        let gone = || {
            // SAFETY: signal 0 only checks that the pid exists.
            let result = unsafe { libc::kill(grandchild as libc::pid_t, 0) };
            result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !gone() {
            assert!(
                std::time::Instant::now() < deadline,
                "the descendant {grandchild} outlived the dropped probe"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// A `session/close` that never answers does not cost the catalog or the sign-in it read:
    /// the close has its own short step.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stalled_session_close_keeps_the_catalog_and_the_sign_in() {
        let sandbox = TestSandbox::new("antigravity-close-stalls");
        let (binary, requests) = antigravity_acp_peer(
            &sandbox,
            "antigravity-cli-close-stalls",
            "1.5.13",
            &antigravity_initialize(1, "1.5.13", true),
            &format!(r#""result":{}"#, antigravity_session()),
            "",
        );
        let started = tokio::time::Instant::now();
        let snapshot = probe_antigravity(
            &sandbox,
            &antigravity_probe_settings(sandbox.root(), &binary, true),
        )
        .await;
        assert!(started.elapsed() < ANTIGRAVITY_DISCOVERY_TIMEOUT);
        assert_eq!(snapshot["auth"], json!({ "status": "authenticated" }));
        assert_eq!(
            snapshot["models"],
            Value::Array(expected_antigravity_models())
        );
        assert_eq!(
            antigravity_methods(&requests),
            ["initialize", "session/new", "session/close"]
        );
    }

    /// `session/close` is sent only when `initialize` advertises it, and a session that lists no
    /// model still proves the CLI is signed in.
    #[cfg(unix)]
    #[tokio::test]
    async fn session_close_is_sent_only_when_advertised() {
        let sandbox = TestSandbox::new("antigravity-close-unadvertised");
        let (binary, requests) = antigravity_acp_peer(
            &sandbox,
            "antigravity-cli-no-close",
            "1.5.13",
            &antigravity_initialize(1, "1.5.13", false),
            r#""result":{"sessionId":"session-1"}"#,
            r#""result":{}"#,
        );
        let mut settings = antigravity_probe_settings(sandbox.root(), &binary, true);
        settings["providerInstances"]["antigravity"]["config"]["customModels"] =
            json!(["custom-one"]);
        let snapshot = probe_antigravity(&sandbox, &settings).await;
        assert_eq!(
            antigravity_methods(&requests),
            ["initialize", "session/new"]
        );
        assert_eq!(snapshot["auth"], json!({ "status": "authenticated" }));
        assert_eq!(
            snapshot["models"],
            Value::Array(custom_models(&["custom-one".to_owned()]))
        );
    }

    /// A peer that answers another ACP version gets no session; the instance stays ready for
    /// the terminal and keeps the version its `--version` printed.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_probe_refuses_another_acp_version_and_keeps_the_terminal() {
        let sandbox = TestSandbox::new("antigravity-protocol-2");
        let (binary, requests) = antigravity_acp_peer(
            &sandbox,
            "antigravity-cli-protocol-2",
            "1.5.13",
            &antigravity_initialize(2, "1.5.20", true),
            &format!(r#""result":{}"#, antigravity_session()),
            r#""result":{}"#,
        );
        let snapshot = probe_antigravity(
            &sandbox,
            &antigravity_probe_settings(sandbox.root(), &binary, true),
        )
        .await;
        assert_eq!(antigravity_methods(&requests), ["initialize"]);
        assert_eq!(snapshot["status"], "ready");
        assert_eq!(snapshot["auth"], json!({ "status": "unknown" }));
        assert_eq!(snapshot["version"], "1.5.13");
        assert_eq!(snapshot["models"], json!([]));
    }

    /// The version published is the validated `agentInfo.version` of a protocol 1 handshake;
    /// text there that is no version leaves the `--version` line.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_probe_publishes_the_validated_agent_version() {
        let sandbox = TestSandbox::new("antigravity-agent-version");
        let session = format!(r#""result":{}"#, antigravity_session());
        let (newer, _) = antigravity_acp_peer(
            &sandbox,
            "antigravity-cli-agent-version",
            "1.5.13",
            &antigravity_initialize(1, "1.5.20", true),
            &session,
            r#""result":{}"#,
        );
        let snapshot = probe_antigravity(
            &sandbox,
            &antigravity_probe_settings(sandbox.root(), &newer, true),
        )
        .await;
        assert_eq!(snapshot["version"], "1.5.20");

        let (junk, _) = antigravity_acp_peer(
            &sandbox,
            "antigravity-cli-agent-junk",
            "1.5.13",
            &antigravity_initialize(1, &format!("build-{ANTIGRAVITY_MARKER}"), true),
            &session,
            r#""result":{}"#,
        );
        let snapshot = probe_antigravity(
            &sandbox,
            &antigravity_probe_settings(sandbox.root(), &junk, true),
        )
        .await;
        assert_eq!(snapshot["version"], "1.5.13");
        assert!(!snapshot.to_string().contains(ANTIGRAVITY_MARKER));
    }

    /// An ACP child that dies on its own during the handshake is reported to the Profiler.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_acp_probe_child_that_dies_on_its_own_is_reported() {
        let captured = crate::diagnostics::profiler::exits::CapturedExits::start();
        let sandbox = TestSandbox::new("antigravity-child-dies");
        let binary = sandbox.path("antigravity-cli-dies");
        crate::test_support::executable_fixture::write_executable(
            &binary,
            "#!/bin/sh\ncase \"$1\" in --version) printf '%s\\n' 1.5.13; exit 0 ;; esac\nread -r request\nexit 17\n",
        );
        let snapshot = probe_antigravity(
            &sandbox,
            &antigravity_probe_settings(sandbox.root(), &binary, true),
        )
        .await;
        assert_eq!(snapshot["status"], "ready");
        let findings = captured.take();
        assert!(
            findings.iter().any(
                |fields| fields.first().map(String::as_str) == Some("provider")
                    && fields.iter().any(|field| field == "antigravity")
            ),
            "{findings:?}"
        );
    }

    /// The `--version` child of a full probe is attributed while it runs.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_antigravity_version_check_is_attributed() {
        let sandbox = TestSandbox::new("antigravity-version-attributed");
        let pid = sandbox.path("pid");
        let binary = sandbox.path("antigravity-cli-slow-version");
        crate::test_support::executable_fixture::write_executable(
            &binary,
            format!(
                "#!/bin/sh\ncase \"$1\" in --version) printf '%s\\n' \"$$\" > '{0}.tmp'; mv '{0}.tmp' '{0}'; sleep 1; printf '%s\\n' 1.5.13; exit 0 ;; esac\nexit 0\n",
                pid.display()
            ),
        );
        let settings = antigravity_probe_settings(sandbox.root(), &binary, true);
        let maintenance = ProviderMaintenance::new();
        let registry = ProcessAttributionRegistry::new();
        let watch = async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while tokio::time::Instant::now() < deadline {
                if let Ok(text) = std::fs::read_to_string(&pid)
                    && let Ok(pid) = text.trim().parse::<u32>()
                    && registry
                        .registered_sources()
                        .iter()
                        .any(|(identity, _)| identity.pid == pid)
                {
                    return true;
                }
                sleep(Duration::from_millis(20)).await;
            }
            false
        };
        let (_, attributed) = tokio::join!(
            probe_full(
                &settings,
                Some("antigravity"),
                sandbox.root(),
                &maintenance,
                Some(&registry),
            ),
            watch
        );
        assert!(attributed, "the version check was not attributed");
    }

    /// Catalog edge cases outside the measured shape: model options that list nothing fall back
    /// to `availableModels`; a `thought_level` without a category, or with no options, still
    /// gives the current model its levels; level ids stay the CLI's own.
    #[test]
    fn antigravity_catalog_edge_cases_follow_the_cli() {
        let fallback = antigravity_models(
            &json!({
                "configOptions": [{ "id": "model", "options": [] }],
                "models": { "availableModels": [{ "modelId": "alpha-high" }],
                    "currentModelId": "alpha-high" }
            }),
            &[],
        )
        .expect("a catalog");
        assert_eq!(fallback[0]["slug"], "alpha-high");

        // The chat runtime's test sends a turn with the level published from these options.
        let uncategorized = antigravity_models(
            &json!({
                "configOptions": crate::provider::antigravity::runtime::uncategorized_level_options()
            }),
            &[],
        )
        .expect("a catalog");
        assert_eq!(
            uncategorized[0]["capabilities"],
            json!({ "optionDescriptors": [{ "id": "reasoning", "label": "Thinking", "type": "select",
                "options": [
                    { "id": "extra-high", "label": "Extra High" },
                    { "id": "low", "label": "low", "isDefault": true }
                ] }] })
        );

        let empty_levels = antigravity_models(
            &json!({
                "configOptions": [
                    { "id": "model", "currentValue": "alpha", "options": [{ "value": "alpha" }] },
                    { "id": "thought_level", "category": "thought_level", "options": [] }
                ],
                "models": { "availableModels": [{ "modelId": "alpha-low" }] }
            }),
            &[],
        )
        .expect("a catalog");
        assert_eq!(
            empty_levels[0]["capabilities"]["optionDescriptors"][0]["options"],
            json!([{ "id": "low", "label": "low" }])
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_antigravity_full_probe_reads_models_levels_and_sign_in_over_acp() {
        let sandbox = TestSandbox::new("antigravity-acp");
        let (binary, requests) = antigravity_acp_fixture(
            &sandbox,
            "antigravity-cli-acp",
            "1.5.13",
            &format!(r#""result":{}"#, antigravity_session()),
        );
        let mut settings = antigravity_probe_settings(sandbox.root(), &binary, true);
        settings["providerInstances"]["antigravity"]["config"]["customModels"] =
            json!(["custom-one", "alpha"]);

        let snapshot = probe_antigravity(&sandbox, &settings).await;

        assert_eq!(snapshot["status"], "ready");
        assert_eq!(snapshot["installed"], true);
        assert_eq!(snapshot["version"], "1.5.13");
        assert_eq!(snapshot["auth"], json!({ "status": "authenticated" }));
        assert!(snapshot.get("message").is_none(), "{snapshot}");
        // The chat reports ACP `usage_update`, so the composer shows its context meter.
        assert_eq!(snapshot["supportsContextWindowUsage"], true);
        let mut expected = expected_antigravity_models();
        expected.extend(custom_models(&["custom-one".to_owned()]));
        assert_eq!(snapshot["models"], Value::Array(expected));
        let requests = antigravity_requests(&requests);
        let methods = requests
            .iter()
            .map(|request| request["method"].as_str().unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(methods, ["initialize", "session/new", "session/close"]);
        assert_eq!(requests[0]["params"]["protocolVersion"], 1);
        assert_eq!(
            requests[1]["params"],
            json!({ "cwd": std::env::temp_dir(), "mcpServers": [] })
        );
        assert_eq!(requests[2]["params"], json!({ "sessionId": "session-1" }));
        assert!(
            !snapshot.to_string().contains(ANTIGRAVITY_MARKER),
            "{snapshot}"
        );
    }

    /// Without `configOptions` the CLI's `availableModels` ids are published unchanged, effort
    /// suffix included, because the chat sends them back as they are.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_antigravity_session_without_config_options_publishes_its_available_models() {
        let sandbox = TestSandbox::new("antigravity-available-models");
        let session = json!({
            "sessionId": "session-1",
            "models": {
                "availableModels": [
                    { "modelId": "alpha-high", "name": "Alpha (High)" },
                    { "modelId": "alpha-pro-high", "name": "Alpha Pro (High)" }
                ],
                "currentModelId": "alpha-pro-high"
            }
        });
        let (binary, _) = antigravity_acp_fixture(
            &sandbox,
            "antigravity-cli-models",
            "1.5.13",
            &format!(r#""result":{session}"#),
        );

        let snapshot = probe_antigravity(
            &sandbox,
            &antigravity_probe_settings(sandbox.root(), &binary, true),
        )
        .await;

        let none = json!({ "optionDescriptors": [] });
        assert_eq!(
            snapshot["models"],
            json!([
                { "slug": "alpha-pro-high", "name": "Alpha Pro (High)", "isCustom": false,
                  "capabilities": none },
                { "slug": "alpha-high", "name": "Alpha (High)", "isCustom": false,
                  "capabilities": none }
            ])
        );
        assert_eq!(snapshot["auth"], json!({ "status": "authenticated" }));
    }

    /// The CLI's order is kept when it lists its current model first, as the measured CLI does.
    #[test]
    fn antigravity_models_keep_the_cli_order_when_the_current_model_is_first() {
        let mut session = antigravity_session();
        session["configOptions"][0]["currentValue"] = json!("alpha");
        session["models"]["currentModelId"] = json!("alpha-high");
        let models = antigravity_models(&session, &[]).expect("a catalog");
        let slugs = models
            .iter()
            .map(|model| model["slug"].as_str().unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(
            slugs,
            [
                "alpha",
                "alpha-pro",
                "beta-orchestrator",
                "gamma-120b-medium",
                "delta",
                "epsilon",
                "epsilon-high"
            ]
        );
        // `alpha` is now the current model: its levels and default come from `thought_level`.
        assert_eq!(
            models[0]["capabilities"]["optionDescriptors"][0]["options"][2],
            json!({ "id": "high", "label": "High", "isDefault": true })
        );
        assert!(antigravity_models(&json!({ "sessionId": "session-1" }), &[]).is_none());
    }

    /// Only "Authentication required" reads as signed out: another `-32000` leaves the sign-in
    /// unknown and no sign-in message.
    #[cfg(unix)]
    #[tokio::test]
    async fn another_antigravity_server_error_is_not_read_as_signed_out() {
        let sandbox = TestSandbox::new("antigravity-other-32000");
        let (binary, _) = antigravity_acp_fixture(
            &sandbox,
            "antigravity-cli-other-32000",
            "1.5.13",
            r#""error":{"code":-32000,"message":"Rate limited"}"#,
        );
        let snapshot = probe_antigravity(
            &sandbox,
            &antigravity_probe_settings(sandbox.root(), &binary, true),
        )
        .await;
        assert_eq!(snapshot["auth"], json!({ "status": "unknown" }));
        assert!(snapshot.get("message").is_none(), "{snapshot}");
    }

    /// `-32000` "Authentication required" reads as signed out while the instance stays ready,
    /// so the terminal the user signs in with stays available; the CLI's text never shows.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_antigravity_sign_in_failure_reads_unauthenticated_and_ready() {
        let sandbox = TestSandbox::new("antigravity-sign-in");
        let (binary, _) = antigravity_acp_fixture(
            &sandbox,
            "antigravity-cli-signed-out",
            "1.5.13",
            &format!(
                r#""error":{{"code":-32000,"message":"Authentication required","data":{{"detail":"{ANTIGRAVITY_MARKER}"}}}}"#
            ),
        );
        let mut settings = antigravity_probe_settings(sandbox.root(), &binary, true);
        settings["providerInstances"]["antigravity"]["config"]["customModels"] =
            json!(["custom-one"]);

        let result = probe_antigravity_result(&sandbox, &settings).await;
        // The signed-out account's catalog is gone: the merge must not keep the last one.
        assert!(result.models_authoritative);
        let snapshot = result.snapshot;

        assert_eq!(snapshot["status"], "ready");
        assert_eq!(snapshot["auth"], json!({ "status": "unauthenticated" }));
        assert_eq!(snapshot["message"], ANTIGRAVITY_SIGN_IN_MESSAGE);
        assert_eq!(
            snapshot["models"],
            Value::Array(custom_models(&["custom-one".to_owned()]))
        );
        assert!(
            !snapshot.to_string().contains(ANTIGRAVITY_MARKER),
            "{snapshot}"
        );
    }

    /// Any other failure keeps the custom models and an unknown sign-in, and its log line names
    /// the step and the error code only. In a process of its own for the log capture.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_antigravity_probe_failure_keeps_custom_models_and_logs_no_peer_text() {
        let Some(child) = crate::test_support::in_own_process(
            "production::provider_inventory::tests::an_antigravity_probe_failure_keeps_custom_models_and_logs_no_peer_text",
        ) else {
            return;
        };
        #[derive(Clone, Default)]
        struct Captured(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Captured {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let log = Captured::default();
        let _logging = tracing::subscriber::set_default(
            tracing_subscriber::fmt()
                .with_ansi(false)
                .with_max_level(tracing::Level::TRACE)
                .with_writer({
                    let log = log.clone();
                    move || log.clone()
                })
                .finish(),
        );
        let sandbox = TestSandbox::new("antigravity-probe-error");
        let (binary, _) = antigravity_acp_fixture(
            &sandbox,
            "antigravity-cli-error",
            "1.5.13",
            &format!(
                r#""error":{{"code":-32603,"message":"Internal {ANTIGRAVITY_MARKER}","data":{{"detail":"{ANTIGRAVITY_MARKER}"}}}}"#
            ),
        );
        let mut settings = antigravity_probe_settings(sandbox.root(), &binary, true);
        settings["providerInstances"]["antigravity"]["config"]["customModels"] =
            json!(["custom-one"]);

        let snapshot = probe_antigravity(&sandbox, &settings).await;

        assert_eq!(snapshot["status"], "ready");
        assert_eq!(snapshot["auth"], json!({ "status": "unknown" }));
        assert_eq!(
            snapshot["models"],
            Value::Array(custom_models(&["custom-one".to_owned()]))
        );
        assert!(
            !snapshot.to_string().contains(ANTIGRAVITY_MARKER),
            "{snapshot}"
        );
        let text = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
        assert!(
            text.lines()
                .any(|line| line.contains("Antigravity inventory probe")
                    && line.contains("step=\"session/new\"")
                    && line.contains("failure=\"error -32603\"")),
            "{text}"
        );
        assert!(!text.contains(ANTIGRAVITY_MARKER), "{text}");
        child.complete();
    }

    /// The version comes from stdout only: a `--version` that writes only to stderr reports no
    /// version, in the inventory and in the maintenance check.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_antigravity_version_never_takes_a_line_of_stderr() {
        let sandbox = TestSandbox::new("antigravity-version-stderr");
        let binary = sandbox.path("antigravity-cli-stderr");
        crate::test_support::executable_fixture::write_executable(
            &binary,
            format!(
                "#!/bin/sh\nprintf '%s\\n' 'stderr-{ANTIGRAVITY_MARKER}' >&2\n[ \"$1\" = --version ] || exit 1\n"
            ),
        );
        let settings = antigravity_probe_settings(sandbox.root(), &binary, true);

        let snapshot = probe_antigravity(&sandbox, &settings).await;
        assert_eq!(snapshot["version"], Value::Null, "{snapshot}");
        assert!(!snapshot.to_string().contains(ANTIGRAVITY_MARKER));

        let target = maintenance_target(&settings, "antigravity", Some("antigravity"))
            .expect("the Antigravity target");
        assert_eq!(
            probe_maintenance_target_version(&target, sandbox.root()).await,
            None
        );
    }

    /// The quick probe starts no ACP process: it only resolves the executable.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_quick_antigravity_probe_starts_no_process() {
        let sandbox = TestSandbox::new("antigravity-quick");
        let ran = sandbox.path("ran");
        let binary = sandbox.path("antigravity-cli-quick");
        crate::test_support::executable_fixture::write_executable(
            &binary,
            format!("#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\n", ran.display()),
        );
        let snapshot = probe(
            &antigravity_probe_settings(sandbox.root(), &binary, true),
            Some("antigravity"),
            sandbox.root(),
            &ProviderMaintenance::new(),
        )
        .await
        .into_iter()
        .next()
        .expect("the Antigravity snapshot")
        .snapshot;
        assert_eq!(snapshot["status"], "ready");
        assert_eq!(snapshot["auth"], json!({ "status": "unknown" }));
        assert!(!ran.exists(), "the quick probe must start no process");
    }

    /// A refresh that drops the probe still stops the whole process group and reaps it, and the
    /// probe's attribution ends with it.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_dropped_antigravity_probe_stops_and_reaps_its_processes() {
        let sandbox = TestSandbox::new("antigravity-drop");
        let pids = sandbox.path("pids");
        let binary = sandbox.path("antigravity-cli-hangs");
        crate::test_support::executable_fixture::write_executable(
            &binary,
            format!(
                "#!/bin/sh\ncase \"$1\" in --version) printf '%s\\n' 1.5.13; exit 0 ;; esac\nsleep 30 &\nprintf '%s %s\\n' \"$$\" \"$!\" > '{0}.tmp'\nmv '{0}.tmp' '{0}'\nwait\n",
                pids.display()
            ),
        );
        let settings = antigravity_probe_settings(sandbox.root(), &binary, true);
        let maintenance = ProviderMaintenance::new();
        let registry = ProcessAttributionRegistry::new();
        let probe = probe_full(
            &settings,
            Some("antigravity"),
            sandbox.root(),
            &maintenance,
            Some(&registry),
        );
        let wait_for_pids = async {
            loop {
                if let Ok(text) = std::fs::read_to_string(&pids) {
                    let mut parts = text.split_whitespace().map(|pid| pid.parse::<u32>());
                    if let (Some(Ok(root)), Some(Ok(grandchild))) = (parts.next(), parts.next()) {
                        let attributed =
                            registry
                                .registered_sources()
                                .iter()
                                .any(|(identity, source)| {
                                    identity.pid == root
                                        && *source
                                            == crate::diagnostics::RegistrationSource::Provider
                                });
                        return (root, grandchild, attributed);
                    }
                }
                sleep(Duration::from_millis(20)).await;
            }
        };
        // `select!` drops the probe future before it returns, as a superseded refresh does.
        let (root, grandchild, attributed) = tokio::select! {
            _ = probe => panic!("the probe finished without an answer"),
            pids = wait_for_pids => pids,
        };
        assert!(attributed, "the running probe process is attributed");
        let gone = |pid: u32| {
            // SAFETY: signal 0 only checks that the pid exists; a zombie still exists.
            let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
            result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !(gone(root) && gone(grandchild) && registry.registered_sources().is_empty()) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "root gone: {}, grandchild gone: {}, attributed: {:?}",
                gone(root),
                gone(grandchild),
                registry.registered_sources()
            );
            sleep(Duration::from_millis(20)).await;
        }
    }

    /// An instance the user configured under the id `antigravity` before this driver existed
    /// keeps the id: the built-in default is not synthesized beside it.
    #[test]
    fn a_configured_instance_that_owns_the_antigravity_id_is_not_duplicated() {
        let settings = json!({
            "providerInstances": {
                "antigravity": { "driver": "codex", "enabled": true, "config": {} }
            }
        });
        let owners = definitions(&settings)
            .into_iter()
            .filter(|definition| definition.instance_id == "antigravity")
            .map(|definition| definition.driver)
            .collect::<Vec<_>>();
        assert_eq!(owners, ["codex"]);
    }

    #[test]
    fn configured_instances_do_not_hide_enabled_legacy_providers() {
        let settings = json!({
            "providerInstances": {
                "cursor": {
                    "driver": "cursor",
                    "enabled": true,
                    "config": { "binaryPath": "agent" }
                }
            },
            "providers": {
                "codex": { "enabled": true, "binaryPath": "codex" },
                "claudeAgent": { "enabled": true, "binaryPath": "claude" },
                "cursor": { "enabled": false, "binaryPath": "agent" },
                "grok": { "enabled": true, "binaryPath": "grok" },
                "opencode": { "enabled": true, "binaryPath": "opencode" }
            }
        });

        let definitions = definitions(&settings);
        let drivers = definitions
            .iter()
            .map(|definition| definition.driver.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            drivers,
            [
                "cursor",
                "codex",
                "claudeAgent",
                "grok",
                "opencode",
                "antigravity"
            ]
        );
        assert_eq!(
            drivers.iter().filter(|driver| **driver == "cursor").count(),
            1
        );
    }

    /// A launch reads an instance's custom models exactly as the catalog does, so the models the
    /// catalog offers are the models the launch accepts.
    #[test]
    fn instance_custom_models_are_the_ones_the_catalog_offers() {
        let settings = json!({
            "providers": { "codex": { "customModels": ["legacy-custom"] } },
            "providerInstances": {
                "codex-work": {
                    "driver": "codex",
                    "config": { "customModels": [" work-custom ", ""] }
                },
                "codex-plain": { "driver": "codex" }
            }
        });
        assert_eq!(
            instance_custom_models(&settings, "codex-work"),
            vec!["work-custom"]
        );
        // An instance without a list of its own takes its driver's legacy list.
        assert_eq!(
            instance_custom_models(&settings, "codex-plain"),
            vec!["legacy-custom"]
        );
        assert!(instance_custom_models(&settings, "codex-missing").is_empty());
        // Settings without instances offer the legacy list on the default instance.
        assert_eq!(
            instance_custom_models(
                &json!({ "providers": { "codex": { "customModels": ["legacy-custom"] } } }),
                "codex"
            ),
            vec!["legacy-custom"]
        );
    }

    #[test]
    fn grok_inventory_stays_disabled_when_saved_settings_enable_it() {
        let legacy = definitions(&json!({
            "providers": {
                "grok": { "enabled": true, "binaryPath": "grok" }
            }
        }));
        let legacy_grok = legacy
            .iter()
            .find(|definition| definition.instance_id == "grok")
            .expect("legacy Grok definition");
        assert!(!legacy_grok.enabled);

        let custom = definitions(&json!({
            "providerInstances": {
                "grok_work": {
                    "driver": "grok",
                    "enabled": true,
                    "config": { "binaryPath": "grok-work" }
                }
            }
        }));
        let custom_grok = custom
            .iter()
            .find(|definition| definition.instance_id == "grok_work")
            .expect("custom Grok definition");
        assert!(!custom_grok.enabled);
    }

    #[test]
    fn codex_inventory_keeps_effort_but_not_unverified_fast_before_live_discovery() {
        let definitions = definitions(&json!({
            "providerInstances": {
                "codex": { "driver": "codex", "enabled": true, "config": {} }
            },
            "providerSessionDefaults": {
                "codex": {
                    "model": "gpt-configured",
                    "options": [
                        { "id": "reasoningEffort", "value": "xhigh" },
                        { "id": "serviceTier", "value": "fast" }
                    ]
                }
            }
        }));
        let models = provider_models_without_version(&definitions[0]);

        assert_eq!(models[0]["slug"], "gpt-configured");
        assert_eq!(
            models[0]["capabilities"]["optionDescriptors"][0]["currentValue"],
            "xhigh"
        );
        assert_eq!(
            models[0]["capabilities"]["optionDescriptors"]
                .as_array()
                .expect("fallback option descriptors")
                .len(),
            1
        );
    }

    #[test]
    fn codex_inventory_marks_native_skills_as_dollar_invoked() {
        let inventory = codex_skill_inventory(&[codex::CodexProviderSkill {
            name: "refactor".to_owned(),
            path: "/fixture/refactor/SKILL.md".to_owned(),
            enabled: true,
            description: Some("Refactor fixture code".to_owned()),
            scope: Some("project".to_owned()),
            display_name: None,
            short_description: None,
        }]);

        assert_eq!(inventory.len(), 1);
        assert_eq!(inventory[0]["name"], "refactor");
        assert_eq!(inventory[0]["invocation"], "dollar");
    }

    #[test]
    fn provider_snapshots_stamp_instance_labels() {
        let definitions = definitions(&json!({
            "providerInstances": {
                "codex_personal": { "driver": "codex" },
                "codex": { "driver": "codex" },
                "codex_work": { "driver": "codex", "displayName": "  Work Codex  " }
            }
        }));
        let labels = ["codex_personal", "codex", "codex_work"].map(|instance_id| {
            snapshot_owned_message(
                definitions
                    .iter()
                    .find(|definition| definition.instance_id == instance_id)
                    .expect("configured provider definition"),
                true,
                None,
                "ready",
                json!({ "status": "authenticated" }),
                Vec::new(),
                ProviderCapabilities::default(),
                None,
                "2026-08-01T00:00:00.000Z".to_owned(),
            )["displayName"]
                .clone()
        });

        assert_eq!(
            labels,
            [json!("Codex Personal"), json!("Codex"), json!("Work Codex")]
        );
    }

    #[test]
    fn provider_inventory_advertises_measured_toolbar_capabilities() {
        let definitions = definitions(&json!({}));
        let snapshot_for = |driver| {
            snapshot_owned_message(
                definitions
                    .iter()
                    .find(|definition| definition.driver == driver)
                    .expect("built-in provider definition"),
                true,
                None,
                "ready",
                json!({ "status": "authenticated" }),
                Vec::new(),
                ProviderCapabilities::default(),
                None,
                "2026-08-01T00:00:00.000Z".to_owned(),
            )
        };
        let codex = snapshot_for("codex");
        let claude = snapshot_for("claudeAgent");
        let cursor = snapshot_for("cursor");
        let grok = snapshot_for("grok");
        let opencode = snapshot_for("opencode");

        assert_eq!(codex["supportsConversationRewind"], true);
        assert_eq!(opencode["supportsConversationRewind"], true);
        assert_eq!(claude["supportsConversationRewind"], false);
        assert_eq!(cursor["supportsConversationRewind"], false);
        assert_eq!(grok["supportsConversationRewind"], false);
        assert_eq!(codex["supportsTurnSteer"], true);
        assert_eq!(claude["supportsTurnSteer"], true);
        assert!(cursor.get("supportsTurnSteer").is_none());
        assert!(grok.get("supportsTurnSteer").is_none());
        assert!(opencode.get("supportsTurnSteer").is_none());
        assert_eq!(codex["supportsMcpStatus"], true);
        assert_eq!(claude["supportsMcpStatus"], true);
        assert!(cursor.get("supportsMcpStatus").is_none());
        assert!(grok.get("supportsMcpStatus").is_none());
        assert!(opencode.get("supportsMcpStatus").is_none());
        assert_eq!(codex["supportsContextWindowUsage"], true);
        assert_eq!(claude["supportsContextWindowUsage"], true);
        assert!(cursor.get("supportsContextWindowUsage").is_none());
        assert!(grok.get("supportsContextWindowUsage").is_none());
        assert!(opencode.get("supportsContextWindowUsage").is_none());
        assert_eq!(codex["supportsCompaction"], true);
        assert_eq!(claude["supportsCompaction"], true);
        assert!(cursor.get("supportsCompaction").is_none());
        assert!(grok.get("supportsCompaction").is_none());
        assert!(opencode.get("supportsCompaction").is_none());
    }

    #[test]
    fn codex_inventory_keeps_legacy_effort_but_not_unverified_fast_before_live_discovery() {
        let definitions = definitions(&json!({
            "providerInstances": {
                "codex": { "driver": "codex", "enabled": true, "config": {} }
            },
            "providerSessionDefaults": {
                "codex": {
                    "model": "gpt-legacy",
                    "options": {
                        "effort": "xhigh",
                        "fastMode": true
                    }
                }
            }
        }));
        let models = provider_models_without_version(&definitions[0]);

        assert_eq!(models[0]["slug"], "gpt-legacy");
        assert_eq!(
            models[0]["capabilities"]["optionDescriptors"][0]["currentValue"],
            "xhigh"
        );
        assert_eq!(
            models[0]["capabilities"]["optionDescriptors"]
                .as_array()
                .expect("fallback option descriptors")
                .len(),
            1
        );
    }

    #[test]
    fn codex_cli_version_is_normalized_to_semver() {
        assert_eq!(
            normalize_provider_version("codex", Some("codex-cli 0.144.1".to_owned())),
            Some("0.144.1".to_owned())
        );
    }

    #[test]
    fn codex_required_auth_is_not_reported_as_ready() {
        let account = json!({ "account": null, "requiresOpenaiAuth": true });

        assert_eq!(
            codex_probe_health(&account),
            (
                "error",
                json!({ "status": "unauthenticated" }),
                Some("Codex is installed but requires authentication.")
            )
        );
    }

    #[test]
    fn codex_authenticated_account_remains_ready_when_openai_auth_is_required() {
        let account = json!({
            "account": {
                "type": "chatgpt",
                "email": "user@example.com"
            },
            "requiresOpenaiAuth": true
        });

        assert_eq!(
            codex_probe_health(&account),
            (
                "ready",
                json!({
                    "status": "authenticated",
                    "type": "chatgpt",
                    "email": "user@example.com"
                }),
                None
            )
        );
    }

    #[test]
    fn codex_without_required_openai_auth_remains_ready() {
        let account = json!({ "account": null, "requiresOpenaiAuth": false });

        assert_eq!(
            codex_probe_health(&account),
            ("ready", json!({ "status": "unauthenticated" }), None)
        );
    }

    #[test]
    fn grok_inventory_has_a_builtin_model_before_acp_discovery() {
        let definition = ProviderDefinition {
            instance_id: "grok".to_owned(),
            driver: "grok".to_owned(),
            display_name: None,
            enabled: true,
            binary_path: "grok".to_owned(),
            available: true,
            custom_models: Vec::new(),
            configured_model: None,
            configured_effort: None,
            configured_service_tier: None,
            endpoint: None,
            server_password: None,
            environment: Vec::new(),
            missing_secret: false,
            secret_values: Vec::new(),
        };

        assert_eq!(
            provider_models_without_version(&definition)[0]["slug"],
            "grok-build"
        );
    }

    #[test]
    fn provider_environment_excludes_redacted_and_empty_entries() {
        let instance = json!({
            "environment": [
                { "name": "API_KEY", "value": "secret", "valueRedacted": false },
                { "name": "pAtH", "value": "/first", "valueRedacted": false },
                { "name": "PATH", "value": "/second", "valueRedacted": false },
                { "name": "HIDDEN", "value": "redacted", "valueRedacted": true },
                { "name": "", "value": "ignored", "valueRedacted": false }
            ]
        });
        assert_eq!(
            provider_environment(&instance),
            vec![
                (OsString::from("API_KEY"), OsString::from("secret")),
                (OsString::from("PATH"), OsString::from("/first"))
            ]
        );
    }

    #[test]
    fn claude_initialization_exposes_commands_and_agents() {
        let metadata = parse_claude_initialization_response(
            &json!({
                "commands": [
                    { "name": "goal", "description": "Keep working", "argumentHint": "[condition]" },
                    { "name": "loop", "description": "Run repeatedly", "argumentHint": "[interval] [prompt]" }
                ],
                "agents": [
                    { "name": "code-reviewer", "description": "Reviews code", "model": "opus" }
                ]
            }),
            &[],
        );
        let capabilities = metadata.capabilities;

        assert_eq!(capabilities.slash_commands[0]["name"], "goal");
        assert_eq!(
            capabilities.slash_commands[0]["input"]["hint"],
            "[condition]"
        );
        assert_eq!(capabilities.slash_commands[1]["name"], "loop");
        assert_eq!(capabilities.agents[0]["name"], "code-reviewer");
        assert_eq!(capabilities.agents[0]["model"], "opus");

        let mut models = vec![json!({"capabilities": {}})];
        apply_agent_options(&mut models, &[json!({"name":"reviewer"})]);
        assert_eq!(
            models[0]["capabilities"]["optionDescriptors"][0]["currentValue"],
            "reviewer"
        );
    }

    #[test]
    fn claude_reload_skills_uses_provider_native_slash_invocation() {
        let skills = parse_claude_skills_response(&json!({
            "skills": [
                { "name": "loop", "description": "Run repeatedly", "argumentHint": "[interval] [prompt]" },
                { "name": "loop", "description": "Duplicate lower-priority skill" }
            ]
        }), &json!({"commands":[{"name":"loop"}]}))
        .expect("valid skills response");

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0]["name"], "loop");
        assert_eq!(skills[0]["invocation"], "slash");
        assert_eq!(skills[0]["path"], "claude://skill/loop");
    }

    #[test]
    fn claude_skills_prioritize_primary_command_names_over_aliases() {
        let skills = parse_claude_skills_response(
            &json!({"skills":[{"name":"beta"}]}),
            &json!({"commands":[{"name":"alpha","aliases":["beta"]},{"name":"beta"}]}),
        )
        .expect("valid native catalogs");
        assert_eq!(skills[0]["name"], "beta");
    }

    #[test]
    fn claude_skills_probe_distinguishes_empty_inventory_from_parse_failure() {
        assert_eq!(
            parse_claude_skills_response(&json!({ "skills": [] }), &json!({"commands":[]})),
            Some(Vec::new())
        );
        assert_eq!(
            parse_claude_skills_response(&json!({ "skills": "invalid" }), &json!({"commands":[]})),
            None
        );
    }

    #[test]
    fn claude_inventory_probe_disables_hooks_without_disabling_capabilities() {
        assert!(
            CLAUDE_CAPABILITY_PROBE_ARGS
                .windows(2)
                .any(|pair| pair == ["--settings", r#"{"disableAllHooks":true}"#])
        );
        assert!(CLAUDE_CAPABILITY_PROBE_ARGS.contains(&"--setting-sources=user,project,local"));
        assert!(!CLAUDE_CAPABILITY_PROBE_ARGS.contains(&"--safe-mode"));
        assert!(!CLAUDE_CAPABILITY_PROBE_ARGS.contains(&"--bare"));
    }

    #[test]
    fn opencode_command_inventory_preserves_arguments() {
        let commands = opencode::model::command_inventory(&json!([
            {
                "name": "review",
                "description": "Review changes",
                "template": "Review $ARGUMENTS"
            }
        ]));

        assert_eq!(commands[0]["name"], "review");
        assert_eq!(commands[0]["input"]["hint"], "arguments");
    }

    #[tokio::test]
    async fn full_probe_does_not_serialize_independent_provider_inventories() {
        let sandbox = tempfile::tempdir().unwrap();
        let missing =
            crate::test_support::hermetic_providers::missing_provider_executable(sandbox.path());
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(6));
        let app = Router::new()
            .route(
                "/global/health",
                get(|| async { Json(json!({ "healthy": true })) }),
            )
            .route(
                "/{*path}",
                get(move || {
                    let barrier = barrier.clone();
                    async move {
                        barrier.wait().await;
                        Json(json!({}))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake OpenCode server");
        let endpoint = format!("http://{}", listener.local_addr().expect("local address"));
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve fake OpenCode API");
        });
        let settings = json!({
            "enableProviderUpdateChecks": false,
            "providers": {
                "codex": { "enabled": false, "binaryPath": missing },
                "claudeAgent": { "enabled": false, "binaryPath": missing },
                "cursor": { "enabled": false, "binaryPath": missing },
                "grok": { "enabled": false, "binaryPath": missing },
                "opencode": { "enabled": false, "binaryPath": missing },
                "antigravity": { "enabled": false, "binaryPath": missing }
            },
            "providerInstances": {
                "first": {
                    "driver": "opencode",
                    "enabled": true,
                    "config": { "serverUrl": endpoint }
                },
                "second": {
                    "driver": "opencode",
                    "enabled": true,
                    "config": { "serverUrl": endpoint }
                }
            }
        });

        let maintenance = ProviderMaintenance::new();
        let result = timeout(
            Duration::from_secs(2),
            probe_full(&settings, None, Path::new("."), &maintenance, None),
        )
        .await;
        server.abort();

        let result = result.expect("independent provider probes should not block each other");
        assert_eq!(result[0].snapshot["instanceId"], "first");
        assert_eq!(result[1].snapshot["instanceId"], "second");
    }

    #[tokio::test]
    async fn opencode_partial_inventory_is_not_authoritative() {
        let app = Router::new()
            .route(
                "/provider",
                get(|| async {
                    Json(json!({
                        "all": [{
                            "id": "openai",
                            "name": "OpenAI",
                            "models": {
                                "gpt-5": {
                                    "id": "gpt-5",
                                    "providerID": "openai",
                                    "name": "GPT-5"
                                }
                            }
                        }],
                        "connected": ["openai"],
                        "default": { "openai": "gpt-5" }
                    }))
                }),
            )
            .route(
                "/agent",
                get(|| async {
                    Json(json!([{
                        "name": "build",
                        "description": "Default agent",
                        "mode": "primary",
                        "native": true
                    }]))
                }),
            )
            .route(
                "/command",
                get(|| async {
                    sleep(Duration::from_millis(200)).await;
                    Json(json!([{
                        "name": "review",
                        "description": "Review changes",
                        "template": "Review $ARGUMENTS"
                    }]))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake OpenCode server");
        let endpoint = format!("http://{}", listener.local_addr().expect("local address"));
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve fake OpenCode API");
        });

        let inventory = probe_opencode_with_timeout(
            &endpoint,
            None,
            &["custom/model".to_owned()],
            Duration::from_millis(75),
            opencode::OpenCodeProtocol::V1,
            Path::new("."),
        )
        .await;
        server.abort();

        assert!(inventory.is_none());
        assert!(
            probe_opencode(
                "http://127.0.0.1:1",
                None,
                &[],
                opencode::OpenCodeProtocol::V1,
                Path::new("."),
            )
            .await
            .is_none()
        );
    }

    #[tokio::test]
    async fn cursor_discovers_project_commands_skills_and_agents() {
        let workspace = tempfile::tempdir().expect("temporary Cursor workspace");
        let command_directory = workspace.path().join(".cursor/commands");
        let skill_directory = workspace.path().join(".cursor/skills/review-code");
        let agent_directory = workspace.path().join(".cursor/agents");
        tokio::fs::create_dir_all(&command_directory)
            .await
            .expect("create Cursor command directory");
        tokio::fs::create_dir_all(&skill_directory)
            .await
            .expect("create Cursor skill directory");
        tokio::fs::create_dir_all(&agent_directory)
            .await
            .expect("create Cursor agent directory");
        tokio::fs::write(
            command_directory.join("review.md"),
            "Review the current changes.",
        )
        .await
        .expect("write Cursor command");
        tokio::fs::write(skill_directory.join("SKILL.md"), "# Review code")
            .await
            .expect("write Cursor skill");
        tokio::fs::write(
            agent_directory.join("reviewer.md"),
            "Review code carefully.",
        )
        .await
        .expect("write Cursor agent");

        let capabilities = cursor::discover_workspace_capabilities(workspace.path()).await;

        assert!(
            capabilities
                .slash_commands
                .iter()
                .any(|command| command["name"] == "review")
        );
        assert!(capabilities.skills.iter().any(|skill| {
            skill["name"] == "review-code"
                && skill["scope"] == "project"
                && skill["invocation"] == "slash"
        }));
        assert!(
            capabilities
                .agents
                .iter()
                .any(|agent| agent["name"] == "reviewer")
        );
    }

    #[tokio::test]
    async fn cursor_discovers_only_the_configured_environment_home() {
        let workspace = tempfile::tempdir().expect("temporary Cursor workspace");
        let configured_home = tempfile::tempdir().expect("temporary configured Cursor home");
        let command_directory = configured_home.path().join(".cursor/commands");
        let skill_directory = configured_home.path().join(".cursor/skills/user-review");
        let agent_directory = configured_home.path().join(".cursor/agents");
        tokio::fs::create_dir_all(&command_directory)
            .await
            .expect("create configured Cursor command directory");
        tokio::fs::create_dir_all(&skill_directory)
            .await
            .expect("create configured Cursor skill directory");
        tokio::fs::create_dir_all(&agent_directory)
            .await
            .expect("create configured Cursor agent directory");
        tokio::fs::write(
            command_directory.join("configured-review.md"),
            "Review from the configured user home.",
        )
        .await
        .expect("write configured Cursor command");
        tokio::fs::write(skill_directory.join("SKILL.md"), "# Configured review")
            .await
            .expect("write configured Cursor skill");
        tokio::fs::write(
            agent_directory.join("configured-reviewer.md"),
            "Review from the configured user home.",
        )
        .await
        .expect("write configured Cursor agent");
        let home_variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let environment = vec![(
            OsString::from(home_variable),
            configured_home.path().as_os_str().to_owned(),
        )];

        let capabilities = cursor::discover_workspace_capabilities_with_environment(
            workspace.path(),
            &environment,
        )
        .await;

        assert_eq!(
            capabilities
                .slash_commands
                .iter()
                .map(|command| command["name"].as_str().expect("Cursor command name"))
                .collect::<Vec<_>>(),
            vec!["configured-review"]
        );
        assert_eq!(
            capabilities
                .skills
                .iter()
                .map(|skill| (
                    skill["name"].as_str().expect("Cursor skill name"),
                    skill["scope"].as_str().expect("Cursor skill scope"),
                ))
                .collect::<Vec<_>>(),
            vec![("user-review", "user")]
        );
        assert_eq!(
            capabilities
                .agents
                .iter()
                .map(|agent| agent["name"].as_str().expect("Cursor agent name"))
                .collect::<Vec<_>>(),
            vec!["configured-reviewer"]
        );
    }

    #[test]
    fn built_in_capabilities_include_provider_specific_goal_and_loop_commands() {
        let codex = built_in_slash_commands("codex");
        assert!(codex.iter().any(|command| command["name"] == "compact"));
        let claude = built_in_slash_commands("claudeAgent");
        let cursor = built_in_slash_commands("cursor");
        let grok = built_in_slash_commands("grok");

        assert!(codex.iter().any(|command| command["name"] == "goal"));
        assert!(claude.iter().any(|command| command["name"] == "goal"));
        assert!(claude.iter().any(|command| command["name"] == "loop"));
        assert!(cursor.iter().any(|command| command["name"] == "models"));
        assert!(cursor.iter().any(|command| command["name"] == "rules"));
        assert!(cursor.iter().any(|command| command["name"] == "commands"));
        assert!(grok.iter().any(|command| command["name"] == "loop"));
        assert!(grok.iter().any(|command| command["name"] == "agents"));
        assert!(grok.iter().any(|command| command["name"] == "skills"));
    }
}
