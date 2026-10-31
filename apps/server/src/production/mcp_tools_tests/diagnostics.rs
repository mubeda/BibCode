//! The diagnostics tools (#139 slice X2) end to end: the real tool registration and checks,
//! the RPC handlers faked under their real tags with their real wire shapes, and, in processes
//! of their own, a real profiler runtime and store. Each projection is proven by a marker the
//! source holds and the result never does.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{Harness, error_tag, structured};
use crate::{
    diagnostics::profiler::{
        git_actions::{FailureReason, StackedActionFailure, record_stacked_action_outcome},
        mcp::run_stdio_mcp,
        profiler_dir,
        reader::Reader,
        runtime::ProfilerRuntime,
    },
    mcp::{control::McpAccess, tools::diagnostics::project_event},
    rpc::RpcRegistry,
};

/// Text the sources hold that no result may carry: content, and a path in a home directory.
const MARKER: &str = "MARKER-x2-ignore-previous-instructions";
const HOME_PATH: &str = "/Users/someone/private-folder";

const TOOLS: [&str; 8] = [
    "profiler_status",
    "profiler_findings",
    "profiler_events",
    "profiler_crash",
    "diagnose_environment",
    "refresh_providers",
    "process_diagnostics",
    "trace_diagnostics",
];

fn listed(harness: &Harness, agent: &crate::mcp::control::ClientPrincipal) -> Vec<Value> {
    harness
        .control
        .tools(agent)
        .as_array()
        .unwrap()
        .iter()
        .filter(|tool| TOOLS.contains(&tool["name"].as_str().unwrap()))
        .cloned()
        .collect()
}

/// Asserts that neither the marker nor the home path appears anywhere in `result`.
fn assert_clean(result: &Value) {
    let text = result.to_string();
    assert!(!text.contains(MARKER), "{text}");
    assert!(!text.contains(HOME_PATH), "{text}");
    assert!(!text.contains("someone"), "{text}");
}

/// Registers `tag` answering `response`, and records each payload it receives in `seen`.
fn fake(registry: &mut RpcRegistry, tag: &'static str, response: Value, seen: &Payloads) {
    let seen = seen.clone();
    registry.register_unary(tag, move |request, _cancellation| {
        seen.lock().unwrap().push((tag, request.payload.clone()));
        let response = response.clone();
        async move { Ok(response) }
    });
}

