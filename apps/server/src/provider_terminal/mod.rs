#[cfg(test)]
mod agent_status_tests;
mod claude;
mod codex;
mod conversation;
mod model;
mod opencode;
mod supervisor;

#[cfg(test)]
pub(crate) use conversation::MAX_TRANSCRIPT_BYTES;
pub(crate) use conversation::{ConversationRefusal, ConversationText, read_claude_conversation};
pub(crate) use model::ObservedConversation;
#[allow(unused_imports)]
pub(crate) use model::{
    TerminalAgentActivityAdmission, TerminalAgentActivityControl, TerminalAgentActivityObservation,
    TerminalAgentActivityObservationKind, TerminalAgentActivityState,
};

pub use claude::{
    CachedClaudeCapabilityProbe, ClaudeAdditiveHookAttestor, ClaudeCapabilities,
    ClaudeCapabilityProbeRunner, ClaudeExecutablePinner, ClaudeInstallResolver, ClaudeProbeOutput,
    ClaudeShimRequest, ClaudeShimResolution, ClaudeTerminalObserverFactory,
    MiseClaudeInstallResolver,
};
pub use codex::{
    CachedCodexCapabilityProbe, CodexCapabilities, CodexCapabilityProbeRunner, CodexHelperLaunch,
    CodexHelperLauncher, CodexHelperProcess, CodexProbeOutput, CodexRemoteClient,
    CodexRemoteClientFactory, CodexTerminalObserverFactory,
};
pub use model::{
    NativeTerminalCommand, PreparedTerminalLaunch, PreparedTerminalObserver,
    TerminalAgentActivityProviderEpochs, TerminalAgentActivityTransition, TerminalAgentObservation,
    TerminalAgentState, TerminalGenerationActivityPublisher, TerminalLaunchPreparation,
    TerminalLaunchPreparationInput, TerminalLaunchPreparer, TerminalObserverCancellationReason,
    TerminalObserverGeneration, TerminalObserverGenerationLease, TerminalObserverWorkerContext,
    TerminalObserverWorkerSpawnError,
};
pub use opencode::{
    CachedOpenCodeCapabilityProbe, OpenCodeCapabilities, OpenCodeCapabilityProbeRunner,
    OpenCodeEventStream, OpenCodeHelperLaunch, OpenCodeHelperLauncher, OpenCodeHelperProcess,
    OpenCodeHelperReady, OpenCodeProbeOutput, OpenCodeRemoteClient, OpenCodeRemoteClientFactory,
    OpenCodeTerminalObserverFactory,
};
pub use supervisor::{
    ProviderSettingsInventoryAuthority, ProviderTerminalActivitySupervisor,
    ProviderTerminalInventory, ProviderTerminalInventoryAuthority, ProviderTerminalInventoryEntry,
    ProviderTerminalObserverFactories, ProviderTerminalObserverFactory,
    ProviderTerminalObserverFactoryInput,
};
