use std::{
    cmp::Reverse,
    collections::{BTreeMap, HashMap},
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const DEFAULT_MAX_FILES: usize = 3;
const DEFAULT_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const SLOW_SPAN_THRESHOLD_MS: f64 = 1_000.0;
const TOP_LIMIT: usize = 10;
const RECENT_LIMIT: usize = 20;
const MAX_CAUSE_CHARS: usize = 8_192;
const MAX_EVENT_NAME_CHARS: usize = 128;

#[derive(Clone, Debug)]
pub struct TraceDiagnosticsStore {
    path: Arc<PathBuf>,
    max_files: usize,
    max_file_bytes: u64,
    write_lock: Arc<Mutex<()>>,
}

impl TraceDiagnosticsStore {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self::with_limits(path, DEFAULT_MAX_FILES, DEFAULT_MAX_FILE_BYTES)
    }

    #[must_use]
    pub fn with_limits(path: PathBuf, max_files: usize, max_file_bytes: u64) -> Self {
        Self {
            path: Arc::new(path),
            max_files,
            max_file_bytes: max_file_bytes.max(1),
            write_lock: Arc::new(Mutex::new(())),
        }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        self.path.as_path()
    }

    pub fn record_failure(&self, name: &str, error: &Value) -> io::Result<()> {
        let now = OffsetDateTime::now_utc().unix_timestamp_nanos();
        let id = Uuid::new_v4().simple().to_string();
        let cause = redact_sensitive_text(&error_summary(&redact_sensitive_value(error)));
        self.append_record(&json!({
            "type": "native-span",
            "name": non_empty(name, "native.failure"),
            "traceId": id,
            "spanId": Uuid::new_v4().simple().to_string(),
            "startTimeUnixNano": now.to_string(),
            "endTimeUnixNano": now.to_string(),
            "durationMs": 0.0,
            "events": [{
                "name": cause,
                "timeUnixNano": now.to_string(),
                "attributes": { "effect.logLevel": "Error" }
            }],
            "exit": { "_tag": "Failure", "cause": cause }
        }))
    }

    pub fn record_event(&self, name: &str, attributes: Value) -> io::Result<()> {
        if !attributes.is_object() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "trace event attributes must be an object",
            ));
        }
        let now = OffsetDateTime::now_utc().unix_timestamp_nanos();
        let name = bounded_event_name(name);
        let trace_id = Uuid::new_v4().simple().to_string();
        self.append_record(&json!({
            "type": "native-span",
            "name": name,
            "traceId": trace_id,
            "spanId": Uuid::new_v4().simple().to_string(),
            "startTimeUnixNano": now.to_string(),
            "endTimeUnixNano": now.to_string(),
            "durationMs": 0.0,
            "events": [{
                "name": name,
                "timeUnixNano": now.to_string(),
                "attributes": redact_sensitive_value(&attributes),
            }],
            "exit": { "_tag": "Success", "value": null }
        }))
    }

    #[must_use]
    pub fn read(&self) -> Value {
        aggregate(self.path(), self.max_files)
    }

    fn append_record(&self, record: &Value) -> io::Result<()> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut encoded = serde_json::to_vec(record).map_err(io::Error::other)?;
        encoded.push(b'\n');
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let current_size = fs::metadata(self.path()).map_or(0, |metadata| metadata.len());
        if current_size > 0
            && current_size.saturating_add(encoded.len() as u64) > self.max_file_bytes
        {
            rotate(self.path(), self.max_files)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path())?;
        file.write_all(&encoded)?;
        file.flush()
    }
}

#[derive(Clone)]
struct SpanOccurrence {
    name: String,
    duration_ms: f64,
    ended_at_ns: i128,
    trace_id: String,
    span_id: String,
}

#[derive(Default)]
struct SpanSummary {
    count: usize,
    failure_count: usize,
    total_duration_ms: f64,
    max_duration_ms: f64,
}

#[derive(Clone)]
struct FailureSummary {
    name: String,
    cause: String,
    count: usize,
    last_seen_ns: i128,
    trace_id: String,
    span_id: String,
}

