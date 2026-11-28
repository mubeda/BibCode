pub(crate) mod acp_mode;
pub mod antigravity;
pub(crate) mod attachments;
pub mod claude;
pub mod codex;
pub mod cursor;
pub(crate) mod environment;
pub mod grok;
pub mod opencode;

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How a user settled a pending clarifying-question request (#430).
///
/// Older answers-only callers (including MCP `answer_question`) omit this field and default to
/// [`UserInputResponseDisposition::Answered`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UserInputResponseDisposition {
    #[default]
    Answered,
    Skipped,
    Cancelled,
}

impl UserInputResponseDisposition {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Answered => "answered",
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
        }
    }

    pub const fn is_skip_or_cancel(self) -> bool {
        matches!(self, Self::Skipped | Self::Cancelled)
    }

    /// True when the response suppresses answer delivery: either `Cancelled` (whose answers are
    /// discarded) or `Skipped` with no non-empty answers. A partial `Skipped` response carrying
    /// non-empty answers still submits those answers and may start a follow-up turn.
    pub(crate) fn is_effective_skip_or_cancel(self, answers: &Value) -> bool {
        matches!(self, Self::Cancelled)
            || (matches!(self, Self::Skipped) && !has_non_empty_user_input_answer(answers))
    }
}

/// Returns true when the answer object carries at least one non-empty string answer.
pub(crate) fn has_non_empty_user_input_answer(answers: &Value) -> bool {
    let Some(map) = answers.as_object() else {
        return false;
    };
    map.values().any(|value| match value {
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .any(|item| !item.trim().is_empty()),
        Value::Bool(_) | Value::Number(_) => true,
        _ => false,
    })
}

/// Compact question summaries embedded in `user-input.resolved` payloads so windowed history
/// reloads render concise receipts even when `user-input.requested` lives on an unloaded page.
pub(crate) fn compact_user_input_question_summaries(questions: &[Value]) -> Vec<Value> {
    questions
        .iter()
        .filter_map(|question| {
            let id = question
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())?;
            let prompt = question
                .get("question")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())?;
            let header = question
                .get("header")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty());
            let mut summary = serde_json::Map::new();
            summary.insert("id".to_owned(), Value::String(id.to_owned()));
            if let Some(header) = header {
                summary.insert("header".to_owned(), Value::String(header.to_owned()));
            }
            summary.insert("question".to_owned(), Value::String(prompt.to_owned()));
            Some(Value::Object(summary))
        })
        .collect()
}

/// Builds a self-sufficient `user-input.resolved` payload carrying answers, disposition, and
/// compact question metadata.
pub(crate) fn build_user_input_resolved_payload(
    answers: Value,
    disposition: UserInputResponseDisposition,
    questions: &[Value],
) -> Value {
    let mut payload = serde_json::Map::new();
    payload.insert("answers".to_owned(), answers);
    payload.insert(
        "disposition".to_owned(),
        Value::String(disposition.as_str().to_owned()),
    );
    let summaries = compact_user_input_question_summaries(questions);
    if !summaries.is_empty() {
        payload.insert("questions".to_owned(), Value::Array(summaries));
    }
    Value::Object(payload)
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) struct RequestScope(uuid::Uuid);

impl RequestScope {
    pub(crate) fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }

    pub(crate) fn approval_id(self, correlation_id: &str) -> String {
        format!("approval:{}:{correlation_id}", self.0)
    }

    pub(crate) fn user_input_id(self, correlation_id: &str) -> String {
        format!("user-input:{}:{correlation_id}", self.0)
    }
}

#[cfg(test)]
mod request_scope_tests {
    use super::{RequestScope, UserInputResponseDisposition};
    use serde_json::json;

    #[test]
    fn one_wire_id_is_stable_within_a_connection_and_distinct_across_connections() {
        let first = RequestScope::new();
        let second = RequestScope::new();
        assert_eq!(first.approval_id("1"), first.approval_id("1"));
        assert_ne!(first.approval_id("1"), second.approval_id("1"));
        assert_ne!(first.approval_id("1"), first.user_input_id("1"));
    }

