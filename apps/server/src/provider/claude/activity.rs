use std::{
    collections::{HashMap, HashSet, VecDeque},
    fmt::Write as _,
};

use serde_json::Value;
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::transcript::ClaudeRecoveredActivity;
use crate::activity::{
    ACTIVITY_DETAIL_MAX_LENGTH, ACTIVITY_ID_MAX_LENGTH, ACTIVITY_LABEL_MAX_LENGTH,
    ACTIVITY_SUMMARY_MAX_LENGTH, ActivityActorSummary, ActivityCapabilities, ActivityEntry,
    ActivityEntryKind, ActivityEntryTone, ActivityHistoryRecovery, ActivityLifecycle,
    ActivityObservationState, ActivityRecordKind, ProviderActivityMutation,
};

const MAX_TRACKED_ACTORS: usize = 256;
const MAX_TRACKED_TOOL_LIFECYCLES: usize = 512;
const MAX_SEEN_EVENTS: usize = 2_048;
const MAX_RECOVERY_SEEN_EVENTS: usize = 10_000;
const MAX_MUTATIONS_PER_OUTPUT: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClaudeActivityStateCounts {
    pub actors: usize,
    pub tool_lifecycles: usize,
    pub seen_events: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaudeActivityInputSource {
    BaseLaunch,
    CapabilityProbe,
    HookInput,
    Stream,
}

#[derive(Debug, Default)]
pub struct ClaudeActivityOutput {
    pub mutations: Vec<ProviderActivityMutation>,
}

impl ClaudeActivityOutput {
    fn push(&mut self, mutation: ProviderActivityMutation) {
        if self.mutations.len() < MAX_MUTATIONS_PER_OUTPUT {
            self.mutations.push(mutation);
        }
    }
}

#[derive(Clone, Debug)]
struct ClaudeActorState {
    canonical_id: String,
    parent_actor_id: Option<String>,
    name: String,
    role: String,
    status: ActivityLifecycle,
    summary: Option<String>,
    started_at: String,
    updated_at: String,
    terminal_at: Option<String>,
}

impl ClaudeActorState {
    fn to_summary(&self) -> Option<ActivityActorSummary> {
        ActivityActorSummary::try_new(
            self.canonical_id.clone(),
            self.parent_actor_id.as_deref(),
            self.name.clone(),
            Some(&self.role),
            Some("claude"),
            self.status,
            self.summary.as_deref(),
            self.started_at.clone(),
            self.updated_at.clone(),
            self.terminal_at.as_deref(),
        )
        .ok()
    }
}

#[derive(Clone, Debug)]
struct ToolLifecycle {
    owner_key: String,
    owner_id: String,
    tool_name: String,
    tool_name_key: String,
}

#[derive(Clone, Debug)]
struct BoundedSeenSet {
    maximum: usize,
    order: VecDeque<String>,
    values: HashSet<String>,
}

impl BoundedSeenSet {
    fn new(maximum: usize) -> Self {
        Self {
            maximum,
            order: VecDeque::new(),
            values: HashSet::new(),
        }
    }

    fn contains(&self, semantic_key: &str) -> bool {
        self.values.contains(&retained_key("seen", semantic_key))
    }

    fn insert(&mut self, semantic_key: &str) -> bool {
        let key = retained_key("seen", semantic_key);
        if self.values.contains(&key) {
            return false;
        }
        if self.order.len() == self.maximum
            && let Some(evicted) = self.order.pop_front()
        {
            self.values.remove(&evicted);
        }
        self.values.insert(key.clone());
        self.order.push_back(key);
        true
    }

    fn len(&self) -> usize {
        self.values.len()
    }
}

impl Default for BoundedSeenSet {
    fn default() -> Self {
        Self::new(MAX_SEEN_EVENTS)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ClaudeActivityTracker {
    root_session_id: String,
    root_session_key: String,
    actors: HashMap<String, ClaudeActorState>,
    terminal_actors: HashMap<String, ClaudeActorState>,
    terminal_actor_order: VecDeque<String>,
    tool_owner_by_use_id: HashMap<String, ToolLifecycle>,
    terminal_actor_keys: BoundedSeenSet,
    seen_events: BoundedSeenSet,
    recovery_seen_events: BoundedSeenSet,
}

impl ClaudeActivityTracker {
    pub(crate) fn new(root_session_id: &str) -> Self {
        Self {
            root_session_id: root_session_id.to_owned(),
            root_session_key: session_key(root_session_id),
            actors: HashMap::new(),
            terminal_actors: HashMap::new(),
            terminal_actor_order: VecDeque::new(),
            tool_owner_by_use_id: HashMap::new(),
            terminal_actor_keys: BoundedSeenSet::default(),
            seen_events: BoundedSeenSet::default(),
            recovery_seen_events: BoundedSeenSet::new(MAX_RECOVERY_SEEN_EVENTS),
        }
    }

    pub(crate) fn state_counts(&self) -> ClaudeActivityStateCounts {
        ClaudeActivityStateCounts {
            actors: self.actors.len(),
            tool_lifecycles: self.tool_owner_by_use_id.len(),
            seen_events: self.seen_events.len(),
        }
    }

    pub(crate) fn is_correlated_actor(&self, session_id: &str, agent_id: &str) -> bool {
        session_key(session_id) == self.root_session_key
            && self.actors.contains_key(&retained_key("agent", agent_id))
    }

    pub(crate) fn handle_value(
        &mut self,
        source: ClaudeActivityInputSource,
        value: &Value,
        emitted_at_ms: u64,
    ) -> ClaudeActivityOutput {
        match source {
            ClaudeActivityInputSource::HookInput => self.handle_hook_input(value, emitted_at_ms),
            ClaudeActivityInputSource::CapabilityProbe => self.handle_capability_probe(value),
            ClaudeActivityInputSource::BaseLaunch | ClaudeActivityInputSource::Stream => {
                ClaudeActivityOutput::default()
            }
        }
    }

    pub(crate) fn handle_recovered_records(
        &mut self,
        agent_id: &str,
        _agent_type: &str,
        records: &[ClaudeRecoveredActivity],
    ) -> ClaudeActivityOutput {
        let Some(owner_id) = canonical_actor_id(agent_id) else {
            return ClaudeActivityOutput::default();
        };
        let owner_key = retained_key("agent", agent_id);
        let mut recovered_tools = HashMap::<String, String>::new();
        let mut output = ClaudeActivityOutput::default();
        for record in records {
            match record {
                ClaudeRecoveredActivity::Commentary {
                    message_id,
                    content_index,
                    text,
                    created_at,
                } => {
                    let semantic_key = semantic_key(&[
                        "TranscriptText",
                        agent_id,
                        message_id,
                        &content_index.to_string(),
                    ]);
                    if !self.recovery_seen_events.insert(&semantic_key) {
                        continue;
                    }
                    let Some(detail) = safe_detail(text) else {
                        continue;
                    };
                    let entry_id = format!(
                        "claude:event:commentary:h{}",
                        framed_digest(&[
                            &self.root_session_key,
                            agent_id,
                            message_id,
                            &content_index.to_string(),
                        ])
                    );
                    let Ok(entry) = ActivityEntry::try_new(
                        entry_id,
                        ActivityRecordKind::Actor,
                        owner_id.clone(),
                        ActivityEntryKind::Commentary,
                        "Commentary",
                        Some(&detail),
                        ActivityEntryTone::Info,
                        created_at.clone(),
                    ) else {
                        continue;
                    };
                    output.push(ProviderActivityMutation::AppendEntry(entry));
                }
                ClaudeRecoveredActivity::ToolUse {
                    tool_use_id,
                    tool_name,
                    command,
                    created_at,
                } => {
                    let semantic_key = semantic_key(&["PreToolUse", agent_id, tool_use_id]);
                    if self.recovery_seen_events.contains(&semantic_key)
                        || self.seen_events.contains(&semantic_key)
                    {
                        recovered_tools.insert(tool_use_id.clone(), tool_name.clone());
                        continue;
                    }
                    let bounded_tool_name = bounded_label(tool_name);
                    if bounded_tool_name.is_empty() {
                        continue;
                    }
                    let tool_key = retained_key("tool", tool_use_id);
                    if self.tool_owner_by_use_id.len() >= MAX_TRACKED_TOOL_LIFECYCLES
                        || self.tool_owner_by_use_id.contains_key(&tool_key)
                    {
                        continue;
                    }
                    let Some(entry_id) = canonical_entry_id_from_parts(
                        "started",
                        &self.root_session_id,
                        agent_id,
                        tool_use_id,
                    ) else {
                        continue;
                    };
                    let detail = command.as_deref().and_then(safe_detail);
                    let kind = if bounded_tool_name == "Bash" {
                        ActivityEntryKind::Command
                    } else {
                        ActivityEntryKind::Tool
                    };
                    let Ok(entry) = ActivityEntry::try_new(
                        entry_id,
                        ActivityRecordKind::Actor,
                        owner_id.clone(),
                        kind,
                        bounded_label(&format!("{bounded_tool_name} started")),
                        detail.as_deref(),
                        ActivityEntryTone::Tool,
                        created_at.clone(),
                    ) else {
                        continue;
                    };
                    self.tool_owner_by_use_id.insert(
                        tool_key,
                        ToolLifecycle {
                            owner_key: owner_key.clone(),
                            owner_id: owner_id.clone(),
                            tool_name: bounded_tool_name,
                            tool_name_key: retained_key("tool-name", tool_name),
                        },
                    );
                    recovered_tools.insert(tool_use_id.clone(), tool_name.clone());
                    self.recovery_seen_events.insert(&semantic_key);
                    output.push(ProviderActivityMutation::AppendEntry(entry));
                }
                ClaudeRecoveredActivity::ToolResult {
                    tool_use_id,
                    failed,
                    error,
                    created_at,
                } => {
                    let Some(tool_name) = recovered_tools.get(tool_use_id) else {
                        continue;
                    };
                    let event = if *failed {
                        "PostToolUseFailure"
                    } else {
                        "PostToolUse"
                    };
                    let status = if *failed { "failed" } else { "completed" };
                    let semantic_key = semantic_key(&[event, agent_id, tool_use_id]);
                    if self.recovery_seen_events.contains(&semantic_key)
                        || self.seen_events.contains(&semantic_key)
                    {
                        continue;
                    }
                    let Some(entry_id) = canonical_entry_id_from_parts(
                        status,
                        &self.root_session_id,
                        agent_id,
                        tool_use_id,
                    ) else {
                        continue;
                    };
                    let detail = error.as_deref().and_then(safe_detail);
                    let Ok(entry) = ActivityEntry::try_new(
                        entry_id,
                        ActivityRecordKind::Actor,
                        owner_id.clone(),
                        if *failed {
                            ActivityEntryKind::Error
                        } else if tool_name == "Bash" {
                            ActivityEntryKind::Command
                        } else {
                            ActivityEntryKind::Tool
                        },
                        bounded_label(&format!("{tool_name} {status}")),
                        detail.as_deref(),
                        if *failed {
                            ActivityEntryTone::Error
                        } else {
                            ActivityEntryTone::Success
                        },
                        created_at.clone(),
                    ) else {
                        continue;
                    };
                    self.recovery_seen_events.insert(&semantic_key);
                    let tool_key = retained_key("tool", tool_use_id);
                    if self
                        .tool_owner_by_use_id
                        .get(&tool_key)
                        .is_some_and(|lifecycle| {
                            lifecycle.owner_key == owner_key
                                && lifecycle.tool_name_key == retained_key("tool-name", tool_name)
                        })
                    {
                        self.tool_owner_by_use_id.remove(&tool_key);
                    }
                    output.push(ProviderActivityMutation::AppendEntry(entry));
                }
            }
        }
        output
    }

    fn handle_capability_probe(&self, value: &Value) -> ClaudeActivityOutput {
        let supported = value
            .get("help_flags")
            .and_then(Value::as_array)
            .is_some_and(|flags| {
                let has_flag =
                    |expected: &str| flags.iter().any(|flag| flag.as_str() == Some(expected));
                has_flag("--include-hook-events") && has_flag("--forward-subagent-text")
            });
        if supported {
            return ClaudeActivityOutput::default();
        }
        let mut output = ClaudeActivityOutput::default();
        output.push(ProviderActivityMutation::SetScope {
            capabilities: ActivityCapabilities {
                actors: false,
                attributed_activity: false,
                background_work: false,
                history_recovery: ActivityHistoryRecovery::None,
                terminal_observation: false,
                targeted_actor_cancellation: false,
            },
            observation_state: ActivityObservationState::Live,
        });
        output
    }

    fn handle_hook_input(&mut self, value: &Value, emitted_at_ms: u64) -> ClaudeActivityOutput {
        let Some(event) = field(value, "hook_event_name") else {
            return ClaudeActivityOutput::default();
        };
        let Some(session_id) = field(value, "session_id") else {
            return ClaudeActivityOutput::default();
        };
        let Some(agent_id) = field(value, "agent_id") else {
            return ClaudeActivityOutput::default();
        };
        let agent_key = retained_key("agent", agent_id);
        let is_root_session = session_key(session_id) == self.root_session_key;
        if event == "SubagentStart" {
            if !is_root_session {
                return ClaudeActivityOutput::default();
            }
            return self.handle_subagent_start(value, agent_id, &agent_key, emitted_at_ms);
        }
        match event {
            "SubagentStop" if self.actors.contains_key(&agent_key) => {
                self.handle_subagent_stop(value, agent_id, &agent_key, emitted_at_ms)
            }
            "PreToolUse" if self.actors.contains_key(&agent_key) => {
                self.handle_pre_tool(value, agent_id, &agent_key, emitted_at_ms)
            }
            "PostToolUse" => {
                self.handle_post_tool(value, agent_id, &agent_key, emitted_at_ms, false)
            }
            "PostToolUseFailure" => {
                self.handle_post_tool(value, agent_id, &agent_key, emitted_at_ms, true)
            }
            _ => ClaudeActivityOutput::default(),
        }
    }

    fn handle_subagent_start(
        &mut self,
        value: &Value,
        agent_id: &str,
        agent_key: &str,
        emitted_at_ms: u64,
    ) -> ClaudeActivityOutput {
        let Some(agent_type) = field(value, "agent_type") else {
            return ClaudeActivityOutput::default();
        };
        let semantic_key = semantic_key(&["SubagentStart", agent_id]);
        if self.actors.contains_key(agent_key)
            || self.terminal_actor_keys.contains(agent_key)
            || self.actors.len() >= MAX_TRACKED_ACTORS
            || !self.seen_events.insert(&semantic_key)
        {
            return ClaudeActivityOutput::default();
        }
        let Some(canonical_id) = canonical_actor_id(agent_id) else {
            return ClaudeActivityOutput::default();
        };
        let timestamp = unix_millis_to_timestamp(emitted_at_ms);
        let role = bounded_label(agent_type);
        if role.is_empty() {
            return ClaudeActivityOutput::default();
        }
        let name = bounded_actor_name(&role);
        let mut actor = ClaudeActorState {
            canonical_id,
            parent_actor_id: field(value, "parent_agent_id")
                .filter(|parent_agent_id| *parent_agent_id != agent_id)
                .and_then(canonical_actor_id),
            name,
            role,
            status: ActivityLifecycle::Starting,
            summary: None,
            started_at: timestamp.clone(),
            updated_at: timestamp,
            terminal_at: None,
        };
        let mut output = ClaudeActivityOutput::default();
        if let Some(summary) = actor.to_summary() {
            output.push(ProviderActivityMutation::UpsertActor(summary));
        }
        actor.status = ActivityLifecycle::Running;
        if let Some(summary) = actor.to_summary() {
            output.push(ProviderActivityMutation::UpsertActor(summary));
        }
        self.actors.insert(agent_key.to_owned(), actor);
        output
    }

    fn handle_subagent_stop(
        &mut self,
        value: &Value,
        agent_id: &str,
        agent_key: &str,
        emitted_at_ms: u64,
    ) -> ClaudeActivityOutput {
        let semantic_key = semantic_key(&["SubagentStop", agent_id]);
        if self.seen_events.contains(&semantic_key) {
            return ClaudeActivityOutput::default();
        }
        let Some(actor) = self.actors.get(agent_key) else {
            return ClaudeActivityOutput::default();
        };
        if actor.status.is_terminal() {
            return ClaudeActivityOutput::default();
        }
        let timestamp = unix_millis_to_timestamp(emitted_at_ms);
        let mut candidate = actor.clone();
        candidate.status = ActivityLifecycle::Completed;
        candidate.summary = value
            .get("last_assistant_message")
            .and_then(Value::as_str)
            .and_then(safe_summary);
        candidate.updated_at.clone_from(&timestamp);
        candidate.terminal_at = Some(timestamp);
        let Some(summary) = candidate.to_summary() else {
            return ClaudeActivityOutput::default();
        };
        if !self.seen_events.insert(&semantic_key) {
            return ClaudeActivityOutput::default();
        }
        self.terminal_actor_keys.insert(agent_key);
        self.actors.remove(agent_key);
        self.insert_terminal_actor(agent_key.to_owned(), candidate);
        self.tool_owner_by_use_id
            .retain(|_, lifecycle| lifecycle.owner_key != agent_key);
        let mut output = ClaudeActivityOutput::default();
        output.push(ProviderActivityMutation::UpsertActor(summary));
        output
    }

    pub(crate) fn handle_task_terminal(
        &mut self,
        agent_id: &str,
        lifecycle: ActivityLifecycle,
        emitted_at_ms: u64,
    ) -> ClaudeActivityOutput {
        if !matches!(
            lifecycle,
            ActivityLifecycle::Cancelled
                | ActivityLifecycle::Interrupted
                | ActivityLifecycle::Failed
        ) {
            return ClaudeActivityOutput::default();
        }
        let agent_key = retained_key("agent", agent_id);
        let actor = self
            .actors
            .get(&agent_key)
            .or_else(|| self.terminal_actors.get(&agent_key));
        let Some(actor) = actor else {
            return ClaudeActivityOutput::default();
        };
        if matches!(
            actor.status,
            ActivityLifecycle::Cancelled
                | ActivityLifecycle::Interrupted
                | ActivityLifecycle::Failed
        ) {
            return ClaudeActivityOutput::default();
        }
        let timestamp = unix_millis_to_timestamp(emitted_at_ms);
        let mut candidate = actor.clone();
        candidate.status = lifecycle;
        candidate.updated_at.clone_from(&timestamp);
        candidate.terminal_at = Some(timestamp);
        let Some(summary) = candidate.to_summary() else {
            return ClaudeActivityOutput::default();
        };
        self.terminal_actor_keys.insert(&agent_key);
        self.actors.remove(&agent_key);
        self.insert_terminal_actor(agent_key.clone(), candidate);
        self.tool_owner_by_use_id
            .retain(|_, lifecycle| lifecycle.owner_key != agent_key);
        let mut output = ClaudeActivityOutput::default();
        output.push(ProviderActivityMutation::UpsertActor(summary));
        output
    }

    pub(crate) fn handle_correlated_parent(
        &mut self,
        agent_id: &str,
        parent_agent_id: &str,
        emitted_at_ms: u64,
    ) -> ClaudeActivityOutput {
        if agent_id == parent_agent_id {
            return ClaudeActivityOutput::default();
        }
        let agent_key = retained_key("agent", agent_id);
        let parent_key = retained_key("agent", parent_agent_id);
        let Some(parent_actor_id) = self
            .actors
            .get(&parent_key)
            .map(|actor| actor.canonical_id.clone())
        else {
            return ClaudeActivityOutput::default();
        };
        let Some(actor) = self.actors.get_mut(&agent_key) else {
            return ClaudeActivityOutput::default();
        };
        if actor.parent_actor_id.as_ref() == Some(&parent_actor_id) {
            return ClaudeActivityOutput::default();
        }
        if actor.parent_actor_id.is_some() {
            return ClaudeActivityOutput::default();
        }
        actor.parent_actor_id = Some(parent_actor_id);
        actor.updated_at = unix_millis_to_timestamp(emitted_at_ms);
        let Some(summary) = actor.to_summary() else {
            return ClaudeActivityOutput::default();
        };
        let mut output = ClaudeActivityOutput::default();
        output.push(ProviderActivityMutation::UpsertActor(summary));
        output
    }

    fn insert_terminal_actor(&mut self, agent_key: String, actor: ClaudeActorState) {
        if !self.terminal_actors.contains_key(&agent_key) {
            while self.terminal_actor_order.len() >= MAX_TRACKED_ACTORS {
                if let Some(evicted) = self.terminal_actor_order.pop_front() {
                    self.terminal_actors.remove(&evicted);
                }
            }
            self.terminal_actor_order.push_back(agent_key.clone());
        }
        self.terminal_actors.insert(agent_key, actor);
    }

    fn handle_pre_tool(
        &mut self,
        value: &Value,
        agent_id: &str,
        agent_key: &str,
        emitted_at_ms: u64,
    ) -> ClaudeActivityOutput {
        let Some(tool_use_id) = field(value, "tool_use_id") else {
            return ClaudeActivityOutput::default();
        };
        let Some(raw_tool_name) = field(value, "tool_name") else {
            return ClaudeActivityOutput::default();
        };
        if self.tool_owner_by_use_id.len() >= MAX_TRACKED_TOOL_LIFECYCLES {
            return ClaudeActivityOutput::default();
        }
        let tool_key = retained_key("tool", tool_use_id);
        if self.tool_owner_by_use_id.contains_key(&tool_key) {
            return ClaudeActivityOutput::default();
        }
        let semantic_key = semantic_key(&["PreToolUse", agent_id, tool_use_id]);
        if self.recovery_seen_events.contains(&semantic_key)
            || !self.seen_events.insert(&semantic_key)
        {
            return ClaudeActivityOutput::default();
        }
        self.recovery_seen_events.insert(&semantic_key);
        let Some(actor) = self.actors.get(agent_key) else {
            return ClaudeActivityOutput::default();
        };
        let tool_name = bounded_label(raw_tool_name);
        if tool_name.is_empty() {
            return ClaudeActivityOutput::default();
        }
        let Some(entry_id) = canonical_entry_id(
            "started",
            &self.root_session_key,
            agent_id,
            tool_use_id,
            value,
        ) else {
            return ClaudeActivityOutput::default();
        };
        let detail = safe_command_detail(value, &tool_name);
        let kind = if tool_name == "Bash" {
            ActivityEntryKind::Command
        } else {
            ActivityEntryKind::Tool
        };
        let title = bounded_label(&format!("{tool_name} started"));
        let Some(entry) = ActivityEntry::try_new(
            entry_id,
            ActivityRecordKind::Actor,
            actor.canonical_id.clone(),
            kind,
            title,
            detail.as_deref(),
            ActivityEntryTone::Tool,
            unix_millis_to_timestamp(emitted_at_ms),
        )
        .ok() else {
            return ClaudeActivityOutput::default();
        };
        self.tool_owner_by_use_id.insert(
            tool_key,
            ToolLifecycle {
                owner_key: agent_key.to_owned(),
                owner_id: actor.canonical_id.clone(),
                tool_name,
                tool_name_key: retained_key("tool-name", raw_tool_name),
            },
        );
        let mut output = ClaudeActivityOutput::default();
        output.push(ProviderActivityMutation::AppendEntry(entry));
        output
    }

    fn handle_post_tool(
        &mut self,
        value: &Value,
        agent_id: &str,
        agent_key: &str,
        emitted_at_ms: u64,
        failed: bool,
    ) -> ClaudeActivityOutput {
        let Some(tool_use_id) = field(value, "tool_use_id") else {
            return ClaudeActivityOutput::default();
        };
        let Some(raw_tool_name) = field(value, "tool_name") else {
            return ClaudeActivityOutput::default();
        };
        let tool_name = bounded_label(raw_tool_name);
        if tool_name.is_empty() {
            return ClaudeActivityOutput::default();
        }
        let tool_key = retained_key("tool", tool_use_id);
        let status = if failed { "failed" } else { "completed" };
        let event = if failed {
            "PostToolUseFailure"
        } else {
            "PostToolUse"
        };
        let semantic_key = semantic_key(&[event, agent_id, tool_use_id]);
        if self.seen_events.contains(&semantic_key)
            || self.recovery_seen_events.contains(&semantic_key)
        {
            return ClaudeActivityOutput::default();
        }
        let Some(lifecycle) = self.tool_owner_by_use_id.get(&tool_key).cloned() else {
            return ClaudeActivityOutput::default();
        };
        if lifecycle.owner_key != agent_key
            || lifecycle.tool_name_key != retained_key("tool-name", raw_tool_name)
        {
            return ClaudeActivityOutput::default();
        }
        let Some(entry_id) =
            canonical_entry_id(status, &self.root_session_key, agent_id, tool_use_id, value)
        else {
            return ClaudeActivityOutput::default();
        };
        let kind = if failed {
            ActivityEntryKind::Error
        } else if tool_name == "Bash" {
            ActivityEntryKind::Command
        } else {
            ActivityEntryKind::Tool
        };
        let tone = if failed {
            ActivityEntryTone::Error
        } else {
            ActivityEntryTone::Success
        };
        let detail = failed
            .then(|| value.get("error").and_then(Value::as_str))
            .flatten()
            .and_then(safe_detail);
        let title = bounded_label(&format!("{} {status}", lifecycle.tool_name));
        let Some(entry) = ActivityEntry::try_new(
            entry_id,
            ActivityRecordKind::Actor,
            lifecycle.owner_id.clone(),
            kind,
            title,
            detail.as_deref(),
            tone,
            unix_millis_to_timestamp(emitted_at_ms),
        )
        .ok() else {
            return ClaudeActivityOutput::default();
        };
        if !self.seen_events.insert(&semantic_key) {
            return ClaudeActivityOutput::default();
        }
        self.recovery_seen_events.insert(&semantic_key);
        self.tool_owner_by_use_id.remove(&tool_key);
        let mut output = ClaudeActivityOutput::default();
        output.push(ProviderActivityMutation::AppendEntry(entry));
        output
    }
}

#[doc(hidden)]
#[derive(Debug)]
pub struct ClaudeActivityFixtureAdapter {
    tracker: ClaudeActivityTracker,
}

#[doc(hidden)]
impl ClaudeActivityFixtureAdapter {
    #[must_use]
    pub fn new(root_session_id: &str) -> Self {
        Self {
            tracker: ClaudeActivityTracker::new(root_session_id),
        }
    }

    #[must_use]
    pub fn state_counts(&self) -> ClaudeActivityStateCounts {
        self.tracker.state_counts()
    }

    pub fn handle_value(
        &mut self,
        source: ClaudeActivityInputSource,
        value: &Value,
        emitted_at_ms: u64,
    ) -> ClaudeActivityOutput {
        self.tracker.handle_value(source, value, emitted_at_ms)
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn safe_command_detail(value: &Value, tool_name: &str) -> Option<String> {
    if tool_name != "Bash" {
        return None;
    }
    let command = value.pointer("/tool_input/command")?.as_str()?.trim();
    safe_detail(command)
}

fn safe_summary(value: &str) -> Option<String> {
    safe_display_text(value, bounded_summary)
}

fn safe_detail(value: &str) -> Option<String> {
    safe_display_text(value, bounded_detail)
}

fn safe_display_text(value: &str, bound: fn(&str) -> String) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || text_is_potentially_sensitive(value) {
        return None;
    }
    let display = bound(value);
    (!display.is_empty()).then_some(display)
}

fn text_is_potentially_sensitive(value: &str) -> bool {
    let lowercase = value.to_ascii_lowercase();
    [
        "access_key",
        "api_key",
        "api-key",
        "apikey",
        "authorization",
        "bearer ",
        "client_secret",
        "credential",
        "database_url",
        "do_not_leak",
        "gh_pat",
        "passwd",
        "password",
        "private-key",
        "private_key",
        "secret",
        "token",
        "x-api-key",
    ]
    .iter()
    .any(|marker| lowercase.contains(marker))
        || lowercase.contains("curl -u ")
        || lowercase.contains("curl --user ")
        || contains_credentialed_url(&lowercase)
        || contains_environment_assignment(value)
}

fn contains_credentialed_url(value: &str) -> bool {
    value.split_ascii_whitespace().any(|word| {
        word.split_once("://").is_some_and(|(_, authority)| {
            authority
                .split('/')
                .next()
                .is_some_and(|part| part.contains('@'))
        })
    })
}

fn contains_environment_assignment(value: &str) -> bool {
    value.split_ascii_whitespace().any(|word| {
        let word =
            word.trim_matches(|character: char| matches!(character, '\'' | '"' | '(' | ')' | ';'));
        let Some((name, assigned)) = word.split_once('=') else {
            return false;
        };
        let name = name.strip_suffix('+').unwrap_or(name);
        let mut characters = name.chars();
        !assigned.is_empty()
            && characters
                .next()
                .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
            && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
    })
}

pub(crate) fn canonical_actor_id(agent_id: &str) -> Option<String> {
    canonical_native_id("claude:agent:", agent_id)
}

fn canonical_native_id(prefix: &str, native: &str) -> Option<String> {
    if native.is_empty() {
        return None;
    }
    let inline = format!("{prefix}{native}");
    if inline.encode_utf16().count() <= ACTIVITY_ID_MAX_LENGTH
        && !native.chars().any(char::is_whitespace)
        && !native.starts_with('h')
    {
        return Some(inline);
    }
    Some(format!("{prefix}h{}", framed_digest(&[native])))
}

fn canonical_entry_id(
    status: &str,
    root_session_key: &str,
    agent_id: &str,
    tool_use_id: &str,
    value: &Value,
) -> Option<String> {
    let session_id = field(value, "session_id")?;
    canonical_entry_id_with_session(status, root_session_key, session_id, agent_id, tool_use_id)
}

fn canonical_entry_id_from_parts(
    status: &str,
    root_session_id: &str,
    agent_id: &str,
    tool_use_id: &str,
) -> Option<String> {
    if agent_id.is_empty() || tool_use_id.is_empty() {
        return None;
    }
    canonical_entry_id_with_session(
        status,
        &session_key(root_session_id),
        root_session_id,
        agent_id,
        tool_use_id,
    )
}

fn canonical_entry_id_with_session(
    status: &str,
    root_session_key: &str,
    session_id: &str,
    agent_id: &str,
    tool_use_id: &str,
) -> Option<String> {
    let simple = [session_id, agent_id, tool_use_id, status]
        .iter()
        .all(|component| {
            component
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        });
    if simple && session_key(session_id) == root_session_key {
        let inline = format!("claude:event:tool:{session_id}:{agent_id}:{tool_use_id}:{status}");
        if inline.encode_utf16().count() <= ACTIVITY_ID_MAX_LENGTH {
            return Some(inline);
        }
    }
    Some(format!(
        "claude:event:tool:h{}",
        framed_digest(&[session_id, agent_id, tool_use_id, status])
    ))
}

fn session_key(session_id: &str) -> String {
    retained_key("session", session_id)
}

fn retained_key(namespace: &str, native: &str) -> String {
    format!("{namespace}:{}", framed_digest(&[native]))
}

fn semantic_key(parts: &[&str]) -> String {
    framed_digest(parts)
}

fn framed_digest(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        let length = u64::try_from(part.len()).unwrap_or(u64::MAX);
        digest.update(length.to_be_bytes());
        digest.update(part.as_bytes());
    }
    let mut output = String::with_capacity(64);
    for byte in digest.finalize() {
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

fn bounded_actor_name(role: &str) -> String {
    let role = clip_utf16_units(
        role,
        ACTIVITY_LABEL_MAX_LENGTH.saturating_sub("Claude ".len()),
    );
    format!("Claude {role}")
}

fn bounded_label(value: &str) -> String {
    clip_utf16_units(value.trim(), ACTIVITY_LABEL_MAX_LENGTH)
}

fn bounded_summary(value: &str) -> String {
    clip_utf16_units(value, ACTIVITY_SUMMARY_MAX_LENGTH)
}

fn bounded_detail(value: &str) -> String {
    clip_utf8_bytes(value, ACTIVITY_DETAIL_MAX_LENGTH)
}

fn clip_utf16_units(value: &str, maximum: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|character| {
            let next = units + character.len_utf16();
            if next > maximum {
                return false;
            }
            units = next;
            true
        })
        .collect()
}

fn clip_utf8_bytes(value: &str, maximum: usize) -> String {
    if value.len() <= maximum {
        return value.to_owned();
    }
    let mut end = maximum;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn unix_millis_to_timestamp(milliseconds: u64) -> String {
    let nanos = i128::from(milliseconds).saturating_mul(1_000_000);
    OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .ok()
        .and_then(|timestamp| timestamp.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_owned())
}
