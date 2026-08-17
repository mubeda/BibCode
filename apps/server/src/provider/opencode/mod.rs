pub(crate) mod activity;
pub mod model;
pub mod runtime;
pub(crate) mod sse;

use std::path::{Path, PathBuf};

use crate::process::Platform;

/// Resolves the native OpenCode executable behind the standard Windows npm
/// shim when BiBCode must own the launched process tree. OpenCode's native
/// launcher can detach from `opencode.cmd`, so supervising only the batch shim
/// does not provide a reliable shutdown boundary.
pub(crate) fn resolve_owned_executable(platform: Platform, executable: &Path) -> PathBuf {
    if platform != Platform::Windows
        || !executable
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("opencode.cmd"))
    {
        return executable.to_path_buf();
    }

    let Some(shim_directory) = executable.parent() else {
        return executable.to_path_buf();
    };
    let native = shim_directory
        .join("node_modules")
        .join("opencode-ai")
        .join("bin")
        .join("opencode.exe");
    if native.is_file() {
        native
    } else {
        executable.to_path_buf()
    }
}

#[doc(hidden)]
pub use activity::{
    OpenCodeActivityFixtureAdapter, OpenCodeActivityOutput, OpenCodeActivityStateCounts,
};
#[cfg_attr(test, allow(unused_imports))]
pub use model::{
    OpenCodeInventorySnapshot, OpenCodeProviderModel, build_inventory_snapshot,
    merge_assistant_text, parse_model_slug,
};
#[cfg_attr(test, allow(unused_imports))]
pub use runtime::{
    OpenCodeRuntimeEvent, OpenCodeRuntimeEventStableView, OpenCodeSessionRuntime,
    OpenCodeSessionSnapshot,
};

#[cfg(test)]
mod launch_tests {
    use super::*;

    #[test]
    fn windows_npm_shim_resolves_to_the_owned_native_executable() {
        let root = tempfile::tempdir().expect("temporary OpenCode npm layout");
        let shim = root.path().join("opencode.cmd");
        let native = root
            .path()
            .join("node_modules/opencode-ai/bin/opencode.exe");
        std::fs::create_dir_all(native.parent().expect("native parent"))
            .expect("native OpenCode directory");
        std::fs::write(&shim, "@opencode fixture").expect("OpenCode shim fixture");
        std::fs::write(&native, b"fixture").expect("native OpenCode fixture");

        assert_eq!(resolve_owned_executable(Platform::Windows, &shim), native);
        assert_eq!(resolve_owned_executable(Platform::Unix, &shim), shim);
    }

    #[test]
    fn custom_or_incomplete_windows_shims_keep_the_configured_executable() {
        let root = tempfile::tempdir().expect("temporary OpenCode shim layout");
        let custom = root.path().join("custom-opencode.cmd");
        let incomplete = root.path().join("opencode.cmd");
        std::fs::write(&custom, "@custom fixture").expect("custom shim fixture");
        std::fs::write(&incomplete, "@incomplete fixture").expect("incomplete shim fixture");

        assert_eq!(resolve_owned_executable(Platform::Windows, &custom), custom);
        assert_eq!(
            resolve_owned_executable(Platform::Windows, &incomplete),
            incomplete
        );
    }
}
