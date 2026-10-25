//! Provider turn failures and conversation compactions.
//!
//! A failed turn is recorded by provider, the provider's own name for why it ended, and the error
//! class BiBCode gave it. Repeats of the same failure accumulate in one finding, so a thread that
//! keeps hitting the same wall (such as a full context window) is visible without reading the
//! conversation. Every compaction BiBCode asked for is recorded when it settles, and a failed one
//! raises its own finding.

use serde_json::json;

use super::{
    cite, emit,
    findings::{FindingInput, Severity},
    is_enabled, record_finding,
};

/// The longest provider-reported reason kept. Longer or non-identifier reasons are recorded as
/// `other`: the reason is part of the fingerprint and must stay a stable, content-free name.
const MAX_REASON_CHARS: usize = 64;

#[cfg(test)]
thread_local! {
    /// The evidence of every record call on this thread, whether or not the profiler is on, so a
    /// test (on a single-threaded runtime) can see which code paths record and how often.
    static RECORDED: std::cell::RefCell<Vec<(&'static str, serde_json::Value)>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// The records made on this thread since the last call: each event kind with its evidence.
#[cfg(test)]
pub(crate) fn take_recorded() -> Vec<(&'static str, serde_json::Value)> {
    RECORDED.with(|recorded| std::mem::take(&mut *recorded.borrow_mut()))
}

#[cfg(test)]
fn note_recorded(kind: &'static str, evidence: serde_json::Value) {
    RECORDED.with(|recorded| recorded.borrow_mut().push((kind, evidence)));
}

/// Records one failed provider turn as a `provider.turn-failed` event and finding. Never
/// records message text: only `provider`, the provider's own reason when it gave one (Claude's
/// `terminal_reason`, Codex's error variant, OpenCode's error name), and the canonical
/// `error_class`. Does nothing while the profiler is off.
pub fn record_turn_failure(provider: &str, provider_reason: Option<&str>, error_class: &str) {
    #[cfg(test)]
    note_recorded(
        "provider.turn-failed",
        turn_failure_finding(provider, provider_reason, error_class).evidence,
    );
    if !is_enabled() {
        return;
    }
    let finding = turn_failure_finding(provider, provider_reason, error_class);
    let event_id = emit("provider.turn-failed", finding.evidence.clone());
    record_finding(FindingInput {
        evidence: cite(finding.evidence, event_id),
        ..finding
    });
}

fn turn_failure_finding(
    provider: &str,
    provider_reason: Option<&str>,
    error_class: &str,
) -> FindingInput {
    let provider = provider_name(provider);
    let reason = provider_reason.map(reason_identifier);
    let error_class = identifier(error_class);
    let severity = if error_class == "context_limit" {
        Severity::Warn
    } else {
        Severity::Info
    };
    let summary = match &reason {
        Some(reason) => format!("A {provider} turn failed with {error_class} ({reason})."),
        None => format!("A {provider} turn failed with {error_class}."),
    };
    FindingInput {
        kind: "provider.turn-failed",
        severity,
        source: "server".into(),
        fingerprint_fields: vec![
            provider.clone(),
            reason.clone().unwrap_or_default(),
            error_class.clone(),
        ],
        title: "Provider turn failed".into(),
        summary,
        evidence: json!({
            "provider": provider,
            "terminalReason": reason,
            "errorClass": error_class,
        }),
    }
}

/// How a conversation compaction settled, for `provider.compaction`.
#[derive(Clone, Copy, Debug)]
pub struct CompactionRecord<'a> {
    pub provider: &'a str,
    /// `manual`, `contextRecovery` or `guard`.
    pub trigger: &'a str,
    /// `completed`, `failed` or `interrupted`.
    pub outcome: &'a str,
    /// Why it did not complete: `not_started`, `no_compaction`, `turn_failed`, `unconfirmed`,
    /// `identity_changed` or `stopped`. `None` for a completed compaction.
    pub reason: Option<&'a str>,
    pub duration_ms: u64,
}

/// Records one settled compaction as a `provider.compaction` event, and a failed one as a
/// `provider.compaction-failed` finding. Never records message, summary or error text. Does
/// nothing while the profiler is off.
pub fn record_compaction(record: CompactionRecord<'_>) {
    #[cfg(test)]
    note_recorded("provider.compaction", compaction_evidence(record));
    if !is_enabled() {
        return;
    }
    let evidence = compaction_evidence(record);
    let event_id = emit("provider.compaction", evidence.clone());
    if let Some(finding) = compaction_failure_finding(record, evidence) {
        record_finding(FindingInput {
            evidence: cite(finding.evidence, event_id),
            ..finding
        });
    }
}

fn compaction_evidence(record: CompactionRecord<'_>) -> serde_json::Value {
    json!({
        "provider": provider_name(record.provider),
        "trigger": reason_identifier(record.trigger),
        "outcome": identifier(record.outcome),
        "reason": record.reason.map(identifier),
        "durationMs": record.duration_ms,
    })
}

fn compaction_failure_finding(
    record: CompactionRecord<'_>,
    evidence: serde_json::Value,
) -> Option<FindingInput> {
    if record.outcome != "failed" {
        return None;
    }
    let provider = provider_name(record.provider);
    let trigger = reason_identifier(record.trigger);
    let reason = record.reason.map(identifier).unwrap_or_default();
    Some(FindingInput {
        kind: "provider.compaction-failed",
        severity: Severity::Warn,
        source: "server".into(),
        fingerprint_fields: vec![provider.clone(), trigger.clone(), reason.clone()],
        title: "Conversation compaction failed".into(),
        summary: format!("A {provider} compaction ({trigger}) failed: {reason}."),
        evidence,
    })
}

/// The provider as the Profiler names it: Claude's driver kinds read `claude`, every other kind
/// is its own name in snake case.
fn provider_name(provider: &str) -> String {
    match provider.trim() {
        "claude" | "claudeAgent" => "claude".to_owned(),
        other => reason_identifier(other),
    }
}

/// A provider's reason as a stable identifier: a camelCase or PascalCase name in snake case
/// first (`contextWindowExceeded` is `context_window_exceeded`, `APIError` is `api_error`), so
/// distinct variants stay distinct; anything that is not a plain name is `other`.
fn reason_identifier(value: &str) -> String {
    identifier(&snake_case(value.trim()))
}

/// Rewrites a camelCase or PascalCase name in snake case, treating a run of capitals as one word.
/// Anything with other characters is returned unchanged, for `identifier` to reject.
fn snake_case(value: &str) -> std::borrow::Cow<'_, str> {
    if !value.bytes().any(|byte| byte.is_ascii_uppercase())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return std::borrow::Cow::Borrowed(value);
    }
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len() + 4);
    for (index, &byte) in bytes.iter().enumerate() {
        if byte.is_ascii_uppercase() && index > 0 {
            let previous = bytes[index - 1];
            let next_is_lower = bytes.get(index + 1).is_some_and(u8::is_ascii_lowercase);
            let boundary = previous.is_ascii_lowercase()
                || previous.is_ascii_digit()
                || (previous.is_ascii_uppercase() && next_is_lower);
            if boundary && !out.ends_with('_') {
                out.push('_');
            }
        }
        out.push(char::from(byte.to_ascii_lowercase()));
    }
    std::borrow::Cow::Owned(out)
}

