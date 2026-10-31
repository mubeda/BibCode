//! The diagnostics tools (#139 slice X2): the profiler's records, an environment report,
//! process and trace summaries, and a provider refresh, in the Diagnostics set.
//!
//! The profiler tools run the stdio `bibcode profiler mcp` handlers in process, over the
//! server's own profiler directory, off the async workers. The others reach the RPCs the
//! Diagnostics settings use. Every result is an allowlisted projection, built from named fields
//! with everything else dropped: content is kept out by projection, not by redaction, so no
//! prompt, message, tool output, command line, log text or path reaches an agent. Profiler
//! events keep their envelope and the payload fields `events.md` documents for their kind; an
//! undocumented kind keeps its envelope only.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::{
    auth::{SCOPE_ORCHESTRATION_OPERATE, SCOPE_ORCHESTRATION_READ},
    diagnostics::profiler::{
        mcp::{self as profiler, Producer, Refusal},
        redact::redact_message,
    },
    mcp::{
        control::{
            Family, McpCapability, ProgressSink, ToolCall, ToolFuture, ToolResult, ToolSpec,
            invalid_argument, object_schema,
        },
        protocol::{Cut, tool_result, typed_tool_failure},
    },
};

const READ: &str = SCOPE_ORCHESTRATION_READ;
const OPERATE: &str = SCOPE_ORCHESTRATION_OPERATE;
const DIAGNOSTICS: Option<McpCapability> = Some(McpCapability::Diagnostics);

/// `process_diagnostics`' history window: 15 minutes in 1-minute buckets unless asked, at
/// most an hour (what the monitor keeps) and at most 120 buckets.
const DEFAULT_WINDOW_MS: i64 = 15 * 60_000;
const WINDOW_MS: (i64, i64) = (60_000, 60 * 60_000);
const MOST_BUCKETS: i64 = 120;
/// Entries per `trace_diagnostics` list: `(default, most)`.
const TRACE_LIMIT: (i64, i64) = (10, 20);

/// The diagnostics tools, in the order `tools/list` shows them.
pub(crate) const TOOLS: &[ToolSpec] = &[
    ToolSpec::client("profiler_status", READ, &[])
        .reads()
        .in_set(DIAGNOSTICS),
    ToolSpec::client("profiler_findings", READ, &[])
        .reads()
        .in_set(DIAGNOSTICS),
    ToolSpec::client("profiler_events", READ, &[])
        .reads()
        .in_set(DIAGNOSTICS),
    ToolSpec::client("profiler_crash", READ, &[])
        .reads()
        .in_set(DIAGNOSTICS),
    ToolSpec::client(
        "diagnose_environment",
        READ,
        &[
            "server.getConfig",
            "server.discoverSourceControl",
            "server.getProfilerStatus",
        ],
    )
    .reads()
    .in_set(DIAGNOSTICS),
    ToolSpec::client("refresh_providers", OPERATE, &["server.refreshProviders"])
        .repeats_safely()
        .in_set(DIAGNOSTICS),
    ToolSpec::client(
        "process_diagnostics",
        READ,
        &[
            "server.getProcessDiagnostics",
            "server.getProcessResourceHistory",
        ],
    )
    .reads()
    .in_set(DIAGNOSTICS),
    ToolSpec::client("trace_diagnostics", READ, &["server.getTraceDiagnostics"])
        .reads()
        .in_set(DIAGNOSTICS),
];

pub(crate) const FAMILY: Family = Family {
    tools: TOOLS,
    text,
    call,
};

fn call<'a>(
    call: &'a ToolCall<'a>,
    name: &'a str,
    _progress: Option<(ProgressSink, Value)>,
) -> ToolFuture<'a> {
    Box::pin(async move {
        match name {
            "profiler_status" => {
                call.profiler(profiler::status_content, project_findings)
                    .await
            }
            "profiler_findings" => {
                call.profiler(profiler::findings_content, project_findings)
                    .await
            }
            "profiler_events" => {
                call.profiler(profiler::events_content, project_events)
                    .await
            }
            "profiler_crash" => call.profiler(profiler::crash_content, project_crash).await,
            "diagnose_environment" => call.diagnose_environment().await,
            "refresh_providers" => call.refresh_providers().await,
            "process_diagnostics" => call.process_diagnostics().await,
            "trace_diagnostics" => call.trace_diagnostics().await,
            _ => Err(typed_tool_failure("McpUnknownToolError", "Unknown tool.")),
        }
    })
}

