use std::{path::PathBuf, time::Duration};

use bibcode_server::{
    ACTIVE_RPC_METHODS, MethodMode, RpcRegistry, ServerConfig,
    production::{
        control::NativeServerControl, runtime::finalize_rpc_registry,
        server_terminal::ProductionServerControl,
    },
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::time::timeout;
use tokio::{net::TcpListener, sync::mpsc};
use tokio_util::sync::CancellationToken;

fn auth_descriptor() -> Value {
    json!({
        "policy": "loopback-browser",
        "bootstrapMethods": ["one-time-token"],
        "sessionMethods": ["browser-session-cookie", "bearer-access-token"],
        "sessionCookieName": "bibcode_session",
    })
}

fn complete_registry_without(excluded: &[&str]) -> RpcRegistry {
    let mut registry = RpcRegistry::empty();
    for method in ACTIVE_RPC_METHODS {
        if excluded.contains(&method.name) {
            continue;
        }
        match method.mode {
            MethodMode::Unary => registry
                .register_unary(method.name, |_request, _cancellation| async {
                    Ok(json!({}))
                }),
            MethodMode::Stream => {
                registry.register_stream(method.name, |_request, _cancellation| {
                    let (_sender, receiver) = mpsc::channel(1);
                    receiver
                })
            }
        }
    }
    registry
}

fn complete_registry() -> RpcRegistry {
    complete_registry_without(&[])
}

async fn fixture() -> (TempDir, NativeServerControl) {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let mut config = ServerConfig::new(directory.path());
    config.environment_id = "test-environment".into();
    config.environment_label = "Test Environment".into();
    let control = NativeServerControl::new(config, auth_descriptor()).await;
    finalize_rpc_registry(&complete_registry(), &control).expect("complete production registry");
    (directory, control)
}

async fn fixture_with_state_file(
    relative_path: &str,
    contents: &[u8],
) -> (TempDir, NativeServerControl) {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let path = directory.path().join("userdata").join(relative_path);
    tokio::fs::create_dir_all(path.parent().expect("state file parent"))
        .await
        .expect("create state directory");
    tokio::fs::write(path, contents)
        .await
        .expect("write state fixture");
    let mut config = ServerConfig::new(directory.path());
    config.environment_id = "test-environment".into();
    config.environment_label = "Test Environment".into();
    let control = NativeServerControl::new(config, auth_descriptor()).await;
    finalize_rpc_registry(&complete_registry(), &control).expect("complete production registry");
    (directory, control)
}

async fn write_provider_fixture(directory: &TempDir) -> PathBuf {
    #[cfg(windows)]
    let (name, contents) = (
        "provider.cmd",
        "@echo off\r\nif \"%1\"==\"about\" (echo {\"cliVersion\":\"9.8.7\",\"userEmail\":\"dev@example.com\",\"subscriptionTier\":\"pro\"}& exit /b 0)\r\necho provider 1.0.0\r\n",
    );
    #[cfg(not(windows))]
    let (name, contents) = (
        "provider",
        "#!/bin/sh\nif [ \"$1\" = \"about\" ]; then\n  echo '{\"cliVersion\":\"9.8.7\",\"userEmail\":\"dev@example.com\",\"subscriptionTier\":\"pro\"}'\nelse\n  echo 'provider 1.0.0'\nfi\n",
    );
    let path = directory.path().join(name);
    tokio::fs::write(&path, contents)
        .await
        .expect("write provider fixture");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mut permissions = tokio::fs::metadata(&path)
            .await
            .expect("provider fixture metadata")
            .permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(&path, permissions)
            .await
            .expect("make provider fixture executable");
    }
    path
}