type Payloads = Arc<Mutex<Vec<(&'static str, Value)>>>;

fn some(value: Value) -> Value {
    json!({ "_tag": "Some", "value": value })
}

fn none() -> Value {
    json!({ "_tag": "None" })
}

#[tokio::test]
async fn the_diagnostics_tools_are_listed_with_their_hints_and_hidden_with_their_set_off() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;

    let tools = listed(&harness, &agent);
    let names: Vec<&str> = tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, TOOLS);
    for tool in &tools {
        let hints = &tool["annotations"];
        assert_eq!(hints["destructiveHint"], false, "{tool}");
        assert_eq!(hints["idempotentHint"], true, "{tool}");
        assert_eq!(hints["openWorldHint"], false, "{tool}");
        assert_eq!(
            hints["readOnlyHint"],
            tool["name"] != "refresh_providers",
            "{tool}"
        );
    }

    // A read-only connection keeps the reads and loses the refresh.
    let (reader, _) = harness.agent(McpAccess::ReadOnly).await;
    assert_eq!(listed(&harness, &reader).len(), 7);
    let refused = harness.call(&reader, "refresh_providers", json!({})).await;
    assert_eq!(error_tag(&refused), "McpAccessCeilingError");

    harness
        .settings
        .send_modify(|settings| settings.capabilities.diagnostics = false);
    assert!(listed(&harness, &agent).is_empty());
    for tool in TOOLS {
        let refused = harness.call(&agent, tool, json!({})).await;
        assert_eq!(error_tag(&refused), "McpCapabilityDisabledError", "{tool}");
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn process_diagnostics_never_return_a_command_line_label_or_message() {
    let seen = Payloads::default();
    let totals = json!({ "cpuPercent": 1.5, "rssBytes": 4096, "processCount": 2 });
    let split = json!({ "combined": 1.0, "core": 1.0, "external": 0.0 });
    let harness = Harness::with_methods(|registry| {
        fake(
            registry,
            "server.getProcessDiagnostics",
            json!({
                "serverPid": 100,
                "readAt": "2026-10-30T10:00:00.000Z",
                "totals": { "combined": totals, "core": totals, "external": totals },
                "uiCoverage": { "status": "partial", "message": some(json!(MARKER)) },
                "processes": [{
                    "pid": 101, "ppid": 100, "pgid": none(), "status": "S", "cpuPercent": 0.5,
                    "rssBytes": 2048, "elapsed": "00:10",
                    "command": format!("{HOME_PATH}/bin/tool --prompt {MARKER}"),
                    "depth": 1, "childPids": [], "processKey": "101:5", "scope": "core",
                    "kind": "provider", "label": MARKER, "confidence": "exact",
                }],
                "error": some(json!({ "message": MARKER })),
            }),
            &seen,
        );
        fake(
            registry,
            "server.getProcessResourceHistory",
            json!({
                "readAt": "2026-10-30T10:00:00.000Z", "windowMs": 900_000, "bucketMs": 60_000,
                "sampleIntervalMs": 2000, "retainedSampleCount": 3, "cpuSecondsApprox": split,
                "uiCoverage": { "status": "partial", "message": some(json!(MARKER)) },
                "buckets": [{
                    "startedAt": "2026-10-30T09:59:00.000Z", "endedAt": "2026-10-30T10:00:00.000Z",
                    "cpuPercent": { "average": split, "peak": split },
                    "rssBytes": { "average": split, "peak": split },
                    "maxProcessCount": split,
                }],
                "processes": [{
                    "processKey": "101:5", "pid": 101, "ppid": 100,
                    "command": format!("{HOME_PATH}/bin/tool {MARKER}"), "depth": 1,
                    "scope": "core", "kind": "provider", "label": MARKER, "confidence": "exact",
                    "firstSeenAt": "2026-10-30T09:50:00.000Z", "lastSeenAt": "2026-10-30T10:00:00.000Z",
                    "currentCpuPercent": 0.5, "avgCpuPercent": 0.4, "maxCpuPercent": 2.0,
                    "cpuSecondsApprox": 3.0, "currentRssBytes": 2048, "maxRssBytes": 4096,
                    "sampleCount": 3,
                }],
                "error": some(json!({ "failureTag": "ProcessDiagnosticsQueryFailedError", "message": MARKER })),
            }),
            &seen,
        );
    })
    .await;
    let (agent, _) = harness.agent(McpAccess::ReadOnly).await;

    let result = harness.call(&agent, "process_diagnostics", json!({})).await;

    assert_clean(&result);
    let content = structured(&result);
    assert_eq!(
        content["processes"][0],
        json!({
            "pid": 101, "ppid": 100, "depth": 1, "status": "S", "elapsed": "00:10",
            "cpuPercent": 0.5, "rssBytes": 2048, "scope": "core", "kind": "provider",
            "confidence": "exact",
        })
    );
    assert_eq!(content["totals"]["combined"]["processCount"], 2);
    assert_eq!(content["readFailed"], true);
    assert_eq!(content["uiCoverage"], "partial");
    let history = &content["history"];
    assert_eq!(history["processes"][0]["maxRssBytes"], 4096);
    assert!(history["processes"][0].get("processKey").is_none());
    assert_eq!(history["buckets"][0]["maxProcessCount"]["combined"], 1.0);
    assert_eq!(history["readFailed"], true);

    // The window defaults to 15 minutes in minute buckets, and is bounded.
    let clamped = harness
        .call(
            &agent,
            "process_diagnostics",
            json!({ "historyWindowMs": 10, "bucketMs": 1 }),
        )
        .await;
    structured(&clamped);
    let windows: Vec<Value> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(tag, _)| *tag == "server.getProcessResourceHistory")
        .map(|(_, payload)| payload.clone())
        .collect();
    assert_eq!(
        windows,
        [
            json!({ "windowMs": 900_000, "bucketMs": 60_000 }),
            json!({ "windowMs": 60_000, "bucketMs": 1_000 }),
        ]
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn trace_diagnostics_never_return_a_cause_a_log_message_or_a_path() {
    let span = |name: &str| {
        json!({
            "name": name, "durationMs": 12.5, "durationMeasured": true,
            "endedAt": "2026-10-30T10:00:00Z", "traceId": "t1", "spanId": "s1",
        })
    };
    let mut failed = span("git.runStackedAction");
    failed["cause"] = format!("{HOME_PATH}: {MARKER}").into();
    let harness = Harness::with_methods(|registry| {
        fake(
            registry,
            "server.getTraceDiagnostics",
            json!({
                "traceFilePath": format!("{HOME_PATH}/server.trace.ndjson"),
                "scannedFilePaths": [format!("{HOME_PATH}/server.trace.ndjson")],
                "readAt": "2026-10-30T10:00:00Z", "recordCount": 40, "parseErrorCount": 1,
                "firstSpanAt": some(json!("2026-10-30T09:00:00Z")), "lastSpanAt": none(),
                "failureCount": 3, "interruptionCount": 1, "slowSpanThresholdMs": 1000,
                "slowSpanCount": 2, "logLevelCounts": { "warn": 4, "error": 1 },
                "topSpansByCount": [{
                    "name": "git.status", "count": 30, "failureCount": 0, "measuredCount": 30,
                    "totalDurationMs": 300.0, "averageDurationMs": 10.0, "maxDurationMs": 40.0,
                }],
                "slowestSpans": [span("git.status"), span("git.fetch")],
                "commonFailures": [{
                    "name": "git.runStackedAction", "cause": MARKER, "count": 3,
                    "lastSeenAt": "2026-10-30T10:00:00Z", "traceId": "t1", "spanId": "s1",
                }],
                "latestFailures": [failed],
                "latestWarningAndErrorLogs": [{
                    "spanName": "provider", "level": "warn", "message": MARKER,
                    "seenAt": "2026-10-30T10:00:00Z", "traceId": "t1", "spanId": "s1",
                }],
                "partialFailure": some(json!(true)),
                "error": some(json!({ "kind": "trace-file-read-failed", "message": MARKER })),
            }),
            &Payloads::default(),
        );
    })
    .await;
    let (agent, _) = harness.agent(McpAccess::ReadOnly).await;

    let result = harness
        .call(&agent, "trace_diagnostics", json!({ "limit": 1 }))
        .await;

    assert_clean(&result);
    let content = structured(&result);
    assert_eq!(
        content["commonFailures"],
        json!([{ "name": "git.runStackedAction", "count": 3, "lastSeenAt": "2026-10-30T10:00:00Z" }])
    );
    assert_eq!(
        content["slowestSpans"].as_array().unwrap().len(),
        1,
        "limit"
    );
    assert_eq!(content["latestFailures"][0]["name"], "git.runStackedAction");
    assert_eq!(content["logLevelCounts"], json!({ "warn": 4, "error": 1 }));
    assert_eq!(content["firstSpanAt"], "2026-10-30T09:00:00Z");
    assert_eq!(content["lastSpanAt"], Value::Null);
    assert_eq!(content["error"], "trace-file-read-failed");
    assert_eq!(content["partialFailure"], true);
    assert!(content.get("latestWarningAndErrorLogs").is_none());
    let refused = harness
        .call(&agent, "trace_diagnostics", json!({ "limit": 0 }))
        .await;
    assert_eq!(error_tag(&refused), "McpInvalidArgumentError");
    harness.shutdown().await;
}

fn provider_wire() -> Value {
    json!({
        "instanceId": "codex", "driver": "codex", "displayName": MARKER, "enabled": true,
        "installed": true, "version": "1.2.3", "status": "warning",
        "auth": { "status": "authenticated", "email": MARKER, "label": MARKER },
        "checkedAt": "2026-10-30T10:00:00Z", "message": MARKER,
        "models": [{ "slug": MARKER }], "slashCommands": [], "skills": [], "agents": [],
    })
}

fn projected_provider() -> Value {
    json!({
        "instanceId": "codex", "driver": "codex", "enabled": true, "installed": true,
        "version": "1.2.3", "status": "warning", "auth": "authenticated",
    })
}

#[tokio::test]
async fn diagnose_environment_returns_no_path_setting_launch_or_message() {
    let seen = Payloads::default();
    let harness = Harness::with_methods(|registry| {
        fake(
            registry,
            "server.getConfig",
            json!({
                "environment": {
                    "environmentId": "env-1", "label": MARKER,
                    "platform": { "os": "darwin", "arch": "arm64" }, "serverVersion": "0.13.1",
                    "storageInstanceId": "s1", "bootId": "b1", "remoteUpdateSupport": "none",
                    "remoteProtocolVersion": 7, "minCompatibleRemoteProtocol": 5,
                    "capabilities": { "profiler": true, "activityProtocolVersion": 2, MARKER: true, "note": MARKER },
                },
                "auth": { "policy": MARKER },
                "cwd": HOME_PATH,
                "keybindingsConfigPath": format!("{HOME_PATH}/keybindings.json"),
                "keybindings": [],
                "issues": [
                    { "kind": "keybindings.invalid-entry", "message": MARKER, "index": 0 },
                    { "kind": "keybindings.invalid-entry", "message": MARKER, "index": 3 },
                    { "kind": "keybindings.malformed-config", "message": MARKER },
                ],
                "providers": [provider_wire()],
                "availableEditors": ["vscode"],
                "observability": { "logsDirectoryPath": HOME_PATH },
                "settings": { "note": MARKER },
                "mcpLaunch": { "argv": [format!("{HOME_PATH}/bibcode"), "mcp"] },
            }),
            &seen,
        );
        fake(
            registry,
            "server.discoverSourceControl",
            json!({
                "versionControlSystems": [{
                    "kind": "git", "implemented": true, "label": "Git",
                    "executable": format!("{HOME_PATH}/bin/git"), "status": "available",
                    "version": some(json!("2.50.0")), "installHint": MARKER,
                    "detail": some(json!(MARKER)),
                }],
                "sourceControlProviders": [{
                    "kind": "github", "label": "GitHub", "executable": format!("{HOME_PATH}/bin/gh"),
                    "status": "available", "version": none(), "installHint": MARKER,
                    "detail": none(),
                    "auth": {
                        "status": "authenticated",
                        "hosts": [{ "host": MARKER, "account": MARKER, "authenticated": true }],
                        "account": some(json!(MARKER)), "host": some(json!(MARKER)),
                        "detail": some(json!(MARKER)),
                    },
                }],
            }),
            &seen,
        );
        fake(
            registry,
            "server.getProfilerStatus",
            json!({
                "enabled": true, "recordingSince": "2026-10-30T09:00:00Z", "diskBytes": 10,
                "eventCount": 5, "droppedEvents": 0, "lastCrashAt": null,
                "capabilities": { "nativeDumps": "available", "osCrashRecords": "unavailable", "storage": "ok" },
                "findings": [{ "title": MARKER }],
            }),
            &seen,
        );
    })
    .await;
    let (agent, _) = harness.agent(McpAccess::ReadOnly).await;

    let result = harness
        .call(&agent, "diagnose_environment", json!({}))
        .await;

    assert_clean(&result);
    let content = structured(&result);
    assert_eq!(content["environment"]["serverVersion"], "0.13.1");
    assert_eq!(content["environment"]["platform"]["os"], "darwin");
    assert_eq!(
        content["environment"]["capabilities"],
        json!({ "profiler": true, "activityProtocolVersion": 2 })
    );
    assert!(content["environment"].get("label").is_none());
    assert_eq!(content["providers"], json!([projected_provider()]));
    assert_eq!(
        content["configIssues"],
        json!([
            { "kind": "keybindings.invalid-entry", "count": 2 },
            { "kind": "keybindings.malformed-config", "count": 1 },
        ])
    );
    assert_eq!(
        content["sourceControl"],
        json!({
            "versionControlSystems": [{ "kind": "git", "implemented": true, "status": "available", "version": "2.50.0" }],
            "sourceControlProviders": [{ "kind": "github", "status": "available", "version": null, "auth": "authenticated" }],
        })
    );
    assert_eq!(content["profiler"]["eventCount"], 5);
    assert!(content["profiler"].get("findings").is_none());
    let discovery: Vec<Value> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(tag, _)| *tag == "server.discoverSourceControl")
        .map(|(_, payload)| payload.clone())
        .collect();
    assert_eq!(discovery, [json!({})], "a read never records hosts");
    harness.shutdown().await;
}

#[tokio::test]
async fn refresh_providers_returns_each_providers_state_only() {
    let seen = Payloads::default();
    let harness = Harness::with_methods(|registry| {
        fake(
            registry,
            "server.refreshProviders",
            json!({ "providers": [provider_wire()] }),
            &seen,
        );
    })
    .await;
    let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;

    let result = harness.call(&agent, "refresh_providers", json!({})).await;

    assert_clean(&result);
    assert_eq!(
        structured(&result)["providers"],
        json!([projected_provider()])
    );
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        [("server.refreshProviders", json!({}))]
    );
    harness.shutdown().await;
}