fn text(name: &str) -> Option<(&'static str, Value)> {
    let none = || object_schema(json!({}), &[]);
    Some(match name {
        "profiler_status" => (profiler::STATUS_DESCRIPTION, none()),
        "profiler_findings" => (profiler::FINDINGS_DESCRIPTION, profiler::findings_schema()),
        "profiler_events" => (
            "Recorded profiler events, newest last: each event's envelope (ts, sid, seq, eventId, kind, source) and the fields its kind documents, nothing else.",
            profiler::events_schema(),
        ),
        "profiler_crash" => (profiler::CRASH_DESCRIPTION, profiler::crash_schema()),
        "diagnose_environment" => (
            "This environment at a glance: the server version, platform and capability flags; each provider's install, enablement, version, status and sign-in state; the count of each kind of config issue; the version control systems and hosting CLIs found and their sign-in state; and the profiler's state. Never paths, settings or messages.",
            none(),
        ),
        "refresh_providers" => (
            "Checks every provider again (install, version, sign-in) as Settings → Providers does, and returns each provider's state. It can take a while.",
            none(),
        ),
        "process_diagnostics" => (
            "BiBCode's processes now (pid, parent, depth, status, elapsed time, CPU and memory, and how BiBCode attributes each: scope, kind, confidence) with totals, and their CPU and memory over a recent window in buckets. Never command lines.",
            object_schema(
                json!({
                    "historyWindowMs": { "type": "integer", "minimum": WINDOW_MS.0, "maximum": WINDOW_MS.1, "description": "How far back the history goes; 900000 (15 minutes) unless set." },
                    "bucketMs": { "type": "integer", "minimum": 1000, "description": "Each history bucket's width; a fifteenth of the window unless set, and never more than 120 buckets." },
                }),
                &[],
            ),
        ),
        "trace_diagnostics" => (
            "A summary of the server's local trace: record and failure counts, log counts per level, the spans seen most often and the slowest ones, and the spans that failed most often or last, by name, count and duration. Never failure causes or log text.",
            object_schema(
                json!({
                    "limit": { "type": "integer", "minimum": 1, "maximum": TRACE_LIMIT.1, "description": "Entries per list; 10 unless set." },
                }),
                &[],
            ),
        ),
        _ => return None,
    })
}