async fn write_claude_fixture(directory: &TempDir, version: &str) -> PathBuf {
    #[cfg(windows)]
    let (name, contents) = (
        "claude.cmd",
        format!(
            "@echo off\r\nif \"%1\"==\"--version\" (echo {version} (Claude Code)& exit /b 0)\r\nif \"%1\"==\"auth\" (echo {{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"email\":\"dev@example.com\"}}& exit /b 0)\r\nexit /b 1\r\n"
        ),
    );
    #[cfg(not(windows))]
    let (name, contents) = (
        "claude",
        format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo '{version} (Claude Code)'\nelif [ \"$1\" = \"auth\" ]; then\n  echo '{{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"email\":\"dev@example.com\"}}'\nelse\n  exit 1\nfi\n"
        ),
    );
    let path = directory.path().join(name);
    tokio::fs::write(&path, contents)
        .await
        .expect("write Claude fixture");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mut permissions = tokio::fs::metadata(&path)
            .await
            .expect("Claude fixture metadata")
            .permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(&path, permissions)
            .await
            .expect("make Claude fixture executable");
    }
    path
}

async fn write_discovering_claude_fixture(directory: &TempDir) -> PathBuf {
    let script = r#"import fs from "node:fs";
import readline from "node:readline";
const version = process.env.BIBCODE_CLAUDE_FIXTURE_VERSION;
const reloadMarker = new URL("./claude-fixture-reloaded", import.meta.url);
const reloaded = fs.existsSync(reloadMarker);
if (process.argv[2] === "--version") {
  process.stdout.write(`${version} (Claude Code)\n`);
  process.exit(0);
}
if (process.argv[2] === "auth") {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "dev@example.test"
  }) + "\n");
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "control_request") return;
  if (message.request?.subtype === "initialize") {
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          commands: [],
          agents: [],
          models: reloaded ? [
            {
              value: "sonnet",
              resolvedModel: "claude-sonnet-5",
              displayName: "Sonnet",
              description: "Sonnet 5 · Efficient for routine tasks",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"]
            }
          ] : [
            {
              value: "opus",
              resolvedModel: "claude-opus-5",
              displayName: "Opus",
              description: "Opus 5 · Best for everyday, complex tasks",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
              supportsFastMode: true
            },
            {
              value: "sonnet",
              resolvedModel: "claude-sonnet-5",
              displayName: "Sonnet",
              description: "Sonnet 5 · Efficient for routine tasks",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"]
            }
          ]
        }
      }
    });
  } else if (message.request?.subtype === "reload_skills") {
    if (!reloaded) fs.writeFileSync(reloadMarker, "");
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: { skills: reloaded ? "invalid" : [{ name: "review" }] }
      }
    });
  }
});"#;
    tokio::fs::write(directory.path().join("claude-fixture.mjs"), script)
        .await
        .expect("write discovering Claude fixture");

    #[cfg(windows)]
    let (name, launcher) = (
        "claude.cmd",
        "@echo off\r\nnode \"%~dp0claude-fixture.mjs\" %*\r\n",
    );
    #[cfg(not(windows))]
    let (name, launcher) = (
        "claude",
        "#!/bin/sh\nexec node \"$(dirname \"$0\")/claude-fixture.mjs\" \"$@\"\n",
    );
    let path = directory.path().join(name);
    tokio::fs::write(&path, launcher)
        .await
        .expect("write discovering Claude launcher");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mut permissions = tokio::fs::metadata(&path)
            .await
            .expect("discovering Claude fixture metadata")
            .permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(&path, permissions)
            .await
            .expect("make discovering Claude fixture executable");
    }
    path
}

async fn call(control: &NativeServerControl, method: &'static str, payload: Value) -> Value {
    control
        .call(method, payload, CancellationToken::new())
        .await
        .unwrap_or_else(|error| panic!("{method} failed: {error}"))
}

async fn next_event(stream: &mut bibcode_server::production::server_terminal::JsonStream) -> Value {
    timeout(Duration::from_secs(2), stream.recv())
        .await
        .expect("stream event timeout")
        .expect("stream remains open")
        .expect("stream event succeeds")
        .into_iter()
        .next()
        .expect("non-empty event batch")
}