/// `value` when it is a short snake_case or kebab-case name, else `other`.
fn identifier(value: &str) -> String {
    let value = value.trim();
    let is_identifier = !value.is_empty()
        && value.len() <= MAX_REASON_CHARS
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        });
    if is_identifier {
        value.to_owned()
    } else {
        "other".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_context_limit_stops_share_one_warning_finding() {
        let first = turn_failure_finding("claude", Some("blocking_limit"), "context_limit");
        let second = turn_failure_finding("claudeAgent", Some("blocking_limit"), "context_limit");
        assert_eq!(first.kind, "provider.turn-failed");
        assert_eq!(first.severity, Severity::Warn);
        assert_eq!(first.fingerprint_fields, second.fingerprint_fields);
        assert_eq!(
            first.evidence,
            json!({
                "provider": "claude",
                "terminalReason": "blocking_limit",
                "errorClass": "context_limit"
            })
        );
        let other = turn_failure_finding("claude", Some("max_turns"), "provider_error");
        assert_eq!(other.severity, Severity::Info);
        assert_ne!(other.fingerprint_fields, first.fingerprint_fields);
    }

    #[test]
    fn a_reason_that_is_not_a_plain_name_is_never_recorded() {
        let finding = turn_failure_finding(
            "claude",
            Some("Prompt is too long: /Users/someone/secret"),
            "context_limit",
        );
        assert_eq!(finding.evidence["terminalReason"], "other");
        assert!(!finding.summary.contains("secret"));
        assert_eq!(
            turn_failure_finding("claude", None, "provider_error").evidence["terminalReason"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn provider_variant_names_stay_distinct_in_snake_case() {
        let reason = |provider, reason| {
            turn_failure_finding(provider, Some(reason), "provider_error").evidence
                ["terminalReason"]
                .clone()
        };
        assert_eq!(
            reason("codex", "contextWindowExceeded"),
            "context_window_exceeded"
        );
        assert_eq!(
            reason("codex", "usageLimitExceeded"),
            "usage_limit_exceeded"
        );
        assert_eq!(reason("opencode", "APIError"), "api_error");
        assert_eq!(
            reason("opencode", "ContextOverflowError"),
            "context_overflow_error"
        );
        assert_eq!(reason("claude", "blocking_limit"), "blocking_limit");
        assert_eq!(reason("codex", "Free text with spaces"), "other");
        assert_eq!(
            turn_failure_finding("opencode", None, "context_limit").evidence["provider"],
            "opencode"
        );
    }

    #[test]
    fn a_compaction_records_only_names_and_a_failed_one_raises_a_finding() {
        let failed = CompactionRecord {
            provider: "claudeAgent",
            trigger: "contextRecovery",
            outcome: "failed",
            reason: Some("no_compaction"),
            duration_ms: 70_000,
        };
        let evidence = compaction_evidence(failed);
        assert_eq!(
            evidence,
            json!({
                "provider": "claude",
                "trigger": "context_recovery",
                "outcome": "failed",
                "reason": "no_compaction",
                "durationMs": 70_000,
            })
        );
        let finding = compaction_failure_finding(failed, evidence).expect("a failed compaction");
        assert_eq!(finding.kind, "provider.compaction-failed");
        assert_eq!(finding.severity, Severity::Warn);
        assert_eq!(
            finding.fingerprint_fields,
            ["claude", "context_recovery", "no_compaction"]
        );
        let completed = CompactionRecord {
            outcome: "completed",
            reason: None,
            ..failed
        };
        assert!(compaction_failure_finding(completed, compaction_evidence(completed)).is_none());
        assert_eq!(
            compaction_evidence(completed)["reason"],
            serde_json::Value::Null
        );
    }
}