impl ToolCall<'_> {
    /// Runs a stdio profiler handler over the server's own profiler directory, off the async
    /// workers, then projects its content.
    async fn profiler(&self, produce: Producer, project: fn(&mut Value)) -> ToolResult {
        let reader = profiler::server_reader().ok_or_else(|| {
            typed_tool_failure(
                "McpProfilerUnavailableError",
                "This server has no profiler storage: its profiler directory could not be opened, or another BiBCode process holds it.",
            )
        })?;
        let arguments = self.arguments.clone();
        let (mut content, cuts) = tokio::task::spawn_blocking(move || produce(&reader, &arguments))
            .await
            .map_err(|_| {
                typed_tool_failure(
                    "McpProfilerReadError",
                    "The profiler records could not be read; try again.",
                )
            })?
            .map_err(|refusal| match refusal {
                Refusal::Invalid(message) => invalid_argument(&message),
                Refusal::Missing(message) => typed_tool_failure("McpCrashNotFoundError", &message),
            })?;
        project(&mut content);
        Ok(tool_result(content, cuts))
    }

    async fn diagnose_environment(&self) -> ToolResult {
        self.only(&[])?;
        // Never `recordHosts`: that rewrites the recorded hosts, which only Settings' scan does.
        let (config, discovery, status) = tokio::join!(
            self.invoke("server.getConfig", json!({})),
            self.invoke("server.discoverSourceControl", json!({})),
            self.invoke("server.getProfilerStatus", json!({})),
        );
        let (environment, providers, issues) = match &config {
            Ok(config) => (
                project_environment(&config["environment"]),
                project_providers(&config["providers"]),
                count_issues(&config["issues"]),
            ),
            Err(failure) => (section_error(failure), section_error(failure), Value::Null),
        };
        Ok(tool_result(
            json!({
                "environment": environment,
                "providers": providers,
                "configIssues": issues,
                "sourceControl": discovery.as_ref().map_or_else(section_error, project_discovery),
                "profiler": status.as_ref().map_or_else(section_error, project_profiler_status),
            }),
            &[],
        ))
    }

    async fn refresh_providers(&self) -> ToolResult {
        self.only(&[])?;
        let refreshed = self.invoke("server.refreshProviders", json!({})).await?;
        Ok(tool_result(
            json!({ "providers": project_providers(&refreshed["providers"]) }),
            &[],
        ))
    }

    async fn process_diagnostics(&self) -> ToolResult {
        self.only(&["historyWindowMs", "bucketMs"])?;
        let window = self
            .integer("historyWindowMs")?
            .unwrap_or(DEFAULT_WINDOW_MS)
            .clamp(WINDOW_MS.0, WINDOW_MS.1);
        let bucket = self
            .integer("bucketMs")?
            .unwrap_or(window / 15)
            .clamp((window / MOST_BUCKETS).max(1_000), window);
        let (current, history) = tokio::join!(
            self.invoke("server.getProcessDiagnostics", json!({})),
            self.invoke(
                "server.getProcessResourceHistory",
                json!({ "windowMs": window, "bucketMs": bucket }),
            ),
        );
        let current = current?;
        let history = history?;
        Ok(tool_result(
            json!({
                "serverPid": current["serverPid"],
                "readAt": current["readAt"],
                "totals": current["totals"],
                "uiCoverage": current["uiCoverage"]["status"],
                "readFailed": is_some(&current["error"]),
                "processes": pick_each(&current["processes"], CURRENT_PROCESS_FIELDS),
                "history": {
                    "readAt": history["readAt"],
                    "windowMs": history["windowMs"],
                    "bucketMs": history["bucketMs"],
                    "sampleIntervalMs": history["sampleIntervalMs"],
                    "retainedSampleCount": history["retainedSampleCount"],
                    "cpuSecondsApprox": history["cpuSecondsApprox"],
                    "readFailed": is_some(&history["error"]),
                    "buckets": pick_each(&history["buckets"], HISTORY_BUCKET_FIELDS),
                    "processes": pick_each(&history["processes"], HISTORY_PROCESS_FIELDS),
                },
            }),
            &[
                ("/history/processes", Cut::Back),
                ("/history/buckets", Cut::Front),
                ("/processes", Cut::Back),
            ],
        ))
    }

    async fn trace_diagnostics(&self) -> ToolResult {
        self.only(&["limit"])?;
        let limit = match self.integer("limit")? {
            None => TRACE_LIMIT.0,
            Some(limit) if (1..=TRACE_LIMIT.1).contains(&limit) => limit,
            Some(_) => {
                return Err(invalid_argument(&format!(
                    "limit must be 1 to {}",
                    TRACE_LIMIT.1
                )));
            }
        };
        let limit = usize::try_from(limit).unwrap_or(1);
        let trace = self.invoke("server.getTraceDiagnostics", json!({})).await?;
        let list = |key: &str, fields: &[&str]| {
            let mut items = pick_each(&trace[key], fields);
            if let Value::Array(items) = &mut items {
                items.truncate(limit);
            }
            items
        };
        let error = &trace["error"];
        Ok(tool_result(
            json!({
                "readAt": trace["readAt"],
                "recordCount": trace["recordCount"],
                "parseErrorCount": trace["parseErrorCount"],
                "firstSpanAt": option_value(&trace["firstSpanAt"]),
                "lastSpanAt": option_value(&trace["lastSpanAt"]),
                "failureCount": trace["failureCount"],
                "interruptionCount": trace["interruptionCount"],
                "slowSpanThresholdMs": trace["slowSpanThresholdMs"],
                "slowSpanCount": trace["slowSpanCount"],
                "logLevelCounts": numbers_only(&trace["logLevelCounts"]),
                "topSpansByCount": list("topSpansByCount", TOP_SPAN_FIELDS),
                "slowestSpans": list("slowestSpans", SPAN_FIELDS),
                "commonFailures": list("commonFailures", FAILURE_FIELDS),
                "latestFailures": list("latestFailures", SPAN_FIELDS),
                "partialFailure": is_some(&trace["partialFailure"]),
                "error": option_value(error).get("kind").cloned().unwrap_or(Value::Null),
            }),
            &[],
        ))
    }
}