    #[test]
    fn effective_skip_or_cancel_treats_partial_skipped_answers_as_deliverable() {
        assert!(
            UserInputResponseDisposition::Cancelled
                .is_effective_skip_or_cancel(&json!({"q1": "yes"}))
        );
        assert!(UserInputResponseDisposition::Skipped.is_effective_skip_or_cancel(&json!({})));
        assert!(
            UserInputResponseDisposition::Skipped
                .is_effective_skip_or_cancel(&json!({"q1": "   "}))
        );
        assert!(
            !UserInputResponseDisposition::Skipped
                .is_effective_skip_or_cancel(&json!({"q1": "Espresso"}))
        );
        assert!(!UserInputResponseDisposition::Answered.is_effective_skip_or_cancel(&json!({})));
    }
}

/// Minimum `agy` CLI version that supports mid-turn steering via a second concurrent ACP
/// `session/prompt` (#434).
pub(crate) const ANTIGRAVITY_MIN_STEER_VERSION: (u64, u64, u64) = (1, 5, 0);

/// Parses the first `major.minor.patch` version triple from a provider version string.
pub(crate) fn parse_semver_triple(text: &str) -> Option<(u64, u64, u64)> {
    parse_semver_with_prerelease(text).map(|(triple, _)| triple)
}

/// Parses the first `major.minor.patch` version triple along with whether a SemVer prerelease
/// identifier (`-...`) immediately follows it.
pub(crate) fn parse_semver_with_prerelease(text: &str) -> Option<((u64, u64, u64), bool)> {
    text.split(|character: char| {
        !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+'))
    })
    .find_map(|token| {
        let token = token.trim_start_matches(['v', 'V']);
        let without_build = token.split('+').next().unwrap_or(token);
        let (core, prerelease) = match without_build.split_once('-') {
            Some((core, pre)) if !pre.is_empty() => (core, true),
            _ => (without_build, false),
        };
        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some(((major, minor, patch), prerelease))
    })
}

/// Driver-owned capability used by durable steer admission.
///
/// Antigravity is further version-gated (`agy >= 1.5.0`) in provider inventory via
/// [`supports_turn_steer_for_version`] and inside the Antigravity runtime.
pub(crate) fn supports_turn_steer(provider: &str) -> bool {
    matches!(provider, "codex" | "claudeAgent" | "antigravity")
}

/// Version-aware capability advertised as `supportsTurnSteer` in provider inventory.
///
/// Follows SemVer 2.0.0 prerelease precedence: `1.5.0-rc.1 < 1.5.0`, while `1.5.0`, `1.5.1-rc.1`,
/// and `1.5.15` all satisfy `>= 1.5.0`. (Antigravity chat startup independently requires `>= 1.5.4`.)
pub(crate) fn supports_turn_steer_for_version(provider: &str, version: Option<&str>) -> bool {
    match provider {
        "codex" | "claudeAgent" => true,
        "antigravity" => {
            version
                .and_then(parse_semver_with_prerelease)
                .is_some_and(|(triple, prerelease)| {
                    triple > ANTIGRAVITY_MIN_STEER_VERSION
                        || (triple == ANTIGRAVITY_MIN_STEER_VERSION && !prerelease)
                })
        }
        _ => false,
    }
}

/// Driver-owned capability used by inventory, `thread.compact` admission and context-limit
/// recovery: the driver's `compact` asks the provider to compact its conversation and reports
/// the compaction as a turn of its own, tagged with the compaction id. OpenCode 2 is left out
/// until its compaction of an idle session (`delivery: steer`) is confirmed to run at once, and
/// a Server URL instance outlives BiBCode, which restart reconciliation assumes it does not;
/// typing `/compact` still compacts there.
pub(crate) fn supports_compaction(provider: &str) -> bool {
    matches!(provider, "claude" | "claudeAgent" | "codex")
}

/// A provider slash invocation, `/name arguments`, as `(name, arguments)`. A name is ASCII
/// letters, digits, `-`, `_`, `:` and `.`, so text such as a leading file path is not one.
pub(crate) fn parse_provider_command(text: &str) -> Option<(&str, &str)> {
    let command = text.strip_prefix('/')?;
    let split = command.find(char::is_whitespace).unwrap_or(command.len());
    let name = &command[..split];
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return None;
    }
    Some((name, command[split..].trim()))
}

