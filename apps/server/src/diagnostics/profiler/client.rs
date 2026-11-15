//! Client responsiveness reports (Decisions 7 and 8).
//!
//! `server.reportProfilerClientBatch` crosses a trust boundary. The whole batch is bounded and
//! validated before anything is derived from it, and an invalid one is refused with a typed
//! error while nothing is written. Slow requests are joined to the server's own timing by
//! correlation ID only: a record without a join entry has an unknown slow part, never a
//! guessed one, because matching by method and time can blame the wrong request.

use std::{
    collections::HashMap,
    io,
    sync::{LazyLock, Mutex, PoisonError},
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    cite, emit_from,
    findings::{FindingInput, Severity},
    is_enabled,
    latency::{
        BUCKET_GROWTH, BUCKETS, JoinEntry, Tier, global_latency, is_background, is_long_running,
        judge,
    },
    record_finding,
    redact::redact_message,
    store::EventId,
};
use crate::rpc::ACTIVE_RPC_METHODS;

const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_RECORDS: usize = 64;
const MAX_HISTOGRAMS: usize = 64;
const MAX_RENDER_ERRORS: usize = 8;
const MAX_COMPONENT_NAMES: usize = 12;
const MAX_NAME_BYTES: usize = 64;
const MAX_ROUTE_BYTES: usize = 256;
/// React's error codes are below 1000 today.
const MAX_REACT_ERROR_CODE: u32 = 9_999;
const MAX_METHOD_BYTES: usize = 128;
const MAX_VERSION_BYTES: usize = 64;
const MAX_ID_BYTES: usize = 64;
const MAX_CAPABILITIES: usize = 32;
const MAX_CAPABILITY_BYTES: usize = 64;
/// A longer sample spans a sleep; the collector drops those itself.
const MAX_SAMPLE_MS: f64 = 3_600_000.0;
const MAX_WINDOW_MS: f64 = 600_000.0;
const MAX_COUNT: u32 = 1_000_000;
/// `performance.now()` of a page open for 30 years.
const MAX_TIMESTAMP_MS: f64 = 1e12;
const MAX_HEAP_BYTES: f64 = (1u64 << 40) as f64;
const STALL_FINDING_MS: f64 = 1_000.0;
const INTERACTION_FINDING_MS: f64 = 500.0;
/// The source of client findings. Events name their client: `client:<clientId>`.
const SOURCE: &str = "client";
/// The collector sends every 10 s; a client sending faster is refused the extra batches, which
/// bounds what one client can write.
const MIN_BATCH_INTERVAL: Duration = Duration::from_secs(5);
/// Client ids whose last batch is remembered; past this, the least recently seen is forgotten.
const MAX_PACED_CLIENTS: usize = 256;

static PACER: LazyLock<Mutex<BatchPacer>> = LazyLock::new(Default::default);

/// Handles one batch: `{ "accepted": true }` once it is recorded, `{ "accepted": false }`
/// while the profiler is off, `{ "accepted": false, "reason": "too-frequent" }`, with nothing
/// written, for a client's batch within 5 s of its previous one, and a
/// `ProfilerClientBatchTooLarge` or `ProfilerClientBatchInvalid` error, with nothing written,
/// for a batch over its limits or with an invalid field. Validation comes first, so a bad
/// batch is refused whatever the toggle.
pub fn ingest_client_batch(batch: Value, env_id: &str) -> Result<Value, Value> {
    let batch = validate(&batch)?;
    if !is_enabled() {
        return Ok(json!({ "accepted": false }));
    }
    let admitted = PACER
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .admit(&batch.client_id, Instant::now());
    if !admitted {
        return Ok(json!({ "accepted": false, "reason": "too-frequent" }));
    }
    let book = global_latency();
    let analysis = analyze(&batch, env_id, |id| book.find_join(id));
    let source = format!("{SOURCE}:{}", batch.client_id);
    let event_ids: Vec<Option<EventId>> = analysis
        .events
        .into_iter()
        .map(|(kind, payload)| emit_from(source.clone(), kind, payload))
        .collect();
    for (finding, event) in analysis.findings {
        let event_id = event_ids.get(event).copied().flatten();
        record_finding(FindingInput {
            evidence: cite(finding.evidence, event_id),
            ..finding
        });
    }
    Ok(json!({ "accepted": true }))
}

/// When each client's last admitted batch arrived, for the minimum batch interval.
#[derive(Default)]
struct BatchPacer {
    last: HashMap<String, Instant>,
}

impl BatchPacer {
    /// Admits a batch from `client_id` unless its previous admitted batch is under 5 s old.
    // ponytail: evicting scans all 256 entries; fine at one batch per client per 5 s.
    fn admit(&mut self, client_id: &str, now: Instant) -> bool {
        if let Some(last) = self.last.get(client_id) {
            if now.saturating_duration_since(*last) < MIN_BATCH_INTERVAL {
                return false;
            }
        } else if self.last.len() >= MAX_PACED_CLIENTS
            && let Some(stalest) = self
                .last
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(id, _)| id.clone())
        {
            self.last.remove(&stalest);
        }
        self.last.insert(client_id.to_owned(), now);
        true
    }
}

/// `ProfilerClientBatch` from `packages/contracts/src/profiler.ts`. Unknown fields are
/// ignored, so a newer client still reports to an older server.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientBatch {
    client_id: String,
    capabilities: Vec<String>,
    window_ms: f64,
    records: Vec<ClientRecord>,
    histograms: Vec<ClientHistogram>,
    stalls: Stalls,
    interactions: Interactions,
    js_heap_bytes: Option<f64>,
    /// The client's own BiBCode version (#98): in browser or remote mode it can differ from
    /// the server's. Older clients send none.
    #[serde(default)]
    app_version: Option<String>,
    /// Render errors the client's error screen caught (R51). Older clients send none.
    #[serde(default)]
    render_errors: Vec<RenderError>,
}