const CURRENT_PROCESS_FIELDS: &[&str] = &[
    "pid",
    "ppid",
    "depth",
    "status",
    "elapsed",
    "cpuPercent",
    "rssBytes",
    "scope",
    "kind",
    "confidence",
];
const HISTORY_PROCESS_FIELDS: &[&str] = &[
    "pid",
    "ppid",
    "depth",
    "scope",
    "kind",
    "confidence",
    "firstSeenAt",
    "lastSeenAt",
    "currentCpuPercent",
    "avgCpuPercent",
    "maxCpuPercent",
    "cpuSecondsApprox",
    "currentRssBytes",
    "maxRssBytes",
    "sampleCount",
];
const HISTORY_BUCKET_FIELDS: &[&str] = &[
    "startedAt",
    "endedAt",
    "cpuPercent",
    "rssBytes",
    "maxProcessCount",
];
const TOP_SPAN_FIELDS: &[&str] = &[
    "name",
    "count",
    "failureCount",
    "measuredCount",
    "totalDurationMs",
    "averageDurationMs",
    "maxDurationMs",
];
const SPAN_FIELDS: &[&str] = &["name", "durationMs", "durationMeasured", "endedAt"];
const FAILURE_FIELDS: &[&str] = &["name", "count", "lastSeenAt"];

/// The environment descriptor's version, platform and capability flags: not its label, ids or
/// anything a person typed.
fn project_environment(environment: &Value) -> Value {
    json!({
        "serverVersion": environment["serverVersion"],
        "platform": pick(&environment["platform"], &["os", "arch"]),
        "remoteProtocolVersion": environment["remoteProtocolVersion"],
        "minCompatibleRemoteProtocol": environment["minCompatibleRemoteProtocol"],
        "capabilities": numbers_only(&environment["capabilities"]),
    })
}

/// Each provider's state: no account, message, models or instructions.
fn project_providers(providers: &Value) -> Value {
    let Some(providers) = providers.as_array() else {
        return Value::Array(Vec::new());
    };
    providers
        .iter()
        .map(|provider| {
            let mut projected = pick(
                provider,
                &[
                    "instanceId",
                    "driver",
                    "enabled",
                    "installed",
                    "version",
                    "status",
                    "availability",
                ],
            );
            projected["auth"] = provider["auth"]["status"].clone();
            projected
        })
        .collect()
}

/// How many config issues of each kind: never their messages.
fn count_issues(issues: &Value) -> Value {
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    for issue in issues.as_array().into_iter().flatten() {
        let kind = token(&issue["kind"]).unwrap_or("unknown");
        *counts.entry(kind.to_owned()).or_default() += 1;
    }
    counts
        .into_iter()
        .map(|(kind, count)| json!({ "kind": kind, "count": count }))
        .collect()
}

/// What was found and its sign-in state: no executable path, hint, detail, host or account.
fn project_discovery(discovery: &Value) -> Value {
    let item = |item: &Value, auth: bool| {
        let mut projected = pick(item, &["kind", "implemented", "status"]);
        projected["version"] = option_value(&item["version"]);
        if auth {
            projected["auth"] = item["auth"]["status"].clone();
        }
        projected
    };
    let each = |key: &str, auth: bool| -> Value {
        discovery[key]
            .as_array()
            .into_iter()
            .flatten()
            .map(|entry| item(entry, auth))
            .collect()
    };
    json!({
        "versionControlSystems": each("versionControlSystems", false),
        "sourceControlProviders": each("sourceControlProviders", true),
    })
}

/// The profiler's state; its findings are `profiler_findings`' to return.
fn project_profiler_status(status: &Value) -> Value {
    pick(
        status,
        &[
            "enabled",
            "recordingSince",
            "eventCount",
            "droppedEvents",
            "lastCrashAt",
            "capabilities",
        ],
    )
}

/// A section that could not be read: its error's tag only.
fn section_error(failure: &Value) -> Value {
    json!({ "error": failure["structuredContent"]["error"]["_tag"].as_str().unwrap_or("McpToolError") })
}

/// The fields every profiler event keeps.
const ENVELOPE: &[&str] = &[
    "v", "bibcode", "ts", "sid", "seq", "eventId", "kind", "source",
];

