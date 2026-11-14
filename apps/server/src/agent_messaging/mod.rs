//! Messages between the agents of one project: the store, the directory, the envelope and the
//! provider tools. Off unless `agentMessaging.enabled` is on. An agent's identity is the thread
//! of its credential, never an argument, and it reaches only agents of its own project.

pub(crate) mod directory;
pub(crate) mod envelope;
pub mod store;

use tokio::sync::watch;

use crate::orchestration::OrchestrationEngine;
use directory::AgentSummary;

const DISABLED_MESSAGE: &str =
    "Agent messaging is off. Turn it on in Settings → Agents → Agent integrations.";
const UNKNOWN_RECIPIENT_MESSAGE: &str =
    "No agent with that address in this project. Call agents_list to see the agents you can reach.";

/// A refusal of an agent messaging tool. Its message never quotes the caller's input.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AgentMessagingError {
    Disabled,
    UnknownRecipient,
    InvalidArgument(String),
    /// The store did not answer; the details go to the log, never to the agent.
    Storage,
}

impl AgentMessagingError {
    pub(crate) fn tag(&self) -> &'static str {
        match self {
            Self::Disabled => "AgentMessagingDisabledError",
            Self::UnknownRecipient => "AgentMessagingUnknownRecipientError",
            Self::InvalidArgument(_) => "AgentMessagingInvalidArgumentError",
            Self::Storage => "McpStorageError",
        }
    }

    pub(crate) fn message(&self) -> String {
        match self {
            Self::Disabled => DISABLED_MESSAGE.to_owned(),
            Self::UnknownRecipient => UNKNOWN_RECIPIENT_MESSAGE.to_owned(),
            Self::InvalidArgument(detail) => detail.clone(),
            Self::Storage => "BiBCode could not read its store; try again.".to_owned(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct AgentMessaging {
    engine: OrchestrationEngine,
    enabled: watch::Receiver<bool>,
}

impl AgentMessaging {
    pub(crate) fn new(engine: OrchestrationEngine, enabled: watch::Receiver<bool>) -> Self {
        Self { engine, enabled }
    }

    pub(crate) fn is_enabled(&self) -> bool {
        *self.enabled.borrow()
    }

    /// The other agents of the caller's project. A caller whose thread is gone reaches nobody.
    pub(crate) async fn agents(
        &self,
        caller_thread_id: &str,
    ) -> Result<Vec<AgentSummary>, AgentMessagingError> {
        if !self.is_enabled() {
            return Err(AgentMessagingError::Disabled);
        }
        let caller = caller_thread_id.to_owned();
        let agents = self
            .engine
            .repositories()
            .database()
            .call(move |connection| {
                let Some(project_id) = directory::project_of(connection, &caller)? else {
                    return Ok(None);
                };
                directory::list_agents(connection, &project_id, &caller).map(Some)
            })
            .await
            .map_err(|error| {
                tracing::warn!(error = %error, "agents_list could not read the directory");
                AgentMessagingError::Storage
            })?;
        agents.ok_or(AgentMessagingError::UnknownRecipient)
    }
}