/// Names and codes only. Unknown fields, such as a message a client should never send, are
/// not deserialized, so they never reach an event.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderError {
    error_type: String,
    react_error_code: Option<u32>,
    component_names: Vec<String>,
    route_pattern: Option<String>,
    fingerprint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientRecord {
    correlation_id: Option<String>,
    method: String,
    rtt_ms: f64,
    render_ms: Option<f64>,
    started_at_ms: f64,
}

#[derive(Deserialize)]
struct ClientHistogram {
    method: String,
    /// `(bucket, count)` pairs; see `latency::bucket_of`.
    buckets: Vec<(u32, u32)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stalls {
    count: u32,
    total_ms: f64,
    max_ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Interactions {
    count: u32,
    max_ms: f64,
}

fn validate(batch: &Value) -> Result<ClientBatch, Value> {
    if serde_json::to_writer(ByteBudget(MAX_PAYLOAD_BYTES), batch).is_err() {
        return Err(too_large("The batch is over 64 KiB."));
    }
    let length = |field: &str| {
        batch
            .get(field)
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    };
    if length("records") > MAX_RECORDS
        || length("histograms") > MAX_HISTOGRAMS
        || length("renderErrors") > MAX_RENDER_ERRORS
    {
        return Err(too_large(
            "The batch has more than 64 records, 64 histograms or 8 render errors.",
        ));
    }
    let batch = ClientBatch::deserialize(batch).map_err(|error| invalid(&error.to_string()))?;
    batch.check().map_err(invalid)?;
    Ok(batch)
}

/// Counts serialized bytes and fails at the cap, so an oversized payload is never copied.
struct ByteBudget(usize);

impl io::Write for ByteBudget {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_sub(bytes.len())
            .ok_or_else(|| io::Error::other("over the byte budget"))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn too_large(message: &str) -> Value {
    json!({ "_tag": "ProfilerClientBatchTooLarge", "message": message })
}

fn invalid(message: &str) -> Value {
    json!({ "_tag": "ProfilerClientBatchInvalid", "message": message })
}

/// Whether `value` is a number in `0..=max`; NaN and infinities are not.
fn bounded(value: f64, max: f64) -> bool {
    (0.0..=max).contains(&value)
}

fn ensure(ok: bool, message: &'static str) -> Result<(), &'static str> {
    if ok { Ok(()) } else { Err(message) }
}

impl ClientBatch {
    /// What the contract's schema leaves open: string lengths, and number ranges.
    fn check(&self) -> Result<(), &'static str> {
        ensure(
            self.client_id.len() <= MAX_ID_BYTES,
            "clientId is over 64 bytes.",
        )?;
        ensure(
            self.capabilities.len() <= MAX_CAPABILITIES
                && self
                    .capabilities
                    .iter()
                    .all(|capability| capability.len() <= MAX_CAPABILITY_BYTES),
            "capabilities holds over 32 entries or an entry over 64 bytes.",
        )?;
        ensure(
            bounded(self.window_ms, MAX_WINDOW_MS),
            "windowMs is outside 0 to 10 minutes.",
        )?;
        for record in &self.records {
            ensure(
                record.method.len() <= MAX_METHOD_BYTES,
                "A record's method is over 128 bytes.",
            )?;
            ensure(
                record
                    .correlation_id
                    .as_ref()
                    .is_none_or(|id| id.len() <= MAX_ID_BYTES),
                "A record's correlationId is over 64 bytes.",
            )?;
            ensure(
                bounded(record.rtt_ms, MAX_SAMPLE_MS)
                    && record.render_ms.is_none_or(|ms| bounded(ms, MAX_SAMPLE_MS))
                    && bounded(record.started_at_ms, MAX_TIMESTAMP_MS),
                "A record's duration is outside 0 to 1 hour, or its start is invalid.",
            )?;
        }
        for histogram in &self.histograms {
            ensure(
                histogram.method.len() <= MAX_METHOD_BYTES,
                "A histogram's method is over 128 bytes.",
            )?;
            ensure(
                histogram.buckets.len() <= BUCKETS
                    && histogram
                        .buckets
                        .iter()
                        .all(|&(bucket, count)| (bucket as usize) < BUCKETS && count <= MAX_COUNT),
                "A histogram bucket is out of range.",
            )?;
        }
        ensure(
            self.stalls.count <= MAX_COUNT
                && bounded(self.stalls.total_ms, MAX_SAMPLE_MS)
                && bounded(self.stalls.max_ms, MAX_SAMPLE_MS)
                && self.interactions.count <= MAX_COUNT
                && bounded(self.interactions.max_ms, MAX_SAMPLE_MS),
            "stalls or interactions are out of range.",
        )?;
        ensure(
            self.js_heap_bytes
                .is_none_or(|bytes| bounded(bytes, MAX_HEAP_BYTES)),
            "jsHeapBytes is out of range.",
        )?;
        ensure(
            self.app_version
                .as_ref()
                .is_none_or(|version| version.len() <= MAX_VERSION_BYTES),
            "appVersion is over 64 bytes.",
        )?;
        for error in &self.render_errors {
            ensure(
                error.component_names.len() <= MAX_COMPONENT_NAMES,
                "A render error has more than 12 component names.",
            )?;
            ensure(
                error
                    .react_error_code
                    .is_none_or(|code| code <= MAX_REACT_ERROR_CODE)
                    && error.fingerprint.len() <= 16
                    && !error.fingerprint.is_empty()
                    && error.fingerprint.bytes().all(|b| b.is_ascii_hexdigit()),
                "A render error's code or fingerprint is invalid.",
            )?;
        }
        Ok(())
    }
}

/// The error types a record may name; any other is [`OTHER_ERROR_TYPE`]. The web collector
/// applies the same set, identifier shape and placeholder (`clientCollector.ts`).
const ERROR_TYPES: [&str; 9] = [
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "EvalError",
    "URIError",
    "AggregateError",
    "DOMException",
];
const OTHER_ERROR_TYPE: &str = "Other";
const UNNAMED_COMPONENT: &str = "Unnamed";
/// The first segments of the web app's route ids (`apps/web/src/routeTree.gen.ts`): a route
/// under any other is not the app's, so it is recorded as unknown. "" is the index route.
const ROUTE_ROOTS: [&str; 5] = ["", "_chat", "settings", "pair", "agents"];

/// A plain identifier: letters, digits, `_` and `$`, so never a path, a URL or a sentence.
fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    value.len() <= MAX_NAME_BYTES
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// A route id of the web app, such as `/_chat/$environmentId/$threadId`: it starts at one of
/// [`ROUTE_ROOTS`], and each further segment is a `$parameter` or a lowercase word without
/// digits, so a real path's ids are refused.
fn is_route_pattern(value: &str) -> bool {
    let word = |segment: &str| {
        let segment = segment.strip_prefix('_').unwrap_or(segment);
        segment
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase())
            && segment.chars().all(|c| c.is_ascii_lowercase() || c == '-')
    };
    let parameter = |segment: &str| {
        segment
            .strip_prefix('$')
            .is_some_and(|name| name.is_empty() || is_identifier(name))
    };
    if value == "__root__" {
        return true;
    }
    let Some(rest) = value.strip_prefix('/') else {
        return false;
    };
    let mut segments = rest.split('/');
    value.len() <= MAX_ROUTE_BYTES
        && segments
            .next()
            .is_some_and(|root| ROUTE_ROOTS.contains(&root))
        && segments.all(|segment| segment.is_empty() || word(segment) || parameter(segment))
}

struct Analysis {
    events: Vec<(&'static str, Value)>,
    /// Each finding with the index in `events` of the event that explains it.
    findings: Vec<(FindingInput, usize)>,
}

fn is_known(method: &str) -> bool {
    ACTIVE_RPC_METHODS.iter().any(|spec| spec.name == method)
}

/// The events and findings for a validated batch. Records and histograms of methods the
/// server does not serve are dropped and counted. A request record becomes an `rpc.slow`
/// finding over the absolute tiers, unless its method waits on external work.
fn analyze(
    batch: &ClientBatch,
    env_id: &str,
    join: impl Fn(&str) -> Option<JoinEntry>,
) -> Analysis {
    let mut events = Vec::new();
    let mut findings = Vec::new();
    let mut dropped = 0usize;
    for record in &batch.records {
        if !is_known(&record.method) {
            dropped += 1;
            continue;
        }
        // An ID joined to another method was reused, so it is not this request.
        let joined = record
            .correlation_id
            .as_deref()
            .and_then(&join)
            .filter(|entry| entry.method == record.method);
        let request = RequestTiming::of(record, joined.as_ref());
        let payload = request.payload(batch, record, env_id);
        let tier = judge(request.total_ms, None, 0, !is_background(&record.method));
        if tier >= Tier::Warn && !is_long_running(&record.method) {
            let finding = FindingInput {
                kind: "rpc.slow",
                severity: if tier == Tier::Severe {
                    Severity::Error
                } else {
                    Severity::Warn
                },
                source: SOURCE.to_owned(),
                fingerprint_fields: vec![record.method.clone(), request.slow_part.to_owned()],
                title: format!("{} took {:.1} s", record.method, request.total_ms / 1000.0),
                summary: request.summary(record),
                evidence: payload.clone(),
            };
            findings.push((finding, events.len()));
        }
        events.push(("client.request", payload));
    }
    let mut histograms = Vec::new();
    for histogram in &batch.histograms {
        if is_known(&histogram.method) {
            histograms.push(json!({ "method": histogram.method, "buckets": histogram.buckets }));
        } else {
            dropped += 1;
        }
    }
    let stalls = json!({
        "count": batch.stalls.count,
        "totalMs": batch.stalls.total_ms,
        "maxMs": batch.stalls.max_ms,
    });
    let interactions = json!({
        "count": batch.interactions.count,
        "maxMs": batch.interactions.max_ms,
    });
    events.push((
        "client.batch",
        json!({
            "envId": env_id,
            "clientId": batch.client_id,
            "capabilities": batch.capabilities,
            "windowMs": batch.window_ms,
            "records": batch.records.len(),
            "droppedUnknownMethods": dropped,
            "bucketGrowth": BUCKET_GROWTH,
            "histograms": histograms,
            "stalls": stalls,
            "interactions": interactions,
            "jsHeapBytes": batch.js_heap_bytes,
            "appVersion": batch.app_version,
        }),
    ));
    // Client-wide findings cite the batch event, which carries their figures.
    let batch_event = events.len() - 1;
    let window_secs = batch.window_ms / 1000.0;
    if batch.stalls.total_ms > STALL_FINDING_MS {
        let finding = FindingInput {
            kind: "client.stall",
            severity: Severity::Warn,
            source: SOURCE.to_owned(),
            fingerprint_fields: vec![SOURCE.to_owned()],
            title: format!(
                "The interface stalled for {:.1} s",
                batch.stalls.total_ms / 1000.0
            ),
            summary: format!(
                "{count} main-thread stalls added up to {total:.0} ms within {window_secs:.0} s; \
                 the longest lasted {max:.0} ms.",
                count = batch.stalls.count,
                total = batch.stalls.total_ms,
                max = batch.stalls.max_ms,
            ),
            evidence: json!({
                "envId": env_id,
                "clientId": batch.client_id,
                "capabilities": batch.capabilities,
                "windowMs": batch.window_ms,
                "stalls": stalls,
            }),
        };
        findings.push((finding, batch_event));
    }
    if batch.interactions.max_ms > INTERACTION_FINDING_MS {
        let finding = FindingInput {
            kind: "client.interaction",
            severity: Severity::Warn,
            source: SOURCE.to_owned(),
            fingerprint_fields: vec![SOURCE.to_owned()],
            title: format!(
                "An interaction took {:.0} ms to paint",
                batch.interactions.max_ms
            ),
            summary: format!(
                "The slowest of {count} slow interactions within {window_secs:.0} s took \
                 {max:.0} ms from input to the next paint.",
                count = batch.interactions.count,
                max = batch.interactions.max_ms,
            ),
            evidence: json!({
                "envId": env_id,
                "clientId": batch.client_id,
                "capabilities": batch.capabilities,
                "windowMs": batch.window_ms,
                "interactions": interactions,
            }),
        };
        findings.push((finding, batch_event));
    }
    for error in &batch.render_errors {
        let (payload, finding) = render_error(batch, error);
        findings.push((finding, events.len()));
        events.push(("client.render-error", payload));
    }
    Analysis { events, findings }
}

/// One caught render error's event and finding. The server enforces the shapes again: an
/// error type outside the closed set becomes "Other", a component name that is not a plain
/// identifier becomes "Unnamed", and a route that is not one of the app's route ids becomes
/// `null`; what is left still passes the redaction helper, as every profiler record does.
/// The finding groups by type, code, route and component names: the packaged app's
/// component names are minified, so the route keeps different crashes apart. The client's
/// hash is shown, not trusted.
fn render_error(batch: &ClientBatch, error: &RenderError) -> (Value, FindingInput) {
    let error_type = redact_message(if ERROR_TYPES.contains(&error.error_type.as_str()) {
        &error.error_type
    } else {
        OTHER_ERROR_TYPE
    });
    let names: Vec<String> = error
        .component_names
        .iter()
        .map(|name| {
            redact_message(if is_identifier(name) {
                name
            } else {
                UNNAMED_COMPONENT
            })
        })
        .collect();
    let route = error
        .route_pattern
        .as_deref()
        .filter(|route| is_route_pattern(route))
        .map(redact_message);
    let payload = json!({
        "clientId": batch.client_id,
        "errorType": error_type,
        "reactErrorCode": error.react_error_code,
        "componentNames": names,
        "routePattern": route,
        "fingerprint": redact_message(&error.fingerprint),
    });
    let code = error
        .react_error_code
        .map_or_else(String::new, |code| code.to_string());
    let react = error
        .react_error_code
        .map_or_else(String::new, |code| format!(" (React error #{code})"));
    let fingerprint_fields = [error_type.clone(), code, route.clone().unwrap_or_default()]
        .into_iter()
        .chain(names.iter().cloned())
        .collect();
    let finding = FindingInput {
        kind: "client.render-error",
        severity: Severity::Error,
        source: SOURCE.to_owned(),
        fingerprint_fields,
        title: format!("The error screen caught {error_type}{react}"),
        summary: format!(
            "The app showed \"Something went wrong.\" for {error_type}{react} in {component} \
             on {route}.",
            component = names.first().map_or("an unnamed component", String::as_str),
            route = route.as_deref().unwrap_or("an unknown route"),
        ),
        evidence: payload.clone(),
    };
    (payload, finding)
}

/// Where one request's time went, as the client saw it until the response was painted.
struct RequestTiming {
    server_ms: Option<f64>,
    /// The round trip minus the server's handler time. The join log has no queue time
    /// (`JoinEntry::queued_ms` is always 0, meaning unknown), so queueing counts here.
    network_ms: Option<f64>,
    total_ms: f64,
    slow_part: &'static str,
}

impl RequestTiming {
    fn of(record: &ClientRecord, joined: Option<&JoinEntry>) -> Self {
        let server_ms = joined.map(|entry| entry.server_ms);
        let network_ms = server_ms.map(|server| (record.rtt_ms - server).max(0.0));
        let slow_part = match (server_ms, network_ms) {
            (Some(server), Some(network)) => slowest([
                ("server", server),
                ("network", network),
                ("render", record.render_ms.unwrap_or(0.0)),
            ]),
            _ => "unknown",
        };
        Self {
            server_ms,
            network_ms,
            total_ms: record.rtt_ms + record.render_ms.unwrap_or(0.0),
            slow_part,
        }
    }

    fn payload(&self, batch: &ClientBatch, record: &ClientRecord, env_id: &str) -> Value {
        json!({
            "envId": env_id,
            "clientId": batch.client_id,
            "method": record.method,
            "correlationId": record.correlation_id,
            "joinedBy": if self.server_ms.is_some() { "correlationId" } else { "none" },
            "rttMs": record.rtt_ms,
            "renderMs": record.render_ms,
            "serverMs": self.server_ms,
            "networkMs": self.network_ms,
            "queuedMs": null,
            "totalMs": self.total_ms,
            "slowPart": self.slow_part,
        })
    }

    fn summary(&self, record: &ClientRecord) -> String {
        let render = record
            .render_ms
            .map_or_else(|| "not measured".to_owned(), |ms| format!("{ms:.0} ms"));
        let total = self.total_ms;
        match (self.server_ms, self.network_ms) {
            (Some(server), Some(network)) => format!(
                "The client waited {total:.0} ms: server {server:.0} ms · network {network:.0} ms \
                 · render {render}. Network includes any time queued on the server."
            ),
            _ => format!(
                "The client waited {total:.0} ms: round trip {rtt:.0} ms · render {render}. The \
                 server's timing for this request was not found, so the slow part is unknown.",
                rtt = record.rtt_ms,
            ),
        }
    }
}

/// The name of the largest part; the first one wins a tie.
fn slowest(parts: [(&'static str, f64); 3]) -> &'static str {
    parts
        .into_iter()
        .fold(
            parts[0],
            |slowest, part| {
                if part.1 > slowest.1 { part } else { slowest }
            },
        )
        .0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::profiler::latency::LatencyBook;

    const SLOW: &str = "orchestration.dispatchCommand";

    fn record(correlation_id: Option<&str>, method: &str, rtt_ms: f64, render_ms: f64) -> Value {
        json!({
            "correlationId": correlation_id,
            "method": method,
            "rttMs": rtt_ms,
            "renderMs": render_ms,
            "startedAtMs": 1_000.0,
        })
    }

    fn batch(records: Vec<Value>) -> Value {
        json!({
            "clientId": "c1",
            "capabilities": ["heartbeat"],
            "windowMs": 10_000,
            "records": records,
            "histograms": [{ "method": "server.getConfig", "buckets": [[3, 7]] }],
            "stalls": { "count": 0, "totalMs": 0, "maxMs": 0 },
            "interactions": { "count": 0, "maxMs": 0 },
            "jsHeapBytes": null,
        })
    }

    fn analyze_with(book: &LatencyBook, batch: &Value) -> Analysis {
        let batch = validate(batch).expect("a valid batch");
        analyze(&batch, "env-1", |id| book.find_join(id))
    }

    fn tag(error: &Value) -> &str {
        error["_tag"].as_str().unwrap_or_default()
    }

    fn events<'a>(analysis: &'a Analysis, kind: &str) -> Vec<&'a Value> {
        analysis
            .events
            .iter()
            .filter(|(event, _)| *event == kind)
            .map(|(_, payload)| payload)
            .collect()
    }

    #[test]
    fn a_client_sends_at_most_one_batch_per_five_seconds() {
        let mut pacer = BatchPacer::default();
        let start = Instant::now();
        assert!(pacer.admit("c1", start));
        assert!(!pacer.admit("c1", start + Duration::from_millis(4_999)));
        assert!(pacer.admit("c2", start), "each client has its own interval");
        assert!(pacer.admit("c1", start + MIN_BATCH_INTERVAL));
        // A refused batch does not restart the interval.
        assert!(!pacer.admit("c1", start + Duration::from_secs(9)));
        assert!(pacer.admit("c1", start + Duration::from_secs(10)));
    }

    #[test]
    fn the_pacer_forgets_the_least_recently_seen_client_past_256() {
        let mut pacer = BatchPacer::default();
        let start = Instant::now();
        for n in 0..MAX_PACED_CLIENTS {
            let at = start + Duration::from_millis(n as u64);
            assert!(pacer.admit(&format!("c{n}"), at));
        }
        let later = start + Duration::from_secs(1);
        assert!(pacer.admit("newcomer", later));
        assert_eq!(pacer.last.len(), MAX_PACED_CLIENTS);
        assert!(!pacer.last.contains_key("c0"), "the stalest client went");
        assert!(
            !pacer.admit("c1", later),
            "a remembered client is still paced"
        );
    }

    #[test]
    fn a_batch_over_any_limit_is_rejected_as_too_large_before_anything_is_read() {
        let too_many_records = batch(vec![record(None, SLOW, 300.0, 10.0); 65]);
        let error = validate(&too_many_records).err().expect("rejected");
        assert_eq!(tag(&error), "ProfilerClientBatchTooLarge");
        // The handler returns before the enabled check, so nothing is emitted or recorded.
        let error = ingest_client_batch(too_many_records, "env-1").expect_err("rejected");
        assert_eq!(tag(&error), "ProfilerClientBatchTooLarge");

        let mut too_many_histograms = batch(Vec::new());
        too_many_histograms["histograms"] = json!(vec![
            json!({ "method": "server.getConfig", "buckets": [] });
            65
        ]);
        assert_eq!(
            tag(&validate(&too_many_histograms).err().expect("rejected")),
            "ProfilerClientBatchTooLarge"
        );

        let mut oversized = batch(Vec::new());
        oversized["capabilities"] = json!(["x".repeat(64 * 1024)]);
        assert_eq!(
            tag(&validate(&oversized).err().expect("rejected")),
            "ProfilerClientBatchTooLarge",
            "the byte cap is checked before any field"
        );
    }

    #[test]
    fn a_joined_record_names_its_largest_part() {
        let book = LatencyBook::default();
        book.joins
            .lock()
            .expect("join log")
            .push("c1:7".into(), SLOW.into(), 900.0, 0.0);
        let analysis = analyze_with(
            &book,
            &batch(vec![record(Some("c1:7"), SLOW, 1_500.0, 50.0)]),
        );

        assert_eq!(analysis.findings.len(), 1);
        let (finding, event) = &analysis.findings[0];
        assert_eq!(finding.kind, "rpc.slow");
        assert_eq!(
            analysis.events[*event].0, "client.request",
            "the finding cites its request's event"
        );
        assert_eq!(finding.source, "client");
        assert_eq!(finding.severity, Severity::Warn);
        assert!(finding.title.starts_with(SLOW), "{}", finding.title);
        assert!(
            finding
                .summary
                .contains("server 900 ms · network 600 ms · render 50 ms"),
            "{}",
            finding.summary
        );
        assert_eq!(finding.fingerprint_fields, [SLOW, "server"]);
        assert_eq!(finding.evidence["joinedBy"], "correlationId");
        assert_eq!(
            finding.evidence["queuedMs"],
            Value::Null,
            "queue time is unknown"
        );

        let requests = events(&analysis, "client.request");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["serverMs"], 900.0);
        assert_eq!(requests[0]["networkMs"], 600.0);
        assert_eq!(requests[0]["slowPart"], "server");
        assert_eq!(requests[0]["envId"], "env-1");
    }

    #[test]
    fn a_record_without_a_join_entry_is_never_guessed() {
        let book = LatencyBook::default();
        // Same method, but another request: a time-based guess could pick it.
        book.joins
            .lock()
            .expect("join log")
            .push("c1:6".into(), SLOW.into(), 1_400.0, 0.0);
        // Same ID, but another method: a reused ID, not this request.
        book.joins.lock().expect("join log").push(
            "c1:9".into(),
            "server.getConfig".into(),
            1_400.0,
            0.0,
        );
        let analysis = analyze_with(
            &book,
            &batch(vec![
                record(Some("c1:8"), SLOW, 1_500.0, 50.0),
                record(Some("c1:9"), SLOW, 1_500.0, 50.0),
                record(None, SLOW, 1_500.0, 50.0),
            ]),
        );

        let requests = events(&analysis, "client.request");
        assert_eq!(requests.len(), 3);
        for request in requests {
            assert_eq!(request["joinedBy"], "none");
            assert_eq!(request["slowPart"], "unknown");
            assert_eq!(request["serverMs"], Value::Null);
        }
        assert_eq!(analysis.findings.len(), 3);
        assert!(
            analysis
                .findings
                .iter()
                .all(|(finding, _)| finding.fingerprint_fields == [SLOW, "unknown"])
        );
    }

    #[test]
    fn only_absolute_tiers_of_non_external_methods_raise_findings() {
        let book = LatencyBook::default();
        let analysis = analyze_with(
            &book,
            &batch(vec![
                record(None, SLOW, 300.0, 10.0),
                record(None, "vcs.clone", 12_000.0, 10.0),
                record(None, "server.getConfig", 10_500.0, 10.0),
            ]),
        );
        assert_eq!(events(&analysis, "client.request").len(), 3, "all logged");
        assert_eq!(analysis.findings.len(), 1);
        assert_eq!(
            analysis.findings[0].0.fingerprint_fields[0],
            "server.getConfig"
        );
        assert_eq!(analysis.findings[0].0.severity, Severity::Error);
    }

    /// #98: the client's own version goes with its batch; an older client sends none.
    #[test]
    fn a_batch_carries_the_clients_version() {
        let book = LatencyBook::default();
        let older = analyze_with(&book, &batch(Vec::new()));
        assert!(events(&older, "client.batch")[0]["appVersion"].is_null());

        let mut newer = batch(Vec::new());
        newer["appVersion"] = json!("0.9.3");
        let analysis = analyze_with(&book, &newer);
        assert_eq!(events(&analysis, "client.batch")[0]["appVersion"], "0.9.3");

        newer["appVersion"] = json!("9".repeat(65));
        assert!(validate(&newer).is_err(), "a version over 64 bytes");
    }

    #[test]
    fn stalls_and_slow_interactions_raise_client_findings_over_their_thresholds() {
        let book = LatencyBook::default();
        let mut quiet = batch(Vec::new());
        quiet["stalls"] = json!({ "count": 4, "totalMs": 1_000, "maxMs": 400 });
        quiet["interactions"] = json!({ "count": 2, "maxMs": 500 });
        assert!(analyze_with(&book, &quiet).findings.is_empty());

        let mut janky = batch(Vec::new());
        janky["stalls"] = json!({ "count": 5, "totalMs": 1_200, "maxMs": 400 });
        janky["interactions"] = json!({ "count": 2, "maxMs": 620 });
        let analysis = analyze_with(&book, &janky);
        let kinds: Vec<&str> = analysis
            .findings
            .iter()
            .map(|(finding, _)| finding.kind)
            .collect();
        assert_eq!(kinds, ["client.stall", "client.interaction"]);
        assert!(
            analysis.findings.iter().all(|(finding, event)| {
                finding.source == "client" && analysis.events[*event].0 == "client.batch"
            }),
            "client-wide findings cite the batch event"
        );
    }

    #[test]
    fn unknown_methods_are_dropped_and_counted() {
        let book = LatencyBook::default();
        let mut report = batch(vec![
            record(None, "not.aMethod", 1_500.0, 10.0),
            record(None, SLOW, 300.0, 10.0),
        ]);
        report["histograms"] = json!([
            { "method": "not.aMethod", "buckets": [[3, 1]] },
            { "method": SLOW, "buckets": [[50, 1]] },
        ]);
        let analysis = analyze_with(&book, &report);
        assert!(analysis.findings.is_empty());
        let requests = events(&analysis, "client.request");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["method"], SLOW);
        let summary = events(&analysis, "client.batch");
        assert_eq!(summary.len(), 1);
        assert_eq!(summary[0]["droppedUnknownMethods"], 2);
        assert_eq!(summary[0]["histograms"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn invalid_fields_are_rejected() {
        type Mutation = Box<dyn Fn(&mut Value)>;
        let cases: Vec<(&str, Mutation)> = vec![
            (
                "negative rtt",
                Box::new(|b| b["records"][0]["rttMs"] = json!(-1)),
            ),
            (
                "rtt over an hour",
                Box::new(|b| b["records"][0]["rttMs"] = json!(3_600_001)),
            ),
            (
                "render over an hour",
                Box::new(|b| b["records"][0]["renderMs"] = json!(3_600_001)),
            ),
            (
                "window over 10 min",
                Box::new(|b| b["windowMs"] = json!(600_001)),
            ),
            (
                "bucket index 100",
                Box::new(|b| b["histograms"][0]["buckets"] = json!([[100, 1]])),
            ),
            (
                "bucket count over 1e6",
                Box::new(|b| b["histograms"][0]["buckets"] = json!([[3, 1_000_001]])),
            ),
            (
                "stall count over 1e6",
                Box::new(|b| b["stalls"]["count"] = json!(1_000_001)),
            ),
            ("negative heap", Box::new(|b| b["jsHeapBytes"] = json!(-5))),
            (
                "long method",
                Box::new(|b| b["records"][0]["method"] = json!("m".repeat(129))),
            ),
            (
                "long client id",
                Box::new(|b| b["clientId"] = json!("c".repeat(65))),
            ),
            (
                "long correlation id",
                Box::new(|b| b["records"][0]["correlationId"] = json!("r".repeat(65))),
            ),
            (
                "33 capabilities",
                Box::new(|b| b["capabilities"] = json!(vec!["event"; 33])),
            ),
            (
                "long capability",
                Box::new(|b| b["capabilities"] = json!(["e".repeat(65)])),
            ),
            (
                "missing field",
                Box::new(|b| {
                    b.as_object_mut().map(|o| o.remove("stalls"));
                }),
            ),
            ("wrong type", Box::new(|b| b["windowMs"] = json!("10s"))),
        ];
        for (name, mutate) in cases {
            let mut report = batch(vec![record(None, SLOW, 300.0, 10.0)]);
            mutate(&mut report);
            let error = validate(&report)
                .err()
                .unwrap_or_else(|| panic!("{name} accepted"));
            assert_eq!(tag(&error), "ProfilerClientBatchInvalid", "{name}");
        }
        assert!(
            validate(&batch(vec![record(
                Some(&"r".repeat(64)),
                SLOW,
                3_600_000.0,
                0.0
            )]))
            .is_ok()
        );
    }

    fn render_error() -> Value {
        json!({
            "errorType": "Error",
            "reactErrorCode": 185,
            "componentNames": ["GitManagerBranchDropdown", "Popover"],
            "routePattern": "/_chat/$environmentId/$threadId",
            "fingerprint": "0a1b2c3d",
        })
    }

    /// R51: each caught render error is one event; repeats share one finding, grouped by the
    /// error's type, code and component names, never by the route or the client's hash.
    #[test]
    fn render_errors_become_events_and_one_grouped_finding() {
        let book = LatencyBook::default();
        let mut report = batch(Vec::new());
        report["renderErrors"] = json!([render_error(), render_error()]);
        let analysis = analyze_with(&book, &report);

        let events = events(&analysis, "client.render-error");
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0],
            &json!({
                "clientId": "c1",
                "errorType": "Error",
                "reactErrorCode": 185,
                "componentNames": ["GitManagerBranchDropdown", "Popover"],
                "routePattern": "/_chat/$environmentId/$threadId",
                "fingerprint": "0a1b2c3d",
            }),
            "no envId, message, URL or path"
        );
        let findings: Vec<&(FindingInput, usize)> = analysis
            .findings
            .iter()
            .filter(|(finding, _)| finding.kind == "client.render-error")
            .collect();
        assert_eq!(
            findings.len(),
            2,
            "one per occurrence, merged by fingerprint"
        );
        let (finding, event) = findings[0];
        assert_eq!(finding.severity, Severity::Error);
        assert_eq!(finding.source, "client");
        assert_eq!(
            finding.fingerprint_fields,
            [
                "Error",
                "185",
                "/_chat/$environmentId/$threadId",
                "GitManagerBranchDropdown",
                "Popover"
            ]
        );
        assert_eq!(findings[1].0.fingerprint_fields, finding.fingerprint_fields);
        assert_eq!(analysis.events[*event].0, "client.render-error");

        let mut other_hash = render_error();
        other_hash["fingerprint"] = json!("ffffffff");
        report["renderErrors"] = json!([other_hash]);
        let analysis = analyze_with(&book, &report);
        assert_eq!(
            analysis.findings[0].0.fingerprint_fields, finding.fingerprint_fields,
            "the client's hash does not split the finding"
        );
        // Minified names are shared by unrelated crashes: the route keeps them apart.
        let mut other_route = render_error();
        other_route["routePattern"] = json!("/settings/general");
        report["renderErrors"] = json!([other_route]);
        let analysis = analyze_with(&book, &report);
        assert_ne!(
            analysis.findings[0].0.fingerprint_fields,
            finding.fingerprint_fields
        );
    }

    /// Codex's adversarial shapes: content where a name or a route should be is replaced,
    /// never recorded, in the event, the evidence and the grouping.
    #[test]
    fn content_shaped_render_error_fields_are_replaced() {
        let book = LatencyBook::default();
        let cases = [
            ("errorType", json!("private_document.txt"), "Other"),
            ("errorType", json!("PrivateDocumentError"), "Other"),
            ("errorType", json!("Error: secret thread"), "Other"),
        ];
        for (field, value, expected) in cases {
            let mut error = render_error();
            error[field] = value.clone();
            let mut report = batch(Vec::new());
            report["renderErrors"] = json!([error]);
            let analysis = analyze_with(&book, &report);
            assert_eq!(analysis.events[1].1[field], expected, "{value}");
            assert_eq!(analysis.findings[0].0.fingerprint_fields[0], expected);
        }
        let mut error = render_error();
        error["componentNames"] = json!([
            "private prompt words",
            "/home/test-user/app.tsx",
            "https://example.test/app.js:1:2",
            "Context.Provider",
            "\"quoted\"",
            "Panel",
        ]);
        let mut report = batch(Vec::new());
        report["renderErrors"] = json!([error]);
        let analysis = analyze_with(&book, &report);
        assert_eq!(
            analysis.events[1].1["componentNames"],
            json!([
                "Unnamed", "Unnamed", "Unnamed", "Unnamed", "Unnamed", "Panel"
            ])
        );
        for route in [
            "/home/test-user/private-project",
            "/_chat/env-1/thread-42",
            "/settings?token=x",
            "private-project",
        ] {
            let mut error = render_error();
            error["routePattern"] = json!(route);
            report["renderErrors"] = json!([error]);
            let analysis = analyze_with(&book, &report);
            assert_eq!(analysis.events[1].1["routePattern"], Value::Null, "{route}");
            assert_eq!(analysis.findings[0].0.fingerprint_fields[2], "", "{route}");
            let finding = &analysis.findings[0].0;
            let text = format!(
                "{:?} {} {} {}",
                finding.fingerprint_fields, finding.evidence, finding.title, finding.summary
            );
            assert!(
                !text.contains("private") && !text.contains("thread-42"),
                "{text}"
            );
        }
        for route in [
            "/",
            "__root__",
            "/settings/source-control",
            "/pair",
            "/_chat/",
        ] {
            let mut error = render_error();
            error["routePattern"] = json!(route);
            report["renderErrors"] = json!([error]);
            let analysis = analyze_with(&book, &report);
            assert_eq!(analysis.events[1].1["routePattern"], route);
        }
    }

    #[test]
    fn a_render_error_keeps_only_its_known_fields() {
        let book = LatencyBook::default();
        let mut leaky = render_error();
        leaky["message"] = json!("Cannot read secret-thread from ~/project/file.ts");
        leaky["url"] = json!("https://example.test/app");
        leaky["threadId"] = json!("thread-1");
        let mut report = batch(Vec::new());
        report["renderErrors"] = json!([leaky]);
        let analysis = analyze_with(&book, &report);
        let event = events(&analysis, "client.render-error")[0].to_string();
        for forbidden in ["message", "secret", "url", "https", "thread-1", "file.ts"] {
            assert!(!event.contains(forbidden), "{forbidden} in {event}");
        }
    }

    #[test]
    fn malformed_render_errors_are_rejected() {
        type Mutation = Box<dyn Fn(&mut Value)>;
        let cases: Vec<(&str, Mutation)> = vec![
            (
                "13 component names",
                Box::new(|e| e["componentNames"] = json!(vec!["Panel"; 13])),
            ),
            (
                "a free-text fingerprint",
                Box::new(|e| e["fingerprint"] = json!("secret thread")),
            ),
            (
                "a code out of range",
                Box::new(|e| e["reactErrorCode"] = json!(100_000)),
            ),
        ];
        for (name, mutate) in cases {
            let mut error = render_error();
            mutate(&mut error);
            let mut report = batch(Vec::new());
            report["renderErrors"] = json!([error]);
            let rejected = validate(&report)
                .err()
                .unwrap_or_else(|| panic!("{name} accepted"));
            assert_eq!(tag(&rejected), "ProfilerClientBatchInvalid", "{name}");
        }
        let mut report = batch(Vec::new());
        report["renderErrors"] = json!(vec![render_error(); 9]);
        assert_eq!(
            tag(&validate(&report).err().expect("rejected")),
            "ProfilerClientBatchTooLarge"
        );
        let mut root = render_error();
        root["routePattern"] = json!("__root__");
        root["reactErrorCode"] = Value::Null;
        report["renderErrors"] = json!([root]);
        assert!(validate(&report).is_ok(), "the root route and no code");
        assert!(
            validate(&batch(Vec::new())).is_ok(),
            "an older client sends no renderErrors"
        );
    }

    #[test]
    fn rejections_have_the_shape_of_the_contract_errors() {
        let fixtures = [
            include_str!(
                "../../../../../packages/contracts/fixtures/rpc-wire/typed-failures/server__reportProfilerClientBatch-00.json"
            ),
            include_str!(
                "../../../../../packages/contracts/fixtures/rpc-wire/typed-failures/server__reportProfilerClientBatch-01.json"
            ),
        ];
        for (fixture, error) in fixtures.into_iter().zip([too_large("m"), invalid("m")]) {
            let fixture: Value = serde_json::from_str(fixture).expect("fixture JSON");
            let expected = &fixture["exit"]["cause"][0]["error"];
            assert_eq!(expected["_tag"], error["_tag"]);
            let keys = |value: &Value| {
                let mut keys: Vec<String> = value
                    .as_object()
                    .expect("an error object")
                    .keys()
                    .cloned()
                    .collect();
                keys.sort();
                keys
            };
            assert_eq!(keys(expected), keys(&error));
        }
    }
}