/// The payload fields each event kind documents in `events.md`.
fn event_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "session.start" => &["version", "host", "os", "arch"],
        "process.sample" => &["procs", "selfCpuMs", "intervalMs"],
        "rpc.timing" => &[
            "method",
            "outcome",
            "ms",
            "queuedMs",
            "tier",
            "p95Ms",
            "samples",
            "correlationId",
        ],
        "rpc.histogram" => &[
            "method",
            "outcome",
            "slotSecs",
            "bucketGrowth",
            "samples",
            "buckets",
        ],
        "rpc.bytes" => &[
            "method",
            "slotSecs",
            "slotStartSecs",
            "messages",
            "bytes",
            "maxBytes",
        ],
        "rpc.disconnect" => &[
            "reason",
            "closeCode",
            "transport",
            "ageMs",
            "sinceInboundMs",
            "sinceOutboundMs",
            "outboundWaitMaxMs",
            "queuedMessages",
            "inFlight",
            "clientId",
        ],
        "rpc.reconnect" => &[
            "clientId",
            "transport",
            "afterMs",
            "previousReason",
            "previousCloseCode",
        ],
        "client.request" => &[
            "envId",
            "clientId",
            "method",
            "correlationId",
            "joinedBy",
            "rttMs",
            "renderMs",
            "serverMs",
            "networkMs",
            "queuedMs",
            "totalMs",
            "slowPart",
        ],
        "client.batch" => &[
            "envId",
            "clientId",
            "capabilities",
            "windowMs",
            "records",
            "droppedUnknownMethods",
            "bucketGrowth",
            "histograms",
            "stalls",
            "interactions",
            "jsHeapBytes",
            "appVersion",
        ],
        "subprocess.exit" => &[
            "processKind",
            "label",
            "pid",
            "outcome",
            "likelyOom",
            "uptimeMs",
        ],
        "provider.turn-failed" => &["provider", "terminalReason", "errorClass"],
        "provider.compaction" => &["provider", "trigger", "outcome", "reason", "durationMs"],
        "device.lifecycle" => &["platform", "phase", "durationMs", "failureKind", "running"],
        "worktree.removal" => &[
            "mode",
            "ok",
            "reason",
            "durationMs",
            "drainTimedOut",
            "capacity",
            "cancelled",
        ],
        "worktree.audit" => &[
            "entries",
            "dirs",
            "registrations",
            "processes",
            "findings",
            "compared",
            "processesRead",
            "durationMs",
        ],
        "git.stacked-action" => &[
            "action",
            "featureBranch",
            "ok",
            "phase",
            "reason",
            "operation",
            "durationMs",
        ],
        "panic" => &[
            "thread", "message", "location", "frames", "version", "os", "arch",
        ],
        "finding" => &["id", "fingerprint", "kindOf"],
        "telemetry.dropped" => &["count"],
        _ => &[],
    }
}

/// The fields of the objects inside an event's lists and records.
const NESTED: &[(&str, &[&str])] = &[
    (
        "procs",
        &[
            "pid",
            "kind",
            "label",
            "metric",
            "cpu",
            "cpuMax",
            "rssBytes",
            "rssMaxBytes",
            "privateBytes",
            "privateMaxBytes",
        ],
    ),
    ("frames", &["module", "debugId", "offset"]),
    ("histograms", &["method", "buckets"]),
];
/// What a client batch may say it measures with.
const CLIENT_CAPABILITIES: &[&str] = &["long-animation-frame", "heartbeat", "event", "memory"];

fn project_findings(content: &mut Value) {
    if let Some(Value::Array(findings)) = content.get_mut("findings") {
        for finding in findings {
            *finding = project_finding(finding);
        }
    }
}

fn project_events(content: &mut Value) {
    if let Some(Value::Array(events)) = content.get_mut("events") {
        for event in events {
            *event = project_event(event);
        }
    }
}