/// Driver-owned capability used by both inventory and checkpoint revert: the driver's
/// `rollback` drops the newest turns from its conversation. A revert on any other provider
/// restores only the files.
pub(crate) fn supports_conversation_rewind(provider: &str) -> bool {
    matches!(provider, "codex" | "opencode")
}

/// Whether the provider's conversation rewind leaves the working tree alone, so a
/// conversation-only revert can use it (#279). Codex's `thread/revert` never touches files and
/// OpenCode 2 stages its revert with `"files": false`; OpenCode 1's `/session/{id}/revert`
/// restores its file snapshots in the same call.
pub(crate) fn rewind_keeps_files(provider: &str, api_version: u32) -> bool {
    match provider {
        "codex" => true,
        "opencode" => api_version >= 2,
        _ => false,
    }
}

// The one refusal policy. Every driver builds the sentence an undelivered turn shows from these
// helpers. `option` is the option's label where the driver has one, otherwise its id.

/// The selected model refuses `option`.
pub(crate) fn unsupported_option_refusal(option: &str) -> String {
    format!(
        "{option} is not supported by the selected model. Choose another option for this model."
    )
}

/// A turn option carries no id.
pub(crate) fn option_without_id_refusal() -> String {
    "The turn has an option without an id.".to_owned()
}

/// A select or text option carries no usable value.
pub(crate) fn option_needs_value_refusal(option: &str) -> String {
    format!("{option} needs a value.")
}

/// An on/off option carries something other than on or off.
pub(crate) fn option_on_or_off_refusal(option: &str) -> String {
    format!("{option} must be on or off.")
}

/// Two options exclude each other.
pub(crate) fn options_conflict_refusal(first: &str, second: &str) -> String {
    format!("{first} and {second} can't be used together.")
}

/// A turn carries options but no model to apply them to.
pub(crate) fn options_need_model_refusal() -> String {
    "Options need a selected model.".to_owned()
}

/// The provider does not offer the turn's model. `provider_label` is the instance's label.
pub(crate) fn model_unavailable_refusal(model: &str, provider_label: &str) -> String {
    format!("{model} is not available in {provider_label}.")
}

/// The session's own option configuration is one BiBCode can't work with, so no option can be
/// applied to it. The configuration is protocol detail the user can't act on, so the sentence
/// stays generic and names what the user can do instead.
pub(crate) fn unusable_options_refusal() -> String {
    "BiBCode can't apply these options to the selected model. Choose another model, or turn these \
     options off."
        .to_owned()
}

/// A live session can't switch to its provider's default model, because the session advertises
/// no default it can return to.
pub(crate) fn default_model_unavailable_refusal() -> String {
    "This session can't switch to the default model. Choose another model.".to_owned()
}

/// A deterministic refusal of a turn's options: the same request is refused again on every
/// retry, so a durable delivery that meets one fails once instead of retrying. `detail` is the
/// technical text that logs and RPC errors show (the Display); `refusal` is the plain sentence an
/// undelivered turn shows, built with the helpers above.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefusedOption {
    pub(crate) detail: String,
    pub(crate) refusal: String,
}

impl RefusedOption {
    pub(crate) fn new(detail: impl Into<String>, refusal: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
            refusal: refusal.into(),
        }
    }

    /// A refusal caused by a session configuration BiBCode can't work with rather than by the
    /// request, shown as [`unusable_options_refusal`].
    pub(crate) fn unusable(detail: impl Into<String>) -> Self {
        Self::new(detail, unusable_options_refusal())
    }
}

impl fmt::Display for RefusedOption {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.detail)
    }
}

impl OptionRefusal for RefusedOption {
    fn refused_option(&self) -> Option<&RefusedOption> {
        Some(self)
    }
}

/// Implemented by each driver runtime's error type, so one mapping turns a refusal into an
/// option refusal of the provider runtime and leaves every other error retryable.
pub trait OptionRefusal {
    /// The refusal behind this error; `None` for every other error, such as a failed request,
    /// which a retry may overcome.
    fn refused_option(&self) -> Option<&RefusedOption>;

    /// The plain sentence an undelivered turn shows for a refusal.
    fn option_refusal(&self) -> Option<&str> {
        self.refused_option()
            .map(|refused| refused.refusal.as_str())
    }
}
