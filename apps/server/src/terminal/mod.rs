mod history;
mod input;
mod manager;
mod model;
mod osc;
mod pty;

pub use input::TerminalInputError;
pub(crate) use manager::TerminalSessionIdentity;
pub use manager::{
    SubprocessInspection, TerminalAttachment, TerminalError, TerminalManager,
    TerminalManagerOptions, TerminalMetadataAttachment, TerminalSubprocessInspector,
    WorktreeRemovalGuard,
};
pub use model::{
    ProviderTerminalActivityLaunch, TerminalAttachInput, TerminalConsoleTheme, TerminalEvent,
    TerminalLaunchCommand, TerminalMetadataEvent, TerminalOpenInput, TerminalRestartInput,
    TerminalSessionSnapshot, TerminalStatus, TerminalSummary,
};
pub use pty::{PortablePtyBackend, PtyBackend, PtyExit, PtyProcess, PtySpawnInput};