/// One profiler event, reduced to its envelope and its kind's documented fields.
pub(crate) fn project_event(event: &Value) -> Value {
    let kind = event["kind"].as_str().unwrap_or_default();
    let mut projected = pick(
        event,
        &ENVELOPE
            .iter()
            .chain(event_fields(kind))
            .copied()
            .collect::<Vec<_>>(),
    );
    for (list, fields) in NESTED {
        if let Some(items) = projected.get(*list) {
            projected[*list] = pick_each(items, fields);
        }
    }
    for field in ["stalls", "interactions"] {
        if let Some(value) = projected.get(field) {
            projected[field] = numbers_only(value);
        }
    }
    clean_client_fields(&mut projected);
    // The server's environment id, kept while it looks like one.
    if let Some(env) = projected.get("envId") {
        projected["envId"] = token(env).map_or(Value::Null, Value::from);
    }
    if let Some(location) = projected.get("location").and_then(Value::as_str) {
        projected["location"] = relative_or_file_name(location).into();
    }
    if let Some(source) = projected.get("source") {
        projected["source"] = match source.as_str() {
            Some("server") => "server".into(),
            Some(source) => match source.strip_prefix("client:") {
                Some(id) => format!("client:{}", opaque(id)).into(),
                None => "client".into(),
            },
            None => Value::Null,
        };
    }
    projected
}

/// A crash record's documented fields, its events projected, and its stack with each frame's
/// file as a relative path or a file name.
fn project_crash(content: &mut Value) {
    let crash = &content["crash"];
    let mut projected = pick(
        crash,
        &[
            "id",
            "createdAt",
            "version",
            "os",
            "arch",
            "processKind",
            "parentPid",
            "bootId",
        ],
    );
    if let Some(events) = crash.get("lastEvents").and_then(Value::as_array) {
        projected["lastEvents"] = events.iter().map(project_event).collect();
    }
    content["crash"] = projected;
    if content["stack"].is_object() {
        let stack = &content["stack"];
        let frames: Value = stack["crashingThread"]["frames"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|frame| {
                let mut frame = pick(frame, &["module", "function", "file", "line", "offset"]);
                if let Some(file) = frame["file"].as_str() {
                    frame["file"] = relative_or_file_name(file).into();
                }
                frame
            })
            .collect();
        content["stack"] = json!({
            "crashReason": stack["crashReason"],
            "crashingThread": stack["crashingThread"].is_object().then(|| json!({ "frames": frames })),
        });
    }
    if let Some(error) = content["stackError"].as_str() {
        content["stackError"] = redact_message(error).into();
    }
}

/// The `fields` of `value` that it has; nothing else.
fn pick(value: &Value, fields: &[&str]) -> Value {
    let mut picked = Map::new();
    for field in fields {
        if let Some(found) = value.get(*field) {
            picked.insert((*field).to_owned(), found.clone());
        }
    }
    Value::Object(picked)
}

/// [`pick`] on each object of a list; anything that is not a list is an empty one.
fn pick_each(items: &Value, fields: &[&str]) -> Value {
    items
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| pick(item, fields))
        .collect()
}

/// An object's number and boolean members whose keys are plain names (a capability or count
/// map); nothing else.
fn numbers_only(value: &Value) -> Value {
    let mut kept = Map::new();
    for (key, member) in value.as_object().into_iter().flatten() {
        let plain = key.len() <= 64
            && key.starts_with(|first: char| first.is_ascii_alphabetic())
            && key.bytes().all(|byte| byte.is_ascii_alphanumeric());
        if plain && (member.is_number() || member.is_boolean()) {
            kept.insert(key.clone(), member.clone());
        }
    }
    Value::Object(kept)
}

/// An Effect `Option` on the wire (`{ _tag: "Some", value }` or `{ _tag: "None" }`) as its
/// value or null; anything else as it is.
fn option_value(value: &Value) -> Value {
    match value["_tag"].as_str() {
        Some("Some") => value["value"].clone(),
        Some("None") => Value::Null,
        _ => value.clone(),
    }
}

/// Whether an Effect `Option` (or a plain value) holds something.
fn is_some(value: &Value) -> bool {
    !option_value(value).is_null()
}

/// A string that looks like an id, a version or a kind, else `None`.
fn token(value: &Value) -> Option<&str> {
    value.as_str().and_then(id_like)
}

