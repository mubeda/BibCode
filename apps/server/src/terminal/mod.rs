mod history;
pub(crate) use history::{HistoryCursor, HistoryWindow};
mod input;
mod manager;
mod model;
mod osc;
mod pty;
mod writer;

pub use input::TerminalInputError;
pub(crate) use input::{InputReadmissionScope, TerminalInputAdmission};
#[cfg(all(test, unix))]
pub(crate) use manager::MAX_PREPARATION_EXECUTION_BUDGET;
pub(crate) use manager::TerminalSessionIdentity;
pub use manager::{
    AttachmentItem, SubprocessInspection, SubprocessInspections, TerminalAttachment, TerminalError,
    TerminalEventReceiver, TerminalManager, TerminalManagerOptions, TerminalMetadataAttachment,
    TerminalSessionLaunch, TerminalSubprocessInspector, WorktreeRemovalGuard, WriteWhenReady,
};
pub use model::{
    ProviderTerminalActivityLaunch, TerminalAgentStatus, TerminalAgentStatusState,
    TerminalAttachInput, TerminalConsoleTheme, TerminalEvent, TerminalGeneration,
    TerminalInputOrigin, TerminalLaunchCommand, TerminalMetadataEvent, TerminalOpenInput,
    TerminalRemovalReason, TerminalResizeOutcome, TerminalResizeResult, TerminalRestartInput,
    TerminalSessionSnapshot, TerminalSize, TerminalStatus, TerminalSummary,
};
pub use pty::{
    ExhaustedResize, PortablePtyBackend, PtyBackend, PtyExit, PtyProcess, PtySpawnInput,
};
pub use writer::WriteGuard;

/// The thread id of the terminal each server owns in its user's home folder (#378). The
/// engine refuses to create a thread with it, so no thread terminal shares that session.
pub const SERVER_TERMINAL_THREAD_ID: &str = "server-terminal";
