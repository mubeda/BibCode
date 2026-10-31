mod history;
pub(crate) use history::{HistoryCursor, HistoryWindow};
mod input;
mod manager;
mod model;
mod osc;
mod pty;

pub use input::TerminalInputError;
pub(crate) use input::{InputReadmissionScope, TerminalInputAdmission};
#[cfg(all(test, unix))]
pub(crate) use manager::MAX_PREPARATION_EXECUTION_BUDGET;
pub(crate) use manager::TerminalSessionIdentity;
pub use manager::{
    AttachmentItem, SubprocessInspection, TerminalAttachment, TerminalError, TerminalEventReceiver,
    TerminalManager, TerminalManagerOptions, TerminalMetadataAttachment,
    TerminalSubprocessInspector, WorktreeRemovalGuard,
};
pub use model::{
    ProviderTerminalActivityLaunch, TerminalAgentStatus, TerminalAgentStatusState,
    TerminalAttachInput, TerminalConsoleTheme, TerminalEvent, TerminalLaunchCommand,
    TerminalMetadataEvent, TerminalOpenInput, TerminalRemovalReason, TerminalRestartInput,
    TerminalSessionSnapshot, TerminalSize, TerminalStatus, TerminalSummary,
};
pub use pty::{PortablePtyBackend, PtyBackend, PtyExit, PtyProcess, PtySpawnInput};