fn id_like(text: &str) -> Option<&str> {
    (!text.is_empty()
        && text.len() <= 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:+-".contains(&byte)))
    .then_some(text)
}

/// The fields every finding keeps. `title` and `summary` are prose that can quote a path or a
/// value, so they are left out: the kind and the evidence carry the facts.
const FINDING_FIELDS: &[&str] = &[
    "id",
    "fingerprint",
    "kind",
    "severity",
    "firstSeen",
    "lastSeen",
    "count",
    "source",
    "state",
    "firstVersion",
    "lastVersion",
];
/// The evidence every finding may cite.
const CITATIONS: &[&str] = &["eventIds", "crashId", "crashIds"];
/// A crashed previous run's evidence.
const RUN: &[&str] = &["pid", "version", "startedAt"];
/// A crash record's evidence: a dump's, an OS record's, or both.
const CRASH_RECORD: &[&str] = &[
    "source",
    "processKind",
    "createdAt",
    "crashReason",
    "faultModule",
    "faultOffset",
    "recordSource",
    "signalOrCode",
    "module",
    "frames",
    "rawRef",
    "signal",
    "exe",
    "crashedAt",
];

/// The evidence fields each finding kind documents in `findings.md`. Free text (an exit
/// detail, a journal excerpt) is left out.
fn evidence_fields(kind: &str) -> Vec<&'static str> {
    let fields: &[&[&'static str]] = match kind {
        "crash.native" => &[RUN, CRASH_RECORD],
        "crash.unclean-exit" | "shutdown.incomplete" => {
            &[RUN, &["facility", "exitCause", "exitNotedAt", "goneAt"]]
        }
        "crash.oom" | "crash.system" => &[RUN],
        "crash.webview" => &[&["reason", "kind", "exitCode", "dump"], CRASH_RECORD],
        "crash.panic" => &[&["thread", "location", "message"]],
        "subprocess.crash" => &[
            &[
                "pid",
                "processKind",
                "label",
                "outcome",
                "uptimeMs",
                "likelyOom",
                "lastRssBytes",
                "lastPrivateBytes",
                "sampledAgoMs",
            ],
            CRASH_RECORD,
        ],
        "provider.turn-failed" => &[&["provider", "terminalReason", "errorClass"]],
        "provider.compaction-failed" => {
            &[&["provider", "trigger", "outcome", "reason", "durationMs"]]
        }
        "memory.leak-suspect" | "memory.leak-likely" => &[&[
            "pid",
            "processKind",
            "label",
            "slopeMbPerH",
            "privateBytes",
            "metric",
            "r2",
        ]],
        "cpu.sustained" => &[&["pid", "processKind", "label"]],
        "rpc.slow" => &[&[
            "method",
            "outcome",
            "slowPart",
            "count",
            "maxMs",
            "tier",
            "envId",
            "clientId",
            "joinedBy",
            "rttMs",
            "renderMs",
            "serverMs",
            "networkMs",
            "queuedMs",
            "totalMs",
        ]],
        "rpc.hang" => &[&["method", "slowPart", "elapsedSecs"]],
        "rpc.saturation" => &[&["slowPart", "methods"]],
        "client.stall" => &[&["envId", "clientId", "capabilities", "windowMs", "stalls"]],
        "client.interaction" => &[&[
            "envId",
            "clientId",
            "capabilities",
            "windowMs",
            "interactions",
        ]],
        "worktree.removal-failed" => &[&[
            "mode",
            "reason",
            "durationMs",
            "drainTimedOut",
            "cancelled",
            "capacity",
        ]],
        "worktree.missing" | "worktree.orphan-dir" | "worktree.registration-mismatch" => {
            &[&["path"]]
        }
        "worktree.stuck-removal" => &[&["path", "minutes"]],
        "worktree.held-open" => &[&["path", "pid"]],
        "git.stacked-action-failed" => &[&[
            "action",
            "featureBranch",
            "phase",
            "reason",
            "operation",
            "message",
            "worktree",
            "repeatsInWindow",
            "windowMinutes",
            "durationMs",
        ]],
        _ => &[],
    };
    CITATIONS
        .iter()
        .chain(fields.iter().copied().flatten())
        .copied()
        .collect()
}

/// One finding as `/mcp` returns it: its documented fields and its kind's evidence, with
/// client-chosen strings replaced or left out and host paths outside home left out.
pub(crate) fn project_finding(finding: &Value) -> Value {
    let mut projected = pick(finding, FINDING_FIELDS);
    let Some(evidence) = finding.get("evidence") else {
        return projected;
    };
    let kind = finding["kind"].as_str().unwrap_or_default();
    let mut evidence = pick(evidence, &evidence_fields(kind));
    if let Some(methods) = evidence.get("methods") {
        evidence["methods"] = pick_each(methods, &["method", "outcome", "count", "maxMs"]);
    }
    if let Some(frames) = evidence.get("frames") {
        evidence["frames"] = frames
            .as_array()
            .into_iter()
            .flatten()
            .filter(|frame| frame.is_string())
            .cloned()
            .collect();
    }
    for field in ["stalls", "interactions"] {
        if let Some(value) = evidence.get(field) {
            evidence[field] = numbers_only(value);
        }
    }
    clean_client_fields(&mut evidence);
    // A worktree's path is kept only inside home, where it reads `~/…`.
    for field in ["worktree", "path"] {
        let inside_home = evidence
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|path| path == "~" || path.starts_with("~/") || path.starts_with("~\\"));
        if !inside_home && let Some(fields) = evidence.as_object_mut() {
            fields.remove(field);
        }
    }
    for field in ["location", "exe", "rawRef"] {
        if let Some(path) = evidence.get(field).and_then(Value::as_str) {
            evidence[field] = relative_or_file_name(path).into();
        }
    }
    projected["evidence"] = evidence;
    projected
}

