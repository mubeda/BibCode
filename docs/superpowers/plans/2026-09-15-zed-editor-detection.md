# "Open with Zed" Editor Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Open in → Zed" appears next to VS Code whenever Zed is installed on the server host, including Flatpak (`dev.zed.Zed`), the `zeditor` distro alias, the macOS app bundle CLI, and the Windows per-user install, and launching it opens the requested `path:line:column`.

**Architecture:** Zed is already implemented end to end: the contracts editor catalog (`packages/contracts/src/editor.ts:23`), the picker (`apps/web/src/components/chat/OpenInPicker.tsx:97-101`), the icon (`Icons.tsx:461`), and the server launch arm (`apps/server/src/production/git_vcs.rs:1749`). It is hidden because `available_editors()` in `apps/server/src/production/control.rs:2173-2182` only probes four binaries on `PATH` (and emits the invalid id `"intellij"` for `idea`), while `open_in_editor_with` in `git_vcs.rs:1733-1762` keeps a separate launch table. This plan replaces both with one server-owned editor table in a new module: each editor lists resolution candidates (PATH command, Flatpak export, home-relative path, absolute path) and an argument style; availability and launch both resolve through it with an injectable probe environment so tests use a temporary directory instead of the real `PATH`.

**Tech Stack:** Rust (Axum server), Vitest via Vite+ for the unchanged web picker tests.

**Spec:** User request, 2026-09-15, verbatim: "Alongside 'Open with VSCode' i want to also provide the option to 'Open with Zed' that is this app, that also is platform. https://zed.dev/". Diagnosis evidence: `flatpak list` on the user's Fedora host shows `Zed dev.zed.Zed`; `/var/lib/flatpak/exports/bin` is not on `PATH` in interactive or login shells; the `zed` picker entry is filtered out by `availableEditorSet` (`OpenInPicker.tsx:177-178`).

## Global Constraints