#[derive(Clone)]
struct LogEvent {
    span_name: String,
    level: String,
    message: String,
    seen_at_ns: i128,
    trace_id: String,
    span_id: String,
}

fn aggregate(path: &Path, max_files: usize) -> Value {
    let scanned_paths = rotated_paths(path, max_files);
    let read_at = format_time(OffsetDateTime::now_utc().unix_timestamp_nanos());
    let mut loaded_any = false;
    let mut read_error = None;
    let mut parse_error_count = 0usize;
    let mut record_count = 0usize;
    let mut failure_count = 0usize;
    let mut interruption_count = 0usize;
    let mut slow_span_count = 0usize;
    let mut first_span_ns = None::<i128>;
    let mut last_span_ns = None::<i128>;
    let mut spans = HashMap::<String, SpanSummary>::new();
    let mut failures = HashMap::<(String, String), FailureSummary>::new();
    let mut latest_failures = Vec::<(SpanOccurrence, String)>::new();
    let mut occurrences = Vec::<SpanOccurrence>::new();
    let mut logs = Vec::<LogEvent>::new();
    let mut log_level_counts = BTreeMap::<String, usize>::new();

    for file_path in &scanned_paths {
        let text = match fs::read_to_string(file_path) {
            Ok(text) => {
                loaded_any = true;
                text
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                read_error = Some(format!(
                    "Failed to read local trace file '{}': {error}",
                    file_path.display()
                ));
                continue;
            }
        };
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                parse_error_count += 1;
                continue;
            };
            let record = redact_sensitive_value(&record);
            let Some(span) = parse_span(&record) else {
                parse_error_count += 1;
                continue;
            };
            record_count += 1;
            let started_at_ns = parse_nanos(record.get("startTimeUnixNano"));
            if let Some(started_at_ns) = started_at_ns {
                first_span_ns =
                    Some(first_span_ns.map_or(started_at_ns, |current| current.min(started_at_ns)));
            }
            last_span_ns = Some(
                last_span_ns.map_or(span.ended_at_ns, |current| current.max(span.ended_at_ns)),
            );
            let exit_tag = record.pointer("/exit/_tag").and_then(Value::as_str);
            let failed = exit_tag == Some("Failure");
            let interrupted = exit_tag == Some("Interrupted");
            failure_count += usize::from(failed);
            interruption_count += usize::from(interrupted);
            slow_span_count += usize::from(span.duration_ms >= SLOW_SPAN_THRESHOLD_MS);

            let summary = spans.entry(span.name.clone()).or_default();
            summary.count += 1;
            summary.failure_count += usize::from(failed);
            summary.total_duration_ms += span.duration_ms;
            summary.max_duration_ms = summary.max_duration_ms.max(span.duration_ms);

            if failed {
                let cause = record
                    .pointer("/exit/cause")
                    .and_then(Value::as_str)
                    .unwrap_or("Failure")
                    .to_owned();
                let key = (span.name.clone(), cause.clone());
                let entry = failures.entry(key).or_insert_with(|| FailureSummary {
                    name: span.name.clone(),
                    cause: cause.clone(),
                    count: 0,
                    last_seen_ns: span.ended_at_ns,
                    trace_id: span.trace_id.clone(),
                    span_id: span.span_id.clone(),
                });
                entry.count += 1;
                if span.ended_at_ns >= entry.last_seen_ns {
                    entry.last_seen_ns = span.ended_at_ns;
                    entry.trace_id.clone_from(&span.trace_id);
                    entry.span_id.clone_from(&span.span_id);
                }
                latest_failures.push((span.clone(), cause));
            }
            collect_log_events(&record, &span, &mut logs, &mut log_level_counts);
            occurrences.push(span);
        }
    }

    let error = if !loaded_any {
        effect_some(
            json!({ "kind": "trace-file-not-found", "message": "No local trace files were found." }),
        )
    } else if let Some(message) = &read_error {
        effect_some(json!({ "kind": "trace-file-read-failed", "message": message }))
    } else {
        effect_none()
    };

    let mut top_spans = spans.into_iter().collect::<Vec<_>>();
    top_spans.sort_by(|left, right| {
        right
            .1
            .count
            .cmp(&left.1.count)
            .then_with(|| right.1.max_duration_ms.total_cmp(&left.1.max_duration_ms))
    });
    let top_spans = top_spans
        .into_iter()
        .take(TOP_LIMIT)
        .map(|(name, span)| {
            json!({
                "name": name,
                "count": span.count,
                "failureCount": span.failure_count,
                "totalDurationMs": span.total_duration_ms,
                "averageDurationMs": span.total_duration_ms / span.count as f64,
                "maxDurationMs": span.max_duration_ms,
            })
        })
        .collect::<Vec<_>>();

    occurrences.sort_by(|left, right| right.duration_ms.total_cmp(&left.duration_ms));
    let slowest_spans = occurrences
        .into_iter()
        .take(TOP_LIMIT)
        .map(span_wire)
        .collect::<Vec<_>>();
    let mut common_failures = failures.into_values().collect::<Vec<_>>();
    common_failures.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| right.last_seen_ns.cmp(&left.last_seen_ns))
    });
    let common_failures = common_failures
        .into_iter()
        .take(TOP_LIMIT)
        .map(|failure| {
            json!({
                "name": failure.name,
                "cause": failure.cause,
                "count": failure.count,
                "lastSeenAt": format_time(failure.last_seen_ns),
                "traceId": failure.trace_id,
                "spanId": failure.span_id,
            })
        })
        .collect::<Vec<_>>();
    latest_failures.sort_by_key(|failure| Reverse(failure.0.ended_at_ns));
    let latest_failures = latest_failures
        .into_iter()
        .take(RECENT_LIMIT)
        .map(|(span, cause)| {
            let mut value = span_wire(span);
            value
                .as_object_mut()
                .expect("span wire object")
                .insert("cause".into(), Value::String(cause));
            value
        })
        .collect::<Vec<_>>();
    logs.sort_by_key(|event| Reverse(event.seen_at_ns));
    let logs = logs
        .into_iter()
        .take(RECENT_LIMIT)
        .map(|event| {
            json!({
                "spanName": event.span_name,
                "level": event.level,
                "message": event.message,
                "seenAt": format_time(event.seen_at_ns),
                "traceId": event.trace_id,
                "spanId": event.span_id,
            })
        })
        .collect::<Vec<_>>();

    json!({
        "traceFilePath": path.to_string_lossy(),
        "scannedFilePaths": scanned_paths.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(),
        "readAt": read_at,
        "recordCount": record_count,
        "parseErrorCount": parse_error_count,
        "firstSpanAt": first_span_ns.map_or_else(effect_none, |value| effect_some(Value::String(format_time(value)))),
        "lastSpanAt": last_span_ns.map_or_else(effect_none, |value| effect_some(Value::String(format_time(value)))),
        "failureCount": failure_count,
        "interruptionCount": interruption_count,
        "slowSpanThresholdMs": SLOW_SPAN_THRESHOLD_MS as usize,
        "slowSpanCount": slow_span_count,
        "logLevelCounts": log_level_counts,
        "topSpansByCount": top_spans,
        "slowestSpans": slowest_spans,
        "commonFailures": common_failures,
        "latestFailures": latest_failures,
        "latestWarningAndErrorLogs": logs,
        "partialFailure": if loaded_any && read_error.is_some() { effect_some(Value::Bool(true)) } else { effect_none() },
        "error": error,
    })
}