/// Client-chosen strings in an event or a finding's evidence: the client's id becomes an
/// opaque value that still matches across records, its correlation id and version are left
/// out (an id's shape says nothing of who chose it), and capabilities keep the known ones.
fn clean_client_fields(record: &mut Value) {
    if let Some(client) = record.get("clientId") {
        record["clientId"] = client.as_str().map_or(Value::Null, |id| opaque(id).into());
    }
    if let Some(fields) = record.as_object_mut() {
        fields.remove("correlationId");
        fields.remove("appVersion");
    }
    if let Some(capabilities) = record.get("capabilities").and_then(Value::as_array) {
        record["capabilities"] = capabilities
            .iter()
            .filter(|capability| {
                capability
                    .as_str()
                    .is_some_and(|capability| CLIENT_CAPABILITIES.contains(&capability))
            })
            .cloned()
            .collect();
    }
}

/// `h` and 12 hex characters of SHA-256 over a client-chosen id: stable, and never its text.
fn opaque(id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(id.as_bytes());
    let hex: String = digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("h{hex}")
}

/// A relative path as it is; a rooted one (`/…`, `~/…`, `C:\…`) as its file name, with any
/// `:line` suffix kept. A build machine's or this host's folders never reach an agent.
fn relative_or_file_name(path: &str) -> &str {
    let rooted = path.starts_with(['/', '\\', '~']) || path.as_bytes().get(1) == Some(&b':');
    if rooted {
        path.rsplit(['/', '\\']).next().unwrap_or_default()
    } else {
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A symbolicated frame's file is the build machine's path, which `redact_path` cannot
    /// clean: only a relative path or the file's name reaches an agent (#139, review round 2).
    #[test]
    fn a_crash_frame_keeps_a_relative_path_or_the_file_name_only() {
        let frame = |file: &str| json!({ "module": "bibcode", "function": "f", "file": file, "line": 7, "offset": 16 });
        let mut content = json!({
            "crash": { "id": "c1" },
            "dump": "read",
            "stack": {
                "crashReason": "SIGSEGV",
                "crashingThread": { "frames": [
                    frame("/builds/private/repo/src/main.rs"),
                    frame("apps/server/src/lib.rs"),
                    frame("~/.cargo/registry/src/index/serde-1.0/src/de.rs"),
                    frame("C:\\builds\\private\\src\\win.rs"),
                    frame("/rustc/abc123/library/core/src/option.rs"),
                ] },
            },
            "stackError": null,
        });

        project_crash(&mut content);

        let files: Vec<&str> = content["stack"]["crashingThread"]["frames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|frame| frame["file"].as_str().unwrap())
            .collect();
        assert_eq!(
            files,
            [
                "main.rs",
                "apps/server/src/lib.rs",
                "de.rs",
                "win.rs",
                "option.rs"
            ]
        );
        assert_eq!(content["stack"]["crashingThread"]["frames"][0]["line"], 7);
    }
}