fn ago(minutes: i64) -> String {
    (OffsetDateTime::now_utc() - time::Duration::minutes(minutes))
        .format(&Rfc3339)
        .unwrap()
}

/// Runs `tool` with `arguments` on the stdio profiler server over `dir` and returns its result.
fn stdio(dir: &std::path::Path, tool: &str, arguments: Value) -> Value {
    let request = json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": tool, "arguments": arguments },
    });
    let mut output = Vec::new();
    run_stdio_mcp(
        Reader::new(dir),
        format!("{request}\n").as_bytes(),
        &mut output,
    )
    .unwrap();
    serde_json::from_slice::<Value>(&output).unwrap()["result"].clone()
}

/// Over `/mcp` the profiler tools read the server's own store: status and findings as the stdio
/// server returns them, events and crash records with only their documented fields. In a
/// process of its own: the profiler handle is process-global.
#[tokio::test]
async fn the_profiler_tools_read_the_servers_own_store_projected() {
    let Some(child) = crate::test_support::in_own_process(
        "production::mcp_tools_tests::diagnostics::the_profiler_tools_read_the_servers_own_store_projected",
    ) else {
        return;
    };
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::ReadOnly).await;
    let unavailable = harness.call(&agent, "profiler_status", json!({})).await;
    assert_eq!(error_tag(&unavailable), "McpProfilerUnavailableError");

    let state = tempfile::tempdir().expect("state");
    let dir = profiler_dir(state.path());
    std::fs::create_dir_all(dir.join("crashes")).unwrap();
    let findings: String = (0..3)
        .map(|index| {
            let finding = json!({
                "id": format!("rpc.slow-{index}"), "fingerprint": format!("{index}"),
                "kind": "rpc.slow", "severity": "warn", "firstSeen": ago(30),
                "lastSeen": ago(10 - index), "count": 1, "source": "server",
                "title": "Slow request", "summary": "s", "state": "open",
                "evidence": { "ms": 1200 },
            });
            format!("{finding}\n")
        })
        .collect();
    std::fs::write(dir.join("findings.ndjson"), findings).unwrap();
    let envelope = |seq: u64, kind: &str| {
        json!({
            "v": 1, "bibcode": "0.13.1", "ts": ago(5), "sid": "aaaa1111", "seq": seq,
            "eventId": format!("aaaa1111-{seq}"), "kind": kind, "source": "server",
        })
    };
    let mut action = envelope(0, "git.stacked-action");
    action["action"] = "commit".into();
    action["ok"] = true.into();
    action["note"] = MARKER.into();
    let mut custom = envelope(1, "x.custom");
    custom["text"] = MARKER.into();
    let mut batch = envelope(2, "client.batch");
    batch["source"] = format!("client:{MARKER} x").into();
    batch["clientId"] = format!("{MARKER} x").into();
    batch["capabilities"] = json!(["heartbeat", MARKER]);
    batch["stalls"] = json!({ "count": 1, "totalMs": 60, "maxMs": 60, "note": MARKER });
    batch["windowMs"] = 10_000.into();
    let mut sample = envelope(3, "process.sample");
    sample["procs"] =
        json!([{ "pid": 7, "kind": "server", "label": "bibcode", "cpu": 1.0, "note": MARKER }]);
    let events: String = [&action, &custom, &batch, &sample]
        .iter()
        .map(|event| format!("{event}\n"))
        .collect();
    std::fs::write(dir.join("events-000000.ndjson"), events).unwrap();
    // No parentPid, so the runtime does not raise a crash finding for it while the test reads.
    let crash_id = "3f2a8c1e-0b7d-4e59-9c1a-2d4b6e8f0a12";
    std::fs::write(
        dir.join(format!("crashes/{crash_id}.json")),
        json!({
            "id": crash_id, "createdAt": ago(20), "version": "0.13.1", "os": "macos",
            "arch": "aarch64", "processKind": "server", "note": MARKER,
            "lastEvents": [action],
        })
        .to_string(),
    )
    .unwrap();
    let (_enabled, enabled) = tokio::sync::watch::channel(false);
    let runtime = ProfilerRuntime::start(state.path(), enabled, vec![]);

    let over_mcp = |tool: &'static str, arguments: Value| {
        let harness = &harness;
        let agent = &agent;
        async move {
            let result = harness.call(agent, tool, arguments).await;
            assert_ne!(result["isError"], true, "{tool}: {result}");
            result
        }
    };
    let status = over_mcp("profiler_status", json!({})).await;
    assert_eq!(status, stdio(&dir, "profiler_status", json!({})));
    let findings = over_mcp("profiler_findings", json!({ "since": "1h" })).await;
    assert_eq!(
        findings,
        stdio(&dir, "profiler_findings", json!({ "since": "1h" }))
    );
    assert_eq!(
        structured(&findings)["findings"][0]["id"],
        "rpc.slow-0",
        "oldest first from since"
    );

    let events = over_mcp("profiler_events", json!({})).await;
    let raw = stdio(&dir, "profiler_events", json!({}));
    assert!(raw.to_string().contains(MARKER), "the fixture holds it");
    assert_clean(&events);
    let projected: Vec<Value> = raw["structuredContent"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(project_event)
        .collect();
    assert_eq!(structured(&events)["events"], json!(projected));
    let events = structured(&events)["events"].as_array().unwrap();
    assert_eq!(events.len(), 4);
    assert_eq!(events[0]["action"], "commit");
    assert_eq!(events[0]["eventId"], "aaaa1111-0");
    assert_eq!(
        events[1].as_object().unwrap().len(),
        8,
        "an undocumented kind keeps its envelope only: {}",
        events[1]
    );
    assert_eq!(events[2]["source"], "client");
    assert_eq!(events[2]["clientId"], Value::Null);
    assert_eq!(events[2]["capabilities"], json!(["heartbeat"]));
    assert_eq!(
        events[2]["stalls"],
        json!({ "count": 1, "totalMs": 60, "maxMs": 60 })
    );
    assert_eq!(events[3]["procs"][0]["label"], "bibcode");

    let crash = over_mcp("profiler_crash", json!({ "id": crash_id })).await;
    assert_clean(&crash);
    let crash = structured(&crash);
    assert_eq!(crash["crash"]["id"], crash_id);
    assert_eq!(crash["crash"]["processKind"], "server");
    assert_eq!(crash["crash"]["lastEvents"][0]["action"], "commit");
    assert_eq!(crash["dump"], "missing");
    let missing = harness
        .call(&agent, "profiler_crash", json!({ "id": "nope" }))
        .await;
    assert_eq!(error_tag(&missing), "McpCrashNotFoundError");
    let refused = harness
        .call(&agent, "profiler_findings", json!({ "cursor": "nope" }))
        .await;
    assert_eq!(error_tag(&refused), "McpInvalidArgumentError");

    runtime.shutdown().await;
    harness.shutdown().await;
    child.complete();
}