fn parse_span(record: &Value) -> Option<SpanOccurrence> {
    Some(SpanOccurrence {
        name: record.get("name")?.as_str()?.trim().to_owned(),
        duration_ms: record.get("durationMs")?.as_f64()?,
        ended_at_ns: parse_nanos(record.get("endTimeUnixNano"))?,
        trace_id: record.get("traceId")?.as_str()?.trim().to_owned(),
        span_id: record.get("spanId")?.as_str()?.trim().to_owned(),
    })
    .filter(|span| !span.name.is_empty() && !span.trace_id.is_empty() && !span.span_id.is_empty())
}

fn collect_log_events(
    record: &Value,
    span: &SpanOccurrence,
    output: &mut Vec<LogEvent>,
    counts: &mut BTreeMap<String, usize>,
) {
    let Some(events) = record.get("events").and_then(Value::as_array) else {
        return;
    };
    for event in events {
        let Some(level) = event
            .pointer("/attributes/effect.logLevel")
            .and_then(Value::as_str)
        else {
            continue;
        };
        *counts.entry(level.to_owned()).or_default() += 1;
        if !matches!(
            level.to_ascii_lowercase().as_str(),
            "warning" | "warn" | "error" | "fatal"
        ) {
            continue;
        }
        output.push(LogEvent {
            span_name: span.name.clone(),
            level: level.to_owned(),
            message: event
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Log event")
                .to_owned(),
            seen_at_ns: parse_nanos(event.get("timeUnixNano")).unwrap_or(span.ended_at_ns),
            trace_id: span.trace_id.clone(),
            span_id: span.span_id.clone(),
        });
    }
}

