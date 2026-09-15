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
    EditorDefinition {
        id: "zed",
        candidates: ZED_CANDIDATES,
        args: EditorArgs::DirectPath,
    },
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
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|home| home.join(".local/share")));
        if let Some(user_data) = user_data {
            flatpak_export_dirs.push(user_data.join("flatpak/exports/bin"));
        }
        let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        Self {
            path_entries,
            home,
            flatpak_export_dirs,
            local_app_data,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedEditor {
    pub id: &'static str,
    pub program: String,
    pub args: EditorArgs,
    /// `Some(app_id)` when this editor launches through Flatpak, so `args_for` can grant the
    /// opened path's directory instead of relying on the sandbox's default `filesystems=home`.
    pub flatpak_app_id: Option<&'static str>,
}

impl ResolvedEditor {
    pub(crate) fn args_for(&self, target: &str) -> Vec<String> {
        let style_args = match self.args {
            EditorArgs::Goto => vec!["--goto".to_owned(), target.to_owned()],
            EditorArgs::DirectPath => vec![target.to_owned()],
            EditorArgs::KiroIde => vec!["ide".to_owned(), "--goto".to_owned(), target.to_owned()],
        };
        let Some(app_id) = self.flatpak_app_id else {
            return style_args;
        };
        let mut args = vec![
            "run".to_owned(),
            format!("--filesystem={}", target_directory(target)),
            app_id.to_owned(),
        ];
        args.extend(style_args);
        args
    }
}

/// Directory a launcher must be able to reach to open `target` (`path[:line[:col]]`).
pub(crate) fn target_directory(target: &str) -> String {
    let mut path = target;
    for _ in 0..2 {
        let Some(colon) = path.rfind(':') else {
            break;
        };
        let (prefix, suffix) = path.split_at(colon);
        let digits = &suffix[1..];
        if prefix.is_empty()
            || digits.is_empty()
            || !digits.bytes().all(|byte| byte.is_ascii_digit())
        {
            break;
        }
        path = prefix;
    }
    if Path::new(path).is_dir() {
        return path.to_owned();
    }
    match Path::new(path).parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_string_lossy().into_owned(),
        _ => path.to_owned(),
    }
}

pub(crate) fn editor_definition(id: &str) -> Option<&'static EditorDefinition> {
    EDITOR_DEFINITIONS
        .iter()
        .find(|definition| definition.id == id)
}

pub(crate) fn resolve_editor(id: &str, env: &EditorProbeEnv) -> Option<ResolvedEditor> {
    let definition = editor_definition(id)?;
    let (program, flatpak_app_id) = definition
        .candidates
        .iter()
        .find_map(|candidate| resolve_candidate(candidate, env))?;
    Some(ResolvedEditor {
        id: definition.id,
        program,
        args: definition.args,
        flatpak_app_id,
    })
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
    definition
        .candidates
        .iter()
        .find_map(|candidate| match candidate {
            EditorCandidate::Path(command) => Some((*command).to_owned()),
            _ => None,
        })
}

/// Resolves a candidate to its launch program and, for Flatpak, the app id `args_for` needs to
/// grant a filesystem override. The export wrapper's existence remains the detection signal, but
/// the program launched is `flatpak` itself (the wrapper execs `/usr/bin/flatpak`, so it is on
/// the host) rather than the wrapper path, so a per-run `--filesystem` override can be inserted.
fn resolve_candidate(
    candidate: &EditorCandidate,
    env: &EditorProbeEnv,
) -> Option<(String, Option<&'static str>)> {
    match candidate {
        EditorCandidate::Path(command) => env
            .path_entries
            .iter()
            .any(|directory| is_executable_file(&directory.join(command)))
            .then(|| ((*command).to_owned(), None)),
        EditorCandidate::Flatpak(app_id) => env
            .flatpak_export_dirs
            .iter()
            .map(|directory| directory.join(app_id))
            .any(|wrapper| is_executable_file(&wrapper))
            .then(|| ("flatpak".to_owned(), Some(*app_id))),
        EditorCandidate::HomeRelative(relative) => {
            let base = if relative.starts_with("AppData/Local/") {
                env.local_app_data
                    .clone()
                    .map(|dir| dir.join(relative.trim_start_matches("AppData/Local/")))
            } else {
                env.home.as_ref().map(|home| home.join(relative))
            };
            base.filter(|path| is_executable_file(path))
                .map(|path| (path.to_string_lossy().into_owned(), None))
        }
        EditorCandidate::Absolute(absolute) => {
            let path = Path::new(absolute);
            is_executable_file(path).then(|| ((*absolute).to_owned(), None))
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
        assert_eq!(
            resolved.args_for("/repo/src/main.ts:4:2"),
            vec!["/repo/src/main.ts:4:2"]
        );
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
        let _wrapper = executable(&exports, "dev.zed.Zed");
        let env = EditorProbeEnv {
            path_entries: Vec::new(),
            home: None,
            flatpak_export_dirs: vec![exports.clone()],
            local_app_data: None,
        };

        let resolved = resolve_editor("zed", &env).expect("flatpak zed resolves");
        assert_eq!(resolved.program, "flatpak");
        assert_eq!(resolved.flatpak_app_id, Some("dev.zed.Zed"));
        assert_eq!(
            resolved.args_for("/repo/src/main.ts:4:2"),
            vec![
                "run",
                "--filesystem=/repo/src",
                "dev.zed.Zed",
                "/repo/src/main.ts:4:2",
            ]
        );
        assert_eq!(available_editor_ids(&env), vec!["zed"]);
    }

    #[test]
    fn target_directory_strips_up_to_two_trailing_line_and_column_suffixes() {
        assert_eq!(target_directory("/repo/src/main.ts:4:2"), "/repo/src");
        assert_eq!(target_directory("/repo/src/main.ts"), "/repo/src");
    }

    #[test]
    fn target_directory_returns_an_existing_directory_target_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().to_string_lossy().into_owned();
        assert_eq!(target_directory(&dir), dir);
    }

    #[cfg(windows)]
    #[test]
    fn target_directory_strips_a_windows_line_suffix() {
        assert_eq!(target_directory("C:\\repo\\a.ts:3"), "C:\\repo");
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

        assert_eq!(
            resolve_editor("zed", &env).unwrap().program,
            cli.to_string_lossy()
        );
    }

    #[test]
    fn vscode_uses_goto_and_kiro_prefixes_ide() {
        let temp = tempfile::tempdir().unwrap();
        executable(temp.path(), "code");
        executable(temp.path(), "kiro");
        let env = env_with(temp.path());

        let code = resolve_editor("vscode", &env).unwrap();
        assert_eq!(
            code.args_for("/repo/a.ts:1"),
            vec!["--goto", "/repo/a.ts:1"]
        );
        let kiro = resolve_editor("kiro", &env).unwrap();
        assert_eq!(
            kiro.args_for("/repo/a.ts:1"),
            vec!["ide", "--goto", "/repo/a.ts:1"]
        );
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
        assert_eq!(
            fallback_program(editor_definition("zed").unwrap()).as_deref(),
            Some("zed")
        );
        assert!(editor_definition("file-manager").is_none());
    }

    #[test]
    fn process_env_reads_path_home_and_flatpak_dirs() {
        let env = EditorProbeEnv::from_process();
        let _ = env.path_entries.len();
        assert!(
            env.flatpak_export_dirs
                .iter()
                .any(|dir| dir.ends_with("flatpak/exports/bin"))
                || !cfg!(target_os = "linux")
        );
    }
}