async fn next_event_of_type(
    stream: &mut bibcode_server::production::server_terminal::JsonStream,
    expected_type: &str,
) -> Value {
    timeout(Duration::from_secs(2), async {
        loop {
            let events = stream
                .recv()
                .await
                .expect("stream remains open")
                .expect("stream event succeeds");
            if let Some(event) = events
                .into_iter()
                .find(|event| event["type"] == expected_type)
            {
                return event;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("stream event {expected_type} timeout"))
}

#[tokio::test]
async fn config_and_settings_match_the_typescript_contract_without_faking_provider_authentication()
{
    let (_directory, control) = fixture().await;
    let settings = call(&control, "server.getSettings", json!({})).await;

    assert_eq!(settings["enableAssistantStreaming"], false);
    assert_eq!(settings["enableProviderUpdateChecks"], true);
    assert_eq!(settings["automaticGitFetchInterval"], 30_000);
    assert_eq!(
        settings["textGenerationModelSelection"]["model"],
        "gpt-5.4-mini"
    );
    assert_eq!(settings["providers"]["codex"]["binaryPath"], "codex");
    assert_eq!(settings["providers"]["cursor"]["enabled"], false);

    let config = call(&control, "server.getConfig", json!({})).await;
    assert_eq!(config["auth"], auth_descriptor());
    assert_eq!(
        config["environment"]["capabilities"]["activityProtocolVersion"],
        1
    );
    assert!(
        config["cwd"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert!(
        config["keybindingsConfigPath"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert!(config["keybindings"].is_array());
    assert!(config["issues"].is_array());
    assert!(config["availableEditors"].is_array());
    assert_eq!(config["settings"], settings);
    for provider in config["providers"].as_array().expect("provider snapshots") {
        if provider["status"] == "ready" {
            assert_eq!(provider["installed"], true);
            assert!(matches!(
                provider["auth"]["status"].as_str(),
                Some("authenticated" | "unauthenticated" | "unknown")
            ));
        }
        if provider["installed"] == false {
            assert!(matches!(
                provider["status"].as_str(),
                Some("error" | "disabled")
            ));
        }
    }
}

#[tokio::test]
async fn activity_protocol_cannot_be_advertised_before_registry_validation() {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let control =
        NativeServerControl::new(ServerConfig::new(directory.path()), auth_descriptor()).await;

    let before_registration = call(&control, "server.getConfig", json!({})).await;
    assert_eq!(
        before_registration["environment"]["capabilities"]["activityProtocolVersion"],
        Value::Null
    );

    let missing_unary = complete_registry_without(&["activity.getSnapshot"]);
    let missing_unary_error =
        finalize_rpc_registry(&missing_unary, &control).expect_err("activity unary is required");
    assert!(missing_unary_error.contains("missing activity.getSnapshot"));
    let after_missing_unary = call(&control, "server.getConfig", json!({})).await;
    assert_eq!(
        after_missing_unary["environment"]["capabilities"]["activityProtocolVersion"],
        Value::Null
    );

    let missing_stream = complete_registry_without(&["subscribeActivity"]);
    let missing_stream_error =
        finalize_rpc_registry(&missing_stream, &control).expect_err("activity stream is required");
    assert!(missing_stream_error.contains("missing subscribeActivity"));
    let after_missing_stream = call(&control, "server.getConfig", json!({})).await;
    assert_eq!(
        after_missing_stream["environment"]["capabilities"]["activityProtocolVersion"],
        Value::Null
    );

    let cancellation = CancellationToken::new();
    let mut lifecycle = control.subscribe("subscribeServerLifecycle", cancellation.clone());
    finalize_rpc_registry(&complete_registry(), &control).expect("complete production registry");
    let welcome = next_event(&mut lifecycle).await;
    let ready = next_event(&mut lifecycle).await;
    assert_eq!(
        welcome["payload"]["environment"]["capabilities"]["activityProtocolVersion"],
        ready["payload"]["environment"]["capabilities"]["activityProtocolVersion"]
    );

    let after_registration = call(&control, "server.getConfig", json!({})).await;
    assert_eq!(
        after_registration["environment"]["capabilities"]["activityProtocolVersion"],
        1
    );

    let post_registration_cancellation = CancellationToken::new();
    let mut post_registration_lifecycle = control.subscribe(
        "subscribeServerLifecycle",
        post_registration_cancellation.clone(),
    );
    let post_registration_welcome = next_event(&mut post_registration_lifecycle).await;
    let post_registration_ready = next_event(&mut post_registration_lifecycle).await;
    assert_eq!(
        post_registration_welcome["payload"]["environment"]["capabilities"]["activityProtocolVersion"],
        1
    );
    assert_eq!(
        post_registration_ready["payload"]["environment"]["capabilities"]["activityProtocolVersion"],
        1
    );
    cancellation.cancel();
    post_registration_cancellation.cancel();
}

#[tokio::test]
async fn settings_update_persists_atomically_redacts_secrets_and_emits_stream_event() {
    let (directory, control) = fixture().await;
    let cancellation = CancellationToken::new();
    let mut stream = control.subscribe("subscribeServerConfig", cancellation.clone());
    assert_eq!(next_event(&mut stream).await["type"], "snapshot");

    let updated = call(
        &control,
        "server.updateSettings",
        json!({ "patch": {
            "enableAssistantStreaming": true,
            "providerInstances": {
                "work": {
                    "driver": "codex",
                    "displayName": "Work",
                    "environment": [{
                        "name": "TOKEN",
                        "value": "top-secret",
                        "sensitive": true
                    }]
                }
            }
        }}),
    )
    .await;
    assert_eq!(updated["enableAssistantStreaming"], true);
    assert_eq!(
        updated["providerInstances"]["work"]["environment"][0]["value"],
        ""
    );
    assert_eq!(
        updated["providerInstances"]["work"]["environment"][0]["valueRedacted"],
        true
    );

    let event = next_event_of_type(&mut stream, "settingsUpdated").await;
    assert_eq!(event["payload"]["settings"], updated);

    let persisted: Value = serde_json::from_slice(
        &tokio::fs::read(directory.path().join("userdata/settings.json"))
            .await
            .expect("persisted settings"),
    )
    .expect("valid settings JSON");
    assert!(!persisted.to_string().contains("top-secret"));
    assert_eq!(
        tokio::fs::read_to_string(
            directory
                .path()
                .join("userdata/secrets/provider-env-d29yaw-VE9LRU4"),
        )
        .await
        .expect("separate secret"),
        "top-secret"
    );
    cancellation.cancel();
}

#[tokio::test]
async fn keybinding_upsert_replace_and_remove_are_resolved_persisted_and_streamed() {
    let (directory, control) = fixture().await;
    let cancellation = CancellationToken::new();
    let mut stream = control.subscribe("subscribeServerConfig", cancellation.clone());
    let _snapshot = next_event(&mut stream).await;

    let added = call(
        &control,
        "server.upsertKeybinding",
        json!({ "key": "ctrl+shift+k", "command": "terminal.toggle" }),
    )
    .await;
    assert_eq!(added["issues"], json!([]));
    let binding = added["keybindings"].as_array().unwrap().last().unwrap();
    assert_eq!(binding["command"], "terminal.toggle");
    assert_eq!(binding["shortcut"]["key"], "k");
    assert_eq!(binding["shortcut"]["ctrlKey"], true);
    assert_eq!(binding["shortcut"]["shiftKey"], true);
    assert_eq!(binding["shortcut"]["modKey"], true);
    let _add_event = next_event_of_type(&mut stream, "keybindingsUpdated").await;

    let replaced = call(
        &control,
        "server.upsertKeybinding",
        json!({
            "key": "alt+j",
            "command": "terminal.toggle",
            "replace": { "key": "ctrl+shift+k", "command": "terminal.toggle" }
        }),
    )
    .await;
    assert!(
        replaced["keybindings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| { row["command"] == "terminal.toggle" && row["shortcut"]["key"] == "j" })
    );
    let _replace_event = next_event_of_type(&mut stream, "keybindingsUpdated").await;

    let removed = call(
        &control,
        "server.removeKeybinding",
        json!({ "key": "alt+j", "command": "terminal.toggle" }),
    )
    .await;
    assert!(
        !removed["keybindings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| { row["command"] == "terminal.toggle" && row["shortcut"]["key"] == "j" })
    );
    let persisted: Value = serde_json::from_slice(
        &tokio::fs::read(directory.path().join("userdata/keybindings.json"))
            .await
            .expect("persisted keybindings"),
    )
    .expect("valid keybindings JSON");
    assert_eq!(persisted, json!([]));
    cancellation.cancel();
}

#[tokio::test]
async fn malformed_keybinding_config_is_reported_instead_of_silently_replaced() {
    let (_directory, control) = fixture_with_state_file("keybindings.json", b"{not-json").await;

    let config = call(&control, "server.getConfig", json!({})).await;
    assert_eq!(config["keybindings"], json!([]));
    assert_eq!(config["issues"][0]["kind"], "keybindings.malformed-config");
    assert!(
        config["issues"][0]["message"]
            .as_str()
            .is_some_and(|message| !message.is_empty())
    );
}

#[tokio::test]
async fn invalid_keybinding_entries_are_reported_by_original_index_while_valid_entries_survive() {
    let rules = json!([
        { "key": "ctrl+k", "command": "terminal.toggle" },
        { "key": "ctrl+shift", "command": "terminal.toggle" },
        "not-an-object"
    ]);
    let (_directory, control) = fixture_with_state_file(
        "keybindings.json",
        &serde_json::to_vec(&rules).expect("serialize keybindings fixture"),
    )
    .await;

    let config = call(&control, "server.getConfig", json!({})).await;
    assert_eq!(config["keybindings"].as_array().unwrap().len(), 1);
    assert_eq!(config["keybindings"][0]["command"], "terminal.toggle");
    assert_eq!(config["issues"].as_array().unwrap().len(), 2);
    assert_eq!(config["issues"][0]["kind"], "keybindings.invalid-entry");
    assert_eq!(config["issues"][0]["index"], 1);
    assert_eq!(config["issues"][1]["index"], 2);
}

#[tokio::test]
async fn provider_inventory_uses_provider_specific_status_and_configured_models() {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let executable = write_provider_fixture(&directory).await;
    let settings = json!({
        "providers": {
            "cursor": {
                "enabled": true,
                "binaryPath": executable,
                "customModels": []
            }
        },
        "providerInstances": {
            "cursor-work": {
                "driver": "cursor",
                "enabled": true,
                "config": { "customModels": ["cursor/custom-test"] }
            }
        }
    });
    let settings_path = directory.path().join("userdata/settings.json");
    tokio::fs::create_dir_all(settings_path.parent().unwrap())
        .await
        .expect("create settings directory");
    tokio::fs::write(
        settings_path,
        serde_json::to_vec(&settings).expect("serialize settings fixture"),
    )
    .await
    .expect("write settings fixture");
    let control =
        NativeServerControl::new(ServerConfig::new(directory.path()), auth_descriptor()).await;

    call(&control, "server.refreshProviders", json!({})).await;
    let config = call(&control, "server.getConfig", json!({})).await;
    let provider = &config["providers"][0];
    assert_eq!(provider["instanceId"], "cursor-work");
    assert_eq!(provider["status"], "ready");
    assert_eq!(provider["version"], "9.8.7");
    assert_eq!(provider["auth"]["status"], "authenticated");
    assert_eq!(provider["auth"]["email"], "dev@example.com");
    assert!(
        provider["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| { model["slug"] == "cursor/custom-test" && model["isCustom"] == true })
    );
}

#[tokio::test]
async fn claude_inventory_uses_authoritative_discovered_model_catalog() {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let executable = write_discovering_claude_fixture(&directory).await;
    let settings = json!({
        "providerInstances": {
            "claudeAgent": {
                "driver": "claudeAgent",
                "enabled": true,
                "environment": [{
                    "name": "BIBCODE_CLAUDE_FIXTURE_VERSION",
                    "value": "2.1.220",
                    "sensitive": false
                }],
                "config": {
                    "binaryPath": executable,
                    "customModels": ["claude-custom-test"]
                }
            }
        }
    });
    let settings_path = directory.path().join("userdata/settings.json");
    tokio::fs::create_dir_all(settings_path.parent().unwrap())
        .await
        .expect("create settings directory");
    tokio::fs::write(settings_path, serde_json::to_vec(&settings).unwrap())
        .await
        .expect("write settings fixture");
    let control =
        NativeServerControl::new(ServerConfig::new(directory.path()), auth_descriptor()).await;

    call(&control, "server.refreshProviders", json!({})).await;
    let config = call(&control, "server.getConfig", json!({})).await;
    let provider = config["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["instanceId"] == "claudeAgent")
        .expect("Claude provider snapshot");
    let models = provider["models"].as_array().unwrap();
    let slugs = models
        .iter()
        .filter_map(|model| model["slug"].as_str())
        .collect::<Vec<_>>();

    assert_eq!(provider["status"], "ready");
    assert_eq!(provider["auth"]["status"], "authenticated");
    assert_eq!(
        slugs,
        ["opus", "sonnet", "claude-custom-test"],
        "Claude initialization models must replace fixed built-ins"
    );
    assert!(!slugs.contains(&"claude-opus-4-8"));
    assert_eq!(models[0]["name"], "Opus 5");
    assert_eq!(
        models[0]["capabilities"]["optionDescriptors"][1]["id"],
        "fastMode"
    );
}

#[tokio::test]
async fn claude_inventory_keeps_discovered_models_when_skill_reload_is_invalid() {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let executable = write_discovering_claude_fixture(&directory).await;
    let settings = json!({
        "providerInstances": {
            "claudeAgent": {
                "driver": "claudeAgent",
                "enabled": true,
                "environment": [{
                    "name": "BIBCODE_CLAUDE_FIXTURE_VERSION",
                    "value": "2.1.220",
                    "sensitive": false
                }],
                "config": { "binaryPath": executable }
            }
        }
    });
    let settings_path = directory.path().join("userdata/settings.json");
    tokio::fs::create_dir_all(settings_path.parent().unwrap())
        .await
        .expect("create settings directory");
    tokio::fs::write(settings_path, serde_json::to_vec(&settings).unwrap())
        .await
        .expect("write settings fixture");
    let control =
        NativeServerControl::new(ServerConfig::new(directory.path()), auth_descriptor()).await;

    call(&control, "server.refreshProviders", json!({})).await;
    let first_config = call(&control, "server.getConfig", json!({})).await;
    let first_provider = first_config["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["instanceId"] == "claudeAgent")
        .expect("Claude provider snapshot");
    assert_eq!(first_provider["models"][0]["slug"], "opus");
    assert_eq!(first_provider["skills"][0]["name"], "review");

    call(&control, "server.refreshProviders", json!({})).await;
    let second_config = call(&control, "server.getConfig", json!({})).await;
    let second_provider = second_config["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["instanceId"] == "claudeAgent")
        .expect("refreshed Claude provider snapshot");
    let slugs = second_provider["models"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|model| model["slug"].as_str())
        .collect::<Vec<_>>();

    assert_eq!(slugs, ["sonnet"]);
    assert_eq!(second_provider["skills"], first_provider["skills"]);
}

#[tokio::test]
async fn claude_inventory_hides_models_unsupported_by_the_installed_cli_version() {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let executable = write_claude_fixture(&directory, "2.1.100").await;
    let settings = json!({
        "providerInstances": {
            "claudeAgent": {
                "driver": "claudeAgent",
                "enabled": true,
                "config": { "binaryPath": executable }
            }
        }
    });
    let settings_path = directory.path().join("userdata/settings.json");
    tokio::fs::create_dir_all(settings_path.parent().unwrap())
        .await
        .expect("create settings directory");
    tokio::fs::write(settings_path, serde_json::to_vec(&settings).unwrap())
        .await
        .expect("write settings fixture");
    let control =
        NativeServerControl::new(ServerConfig::new(directory.path()), auth_descriptor()).await;

    call(&control, "server.refreshProviders", json!({})).await;
    let config = call(&control, "server.getConfig", json!({})).await;
    let provider = config["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["instanceId"] == "claudeAgent")
        .expect("Claude provider snapshot");
    let slugs = provider["models"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|model| model["slug"].as_str())
        .collect::<Vec<_>>();

    assert!(!slugs.contains(&"claude-fable-5"));
    assert!(!slugs.contains(&"claude-opus-4-8"));
    assert!(!slugs.contains(&"claude-opus-4-7"));
    assert!(slugs.contains(&"claude-opus-4-6"));
    assert!(slugs.contains(&"claude-sonnet-5"));
}

#[tokio::test]
async fn trace_and_auxiliary_streams_use_exact_contract_shapes() {
    let (_directory, control) = fixture().await;
    let diagnostics = call(&control, "server.getTraceDiagnostics", json!({})).await;
    assert!(
        diagnostics["traceFilePath"]
            .as_str()
            .is_some_and(|path| !path.is_empty())
    );
    assert!(diagnostics["scannedFilePaths"].is_array());
    assert!(diagnostics["readAt"].is_string());
    for field in [
        "recordCount",
        "parseErrorCount",
        "failureCount",
        "interruptionCount",
        "slowSpanThresholdMs",
        "slowSpanCount",
    ] {
        assert!(
            diagnostics[field].is_number(),
            "missing numeric field {field}"
        );
    }
    for field in ["firstSpanAt", "lastSpanAt", "partialFailure"] {
        assert_eq!(
            diagnostics[field],
            json!({ "_id": "Option", "_tag": "None" })
        );
    }
    assert_eq!(diagnostics["error"]["_tag"], "Some");
    assert_eq!(
        diagnostics["error"]["value"]["kind"],
        "trace-file-not-found"
    );

    let lifecycle_cancel = CancellationToken::new();
    let mut lifecycle = control.subscribe("subscribeServerLifecycle", lifecycle_cancel.clone());
    assert_eq!(next_event(&mut lifecycle).await["type"], "welcome");
    assert_eq!(next_event(&mut lifecycle).await["type"], "ready");
    lifecycle_cancel.cancel();

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind local listener");
    let port = listener.local_addr().expect("listener address").port();
    let discovery_cancel = CancellationToken::new();
    let mut discovery =
        control.subscribe("subscribeDiscoveredLocalServers", discovery_cancel.clone());
    let discovered = next_event(&mut discovery).await;
    assert!(discovered["scannedAt"].is_string());
    assert!(
        discovered["servers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|server| {
                server["host"] == "127.0.0.1"
                    && server["port"] == port
                    && server["url"] == format!("http://127.0.0.1:{port}/")
            })
    );

    drop(listener);
    let rescanned = timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = next_event(&mut discovery).await;
            if snapshot["servers"]
                .as_array()
                .is_some_and(|servers| servers.iter().all(|server| server["port"] != port))
            {
                break snapshot;
            }
        }
    })
    .await
    .expect("periodic discovery removes closed listener");
    assert!(rescanned["scannedAt"].is_string());
    discovery_cancel.cancel();
    assert!(
        timeout(Duration::from_secs(2), discovery.recv())
            .await
            .expect("discovery cancellation timeout")
            .is_none()
    );
}

#[tokio::test]
async fn provider_update_reports_the_contract_error_when_native_update_is_unavailable() {
    let (_directory, control) = fixture().await;
    let error = control
        .call(
            "server.updateProvider",
            json!({ "provider": "grok" }),
            CancellationToken::new(),
        )
        .await
        .expect_err("manual-only provider update must fail");
    assert_eq!(error["_tag"], "ServerProviderUpdateError");
    assert_eq!(error["provider"], "grok");
    assert!(
        error["reason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty())
    );
}

#[tokio::test]
async fn refresh_providers_returns_version_advisories_without_registry_access() {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let missing_codex = directory.path().join("missing-codex");
    let settings = json!({
        "enableProviderUpdateChecks": false,
        "providers": {
            "claudeAgent": { "enabled": false },
            "cursor": { "enabled": false },
            "grok": { "enabled": false },
            "opencode": { "enabled": false }
        },
        "providerInstances": {
            "codex": {
                "driver": "codex",
                "enabled": true,
                "config": { "binaryPath": missing_codex }
            }
        }
    });
    let settings_path = directory.path().join("userdata/settings.json");
    tokio::fs::create_dir_all(settings_path.parent().expect("settings parent"))
        .await
        .expect("create settings directory");
    tokio::fs::write(
        settings_path,
        serde_json::to_vec(&settings).expect("settings JSON"),
    )
    .await
    .expect("write settings fixture");
    let control =
        NativeServerControl::new(ServerConfig::new(directory.path()), auth_descriptor()).await;

    let refreshed = call(
        &control,
        "server.refreshProviders",
        json!({ "instanceId": "codex" }),
    )
    .await;
    let codex = refreshed["providers"]
        .as_array()
        .expect("providers")
        .iter()
        .find(|provider| provider["driver"] == "codex")
        .expect("codex provider");
    assert!(codex["versionAdvisory"].is_object());
    assert!(codex["versionAdvisory"]["canUpdate"].is_boolean());
    assert!(codex["versionAdvisory"]["status"].is_string());
}

#[tokio::test]
async fn provider_update_executes_a_supported_cursor_command_but_cannot_verify_version() {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let executable = write_provider_fixture(&directory).await;
    let settings = json!({
        "enableProviderUpdateChecks": false,
        "providerInstances": {
            "cursor-work": {
                "driver": "cursor",
                "enabled": true,
                "config": { "binaryPath": executable }
            }
        }
    });
    let settings_path = directory.path().join("userdata/settings.json");
    tokio::fs::create_dir_all(settings_path.parent().expect("settings parent"))
        .await
        .expect("create settings directory");
    tokio::fs::write(
        settings_path,
        serde_json::to_vec(&settings).expect("settings JSON"),
    )
    .await
    .expect("write settings fixture");
    let control =
        NativeServerControl::new(ServerConfig::new(directory.path()), auth_descriptor()).await;

    let result = call(
        &control,
        "server.updateProvider",
        json!({ "provider": "cursor", "instanceId": "cursor-work" }),
    )
    .await;
    let provider = result["providers"]
        .as_array()
        .expect("providers")
        .iter()
        .find(|provider| provider["instanceId"] == "cursor-work")
        .expect("updated cursor");
    assert_eq!(provider["updateState"]["status"], "unchanged");
    assert_eq!(
        provider["updateState"]["message"],
        "Update command completed, but BiBCode could not verify the provider version."
    );
}

#[tokio::test]
async fn provider_update_rejects_an_instance_driver_mismatch() {
    let (_directory, control) = fixture().await;
    let error = control
        .call(
            "server.updateProvider",
            json!({ "provider": "cursor", "instanceId": "codex" }),
            CancellationToken::new(),
        )
        .await
        .expect_err("mismatched instance and driver must fail");
    assert_eq!(error["_tag"], "ServerProviderUpdateError");
    assert_eq!(error["provider"], "cursor");
}

#[tokio::test]
async fn provider_update_rejects_malformed_instance_ids_without_publishing_update_state() {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let executable = write_provider_fixture(&directory).await;
    let settings = json!({
        "enableProviderUpdateChecks": false,
        "providerInstances": {
            "cursor-work": {
                "driver": "cursor",
                "enabled": true,
                "config": { "binaryPath": executable }
            }
        }
    });
    let settings_path = directory.path().join("userdata/settings.json");
    tokio::fs::create_dir_all(settings_path.parent().expect("settings parent"))
        .await
        .expect("create settings directory");
    tokio::fs::write(
        settings_path,
        serde_json::to_vec(&settings).expect("settings JSON"),
    )
    .await
    .expect("write settings fixture");
    let control =
        NativeServerControl::new(ServerConfig::new(directory.path()), auth_descriptor()).await;

    for instance_id in [Value::Null, json!(7), json!({}), json!("not a slug")] {
        let error = control
            .call(
                "server.updateProvider",
                json!({ "provider": "cursor", "instanceId": instance_id }),
                CancellationToken::new(),
            )
            .await
            .expect_err("malformed instance ID must be rejected");
        assert_eq!(error["_tag"], "ServerProviderUpdateError");
        assert_eq!(error["provider"], "cursor");
        assert!(
            error["reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("instanceId"))
        );
    }

    let config = call(&control, "server.getConfig", json!({})).await;
    assert_eq!(config["providers"][0]["updateState"], Value::Null);
}