fn error_summary(error: &Value) -> String {
    let candidate = ["detail", "message", "cause"]
        .into_iter()
        .find_map(|key| error.get(key).and_then(Value::as_str))
        .or_else(|| error.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| error.to_string());
    candidate.chars().take(MAX_CAUSE_CHARS).collect()
}

pub(crate) fn redact_sensitive_text(input: &str) -> String {
    input
        .lines()
        .map(redact_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn redact_sensitive_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let value = if is_sensitive_key(key) {
                        Value::String("[REDACTED]".to_owned())
                    } else {
                        redact_sensitive_value(value)
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(redact_sensitive_value).collect()),
        Value::String(value) => Value::String(redact_sensitive_text(value)),
        _ => value.clone(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "authorization"
            | "proxyauthorization"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "githubtoken"
            | "apikey"
            | "password"
            | "secret"
            | "clientsecret"
            | "credential"
            | "cookie"
            | "setcookie"
    )
}

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    for marker in [
        "authorization:",
        "proxy-authorization:",
        "bearer ",
        "access_token=",
        "refresh_token=",
        "github_token=",
        "token=",
        "api_key=",
        "apikey=",
        "password=",
        "secret=",
        "\"token\":",
        "\"access_token\":",
        "\"refresh_token\":",
        "\"api_key\":",
        "\"password\":",
        "\"secret\":",
    ] {
        if let Some(index) = lower.find(marker) {
            let end = index + marker.len();
            return format!("{} [REDACTED]", line[..end].trim_end());
        }
    }
    redact_url_credentials(line)
}

fn redact_url_credentials(input: &str) -> String {
    let mut output = input.to_owned();
    let mut search_from = 0;
    while let Some(relative_scheme) = output[search_from..].find("://") {
        let authority_start = search_from + relative_scheme + 3;
        let authority_end = output[authority_start..]
            .find(['/', ' ', '\t', '\r', '\n'])
            .map_or(output.len(), |offset| authority_start + offset);
        let Some(at_offset) = output[authority_start..authority_end].rfind('@') else {
            search_from = authority_end;
            if search_from >= output.len() {
                break;
            }
            continue;
        };
        let at = authority_start + at_offset;
        output.replace_range(authority_start..at, "[REDACTED]");
        search_from = authority_start + "[REDACTED]@".len();
    }
    output
}

fn rotate(path: &Path, max_files: usize) -> io::Result<()> {
    if max_files == 0 {
        if path.exists() {
            fs::remove_file(path)?;
        }
        return Ok(());
    }
    let oldest = rotated_path(path, max_files);
    if oldest.exists() {
        fs::remove_file(oldest)?;
    }
    for index in (1..max_files).rev() {
        let source = rotated_path(path, index);
        if source.exists() {
            fs::rename(source, rotated_path(path, index + 1))?;
        }
    }
    if path.exists() {
        fs::rename(path, rotated_path(path, 1))?;
    }
    Ok(())
}

fn rotated_paths(path: &Path, max_files: usize) -> Vec<PathBuf> {
    (1..=max_files)
        .rev()
        .map(|index| rotated_path(path, index))
        .chain(std::iter::once(path.to_path_buf()))
        .collect()
}

fn rotated_path(path: &Path, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.{index}", path.to_string_lossy()))
}