/// A rejected `git.runStackedAction` records only a known action name, so the client's text
/// never reaches an agent through an event or a finding (#139, Revision 4). In a process of
/// its own: the profiler handle is process-global.
#[tokio::test]
async fn a_rejected_actions_text_never_reaches_an_agent() {
    let Some(child) = crate::test_support::in_own_process(
        "production::mcp_tools_tests::diagnostics::a_rejected_actions_text_never_reaches_an_agent",
    ) else {
        return;
    };
    let state = tempfile::tempdir().expect("state");
    let (_enabled, enabled) = tokio::sync::watch::channel(true);
    let runtime = ProfilerRuntime::start(state.path(), enabled, vec![]);
    tokio::time::timeout(Duration::from_secs(30), async {
        while runtime.status()["enabled"] != true {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the profiler turns on");
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::ReadOnly).await;

    // What `git.runStackedAction` passes for a refused request: the client's own action.
    record_stacked_action_outcome(
        MARKER,
        false,
        "/tmp/repository",
        Err(StackedActionFailure {
            phase: None,
            reason: FailureReason::Rejected,
            operation: None,
            message: "Unsupported Git action.",
        }),
        Duration::from_millis(3),
    );
    // Three failing steps raise the finding, whose summary and evidence name the action.
    for _ in 0..3 {
        record_stacked_action_outcome(
            MARKER,
            false,
            "/tmp/repository",
            Err(StackedActionFailure {
                phase: Some("commit"),
                reason: FailureReason::Internal,
                operation: None,
                message: "Git action could not complete.",
            }),
            Duration::from_millis(3),
        );
    }

    let (events, findings) = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let events = harness
                .call(
                    &agent,
                    "profiler_events",
                    json!({ "kind": "git.stacked-action" }),
                )
                .await;
            let findings = harness
                .call(
                    &agent,
                    "profiler_findings",
                    json!({ "kind": "git.stacked-action-failed" }),
                )
                .await;
            if structured(&events)["events"].as_array().unwrap().len() == 4
                && structured(&findings)["findings"].as_array().unwrap().len() == 1
            {
                return (events, findings);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the events and the finding are written");

    assert_clean(&events);
    assert_clean(&findings);
    for event in structured(&events)["events"].as_array().unwrap() {
        assert_eq!(event["action"], "unknown", "{event}");
    }
    assert_eq!(structured(&events)["events"][0]["reason"], "rejected");
    let finding = &structured(&findings)["findings"][0];
    assert_eq!(finding["evidence"]["action"], "unknown");
    runtime.shutdown().await;
    harness.shutdown().await;
    child.complete();
}