- Editor ids stay exactly the `EditorId` literals in `packages/contracts/src/editor.ts`; the server must never emit an id outside that set (fixes the `"intellij"` bug).
- The `shell.openInEditor` RPC payload (`{ cwd, editor }`), error tags `ExternalLauncherUnknownEditorError` and `ExternalLauncherEditorSpawnError`, and the `availableEditors` array in `ServerConfig` are unchanged, so no contract fixture regeneration is required.
- Zed launch style stays `direct-path`: the target `path[:line[:col]]` is passed as one bare argument (`zed file.ts:42:10`).
- Windows keeps the `ShellAssociation` strategy (`open::with_detached(target, application)`); a resolved absolute program path is passed as `application`.
- Non-Windows keeps the detached `Command::new(program).args(args)` spawn.
- A known editor that is not detected at launch time still attempts its first `PATH` candidate (preserves today's behaviour when `PATH` changes after startup).
- The desktop e2e shim only fakes `cursor` (`apps/desktop/e2e/support/test-project.ts:901-904`); `cursor` must remain probed by its `PATH` name.
- Rust changes require `cargo fmt --all --check`, focused `cargo test -p bibcode-server`, and Clippy with warnings denied for `bibcode-server`.
- No contracts cleanup: the unused `commands`/`launchStyle` fields in `packages/contracts/src/editor.ts` stay as they are (recorded under Out of scope).

---

### Task 1: Server editor table and resolver

**Files:**
- Create: `apps/server/src/production/editor_launch.rs`
- Modify: `apps/server/src/production/mod.rs` (add `pub(crate) mod editor_launch;` next to the other production modules)
- Test: unit tests inside `editor_launch.rs`

**Interfaces:**
- Produces (all `pub(crate)`):

```rust
pub(crate) enum EditorArgs { Goto, DirectPath, KiroIde }
pub(crate) enum EditorCandidate {
    Path(&'static str),          // command name looked up on PATH
    Flatpak(&'static str),       // app id resolved through flatpak export dirs
    HomeRelative(&'static str),  // path under the home directory (POSIX separators)
    Absolute(&'static str),      // fixed absolute path
}
pub(crate) struct EditorDefinition {
    pub id: &'static str,
    pub candidates: &'static [EditorCandidate],
    pub args: EditorArgs,
}
pub(crate) struct EditorProbeEnv {
    pub path_entries: Vec<PathBuf>,
    pub home: Option<PathBuf>,
    pub flatpak_export_dirs: Vec<PathBuf>,
    pub local_app_data: Option<PathBuf>,
}
impl EditorProbeEnv { pub(crate) fn from_process() -> Self }
pub(crate) struct ResolvedEditor { pub id: &'static str, pub program: String, pub args: EditorArgs }
impl ResolvedEditor { pub(crate) fn args_for(&self, target: &str) -> Vec<String> }
pub(crate) fn editor_definition(id: &str) -> Option<&'static EditorDefinition>
pub(crate) fn resolve_editor(id: &str, env: &EditorProbeEnv) -> Option<ResolvedEditor>
pub(crate) fn available_editor_ids(env: &EditorProbeEnv) -> Vec<&'static str>
pub(crate) fn fallback_program(definition: &EditorDefinition) -> Option<String>
```

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/production/editor_launch.rs` containing only the test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn executable(dir: &std::path::Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    fn env_with(path_dir: &std::path::Path) -> EditorProbeEnv {
        EditorProbeEnv {
            path_entries: vec![path_dir.to_path_buf()],
            home: None,
            flatpak_export_dirs: Vec::new(),
            local_app_data: None,
        }
    }

    #[test]
    fn resolves_zed_from_path_and_reports_it_available() {
        let temp = tempfile::tempdir().unwrap();
        executable(temp.path(), "zed");
        let env = env_with(temp.path());

        let resolved = resolve_editor("zed", &env).expect("zed resolves");
        assert_eq!(resolved.id, "zed");
        assert_eq!(resolved.program, "zed");
        assert_eq!(resolved.args_for("/repo/src/main.ts:4:2"), vec!["/repo/src/main.ts:4:2"]);
        assert_eq!(available_editor_ids(&env), vec!["zed"]);
    }

    #[test]
    fn resolves_zed_through_the_zeditor_alias() {
        let temp = tempfile::tempdir().unwrap();
        executable(temp.path(), "zeditor");
        let env = env_with(temp.path());

        assert_eq!(resolve_editor("zed", &env).unwrap().program, "zeditor");
    }

    #[test]
    fn resolves_zed_through_a_flatpak_export_when_path_is_empty() {
        let temp = tempfile::tempdir().unwrap();
        let exports = temp.path().join("exports/bin");
        fs::create_dir_all(&exports).unwrap();
        let wrapper = executable(&exports, "dev.zed.Zed");
        let env = EditorProbeEnv {
            path_entries: Vec::new(),
            home: None,
            flatpak_export_dirs: vec![exports.clone()],
            local_app_data: None,
        };

        let resolved = resolve_editor("zed", &env).expect("flatpak zed resolves");
        assert_eq!(resolved.program, wrapper.to_string_lossy());
        assert_eq!(available_editor_ids(&env), vec!["zed"]);
    }

    #[test]
    fn resolves_zed_through_the_macos_bundle_cli_under_home_or_applications() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let bundle = home.join("Applications/Zed.app/Contents/MacOS");
        fs::create_dir_all(&bundle).unwrap();
        let cli = executable(&bundle, "cli");
        let env = EditorProbeEnv {
            path_entries: Vec::new(),
            home: Some(home),
            flatpak_export_dirs: Vec::new(),
            local_app_data: None,
        };

        assert_eq!(resolve_editor("zed", &env).unwrap().program, cli.to_string_lossy());
    }

    #[test]
    fn vscode_uses_goto_and_kiro_prefixes_ide() {
        let temp = tempfile::tempdir().unwrap();
        executable(temp.path(), "code");
        executable(temp.path(), "kiro");
        let env = env_with(temp.path());

        let code = resolve_editor("vscode", &env).unwrap();
        assert_eq!(code.args_for("/repo/a.ts:1"), vec!["--goto", "/repo/a.ts:1"]);
        let kiro = resolve_editor("kiro", &env).unwrap();
        assert_eq!(kiro.args_for("/repo/a.ts:1"), vec!["ide", "--goto", "/repo/a.ts:1"]);
        let mut ids = available_editor_ids(&env);
        ids.sort_unstable();
        assert_eq!(ids, vec!["kiro", "vscode"]);
    }

    #[test]
    fn idea_reports_its_contract_id_not_intellij() {
        let temp = tempfile::tempdir().unwrap();
        executable(temp.path(), "idea");
        let env = env_with(temp.path());

        assert_eq!(available_editor_ids(&env), vec!["idea"]);
    }

    #[test]
    fn unknown_editor_has_no_definition_and_missing_editor_falls_back_to_first_path_name() {
        let env = env_with(std::path::Path::new("/definitely/not/a/dir"));
        assert!(editor_definition("missing-editor").is_none());
        assert!(resolve_editor("zed", &env).is_none());
        assert_eq!(fallback_program(editor_definition("zed").unwrap()).as_deref(), Some("zed"));
        assert!(editor_definition("file-manager").is_none());
    }

    #[test]
    fn process_env_reads_path_home_and_flatpak_dirs() {
        let env = EditorProbeEnv::from_process();
        let _ = env.path_entries.len();
        assert!(env
            .flatpak_export_dirs
            .iter()
            .any(|dir| dir.ends_with("flatpak/exports/bin")) || !cfg!(target_os = "linux"));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cargo test -p bibcode-server --lib -j 2 production::editor_launch::tests
```

Expected: compile error, `resolve_editor`, `EditorProbeEnv`, and friends are undefined.

- [ ] **Step 3: Implement the module**

Add above the test module in `editor_launch.rs`:

```rust
//! One server-owned catalog of external editors: how each is detected on the host and how its
//! launch arguments are shaped. `control.rs` reports availability from it and `git_vcs.rs`
//! launches through it, so the two can never disagree.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EditorArgs {
    /// `<program> --goto <path[:line[:col]]>` (VS Code family).
    Goto,
    /// `<program> <path[:line[:col]]>` (Zed, JetBrains).
    DirectPath,
    /// `<program> ide --goto <path[:line[:col]]>` (Kiro).
    KiroIde,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EditorCandidate {
    Path(&'static str),
    Flatpak(&'static str),
    HomeRelative(&'static str),
    Absolute(&'static str),
}

#[derive(Debug)]
pub(crate) struct EditorDefinition {
    pub id: &'static str,
    pub candidates: &'static [EditorCandidate],
    pub args: EditorArgs,
}

const ZED_CANDIDATES: &[EditorCandidate] = &[
    EditorCandidate::Path("zed"),
    EditorCandidate::Path("zeditor"),
    EditorCandidate::Flatpak("dev.zed.Zed"),
    EditorCandidate::HomeRelative(".local/bin/zed"),
    EditorCandidate::HomeRelative("Applications/Zed.app/Contents/MacOS/cli"),
    EditorCandidate::Absolute("/Applications/Zed.app/Contents/MacOS/cli"),
    EditorCandidate::HomeRelative("AppData/Local/Programs/Zed/zed.exe"),
];

macro_rules! path_editor {
    ($id:literal, $command:literal, $args:expr) => {
        EditorDefinition {
            id: $id,
            candidates: &[EditorCandidate::Path($command)],
            args: $args,
        }
    };
}

pub(crate) static EDITOR_DEFINITIONS: &[EditorDefinition] = &[
    path_editor!("cursor", "cursor", EditorArgs::Goto),
    path_editor!("trae", "trae", EditorArgs::Goto),
    path_editor!("kiro", "kiro", EditorArgs::KiroIde),
    path_editor!("vscode", "code", EditorArgs::Goto),
    path_editor!("vscode-insiders", "code-insiders", EditorArgs::Goto),
    path_editor!("vscodium", "codium", EditorArgs::Goto),
    EditorDefinition { id: "zed", candidates: ZED_CANDIDATES, args: EditorArgs::DirectPath },
    path_editor!("antigravity", "agy", EditorArgs::Goto),
    path_editor!("idea", "idea", EditorArgs::DirectPath),
    path_editor!("aqua", "aqua", EditorArgs::DirectPath),
    path_editor!("clion", "clion", EditorArgs::DirectPath),
    path_editor!("datagrip", "datagrip", EditorArgs::DirectPath),
    path_editor!("dataspell", "dataspell", EditorArgs::DirectPath),
    path_editor!("goland", "goland", EditorArgs::DirectPath),
    path_editor!("phpstorm", "phpstorm", EditorArgs::DirectPath),
    path_editor!("pycharm", "pycharm", EditorArgs::DirectPath),
    path_editor!("rider", "rider", EditorArgs::DirectPath),
    path_editor!("rubymine", "rubymine", EditorArgs::DirectPath),
    path_editor!("rustrover", "rustrover", EditorArgs::DirectPath),
    path_editor!("webstorm", "webstorm", EditorArgs::DirectPath),
];

#[derive(Debug, Clone)]
pub(crate) struct EditorProbeEnv {
    pub path_entries: Vec<PathBuf>,
    pub home: Option<PathBuf>,
    pub flatpak_export_dirs: Vec<PathBuf>,
    pub local_app_data: Option<PathBuf>,
}

impl EditorProbeEnv {
    pub(crate) fn from_process() -> Self {
        let path_entries = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();
        let home = dirs::home_dir();
        let mut flatpak_export_dirs = vec![PathBuf::from("/var/lib/flatpak/exports/bin")];
        let user_data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|home| home.join(".local/share")));
        if let Some(user_data) = user_data {
            flatpak_export_dirs.push(user_data.join("flatpak/exports/bin"));
        }
        let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        Self { path_entries, home, flatpak_export_dirs, local_app_data }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedEditor {
    pub id: &'static str,
    pub program: String,
    pub args: EditorArgs,
}

impl ResolvedEditor {
    pub(crate) fn args_for(&self, target: &str) -> Vec<String> {
        match self.args {
            EditorArgs::Goto => vec!["--goto".to_owned(), target.to_owned()],
            EditorArgs::DirectPath => vec![target.to_owned()],
            EditorArgs::KiroIde => vec!["ide".to_owned(), "--goto".to_owned(), target.to_owned()],
        }
    }
}

pub(crate) fn editor_definition(id: &str) -> Option<&'static EditorDefinition> {
    EDITOR_DEFINITIONS.iter().find(|definition| definition.id == id)
}

pub(crate) fn resolve_editor(id: &str, env: &EditorProbeEnv) -> Option<ResolvedEditor> {
    let definition = editor_definition(id)?;
    let program = definition
        .candidates
        .iter()
        .find_map(|candidate| resolve_candidate(candidate, env))?;
    Some(ResolvedEditor { id: definition.id, program, args: definition.args })
}

pub(crate) fn available_editor_ids(env: &EditorProbeEnv) -> Vec<&'static str> {
    EDITOR_DEFINITIONS
        .iter()
        .filter(|definition| resolve_editor(definition.id, env).is_some())
        .map(|definition| definition.id)
        .collect()
}

/// The command name to try when nothing resolved at probe time (PATH may differ at launch).
pub(crate) fn fallback_program(definition: &EditorDefinition) -> Option<String> {
    definition.candidates.iter().find_map(|candidate| match candidate {
        EditorCandidate::Path(command) => Some((*command).to_owned()),
        _ => None,
    })
}

fn resolve_candidate(candidate: &EditorCandidate, env: &EditorProbeEnv) -> Option<String> {
    match candidate {
        EditorCandidate::Path(command) => env
            .path_entries
            .iter()
            .any(|directory| is_executable_file(&directory.join(command)))
            .then(|| (*command).to_owned()),
        EditorCandidate::Flatpak(app_id) => env
            .flatpak_export_dirs
            .iter()
            .map(|directory| directory.join(app_id))
            .find(|wrapper| is_executable_file(wrapper))
            .map(|wrapper| wrapper.to_string_lossy().into_owned()),
        EditorCandidate::HomeRelative(relative) => {
            let base = if relative.starts_with("AppData/Local/") {
                env.local_app_data
                    .clone()
                    .map(|dir| dir.join(relative.trim_start_matches("AppData/Local/")))
            } else {
                env.home.as_ref().map(|home| home.join(relative))
            };
            base.filter(|path| is_executable_file(path))
                .map(|path| path.to_string_lossy().into_owned())
        }
        EditorCandidate::Absolute(absolute) => {
            let path = Path::new(absolute);
            is_executable_file(path).then(|| (*absolute).to_owned())
        }
    }
}

fn is_executable_file(path: &Path) -> bool {
    if path.is_file() {
        return true;
    }
    cfg!(windows)
        && ["exe", "cmd", "bat"]
            .into_iter()
            .any(|extension| path.with_extension(extension).is_file())
}
```

Confirm `dirs` is already a `bibcode-server` dependency (`apps/server/src/workspace/entries.rs:195` uses `dirs::home_dir()`); if the crate is named differently in `apps/server/Cargo.toml`, use that name.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cargo test -p bibcode-server --lib -j 2 production::editor_launch::tests
```

Expected: PASS, 8 tests. The Windows `AppData/Local` candidate is exercised only through the `HomeRelative` branch on Windows hosts; on Linux and macOS the `local_app_data` field stays `None`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/production/editor_launch.rs apps/server/src/production/mod.rs
git commit -m "feat(server): add a shared editor catalog with Flatpak and bundle detection"
```

---

### Task 2: Report availability from the shared catalog

**Files:**
- Modify: `apps/server/src/production/control.rs:2173-2196` (delete `available_editors` and `command_exists`; keep the call site at line 376 `"availableEditors": available_editors()` working)
- Test: `apps/server/src/production/control.rs:5143-5173` (`unit_build_covers_server_control_settings_keybindings_and_streams`, which currently calls `let _ = available_editors(); assert!(!command_exists("definitely-not-a-bibcode-editor"));`)

**Interfaces:**
- Consumes: `available_editor_ids(&EditorProbeEnv::from_process())` from Task 1.
- Produces: `fn available_editors() -> Vec<&'static str>` retains its name and return type so the `config_snapshot` call site is unchanged.

- [ ] **Step 1: Update the smoke test**

Replace the two lines in the smoke test with:

```rust
        let editors = available_editors();
        assert!(editors.iter().all(|id| super::super::editor_launch::editor_definition(id).is_some()));
        assert!(!editors.contains(&"intellij"));
```

(Adjust the module path to `crate::production::editor_launch::editor_definition` if `super::super` does not resolve from the test module.)

- [ ] **Step 2: Run the test to verify it fails**

```bash
cargo test -p bibcode-server --lib -j 2 unit_build_covers_server_control_settings_keybindings_and_streams
```

Expected: compile error, `editor_launch::editor_definition` not in scope is acceptable only until Step 3; if it compiles, the assertion fails on a host with `idea` on `PATH` and passes elsewhere. Either way proceed.

- [ ] **Step 3: Replace the probe**

Replace `available_editors` and `command_exists` in `control.rs` with:

```rust
fn available_editors() -> Vec<&'static str> {
    crate::production::editor_launch::available_editor_ids(
        &crate::production::editor_launch::EditorProbeEnv::from_process(),
    )
}
```

Remove any now-unused imports.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cargo test -p bibcode-server --lib -j 2 unit_build_covers_server_control_settings_keybindings_and_streams
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/production/control.rs
git commit -m "fix(server): report editor availability from the shared catalog"
```

---

### Task 3: Launch through the shared catalog

**Files:**
- Modify: `apps/server/src/production/git_vcs.rs:1733-1762` (`open_in_editor_with`), keep `launch_editor`, `EditorLaunchStrategy`, `editor_launch_strategy`; delete `JETBRAINS_EDITORS` (lines 1814-1827) once unused
- Test: `apps/server/src/production/git_vcs.rs` tests near line 3637-3683 (Windows arg shaping) and 4202-4210 (`missing-editor` → error); add non-Windows tests

**Interfaces:**
- Consumes: `resolve_editor`, `editor_definition`, `fallback_program`, `EditorProbeEnv::from_process` from Task 1.
- Produces: `open_in_editor_with` gains an `env: &EditorProbeEnv` parameter; the RPC dispatcher at line 1652-1654 passes `&EditorProbeEnv::from_process()`.

- [ ] **Step 1: Write the failing tests**

In the `git_vcs.rs` test module, add:

```rust
    #[cfg(not(windows))]
    #[test]
    fn open_in_editor_launches_zed_with_the_bare_target() {
        let temp = tempfile::tempdir().unwrap();
        let zed = temp.path().join("zed");
        std::fs::write(&zed, b"#!/bin/sh\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&zed, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let env = crate::production::editor_launch::EditorProbeEnv {
            path_entries: vec![temp.path().to_path_buf()],
            home: None,
            flatpak_export_dirs: Vec::new(),
            local_app_data: None,
        };
        let captured = std::sync::Mutex::new(None);
        let result = open_in_editor_with(
            json!({ "cwd": "/repo/src/main.ts:4:2", "editor": "zed" }),
            &env,
            |strategy| {
                *captured.lock().unwrap() = Some(strategy.clone());
                Ok(())
            },
        );
        assert!(result.is_ok());
        assert_eq!(
            captured.into_inner().unwrap(),
            Some(EditorLaunchStrategy::Process {
                command: "zed".to_owned(),
                args: vec!["/repo/src/main.ts:4:2".to_owned()],
            })
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn open_in_editor_launches_flatpak_zed_through_its_export_wrapper() {
        let temp = tempfile::tempdir().unwrap();
        let exports = temp.path().join("exports/bin");
        std::fs::create_dir_all(&exports).unwrap();
        let wrapper = exports.join("dev.zed.Zed");
        std::fs::write(&wrapper, b"#!/bin/sh\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let env = crate::production::editor_launch::EditorProbeEnv {
            path_entries: Vec::new(),
            home: None,
            flatpak_export_dirs: vec![exports],
            local_app_data: None,
        };
        let captured = std::sync::Mutex::new(None);
        open_in_editor_with(json!({ "cwd": "/repo", "editor": "zed" }), &env, |strategy| {
            *captured.lock().unwrap() = Some(strategy.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            captured.into_inner().unwrap(),
            Some(EditorLaunchStrategy::Process {
                command: wrapper.to_string_lossy().into_owned(),
                args: vec!["/repo".to_owned()],
            })
        );
    }

    #[test]
    fn open_in_editor_still_tries_the_path_name_when_nothing_resolved() {
        let env = crate::production::editor_launch::EditorProbeEnv {
            path_entries: Vec::new(),
            home: None,
            flatpak_export_dirs: Vec::new(),
            local_app_data: None,
        };
        let error = open_in_editor_with(json!({ "cwd": "/repo", "editor": "vscode" }), &env, |_| {
            Err(std::io::Error::other("spawn failed"))
        })
        .unwrap_err();
        assert_eq!(error["_tag"], "ExternalLauncherEditorSpawnError");
        assert_eq!(error["command"], "code");
    }
```

`EditorLaunchStrategy` needs `#[derive(Debug, Clone, Eq, PartialEq)]` (add `Clone`). Update the existing Windows-only tests at lines 3637-3683 to pass an `EditorProbeEnv` with an empty `path_entries` and assert the same `ShellAssociation { application, target }` values they assert today.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cargo test -p bibcode-server --lib -j 2 open_in_editor
```

Expected: compile error, `open_in_editor_with` takes two arguments.

- [ ] **Step 3: Rewrite `open_in_editor_with`**

```rust
fn open_in_editor_with(
    payload: Value,
    env: &crate::production::editor_launch::EditorProbeEnv,
    launch: impl FnOnce(&EditorLaunchStrategy) -> std::io::Result<()>,
) -> RpcResult {
    use crate::production::editor_launch::{editor_definition, fallback_program, resolve_editor};

    let input: LaunchEditorInput = decode(payload, "shell.openInEditor")?;
    if input.editor == "file-manager" {
        return open::that_detached(&input.cwd).map(|()| Value::Null).map_err(|error| {
            json!({
                "_tag": "ExternalLauncherEditorSpawnError", "editor": input.editor,
                "target": display_path(&input.cwd), "command": "open", "args": [],
                "cause": error.to_string(),
            })
        });
    }
    let Some(definition) = editor_definition(&input.editor) else {
        return Err(json!({ "_tag": "ExternalLauncherUnknownEditorError", "editor": input.editor }));
    };
    let target = display_path(&input.cwd);
    let resolved = resolve_editor(definition.id, env).or_else(|| {
        fallback_program(definition).map(|program| {
            crate::production::editor_launch::ResolvedEditor {
                id: definition.id,
                program,
                args: definition.args,
            }
        })
    });
    let Some(resolved) = resolved else {
        return Err(json!({ "_tag": "ExternalLauncherUnknownEditorError", "editor": input.editor }));
    };
    let args = resolved.args_for(&target);
    let strategy = editor_launch_strategy(&resolved.program, args.clone(), target.clone());
    launch(&strategy).map(|()| Value::Null).map_err(|error| {
        json!({
            "_tag": "ExternalLauncherEditorSpawnError", "editor": input.editor,
            "target": target, "command": resolved.program, "args": args,
            "cause": error.to_string(),
        })
    })
}
```

Update the dispatcher call at `git_vcs.rs:1652-1654` to:

```rust
open_in_editor_with(
    payload,
    &crate::production::editor_launch::EditorProbeEnv::from_process(),
    launch_editor,
)
```

Delete `JETBRAINS_EDITORS` and any import that becomes unused.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cargo test -p bibcode-server --lib -j 2 open_in_editor
cargo test -p bibcode-server --lib -j 2 production::git_vcs
cargo test -p bibcode-server -j 2 --test production_git_vcs_rpc
```

Expected: PASS, including the existing `missing-editor` → error test at line 4202 and the wire test in `apps/server/tests/production_git_vcs_rpc.rs:2367-2376`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/production/git_vcs.rs
git commit -m "fix(server): launch external editors through the shared catalog"
```

---

### Task 4: Documentation and validation

**Files:**
- Modify: `docs/user/workspace-ui.md:81-83` (Open in paragraph)
- Review only: `docs/testing/` runbooks (`rg -n "Open in|editor" docs/testing`), `packages/contracts` fixtures (unchanged)

- [ ] **Step 1: Document detection**

After the sentence about **Open in → File Explorer** being omitted for remote environments and browser mode, add:

```markdown
External editors are listed when the server host can find them: on `PATH`
(for Zed also the `zeditor` alias), as a Flatpak export (`dev.zed.Zed`), in
`~/.local/bin`, as the macOS app bundle CLI, or in the Windows per-user
install directory. Detection runs on the server that owns the environment, so
a remote environment lists the editors installed on that remote host.
```

- [ ] **Step 2: Run repository gates**

```bash
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
cargo test -p bibcode-server --lib -j 2 production::editor_launch production::git_vcs unit_build_covers_server_control_settings_keybindings_and_streams
node scripts/run-local-vp.mjs test run packages/contracts/src/editor.test.ts apps/web/src/components/chat/OpenInPicker.test.tsx
vp check
vp run typecheck
```

Expected: all green; `git status --short` shows only the new module, `mod.rs`, `control.rs`, `git_vcs.rs`, and the doc.

- [ ] **Step 3: Manual verification on the user's host**

Start the server (`cargo run -p bibcode-server -- serve` or `vp run dev`), open a project, and confirm the Open in picker lists **Zed**; choose it and confirm the Flatpak Zed window opens the file. Record the observation in the final report.

- [ ] **Step 4: Commit**

```bash
git add docs/user/workspace-ui.md
git commit -m "docs(editors): describe how external editors are detected"
```

## Out of scope

- Removing the unused `commands`/`launchStyle` fields from `packages/contracts/src/editor.ts` (duplicate source of truth today, but touching contracts triggers fixture regeneration and is unrelated to the user's ask).
- Flatpak candidates for VS Code (`com.visualstudio.code`) and VSCodium (`com.vscodium.codium`): trivial to add to the catalog later as `EditorCandidate::Flatpak` entries.
- `"file-manager"` is never emitted in `availableEditors` even though `GitManagerChangesView.tsx:482` gates on it.

## Residual risk

- Windows per-user Zed path (`%LOCALAPPDATA%\Programs\Zed\zed.exe`) is taken from Zed's install docs and is not verified on a Windows host in this plan; the `open::with_detached` call with an absolute program path is the same mechanism VS Code uses today.
- The Flatpak export wrapper is executed directly (it is a shell script that runs `flatpak run dev.zed.Zed "$@"`); if a distribution places exports elsewhere, `PATH`-based detection still applies.

## Self-review

- Spec coverage: Zed shown when installed (Tasks 1-2), Zed launches with the file target (Task 3), documented (Task 4).
- Placeholder scan: none.
- Type consistency: `EditorProbeEnv { path_entries, home, flatpak_export_dirs, local_app_data }`, `resolve_editor(id, env)`, `available_editor_ids(env)`, `fallback_program(definition)`, `ResolvedEditor::args_for(target)` are used with the same names in Tasks 1, 2, and 3; `EditorLaunchStrategy` gains `Clone` in Task 3.
