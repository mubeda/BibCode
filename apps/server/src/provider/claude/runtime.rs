use std::{
    collections::{BTreeMap, BTreeSet, HashSet, VecDeque},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::activity::{ClaudeActivityInputSource, ClaudeActivityTracker, canonical_actor_id};
use super::canonical::CanonicalEvent;
use super::protocol::{
    AssistantContent, AssistantMessage, ClaudeMessage, ClaudeTaskNotificationMessage,
    ClaudeTaskStartedMessage, ContentBlock, ContentBlockDelta, ResultMessage, StreamEvent,
    UserContent,
};
use super::transcript::{
    ClaudeRecoveredTranscript, ClaudeTranscriptRecoveryRequest,
    ClaudeTranscriptRecoveryRequestMetadata, records_at_or_after,
};
use super::usage::{ClaudeTokenUsageSnapshot, ClaudeTokenUsageState};
use crate::activity::{
    ACTIVITY_PAGE_MAX_LENGTH, ActivityCapabilities, ActivityHistoryRecovery,
    ActivityObservationState, ProviderActivityControlUpdate, ProviderActivityMutation,
    ProviderActivityNativeTarget,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeMode {
    FullAccess,
    ApprovalRequired,
    AutoAcceptEdits,
    Plan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClaudePermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
}

impl RuntimeMode {
    pub fn permission_mode(self) -> ClaudePermissionMode {
        match self {
            Self::FullAccess => ClaudePermissionMode::BypassPermissions,
            Self::ApprovalRequired => ClaudePermissionMode::Default,
            Self::AutoAcceptEdits => ClaudePermissionMode::AcceptEdits,
            Self::Plan => ClaudePermissionMode::Plan,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequestInput {
    pub thread_id: String,
    pub runtime_mode: RuntimeMode,
    pub cwd: Option<String>,
    pub claude_path: String,
    pub resume_session_id: Option<String>,
    pub new_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub permission_mode: ClaudePermissionMode,
    pub allow_dangerously_skip_permissions: bool,
    pub include_partial_messages: bool,
    pub additional_directories: Vec<String>,
    pub resume: Option<String>,
    pub session_id: Option<String>,
    pub executable: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaudeControlRequest {
    #[serde(rename = "type")]
    message_type: String,
    request_id: String,
    request: ControlRequestBody,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ControlRequestBody {
    Interrupt,
    SetPermissionMode { mode: ClaudePermissionMode },
    CancelRequest { request_id: String },
    GetContextUsage,
    McpStatus,
}

impl ClaudeControlRequest {
    pub fn interrupt(sequence: u64) -> Self {
        Self {
            message_type: "control_request".to_owned(),
            request_id: format!("bibcode-{sequence}"),
            request: ControlRequestBody::Interrupt,
        }
    }

    pub fn set_permission_mode(sequence: u64, mode: ClaudePermissionMode) -> Self {
        Self {
            message_type: "control_request".to_owned(),
            request_id: format!("bibcode-{sequence}"),
            request: ControlRequestBody::SetPermissionMode { mode },
        }
    }

    pub fn cancel_request(sequence: u64, request_id: &str) -> Self {
        Self {
            message_type: "control_request".to_owned(),
            request_id: format!("bibcode-{sequence}"),
            request: ControlRequestBody::CancelRequest {
                request_id: request_id.to_owned(),
            },
        }
    }

    pub fn get_context_usage(sequence: u64) -> Self {
        Self {
            message_type: "control_request".to_owned(),
            request_id: format!("bibcode-{sequence}"),
            request: ControlRequestBody::GetContextUsage,
        }
    }

    pub fn mcp_status(sequence: u64) -> Self {
        Self {
            message_type: "control_request".to_owned(),
            request_id: format!("bibcode-{sequence}"),
            request: ControlRequestBody::McpStatus,
        }
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Accept,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnInput {
    pub turn_id: String,
    pub input: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestInput {
    pub tool_name: String,
    pub input: Value,
    pub tool_use_id: String,
    #[serde(default)]
    pub suggestions: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputRequestInput {
    pub tool_name: String,
    pub input: Value,
    pub tool_use_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedUserInput {
    pub updated_input: Value,
    pub events: Vec<CanonicalEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectSnapshot {
    pub session_id: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub runtime_mode: RuntimeMode,
    #[serde(default)]
    pub pending_approvals: Vec<Value>,
    #[serde(default)]
    pub pending_user_inputs: Vec<Value>,
}

#[derive(Debug, Clone)]
struct InFlightTool {
    index: u64,
    tool_use_id: String,
    tool_name: String,
    input: Value,
    result: Option<Value>,
    stopped: bool,
    completed: bool,
}

#[derive(Debug, Clone)]
struct PendingApproval {
    provider_item_id: String,
    raw: Value,
}

#[derive(Debug, Clone)]
struct PendingUserInput {
    provider_item_id: String,
    original_input: Value,
    raw: Value,
}

#[derive(Debug, Default)]
struct ClaudeTaskCorrelation {
    invocation_is_agent: Option<bool>,
    launched_agent_id: Option<String>,
    task_id: Option<String>,
    conflicted: bool,
}

#[derive(Debug, Eq, PartialEq)]
enum ClaudeTaskControlEffect {
    Install { agent_id: String, task_id: String },
    Retire { agent_id: String },
    Stopped { agent_id: String },
}

struct ClaudeTaskControlCorrelator {
    root_session_id: String,
    generation: u64,
    correlations_by_tool_use: BTreeMap<String, ClaudeTaskCorrelation>,
    verified_agents: BTreeSet<String>,
    actor_target_by_agent: BTreeMap<String, String>,
    agent_by_task: BTreeMap<String, String>,
    terminal_status_by_task: BTreeSet<String>,
    terminal_status_order: VecDeque<String>,
    saturated: bool,
}

impl std::fmt::Debug for ClaudeTaskControlCorrelator {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ClaudeTaskControlCorrelator")
            .field("generation", &self.generation)
            .field("correlation_count", &self.correlations_by_tool_use.len())
            .field("verified_agent_count", &self.verified_agents.len())
            .field("active_target_count", &self.actor_target_by_agent.len())
            .field("task_count", &self.agent_by_task.len())
            .field("terminal_count", &self.terminal_status_by_task.len())
            .field("saturated", &self.saturated)
            .finish()
    }
}

impl ClaudeTaskControlCorrelator {
    fn new(root_session_id: &str, generation: u64) -> Self {
        Self {
            root_session_id: root_session_id.to_owned(),
            generation,
            correlations_by_tool_use: BTreeMap::new(),
            verified_agents: BTreeSet::new(),
            actor_target_by_agent: BTreeMap::new(),
            agent_by_task: BTreeMap::new(),
            terminal_status_by_task: BTreeSet::new(),
            terminal_status_order: VecDeque::new(),
            saturated: false,
        }
    }

    fn reset(&mut self, root_session_id: &str, generation: u64) {
        *self = Self::new(root_session_id, generation);
    }

    fn accepts(&self, session_id: &str, generation: u64) -> bool {
        generation == self.generation
            && session_id == self.root_session_id
            && usable_control_identity(session_id)
    }

    fn correlation_mut(&mut self, tool_use_id: &str) -> Option<&mut ClaudeTaskCorrelation> {
        if self.correlations_by_tool_use.contains_key(tool_use_id) {
            return self.correlations_by_tool_use.get_mut(tool_use_id);
        }
        if self.saturated || self.correlations_by_tool_use.len() >= ACTIVITY_PAGE_MAX_LENGTH {
            self.saturated = true;
            return None;
        }
        self.correlations_by_tool_use
            .insert(tool_use_id.to_owned(), ClaudeTaskCorrelation::default());
        self.correlations_by_tool_use.get_mut(tool_use_id)
    }

    fn observe_tool_invocation(
        &mut self,
        session_id: &str,
        generation: u64,
        tool_use_id: &str,
        tool_name: &str,
    ) -> Vec<ClaudeTaskControlEffect> {
        if !self.accepts(session_id, generation)
            || !usable_control_identity(tool_use_id)
            || !usable_control_label(tool_name)
        {
            return Vec::new();
        }
        let is_agent = matches!(tool_name, "Agent" | "Task");
        let conflict = {
            let Some(record) = self.correlation_mut(tool_use_id) else {
                return Vec::new();
            };
            match record.invocation_is_agent {
                Some(existing) if existing != is_agent => true,
                Some(_) => false,
                None => {
                    record.invocation_is_agent = Some(is_agent);
                    false
                }
            }
        };
        if conflict {
            return self.poison(tool_use_id);
        }
        self.reconcile(tool_use_id)
    }

    fn observe_async_launch(
        &mut self,
        session_id: &str,
        generation: u64,
        tool_use_id: &str,
        tool_name: &str,
        status: &str,
        agent_id: &str,
    ) -> Vec<ClaudeTaskControlEffect> {
        if !self.accepts(session_id, generation)
            || !usable_control_identity(tool_use_id)
            || !usable_control_identity(agent_id)
        {
            return Vec::new();
        }
        let valid = matches!(tool_name, "Agent" | "Task") && status == "async_launched";
        let conflict = {
            let Some(record) = self.correlation_mut(tool_use_id) else {
                return Vec::new();
            };
            if !valid {
                true
            } else {
                match record.launched_agent_id.as_deref() {
                    Some(existing) if existing != agent_id => true,
                    Some(_) => false,
                    None => {
                        record.launched_agent_id = Some(agent_id.to_owned());
                        false
                    }
                }
            }
        };
        if conflict {
            return self.poison(tool_use_id);
        }
        self.reconcile(tool_use_id)
    }

    fn observe_task_started(
        &mut self,
        generation: u64,
        message: &ClaudeTaskStartedMessage,
    ) -> Vec<ClaudeTaskControlEffect> {
        if !self.accepts(&message.session_id, generation)
            || !usable_control_identity(&message.tool_use_id)
            || !usable_control_identity(&message.task_id)
        {
            return Vec::new();
        }
        let conflict = {
            let Some(record) = self.correlation_mut(&message.tool_use_id) else {
                return Vec::new();
            };
            if message.task_type != "local_agent" {
                true
            } else {
                match record.task_id.as_deref() {
                    Some(existing) if existing != message.task_id => true,
                    Some(_) => false,
                    None => {
                        record.task_id = Some(message.task_id.clone());
                        false
                    }
                }
            }
        };
        if conflict {
            return self.poison(&message.tool_use_id);
        }
        self.reconcile(&message.tool_use_id)
    }

    fn observe_verified_agent(
        &mut self,
        session_id: &str,
        generation: u64,
        agent_id: &str,
    ) -> Vec<ClaudeTaskControlEffect> {
        if !self.accepts(session_id, generation) || !usable_control_identity(agent_id) {
            return Vec::new();
        }
        if !self.verified_agents.contains(agent_id) {
            let known = self
                .correlations_by_tool_use
                .values()
                .any(|record| record.launched_agent_id.as_deref() == Some(agent_id));
            if (self.saturated && !known) || self.verified_agents.len() >= ACTIVITY_PAGE_MAX_LENGTH
            {
                self.saturated = true;
                return Vec::new();
            }
            self.verified_agents.insert(agent_id.to_owned());
        }
        let tool_use_ids = self
            .correlations_by_tool_use
            .iter()
            .filter_map(|(tool_use_id, record)| {
                (record.launched_agent_id.as_deref() == Some(agent_id))
                    .then_some(tool_use_id.clone())
            })
            .collect::<Vec<_>>();
        tool_use_ids
            .into_iter()
            .flat_map(|tool_use_id| self.reconcile(&tool_use_id))
            .collect()
    }

    fn observe_task_notification(
        &mut self,
        generation: u64,
        message: &ClaudeTaskNotificationMessage,
    ) -> Vec<ClaudeTaskControlEffect> {
        if message.status != "stopped"
            || !self.accepts(&message.session_id, generation)
            || !usable_control_identity(&message.task_id)
        {
            return Vec::new();
        }
        let mapped_agent = self.agent_by_task.get(&message.task_id).cloned();
        self.remember_terminal_task(&message.task_id);
        let Some(agent_id) = mapped_agent else {
            return Vec::new();
        };
        self.retire_terminal_mapping(&message.task_id, &agent_id);
        vec![
            ClaudeTaskControlEffect::Retire {
                agent_id: agent_id.clone(),
            },
            ClaudeTaskControlEffect::Stopped { agent_id },
        ]
    }

    fn remember_terminal_task(&mut self, task_id: &str) {
        if self.terminal_status_by_task.contains(task_id) {
            return;
        }
        while self.terminal_status_order.len() >= ACTIVITY_PAGE_MAX_LENGTH {
            if let Some(evicted) = self.terminal_status_order.pop_front() {
                self.terminal_status_by_task.remove(&evicted);
            }
        }
        self.terminal_status_by_task.insert(task_id.to_owned());
        self.terminal_status_order.push_back(task_id.to_owned());
    }

    fn observe_agent_stop(
        &mut self,
        session_id: &str,
        generation: u64,
        agent_id: &str,
    ) -> Vec<ClaudeTaskControlEffect> {
        if !self.accepts(session_id, generation) || !usable_control_identity(agent_id) {
            return Vec::new();
        }
        self.actor_target_by_agent
            .remove(agent_id)
            .map(|_| ClaudeTaskControlEffect::Retire {
                agent_id: agent_id.to_owned(),
            })
            .into_iter()
            .collect()
    }

    fn poison(&mut self, tool_use_id: &str) -> Vec<ClaudeTaskControlEffect> {
        let agent_id = self
            .correlations_by_tool_use
            .get_mut(tool_use_id)
            .and_then(|record| {
                record.conflicted = true;
                record.launched_agent_id.clone()
            });
        agent_id
            .map(|agent_id| self.poison_agent(&agent_id))
            .unwrap_or_default()
    }

    fn reconcile(&mut self, tool_use_id: &str) -> Vec<ClaudeTaskControlEffect> {
        let Some((agent_id, task_id)) =
            self.correlations_by_tool_use
                .get(tool_use_id)
                .and_then(|record| {
                    (!record.conflicted && record.invocation_is_agent == Some(true)).then(|| {
                        Some((record.launched_agent_id.clone()?, record.task_id.clone()?))
                    })?
                })
        else {
            return Vec::new();
        };
        if !self.verified_agents.contains(&agent_id) {
            return Vec::new();
        }

        let mut effects = Vec::new();
        if let Some(existing_task) = self.actor_target_by_agent.get(&agent_id)
            && existing_task != &task_id
        {
            effects.extend(self.poison_agent(&agent_id));
            if let Some(record) = self.correlations_by_tool_use.get_mut(tool_use_id) {
                record.conflicted = true;
            }
            return effects;
        }
        if let Some(existing_agent) = self.agent_by_task.get(&task_id).cloned()
            && existing_agent != agent_id
        {
            effects.extend(self.poison_task(&task_id));
            if let Some(record) = self.correlations_by_tool_use.get_mut(tool_use_id) {
                record.conflicted = true;
            }
            return effects;
        }
        if self.actor_target_by_agent.contains_key(&agent_id) {
            return effects;
        }
        if self.actor_target_by_agent.len() >= ACTIVITY_PAGE_MAX_LENGTH
            || (self.agent_by_task.len() >= ACTIVITY_PAGE_MAX_LENGTH
                && !self.agent_by_task.contains_key(&task_id))
        {
            self.saturated = true;
            return effects;
        }
        self.agent_by_task.insert(task_id.clone(), agent_id.clone());
        if self.terminal_status_by_task.contains(&task_id) {
            self.retire_terminal_mapping(&task_id, &agent_id);
            effects.push(ClaudeTaskControlEffect::Stopped { agent_id });
        } else {
            self.actor_target_by_agent
                .insert(agent_id.clone(), task_id.clone());
            effects.push(ClaudeTaskControlEffect::Install { agent_id, task_id });
        }
        effects
    }

    fn retire_terminal_mapping(&mut self, task_id: &str, agent_id: &str) {
        self.actor_target_by_agent.remove(agent_id);
        self.agent_by_task.remove(task_id);
        self.verified_agents.remove(agent_id);
        self.terminal_status_by_task.remove(task_id);
        self.terminal_status_order
            .retain(|retained| retained != task_id);
        self.correlations_by_tool_use.retain(|_, record| {
            record.task_id.as_deref() != Some(task_id)
                && record.launched_agent_id.as_deref() != Some(agent_id)
        });
    }

    fn poison_agent(&mut self, agent_id: &str) -> Vec<ClaudeTaskControlEffect> {
        for record in self.correlations_by_tool_use.values_mut() {
            if record.launched_agent_id.as_deref() == Some(agent_id) {
                record.conflicted = true;
            }
        }
        let task_id = self.actor_target_by_agent.remove(agent_id);
        if let Some(task_id) = task_id.as_ref()
            && self.agent_by_task.get(task_id).map(String::as_str) == Some(agent_id)
        {
            self.agent_by_task.remove(task_id);
        }
        task_id
            .map(|_| ClaudeTaskControlEffect::Retire {
                agent_id: agent_id.to_owned(),
            })
            .into_iter()
            .collect()
    }

    fn poison_task(&mut self, task_id: &str) -> Vec<ClaudeTaskControlEffect> {
        for record in self.correlations_by_tool_use.values_mut() {
            if record.task_id.as_deref() == Some(task_id) {
                record.conflicted = true;
            }
        }
        let agent_id = self.agent_by_task.remove(task_id);
        agent_id
            .and_then(|agent_id| {
                self.actor_target_by_agent.remove(&agent_id)?;
                Some(ClaudeTaskControlEffect::Retire { agent_id })
            })
            .into_iter()
            .collect()
    }

    #[cfg(test)]
    fn state_is_bounded(&self) -> bool {
        self.correlations_by_tool_use.len() <= ACTIVITY_PAGE_MAX_LENGTH
            && self.verified_agents.len() <= ACTIVITY_PAGE_MAX_LENGTH
            && self.actor_target_by_agent.len() <= ACTIVITY_PAGE_MAX_LENGTH
            && self.agent_by_task.len() <= ACTIVITY_PAGE_MAX_LENGTH
            && self.terminal_status_by_task.len() <= ACTIVITY_PAGE_MAX_LENGTH
            && self.terminal_status_order.len() <= ACTIVITY_PAGE_MAX_LENGTH
    }
}

fn usable_control_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.chars().any(char::is_whitespace)
        && !value.chars().any(char::is_control)
}

fn usable_control_label(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

#[derive(Debug, Default)]
pub struct ClaudeRuntimeOutput {
    pub events: Vec<CanonicalEvent>,
    pub activity: Vec<ProviderActivityMutation>,
    pub native_event_id: Option<String>,
    pub(crate) activity_controls: Vec<ProviderActivityControlUpdate>,
    pub(crate) recovery_request: Option<ClaudeTranscriptRecoveryRequest>,
}

impl ClaudeRuntimeOutput {
    #[doc(hidden)]
    #[must_use]
    pub fn recovery_request_metadata(&self) -> Option<ClaudeTranscriptRecoveryRequestMetadata> {
        self.recovery_request.as_ref().map(Into::into)
    }
}

#[derive(Debug)]
pub struct ClaudeProviderRuntime {
    thread_id: String,
    session_id: String,
    runtime_mode: Option<RuntimeMode>,
    current_turn_id: Option<String>,
    pending_approvals: BTreeMap<String, PendingApproval>,
    pending_user_inputs: BTreeMap<String, PendingUserInput>,
    in_flight_tools: BTreeMap<String, InFlightTool>,
    activity_tracker: ClaudeActivityTracker,
    task_control_correlator: ClaudeTaskControlCorrelator,
    agent_activity_enabled: bool,
    activity_generation: u64,
    activity_not_before_unix_nanos: i128,
    correlated_activity_enabled: bool,
    token_usage: ClaudeTokenUsageState,
    last_mcp_status: Option<Vec<Value>>,
}

impl ClaudeProviderRuntime {
    pub fn new(thread_id: String, session_id: String) -> Self {
        Self::new_with_agent_activity_enabled(thread_id, session_id, true)
    }

    pub(crate) fn new_with_agent_activity_enabled(
        thread_id: String,
        session_id: String,
        agent_activity_enabled: bool,
    ) -> Self {
        let activity_tracker = ClaudeActivityTracker::new(&session_id);
        let task_control_correlator = ClaudeTaskControlCorrelator::new(&session_id, 0);
        Self {
            thread_id,
            session_id,
            runtime_mode: None,
            current_turn_id: None,
            pending_approvals: BTreeMap::new(),
            pending_user_inputs: BTreeMap::new(),
            in_flight_tools: BTreeMap::new(),
            activity_tracker,
            task_control_correlator,
            agent_activity_enabled,
            activity_generation: 0,
            activity_not_before_unix_nanos: i128::MIN,
            correlated_activity_enabled: false,
            token_usage: ClaudeTokenUsageState::default(),
            last_mcp_status: None,
        }
    }

    pub fn set_agent_activity_enabled(&mut self, enabled: bool) {
        if self.agent_activity_enabled == enabled {
            return;
        }
        self.agent_activity_enabled = enabled;
        self.activity_generation = self.activity_generation.wrapping_add(1);
        self.task_control_correlator
            .reset(&self.session_id, self.activity_generation);
        if enabled {
            self.activity_tracker = ClaudeActivityTracker::new(&self.session_id);
            self.activity_not_before_unix_nanos = current_unix_nanos();
            self.correlated_activity_enabled = false;
        }
    }

    pub fn build_launch_request(input: LaunchRequestInput) -> LaunchRequest {
        let permission_mode = input.runtime_mode.permission_mode();
        LaunchRequest {
            permission_mode,
            allow_dangerously_skip_permissions: permission_mode
                == ClaudePermissionMode::BypassPermissions,
            include_partial_messages: true,
            additional_directories: input.cwd.into_iter().collect(),
            resume: input.resume_session_id,
            session_id: input.new_session_id,
            executable: input.claude_path,
        }
    }

    pub fn start_session(
        &mut self,
        runtime_mode: RuntimeMode,
        cwd: Option<String>,
    ) -> Vec<CanonicalEvent> {
        self.runtime_mode = Some(runtime_mode);
        vec![
            self.event(
                "session.started",
                None,
                None,
                None,
                json!({
                    "message": "Claude session started.",
                    "resume": { "sessionId": self.session_id },
                }),
            ),
            self.event(
                "session.configured",
                None,
                None,
                None,
                json!({
                    "permissionMode": runtime_mode.permission_mode(),
                    "cwd": cwd,
                }),
            ),
            self.event(
                "session.state.changed",
                None,
                None,
                None,
                json!({ "state": "ready" }),
            ),
        ]
    }

    pub fn start_turn(&mut self, input: TurnInput) -> Vec<CanonicalEvent> {
        self.token_usage.start_turn();
        self.current_turn_id = Some(input.turn_id.clone());
        vec![self.event(
            "turn.started",
            Some(input.turn_id),
            None,
            None,
            json!({ "input": input.input }),
        )]
    }

    pub fn handle_message(&mut self, message: ClaudeMessage) -> Vec<CanonicalEvent> {
        match message {
            ClaudeMessage::StreamEvent(message) => self.handle_stream_event(message.event),
            ClaudeMessage::System(_) => Vec::new(),
            ClaudeMessage::User(message) => self.handle_user_message(message.message.content),
            ClaudeMessage::Assistant(message) => self.handle_assistant_message(message),
            ClaudeMessage::Result(message) => self.handle_result_message(message),
        }
    }

    pub fn handle_raw_value(&mut self, value: &Value, emitted_at_ms: u64) -> ClaudeRuntimeOutput {
        self.handle_raw_value_inner(value, emitted_at_ms, false)
    }

    #[doc(hidden)]
    pub fn handle_authenticated_hook_value(
        &mut self,
        value: &Value,
        emitted_at_ms: u64,
    ) -> ClaudeRuntimeOutput {
        self.handle_raw_value_inner(value, emitted_at_ms, true)
    }

    fn handle_raw_value_inner(
        &mut self,
        value: &Value,
        emitted_at_ms: u64,
        authenticated_hook: bool,
    ) -> ClaudeRuntimeOutput {
        let token_usage = self.token_usage.observe_stream_value(value);
        let turn_id = self.current_turn_id.clone();
        let mut output = self.handle_non_usage_raw_value(value, emitted_at_ms, authenticated_hook);
        if let (Some(turn_id), Some(usage)) = (turn_id, token_usage) {
            output
                .events
                .insert(0, self.token_usage_event(turn_id, usage));
        }
        output
    }

    fn handle_non_usage_raw_value(
        &mut self,
        value: &Value,
        emitted_at_ms: u64,
        authenticated_hook: bool,
    ) -> ClaudeRuntimeOutput {
        if value
            .get("hook_event_name")
            .and_then(Value::as_str)
            .is_some()
        {
            if !self.agent_activity_enabled {
                return ClaudeRuntimeOutput::default();
            }
            if !claude_hook_identity_fields_are_safe(value) {
                return ClaudeRuntimeOutput::default();
            }
            let recovery_request = authenticated_hook
                .then(|| {
                    let session_id = value.get("session_id").and_then(Value::as_str)?;
                    let agent_id = value.get("agent_id").and_then(Value::as_str)?;
                    ClaudeTranscriptRecoveryRequest::from_authenticated_hook_for_epoch(
                        value,
                        self.activity_tracker
                            .is_correlated_actor(session_id, agent_id),
                        self.activity_generation,
                        self.activity_not_before_unix_nanos,
                    )
                })
                .flatten();
            let output = self.activity_tracker.handle_value(
                ClaudeActivityInputSource::HookInput,
                value,
                emitted_at_ms,
            );
            let control_effects = if authenticated_hook {
                self.observe_authenticated_control_hook(value)
            } else {
                Vec::new()
            };
            let (terminal_activity, activity_controls) =
                self.apply_task_control_effects(control_effects, emitted_at_ms);
            if output.mutations.is_empty()
                && terminal_activity.is_empty()
                && activity_controls.is_empty()
                && recovery_request.is_none()
            {
                return ClaudeRuntimeOutput::default();
            }
            let mut activity = output.mutations;
            activity.extend(terminal_activity);
            if !self.correlated_activity_enabled {
                activity.insert(
                    0,
                    ProviderActivityMutation::SetScope {
                        capabilities: ActivityCapabilities {
                            actors: true,
                            attributed_activity: true,
                            background_work: false,
                            history_recovery: ActivityHistoryRecovery::None,
                            terminal_observation: false,
                            targeted_actor_cancellation: false,
                        },
                        observation_state: ActivityObservationState::Live,
                    },
                );
                self.correlated_activity_enabled = true;
            }
            return ClaudeRuntimeOutput {
                events: Vec::new(),
                activity,
                native_event_id: claude_hook_native_event_id(value),
                activity_controls,
                recovery_request,
            };
        }

        if value.get("type").and_then(Value::as_str) == Some("system") {
            let effects = match value.get("subtype").and_then(Value::as_str) {
                Some("task_started") => {
                    serde_json::from_value::<ClaudeTaskStartedMessage>(value.clone())
                        .ok()
                        .map(|message| {
                            self.task_control_correlator
                                .observe_task_started(self.activity_generation, &message)
                        })
                        .unwrap_or_default()
                }
                Some("task_notification") => {
                    serde_json::from_value::<ClaudeTaskNotificationMessage>(value.clone())
                        .ok()
                        .map(|message| {
                            self.task_control_correlator
                                .observe_task_notification(self.activity_generation, &message)
                        })
                        .unwrap_or_default()
                }
                _ => Vec::new(),
            };
            let (activity, activity_controls) =
                self.apply_task_control_effects(effects, emitted_at_ms);
            let events = if value.get("subtype").and_then(Value::as_str) == Some("init") {
                value
                    .get("mcp_servers")
                    .and_then(|servers| self.mcp_status_event(servers))
                    .into_iter()
                    .collect()
            } else {
                Vec::new()
            };
            return ClaudeRuntimeOutput {
                events,
                activity,
                activity_controls,
                ..ClaudeRuntimeOutput::default()
            };
        }
        let control_effects = root_agent_tool_identity(value)
            .map(|(session_id, tool_use_id, tool_name)| {
                self.task_control_correlator.observe_tool_invocation(
                    session_id,
                    self.activity_generation,
                    tool_use_id,
                    tool_name,
                )
            })
            .unwrap_or_default();
        let (_, activity_controls) =
            self.apply_task_control_effects(control_effects, emitted_at_ms);
        let Ok(message) = serde_json::from_value::<ClaudeMessage>(value.clone()) else {
            return ClaudeRuntimeOutput {
                activity_controls,
                ..ClaudeRuntimeOutput::default()
            };
        };
        let events = match claude_message_route(&message) {
            ClaudeMessageRoute::Root => self.handle_message(message),
            ClaudeMessageRoute::ForwardedTaskLifecycle { parent_tool_use_id } => {
                correlate_forwarded_task_events(self.handle_message(message), &parent_tool_use_id)
            }
            ClaudeMessageRoute::SuppressedChildText => Vec::new(),
        };
        ClaudeRuntimeOutput {
            events,
            activity: Vec::new(),
            native_event_id: None,
            activity_controls,
            recovery_request: None,
        }
    }

    fn observe_authenticated_control_hook(
        &mut self,
        value: &Value,
    ) -> Vec<ClaudeTaskControlEffect> {
        let Some(session_id) = value.get("session_id").and_then(Value::as_str) else {
            return Vec::new();
        };
        match value.get("hook_event_name").and_then(Value::as_str) {
            Some("PostToolUse") => {
                let Some(tool_use_id) = value.get("tool_use_id").and_then(Value::as_str) else {
                    return Vec::new();
                };
                let Some(tool_name) = value.get("tool_name").and_then(Value::as_str) else {
                    return Vec::new();
                };
                let Some(status) = value
                    .pointer("/tool_response/status")
                    .and_then(Value::as_str)
                else {
                    return Vec::new();
                };
                let Some(agent_id) = value
                    .pointer("/tool_response/agentId")
                    .and_then(Value::as_str)
                else {
                    return Vec::new();
                };
                self.task_control_correlator.observe_async_launch(
                    session_id,
                    self.activity_generation,
                    tool_use_id,
                    tool_name,
                    status,
                    agent_id,
                )
            }
            Some("SubagentStart") => value
                .get("agent_id")
                .and_then(Value::as_str)
                .map(|agent_id| {
                    self.task_control_correlator.observe_verified_agent(
                        session_id,
                        self.activity_generation,
                        agent_id,
                    )
                })
                .unwrap_or_default(),
            Some("SubagentStop") => value
                .get("agent_id")
                .and_then(Value::as_str)
                .map(|agent_id| {
                    self.task_control_correlator.observe_agent_stop(
                        session_id,
                        self.activity_generation,
                        agent_id,
                    )
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    fn apply_task_control_effects(
        &mut self,
        effects: Vec<ClaudeTaskControlEffect>,
        emitted_at_ms: u64,
    ) -> (
        Vec<ProviderActivityMutation>,
        Vec<ProviderActivityControlUpdate>,
    ) {
        let mut activity = Vec::new();
        let mut controls = Vec::new();
        for effect in effects {
            match effect {
                ClaudeTaskControlEffect::Install { agent_id, task_id } => {
                    let Some(actor_id) = canonical_actor_id(&agent_id) else {
                        continue;
                    };
                    controls.push(ProviderActivityControlUpdate::ActorTarget {
                        actor_id,
                        target: Some(ProviderActivityNativeTarget::claude_task(task_id)),
                    });
                }
                ClaudeTaskControlEffect::Retire { agent_id } => {
                    let Some(actor_id) = canonical_actor_id(&agent_id) else {
                        continue;
                    };
                    controls.push(ProviderActivityControlUpdate::ActorTarget {
                        actor_id,
                        target: None,
                    });
                }
                ClaudeTaskControlEffect::Stopped { agent_id } => {
                    activity.extend(
                        self.activity_tracker
                            .handle_task_stopped(&agent_id, emitted_at_ms)
                            .mutations,
                    );
                }
            }
        }
        (activity, controls)
    }

    pub(crate) fn apply_context_usage_response(
        &mut self,
        turn_id: &str,
        response: &Value,
    ) -> Option<CanonicalEvent> {
        if self.current_turn_id.as_deref() != Some(turn_id) {
            return None;
        }
        let usage = self.token_usage.observe_context_response(response)?;
        Some(self.token_usage_event(turn_id.to_owned(), usage))
    }

    #[doc(hidden)]
    pub fn apply_context_usage_response_for_test(
        &mut self,
        turn_id: &str,
        response: &Value,
    ) -> Option<CanonicalEvent> {
        self.apply_context_usage_response(turn_id, response)
    }

    pub(crate) fn apply_mcp_status_response(&mut self, response: &Value) -> Option<CanonicalEvent> {
        self.mcp_status_event(response.get("mcpServers")?)
    }

    #[doc(hidden)]
    pub fn apply_mcp_status_response_for_test(
        &mut self,
        response: &Value,
    ) -> Option<CanonicalEvent> {
        self.apply_mcp_status_response(response)
    }

    pub(crate) fn handle_recovered_transcript(
        &mut self,
        recovered: ClaudeRecoveredTranscript,
    ) -> ClaudeRuntimeOutput {
        if !self.agent_activity_enabled
            || recovered.root_session_id != self.session_id
            || recovered.generation != self.activity_generation
            || recovered.not_before_unix_nanos != self.activity_not_before_unix_nanos
        {
            return ClaudeRuntimeOutput::default();
        }
        let records = records_at_or_after(recovered.records, self.activity_not_before_unix_nanos);
        let mut activity = self
            .activity_tracker
            .handle_recovered_records(&recovered.agent_id, &recovered.agent_type, &records)
            .mutations;
        activity.push(ProviderActivityMutation::SetScope {
            capabilities: ActivityCapabilities {
                actors: self.correlated_activity_enabled,
                attributed_activity: self.correlated_activity_enabled,
                background_work: false,
                history_recovery: ActivityHistoryRecovery::Bounded,
                terminal_observation: false,
                targeted_actor_cancellation: false,
            },
            observation_state: ActivityObservationState::Live,
        });
        ClaudeRuntimeOutput {
            events: Vec::new(),
            activity,
            native_event_id: Some(recovered.native_event_id),
            activity_controls: Vec::new(),
            recovery_request: None,
        }
    }

    pub fn handle_assistant_message(&mut self, message: AssistantMessage) -> Vec<CanonicalEvent> {
        let mut events = Vec::new();
        for content in message.message.content {
            if let AssistantContent::ToolUse { id, name, input } = content
                && name == "ExitPlanMode"
                && let Some(plan_markdown) = input
                    .get("plan")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            {
                events.push(self.event(
                    "turn.proposed.completed",
                    self.current_turn_id.clone(),
                    None,
                    Some(json!({ "providerItemId": id })),
                    json!({ "planMarkdown": plan_markdown }),
                ));
            }
        }
        events
    }

    pub fn open_permission_request(
        &mut self,
        input: PermissionRequestInput,
        request_id: &str,
    ) -> Vec<CanonicalEvent> {
        let provider_item_id = input.tool_use_id.clone();
        let tool_name = input.tool_name.clone();
        let tool_input = input.input.clone();
        let suggestions = input.suggestions.clone();
        self.pending_approvals.insert(
            request_id.to_owned(),
            PendingApproval {
                provider_item_id: provider_item_id.clone(),
                raw: json!({
                    "requestId": request_id,
                    "providerItemId": provider_item_id,
                    "toolName": tool_name,
                    "input": tool_input,
                    "suggestions": suggestions,
                }),
            },
        );
        vec![self.event(
            "request.opened",
            self.current_turn_id.clone(),
            Some(request_id.to_owned()),
            Some(json!({ "providerItemId": input.tool_use_id })),
            json!({
                "requestType": classify_request_type(&input.tool_name),
                "toolName": input.tool_name,
                "input": input.input,
                "suggestions": input.suggestions,
            }),
        )]
    }

    pub fn resolve_permission_request(
        &mut self,
        request_id: &str,
        decision: Decision,
    ) -> Vec<CanonicalEvent> {
        let Some(pending) = self.pending_approvals.remove(request_id) else {
            return Vec::new();
        };
        vec![self.event(
            "request.resolved",
            self.current_turn_id.clone(),
            Some(request_id.to_owned()),
            Some(json!({ "providerItemId": pending.provider_item_id })),
            json!({ "decision": decision }),
        )]
    }

    pub fn open_user_input_request(
        &mut self,
        input: UserInputRequestInput,
        request_id: &str,
    ) -> Vec<CanonicalEvent> {
        let questions = normalize_questions(&input.input);
        let provider_item_id = input.tool_use_id.clone();
        self.pending_user_inputs.insert(
            request_id.to_owned(),
            PendingUserInput {
                provider_item_id: provider_item_id.clone(),
                original_input: input.input.clone(),
                raw: json!({
                    "requestId": request_id,
                    "providerItemId": provider_item_id,
                    "questions": questions.clone(),
                }),
            },
        );
        vec![self.event(
            "user-input.requested",
            self.current_turn_id.clone(),
            Some(request_id.to_owned()),
            Some(json!({ "providerItemId": input.tool_use_id })),
            json!({ "questions": questions }),
        )]
    }

    pub fn resolve_user_input_request(
        &mut self,
        request_id: &str,
        answers: Value,
    ) -> ResolvedUserInput {
        let pending = self
            .pending_user_inputs
            .remove(request_id)
            .expect("pending user input request");
        let updated_input = json!({
            "questions": pending
                .original_input
                .get("questions")
                .cloned()
                .unwrap_or_else(|| json!([])),
            "answers": answers.clone(),
        });
        let events = vec![self.event(
            "user-input.resolved",
            self.current_turn_id.clone(),
            Some(request_id.to_owned()),
            Some(json!({ "providerItemId": pending.provider_item_id })),
            json!({ "answers": answers }),
        )];
        ResolvedUserInput {
            updated_input,
            events,
        }
    }

    pub fn handle_stream_failure(&mut self, error: &str) -> Vec<CanonicalEvent> {
        let error_message = if is_interrupted_error(error) {
            "Claude runtime interrupted.".to_owned()
        } else {
            error.to_owned()
        };
        vec![
            self.event(
                "turn.completed",
                self.current_turn_id.clone(),
                None,
                None,
                json!({
                    "state": "interrupted",
                    "errorMessage": error_message,
                }),
            ),
            self.event(
                "session.exited",
                None,
                None,
                None,
                json!({ "reason": "stream_failure" }),
            ),
        ]
    }

    pub fn snapshot(&self) -> ReconnectSnapshot {
        ReconnectSnapshot {
            session_id: self.session_id.clone(),
            thread_id: self.thread_id.clone(),
            turn_id: self.current_turn_id.clone(),
            runtime_mode: self.runtime_mode.unwrap_or(RuntimeMode::ApprovalRequired),
            pending_approvals: self
                .pending_approvals
                .values()
                .map(|pending| pending.raw.clone())
                .collect(),
            pending_user_inputs: self
                .pending_user_inputs
                .values()
                .map(|pending| pending.raw.clone())
                .collect(),
        }
    }

    pub fn restore_from_snapshot(&mut self, snapshot: ReconnectSnapshot) {
        self.session_id = snapshot.session_id;
        self.thread_id = snapshot.thread_id;
        self.current_turn_id = snapshot.turn_id;
        self.runtime_mode = Some(snapshot.runtime_mode);
        self.pending_approvals = snapshot
            .pending_approvals
            .into_iter()
            .filter_map(|value| {
                let request_id = value.get("requestId")?.as_str()?.to_owned();
                let provider_item_id = value.get("providerItemId")?.as_str()?.to_owned();
                Some((
                    request_id,
                    PendingApproval {
                        provider_item_id,
                        raw: value,
                    },
                ))
            })
            .collect();
        self.pending_user_inputs = snapshot
            .pending_user_inputs
            .into_iter()
            .filter_map(|value| {
                let request_id = value.get("requestId")?.as_str()?.to_owned();
                let provider_item_id = value.get("providerItemId")?.as_str()?.to_owned();
                Some((
                    request_id,
                    PendingUserInput {
                        provider_item_id,
                        original_input: json!({
                            "questions": value.get("questions").cloned().unwrap_or_else(|| json!([])),
                        }),
                        raw: value,
                    },
                ))
            })
            .collect();
    }

    fn handle_stream_event(&mut self, event: StreamEvent) -> Vec<CanonicalEvent> {
        match event {
            StreamEvent::MessageStart { message } => vec![self.event(
                "thread.started",
                self.current_turn_id.clone(),
                None,
                None,
                json!({ "providerThreadId": message.id }),
            )],
            StreamEvent::ContentBlockStart {
                index,
                content_block: ContentBlock::ToolUse { id, name, input },
            } => {
                self.in_flight_tools.insert(
                    id.clone(),
                    InFlightTool {
                        index,
                        tool_use_id: id.clone(),
                        tool_name: name.clone(),
                        input: input.clone(),
                        result: None,
                        stopped: false,
                        completed: false,
                    },
                );
                vec![self.event(
                    "item.started",
                    self.current_turn_id.clone(),
                    None,
                    Some(json!({ "providerItemId": id })),
                    json!({
                        "itemType": classify_item_type(&name),
                        "title": classify_title(&name),
                        "data": {
                            "toolName": name,
                            "input": input,
                        },
                    }),
                )]
            }
            StreamEvent::ContentBlockDelta {
                index: _,
                delta: ContentBlockDelta::ThinkingDelta { thinking },
            } => vec![self.event(
                "content.delta",
                self.current_turn_id.clone(),
                None,
                None,
                json!({
                    "streamKind": "reasoning_text",
                    "delta": thinking,
                }),
            )],
            StreamEvent::ContentBlockDelta {
                index: _,
                delta: ContentBlockDelta::TextDelta { text },
            } => vec![self.event(
                "content.delta",
                self.current_turn_id.clone(),
                None,
                None,
                json!({
                    "streamKind": "assistant_text",
                    "delta": text,
                }),
            )],
            StreamEvent::ContentBlockDelta {
                index,
                delta: ContentBlockDelta::InputJsonDelta { partial_json },
            } => {
                let Some((tool_use_id, tool_name, parsed_input, plan)) =
                    self.update_tool_input(index, &partial_json)
                else {
                    return Vec::new();
                };
                let mut events = vec![self.event(
                    "item.updated",
                    self.current_turn_id.clone(),
                    None,
                    Some(json!({ "providerItemId": tool_use_id })),
                    json!({
                        "data": {
                            "toolName": tool_name,
                            "input": parsed_input,
                        },
                    }),
                )];
                if let Some(plan) = plan {
                    events.push(self.event(
                        "turn.plan.updated",
                        self.current_turn_id.clone(),
                        None,
                        None,
                        json!({ "plan": plan }),
                    ));
                }
                events
            }
            StreamEvent::ContentBlockStop { index } => {
                if let Some(tool) = self.find_tool_by_index_mut(index) {
                    tool.stopped = true;
                }
                Vec::new()
            }
        }
    }

    fn handle_user_message(&mut self, contents: Vec<UserContent>) -> Vec<CanonicalEvent> {
        let mut events = Vec::new();
        for content in contents {
            match content {
                UserContent::ToolResult {
                    tool_use_id,
                    content,
                } => {
                    let Some((provider_item_id, result, should_complete)) =
                        self.apply_tool_result(&tool_use_id, content)
                    else {
                        continue;
                    };
                    events.push(self.event(
                        "item.updated",
                        self.current_turn_id.clone(),
                        None,
                        Some(json!({ "providerItemId": provider_item_id.clone() })),
                        json!({ "data": result }),
                    ));
                    if should_complete
                        && let Some(event) = self.complete_tool_by_id(&provider_item_id)
                    {
                        events.push(event);
                    }
                }
            }
        }
        events
    }

    fn handle_result_message(&mut self, message: ResultMessage) -> Vec<CanonicalEvent> {
        let mut events = self.flush_incomplete_tools();
        let interrupted = is_interrupted_result(&message);
        let failed = message.is_error && !interrupted;
        let stop_reason = message.stop_reason.unwrap_or_else(|| {
            if interrupted {
                "interrupted".to_owned()
            } else if failed {
                "error".to_owned()
            } else {
                "success".to_owned()
            }
        });
        let mut payload = json!({
            "state": if interrupted { "interrupted" } else if failed { "failed" } else { "completed" },
            "stopReason": stop_reason,
        });
        if interrupted || failed {
            let error_message = message.errors.first().cloned().unwrap_or_else(|| {
                if interrupted {
                    "Claude runtime interrupted.".to_owned()
                } else {
                    "Claude turn failed.".to_owned()
                }
            });
            payload["errorMessage"] = json!(error_message);
        }
        events.push(self.event(
            "turn.completed",
            self.current_turn_id.clone(),
            None,
            None,
            payload,
        ));
        events
    }

    fn flush_incomplete_tools(&mut self) -> Vec<CanonicalEvent> {
        let pending_ids = self
            .in_flight_tools
            .iter()
            .filter_map(|(tool_id, tool)| (!tool.completed).then_some(tool_id.clone()))
            .collect::<Vec<_>>();
        pending_ids
            .into_iter()
            .filter_map(|tool_id| self.complete_tool_by_id(&tool_id))
            .collect()
    }

    fn complete_tool_by_id(&mut self, tool_id: &str) -> Option<CanonicalEvent> {
        let turn_id = self.current_turn_id.clone();
        let (provider_item_id, data) = {
            let tool = self.in_flight_tools.get_mut(tool_id)?;
            tool.completed = true;
            let mut data = json!({
                "toolName": tool.tool_name,
                "input": tool.input,
            });
            if let Some(result) = &tool.result {
                data["result"] = result.clone();
            }
            (tool.tool_use_id.clone(), data)
        };
        Some(self.event(
            "item.completed",
            turn_id,
            None,
            Some(json!({ "providerItemId": provider_item_id })),
            json!({ "data": data }),
        ))
    }

    fn update_tool_input(
        &mut self,
        index: u64,
        partial_json: &str,
    ) -> Option<(String, String, Value, Option<Vec<Value>>)> {
        let parsed_input = serde_json::from_str::<Value>(partial_json).unwrap_or_else(|_| {
            json!({
                "raw": partial_json,
            })
        });
        let tool = self.find_tool_by_index_mut(index)?;
        tool.input = parsed_input.clone();
        let plan = if is_todo_tool(&tool.tool_name) {
            extract_plan_steps(&tool.input)
        } else {
            None
        };
        Some((
            tool.tool_use_id.clone(),
            tool.tool_name.clone(),
            parsed_input,
            plan,
        ))
    }

    fn apply_tool_result(
        &mut self,
        tool_use_id: &str,
        content: Value,
    ) -> Option<(String, Value, bool)> {
        let tool = self.in_flight_tools.get_mut(tool_use_id)?;
        let result = json!({
            "tool_use_id": tool_use_id,
            "content": content,
        });
        tool.result = Some(result.clone());
        Some((
            tool.tool_use_id.clone(),
            result,
            tool.stopped && !tool.completed,
        ))
    }

    fn find_tool_by_index_mut(&mut self, index: u64) -> Option<&mut InFlightTool> {
        self.in_flight_tools
            .values_mut()
            .find(|tool| tool.index == index)
    }

    fn event(
        &self,
        event_type: &str,
        turn_id: Option<String>,
        request_id: Option<String>,
        provider_refs: Option<Value>,
        payload: Value,
    ) -> CanonicalEvent {
        CanonicalEvent {
            event_type: event_type.to_owned(),
            thread_id: self.thread_id.clone(),
            turn_id,
            request_id,
            provider_refs,
            payload,
        }
    }

    fn token_usage_event(
        &self,
        turn_id: String,
        usage: ClaudeTokenUsageSnapshot,
    ) -> CanonicalEvent {
        self.event(
            "thread.token-usage.updated",
            Some(turn_id),
            None,
            None,
            json!({ "usage": usage }),
        )
    }

    fn mcp_status_event(&mut self, value: &Value) -> Option<CanonicalEvent> {
        let servers = normalize_mcp_servers(value)?;
        if self.last_mcp_status.as_ref() == Some(&servers) {
            return None;
        }
        self.last_mcp_status = Some(servers.clone());
        Some(self.event(
            "mcp.status.updated",
            None,
            None,
            None,
            json!({ "servers": servers }),
        ))
    }
}

const MAX_MCP_SERVERS: usize = 256;

fn normalize_mcp_servers(value: &Value) -> Option<Vec<Value>> {
    let entries = value.as_array()?;
    if entries.len() > MAX_MCP_SERVERS {
        return None;
    }
    let mut names = HashSet::with_capacity(entries.len());
    entries
        .iter()
        .map(|entry| {
            let entry = entry.as_object()?;
            let name = entry.get("name")?.as_str()?.trim();
            if name.is_empty() || !names.insert(name.to_owned()) {
                return None;
            }
            let state = match entry.get("status")?.as_str()? {
                "connected" => "connected",
                "pending" => "starting",
                "needs-auth" => "needs-auth",
                "disabled" => "disconnected",
                "failed" => "error",
                _ => return None,
            };
            let detail = entry
                .get("error")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|detail| !detail.is_empty());
            let mut server = json!({ "name": name, "state": state });
            if let Some(detail) = detail {
                server["detail"] = json!(detail);
            }
            Some(server)
        })
        .collect()
}

fn current_unix_nanos() -> i128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i128::try_from(duration.as_nanos()).unwrap_or(i128::MAX))
        .unwrap_or_default()
}

enum ClaudeMessageRoute {
    Root,
    ForwardedTaskLifecycle { parent_tool_use_id: String },
    SuppressedChildText,
}

fn root_agent_tool_identity(value: &Value) -> Option<(&str, &str, &str)> {
    if value.get("type").and_then(Value::as_str) != Some("stream_event")
        || value
            .get("parent_tool_use_id")
            .is_some_and(|parent| !parent.is_null())
        || value.pointer("/event/type").and_then(Value::as_str) != Some("content_block_start")
        || value
            .pointer("/event/content_block/type")
            .and_then(Value::as_str)
            != Some("tool_use")
    {
        return None;
    }
    Some((
        value.get("session_id")?.as_str()?,
        value.pointer("/event/content_block/id")?.as_str()?,
        value.pointer("/event/content_block/name")?.as_str()?,
    ))
}

fn claude_message_route(message: &ClaudeMessage) -> ClaudeMessageRoute {
    let forwarded_task = |parent_tool_use_id: &Option<String>| {
        parent_tool_use_id
            .as_ref()
            .map_or(ClaudeMessageRoute::Root, |parent_tool_use_id| {
                if parent_tool_use_id.is_empty() {
                    ClaudeMessageRoute::SuppressedChildText
                } else {
                    ClaudeMessageRoute::ForwardedTaskLifecycle {
                        parent_tool_use_id: parent_tool_use_id.clone(),
                    }
                }
            })
    };
    match message {
        ClaudeMessage::StreamEvent(message) if message.parent_tool_use_id.is_some() => {
            match &message.event {
                StreamEvent::ContentBlockStart { .. }
                | StreamEvent::ContentBlockDelta {
                    delta: ContentBlockDelta::InputJsonDelta { .. },
                    ..
                }
                | StreamEvent::ContentBlockStop { .. } => {
                    forwarded_task(&message.parent_tool_use_id)
                }
                StreamEvent::MessageStart { .. }
                | StreamEvent::ContentBlockDelta {
                    delta:
                        ContentBlockDelta::ThinkingDelta { .. } | ContentBlockDelta::TextDelta { .. },
                    ..
                } => ClaudeMessageRoute::SuppressedChildText,
            }
        }
        ClaudeMessage::User(message) => forwarded_task(&message.parent_tool_use_id),
        ClaudeMessage::Assistant(message) if message.parent_tool_use_id.is_some() => {
            ClaudeMessageRoute::SuppressedChildText
        }
        ClaudeMessage::Assistant(_) | ClaudeMessage::Result(_) | ClaudeMessage::StreamEvent(_) => {
            ClaudeMessageRoute::Root
        }
        ClaudeMessage::System(_) => ClaudeMessageRoute::Root,
    }
}

fn correlate_forwarded_task_events(
    mut events: Vec<CanonicalEvent>,
    parent_tool_use_id: &str,
) -> Vec<CanonicalEvent> {
    for event in &mut events {
        match event.provider_refs.as_mut() {
            Some(Value::Object(provider_refs)) => {
                provider_refs.insert(
                    "parentToolUseId".to_owned(),
                    Value::String(parent_tool_use_id.to_owned()),
                );
            }
            _ => {
                event.provider_refs = Some(json!({
                    "parentToolUseId": parent_tool_use_id,
                }));
            }
        }
    }
    events
}

fn claude_hook_native_event_id(value: &Value) -> Option<String> {
    if !claude_hook_identity_fields_are_safe(value) {
        return None;
    }
    let fields = [
        value.get("hook_event_name").and_then(Value::as_str)?,
        value.get("session_id").and_then(Value::as_str)?,
        value.get("agent_id").and_then(Value::as_str)?,
        value
            .get("tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ];
    let mut hasher = Sha256::new();
    for field in fields {
        let field_length = u64::try_from(field.len()).ok()?;
        hasher.update(field_length.to_be_bytes());
        hasher.update(field.as_bytes());
    }
    let digest = hasher.finalize();
    let encoded = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Some(format!("claude:hook:{encoded}"))
}

fn claude_hook_identity_fields_are_safe(value: &Value) -> bool {
    ["hook_event_name", "session_id", "agent_id", "tool_use_id"]
        .into_iter()
        .filter_map(|field| value.get(field).and_then(Value::as_str))
        .all(|field| !field.chars().any(char::is_control))
}

#[doc(hidden)]
pub fn claude_hook_native_event_id_for_test(value: &Value) -> Option<String> {
    claude_hook_native_event_id(value)
}

fn classify_request_type(tool_name: &str) -> &'static str {
    let normalized = tool_name.to_ascii_lowercase();
    if normalized.contains("bash") || normalized.contains("command") || normalized.contains("shell")
    {
        return "command_execution_approval";
    }
    if normalized.contains("grep") || normalized.contains("read") {
        return "file_read_approval";
    }
    if normalized.contains("edit") || normalized.contains("write") {
        return "file_change_approval";
    }
    "dynamic_tool_call"
}

fn classify_item_type(tool_name: &str) -> &'static str {
    let normalized = tool_name.to_ascii_lowercase();
    if normalized == "task" || normalized.contains("subagent") {
        return "collab_agent_tool_call";
    }
    if is_todo_tool(tool_name) {
        return "plan";
    }
    "dynamic_tool_call"
}

fn classify_title(tool_name: &str) -> &'static str {
    match classify_item_type(tool_name) {
        "collab_agent_tool_call" => "Subagent task",
        "plan" => "Plan",
        _ => "Tool call",
    }
}

fn is_todo_tool(tool_name: &str) -> bool {
    tool_name.to_ascii_lowercase().contains("todowrite")
}

fn extract_plan_steps(input: &Value) -> Option<Vec<Value>> {
    let todos = input.get("todos")?.as_array()?;
    Some(
        todos
            .iter()
            .filter_map(|todo| {
                let todo = todo.as_object()?;
                let step = todo
                    .get("content")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Task");
                let status = match todo.get("status").and_then(Value::as_str) {
                    Some("completed") => "completed",
                    Some("in_progress") => "inProgress",
                    _ => "pending",
                };
                Some(json!({
                    "step": step,
                    "status": status,
                }))
            })
            .collect(),
    )
}

fn normalize_questions(input: &Value) -> Vec<Value> {
    input
        .get("questions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions
                .iter()
                .enumerate()
                .filter_map(|(index, question)| {
                    let question = question.as_object()?;
                    let prompt = question
                        .get("question")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let id = if prompt.is_empty() {
                        format!("q-{index}")
                    } else {
                        prompt.clone()
                    };
                    let header = question
                        .get("header")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("Question {}", index + 1));
                    let options = question
                        .get("options")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    Some(json!({
                        "id": id,
                        "header": header,
                        "question": prompt,
                        "options": options,
                        "multiSelect": question
                            .get("multiSelect")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn is_interrupted_result(message: &ResultMessage) -> bool {
    message
        .errors
        .iter()
        .any(|error| is_interrupted_error(error))
        || message.subtype == "error_during_execution"
}

fn is_interrupted_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("all fibers interrupted without error")
        || normalized.contains("request was aborted")
        || normalized.contains("interrupted by user")
}

#[cfg(test)]
mod targeted_task_correlation_tests {
    use super::*;

    fn facts(session_id: &str, tool_use_id: &str, agent_id: &str, task_id: &str) -> [Value; 4] {
        [
            json!({
                "type": "stream_event",
                "session_id": session_id,
                "uuid": format!("tool-{tool_use_id}"),
                "parent_tool_use_id": null,
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {
                        "type": "tool_use",
                        "id": tool_use_id,
                        "name": "Agent",
                        "input": {"description": "identical", "prompt": "identical"}
                    }
                }
            }),
            json!({
                "hook_event_name": "PostToolUse",
                "session_id": session_id,
                "tool_name": "Agent",
                "tool_use_id": tool_use_id,
                "tool_response": {
                    "status": "async_launched",
                    "agentId": agent_id,
                    "prompt": "must not be retained"
                }
            }),
            json!({
                "type": "system",
                "subtype": "task_started",
                "session_id": session_id,
                "uuid": format!("started-{task_id}"),
                "task_id": task_id,
                "tool_use_id": tool_use_id,
                "task_type": "local_agent",
                "description": "identical"
            }),
            json!({
                "hook_event_name": "SubagentStart",
                "session_id": session_id,
                "agent_id": agent_id,
                "agent_type": "identical",
                "description": "identical",
                "prompt": "identical"
            }),
        ]
    }

    fn handle_fact(
        runtime: &mut ClaudeProviderRuntime,
        value: &Value,
        authenticated_hook: bool,
        at: u64,
    ) -> ClaudeRuntimeOutput {
        if authenticated_hook && value.get("hook_event_name").is_some() {
            runtime.handle_authenticated_hook_value(value, at)
        } else {
            runtime.handle_raw_value(value, at)
        }
    }

    fn mapped_targets(outputs: &[ClaudeRuntimeOutput]) -> Vec<(String, String)> {
        outputs
            .iter()
            .flat_map(|output| &output.activity_controls)
            .filter_map(|update| match update {
                crate::activity::ProviderActivityControlUpdate::ActorTarget {
                    actor_id,
                    target: Some(target),
                } => target
                    .claude_task_id()
                    .map(|task_id| (actor_id.clone(), task_id.to_owned())),
                crate::activity::ProviderActivityControlUpdate::ActorTarget { .. }
                | crate::activity::ProviderActivityControlUpdate::WorkTarget { .. } => None,
            })
            .collect()
    }

    fn permutations(values: [usize; 4]) -> Vec<[usize; 4]> {
        let mut result = Vec::new();
        for a in values {
            for b in values {
                for c in values {
                    for d in values {
                        let candidate = [a, b, c, d];
                        if candidate.iter().copied().collect::<HashSet<_>>().len() == 4 {
                            result.push(candidate);
                        }
                    }
                }
            }
        }
        result
    }

    #[test]
    fn targeted_task_correlation_accepts_all_exact_identity_fact_orders_once() {
        // Mutation caught: making correlation depend on event adjacency or arrival order.
        let facts = facts("session", "tool-a", "agent-a", "task-a");
        for order in permutations([0, 1, 2, 3]) {
            let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
            let outputs = order
                .into_iter()
                .enumerate()
                .map(|(index, fact)| handle_fact(&mut runtime, &facts[fact], true, index as u64))
                .collect::<Vec<_>>();
            assert_eq!(
                mapped_targets(&outputs),
                [("claude:agent:agent-a".to_owned(), "task-a".to_owned())],
                "failed exact fact order {order:?}"
            );
        }
    }

    #[test]
    fn targeted_task_correlation_ignores_identical_semantics_and_maps_each_exact_chain() {
        // Mutation caught: joining actors by shared names, roles, descriptions, prompts, or proximity.
        let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
        let first = facts("session", "tool-a", "agent-a", "task-a");
        let second = facts("session", "tool-b", "agent-b", "task-b");
        let outputs = first
            .iter()
            .chain(&second)
            .enumerate()
            .map(|(index, fact)| handle_fact(&mut runtime, fact, true, index as u64))
            .collect::<Vec<_>>();
        assert_eq!(
            mapped_targets(&outputs),
            [
                ("claude:agent:agent-a".to_owned(), "task-a".to_owned()),
                ("claude:agent:agent-b".to_owned(), "task-b".to_owned()),
            ]
        );
    }

    #[test]
    fn targeted_task_correlation_debug_redacts_native_identifiers() {
        // Mutation caught: exposing retained provider identities through runtime Debug logging.
        let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
        let chain = facts("session", "tool-secret", "agent-secret", "task-secret");
        for (index, fact) in chain.iter().enumerate() {
            let _ = handle_fact(&mut runtime, fact, true, index as u64);
        }
        let debug = format!("{:?}", runtime.task_control_correlator);
        assert!(!debug.contains("tool-secret"));
        assert!(!debug.contains("agent-secret"));
        assert!(!debug.contains("task-secret"));
    }

    #[test]
    fn targeted_task_correlation_rejects_missing_invalid_unauthenticated_and_stale_facts() {
        // Mutation caught: guessing from semantic content or accepting an incomplete/untrusted chain.
        let base = facts("session", "tool-a", "agent-a", "task-a");
        for omitted in 0..4 {
            let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
            let outputs = base
                .iter()
                .enumerate()
                .filter(|(index, _)| *index != omitted)
                .map(|(index, fact)| handle_fact(&mut runtime, fact, true, index as u64))
                .collect::<Vec<_>>();
            assert!(
                mapped_targets(&outputs).is_empty(),
                "omitted fact {omitted}"
            );
        }

        let mut cases = Vec::new();
        let mut non_agent = base.clone();
        non_agent[0]["event"]["content_block"]["name"] = json!("Read");
        cases.push(non_agent);
        let mut non_async = base.clone();
        non_async[1]["tool_response"]["status"] = json!("completed");
        cases.push(non_async);
        let mut non_local = base.clone();
        non_local[2]["task_type"] = json!("shell");
        cases.push(non_local);
        let mut wrong_session = base.clone();
        wrong_session[2]["session_id"] = json!("other-session");
        cases.push(wrong_session);
        let mut oversized = base.clone();
        oversized[2]["task_id"] = json!("x".repeat(257));
        cases.push(oversized);
        let mut control = base.clone();
        control[1]["tool_response"]["agentId"] = json!("agent\u{0000}a");
        cases.push(control);

        for case in cases {
            let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
            let outputs = case
                .iter()
                .enumerate()
                .map(|(index, fact)| handle_fact(&mut runtime, fact, true, index as u64))
                .collect::<Vec<_>>();
            assert!(mapped_targets(&outputs).is_empty(), "invalid chain mapped");
        }

        let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
        let outputs = base
            .iter()
            .enumerate()
            .map(|(index, fact)| handle_fact(&mut runtime, fact, index != 1, index as u64))
            .collect::<Vec<_>>();
        assert!(
            mapped_targets(&outputs).is_empty(),
            "unauthenticated PostToolUse mapped"
        );

        let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
        let mut outputs = base[..3]
            .iter()
            .enumerate()
            .map(|(index, fact)| handle_fact(&mut runtime, fact, true, index as u64))
            .collect::<Vec<_>>();
        runtime.set_agent_activity_enabled(false);
        runtime.set_agent_activity_enabled(true);
        outputs.push(handle_fact(&mut runtime, &base[3], true, 4));
        assert!(
            mapped_targets(&outputs).is_empty(),
            "prior-generation facts mapped"
        );
    }

    #[test]
    fn targeted_task_correlation_rejects_conflicts_and_duplicate_task_assignment() {
        // Mutation caught: retaining a target after identity evidence becomes ambiguous.
        let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
        let first = facts("session", "tool-a", "agent-a", "task-shared");
        let second = facts("session", "tool-b", "agent-b", "task-shared");
        let mut outputs = first
            .iter()
            .enumerate()
            .map(|(index, fact)| handle_fact(&mut runtime, fact, true, index as u64))
            .collect::<Vec<_>>();
        outputs.extend(
            second
                .iter()
                .enumerate()
                .map(|(index, fact)| handle_fact(&mut runtime, fact, true, 10 + index as u64)),
        );
        let mapped = mapped_targets(&outputs);
        assert_eq!(
            mapped,
            [("claude:agent:agent-a".to_owned(), "task-shared".to_owned())]
        );
        assert!(
            outputs
                .iter()
                .flat_map(|output| &output.activity_controls)
                .any(|update| {
                    matches!(
                        update,
                        crate::activity::ProviderActivityControlUpdate::ActorTarget {
                            actor_id,
                            target: None,
                        } if actor_id == "claude:agent:agent-a"
                    )
                })
        );

        let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
        let base = facts("session", "tool-a", "agent-a", "task-a");
        let mut conflict = base[1].clone();
        conflict["tool_response"]["agentId"] = json!("agent-b");
        let mut outputs = base
            .iter()
            .enumerate()
            .map(|(index, fact)| handle_fact(&mut runtime, fact, true, index as u64))
            .collect::<Vec<_>>();
        outputs.push(handle_fact(&mut runtime, &conflict, true, 10));
        assert!(
            outputs
                .last()
                .is_some_and(|output| output.activity_controls.iter().any(|update| {
                    matches!(
                        update,
                        crate::activity::ProviderActivityControlUpdate::ActorTarget {
                            actor_id,
                            target: None,
                        } if actor_id == "claude:agent:agent-a"
                    )
                }))
        );
    }

    #[test]
    fn targeted_task_correlation_saturation_is_bounded_and_never_partially_joins() {
        // Mutation caught: accepting later facts for an identity whose first fact was rejected at capacity.
        let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
        for index in 0..crate::activity::ACTIVITY_PAGE_MAX_LENGTH {
            let fact = facts(
                "session",
                &format!("tool-{index}"),
                &format!("agent-{index}"),
                &format!("task-{index}"),
            );
            let _ = handle_fact(&mut runtime, &fact[0], true, index as u64);
        }
        let rejected = facts(
            "session",
            "tool-overflow",
            "agent-overflow",
            "task-overflow",
        );
        let outputs = rejected
            .iter()
            .enumerate()
            .map(|(index, fact)| handle_fact(&mut runtime, fact, true, 1_000 + index as u64))
            .collect::<Vec<_>>();
        assert!(mapped_targets(&outputs).is_empty());
        assert!(runtime.task_control_correlator.state_is_bounded());
    }
}
