use super::{ActivityProjection, ActivityRepository, ActivityScopeRef, AgentActivityController};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentActivitySource {
    Chat,
    Terminal,
}

impl AgentActivitySource {
    #[must_use]
    pub const fn for_scope(scope: &ActivityScopeRef) -> Self {
        match scope {
            ActivityScopeRef::Thread { .. } => Self::Chat,
            ActivityScopeRef::Terminal { .. } => Self::Terminal,
        }
    }

    #[must_use]
    pub const fn storage_kind(self) -> &'static str {
        match self {
            Self::Chat => "thread",
            Self::Terminal => "terminal",
        }
    }

    #[must_use]
    pub const fn trace_label(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Terminal => "terminal",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ActivityProjections {
    chat: ActivityProjection,
    terminal: ActivityProjection,
}

impl ActivityProjections {
    #[must_use]
    pub fn new(
        repository: ActivityRepository,
        chat_controller: AgentActivityController,
        terminal_controller: AgentActivityController,
    ) -> Self {
        Self {
            chat: ActivityProjection::with_source_controller(
                repository.clone(),
                chat_controller,
                AgentActivitySource::Chat,
            ),
            terminal: ActivityProjection::with_source_controller(
                repository,
                terminal_controller,
                AgentActivitySource::Terminal,
            ),
        }
    }

    #[must_use]
    pub fn chat(&self) -> ActivityProjection {
        self.chat.clone()
    }

    #[must_use]
    pub fn terminal(&self) -> ActivityProjection {
        self.terminal.clone()
    }

    #[must_use]
    pub fn for_scope(&self, scope: &ActivityScopeRef) -> ActivityProjection {
        self.for_source(AgentActivitySource::for_scope(scope))
    }

    #[must_use]
    pub fn for_source(&self, source: AgentActivitySource) -> ActivityProjection {
        match source {
            AgentActivitySource::Chat => self.chat(),
            AgentActivitySource::Terminal => self.terminal(),
        }
    }

    #[doc(hidden)]
    #[must_use]
    pub fn with_capacity(
        repository: ActivityRepository,
        chat_controller: AgentActivityController,
        terminal_controller: AgentActivityController,
        capacity: usize,
    ) -> Self {
        Self {
            chat: ActivityProjection::with_source_controller_and_capacity(
                repository.clone(),
                chat_controller,
                AgentActivitySource::Chat,
                capacity,
            ),
            terminal: ActivityProjection::with_source_controller_and_capacity(
                repository,
                terminal_controller,
                AgentActivitySource::Terminal,
                capacity,
            ),
        }
    }
}