fn span_wire(span: SpanOccurrence) -> Value {
    json!({
        "name": span.name,
        "durationMs": span.duration_ms,
        "endedAt": format_time(span.ended_at_ns),
        "traceId": span.trace_id,
        "spanId": span.span_id,
    })
}

fn parse_nanos(value: Option<&Value>) -> Option<i128> {
    value?.as_str()?.parse().ok()
}

fn format_time(nanos: i128) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

fn effect_none() -> Value {
    json!({ "_id": "Option", "_tag": "None" })
}

fn effect_some(value: Value) -> Value {
    json!({ "_id": "Option", "_tag": "Some", "value": value })
}

fn non_empty<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.trim().is_empty() {
        fallback
    } else {
        value
    }
}

fn bounded_event_name(name: &str) -> String {
    non_empty(name.trim(), "native.event")
        .chars()
        .take(MAX_EVENT_NAME_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_activity_event_is_bounded_redacted_and_aggregated() {
        let temp = tempfile::tempdir().expect("trace directory");
        let path = temp.path().join("server.trace.ndjson");
        let store = TraceDiagnosticsStore::new(path.clone());

        store
            .record_event(
                &format!("agent_activity_disabled{}", "x".repeat(256)),
                json!({
                    "enabled": false,
                    "settingsGeneration": 4,
                    "observationGeneration": 7,
                    "closedSubscriptions": 2,
                    "stoppedObservers": 3,
                    "dormantObservers": 1,
                    "resumedObservers": 0,
                    "failedObservers": 0,
                    "finalizedRecords": 5,
                    "durationMs": 12,
                    "authorization": "Bearer should-not-survive",
                }),
            )
            .expect("record effective state");

        let diagnostics = store.read();
        assert_eq!(diagnostics["recordCount"], 1);
        assert_eq!(diagnostics["failureCount"], 0);
        let record: Value = serde_json::from_str(
            fs::read_to_string(path)
                .expect("trace file")
                .lines()
                .next()
                .expect("trace record"),
        )
        .expect("valid trace record");
        assert_eq!(record["type"], "native-span");
        assert_eq!(record["exit"]["_tag"], "Success");
        assert_eq!(
            record["events"][0]["attributes"]["authorization"],
            "[REDACTED]"
        );
        assert_eq!(record["events"][0]["attributes"]["finalizedRecords"], 5);
        assert!(record["name"].as_str().expect("bounded event name").len() <= 128);
        assert!(!record.to_string().contains("should-not-survive"));
    }

    #[test]
    fn agent_activity_event_rejects_non_object_attributes() {
        let temp = tempfile::tempdir().expect("trace directory");
        let store = TraceDiagnosticsStore::new(temp.path().join("server.trace.ndjson"));

        let error = store
            .record_event("agent_activity_disabled", json!(false))
            .expect_err("non-object attributes are rejected");

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(store.read()["recordCount"], 0);
    }

    #[test]
    fn unit_build_covers_file_rotation_and_helpers() {
        let temp = tempfile::tempdir().expect("trace directory");
        let path = temp.path().join("server.trace.ndjson");
        let store = TraceDiagnosticsStore::with_limits(path.clone(), 2, 320);
        store
            .record_failure(
                "",
                &json!({"message":"https://user:password@example.test/path"}),
            )
            .expect("native failure");
        store
            .record_failure("unit.final", &json!({"detail":"final failure"}))
            .expect("rotating failure");

        assert!(path.exists());
        assert!(rotated_path(&path, 1).exists());
        let diagnostics = store.read();
        assert!(diagnostics["recordCount"].as_u64().unwrap_or_default() >= 1);
        assert!(diagnostics["scannedFilePaths"].as_array().is_some());
        assert!(!diagnostics.to_string().contains("password"));

        let zero_rotation = temp.path().join("zero.ndjson");
        fs::write(&zero_rotation, "record").expect("rotation fixture");
        rotate(&zero_rotation, 0).expect("zero-file rotation");
        assert!(!zero_rotation.exists());
        assert_eq!(non_empty(" ", "fallback"), "fallback");
        assert_eq!(parse_nanos(Some(&json!(1))), None);
        assert_eq!(effect_none()["_tag"], "None");
        assert_eq!(effect_some(json!(1))["value"], 1);
    }
}
