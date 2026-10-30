//! Thread targets and workspace paths for the outside-agent tools (#139, C5).
//!
//! Every workspace tool takes a `threadId`; the server resolves the folder the thread works in
//! (its worktree, else its project's root). Tools that name files take paths relative to that
//! folder, checked here before any RPC: literal file paths only, never globs or Git pathspec
//! magic, and never a path that leaves the folder, through `..` or through a symlinked
//! directory. Slices G and X5 call [`validate_paths`]; the Git layer adds
//! `--literal-pathspecs` for every caller (slice G).

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use super::{
    control::{ToolCall, invalid_argument, storage_failure},
    protocol::typed_tool_failure,
};

/// `PROJECT_ENTRY_PATH_MAX_LENGTH` in `packages/contracts/src/project.ts`.
pub(crate) const MOST_PATH_CHARS: usize = 512;
/// Paths one call may name.
pub(crate) const MOST_PATHS: usize = 200;

/// The folder a thread works in, and its project.
#[allow(
    dead_code,
    reason = "the workspace tool slices read the thread and project"
)]
pub(crate) struct ThreadTarget {
    pub(crate) thread: crate::persistence::ProjectionThread,
    pub(crate) project_id: String,
    /// The thread's worktree path, else its project's workspace root.
    pub(crate) cwd: String,
}

impl ToolCall<'_> {
    /// The thread `thread_id` names and the folder it works in.
    pub(crate) async fn target(&self, thread_id: &str) -> Result<ThreadTarget, Value> {
        let thread = self.thread(thread_id).await?;
        let cwd = match thread.worktree_path.clone().filter(|path| !path.is_empty()) {
            Some(path) => path,
            None => {
                self.control
                    .repositories()
                    .get_project(thread.project_id.clone())
                    .await
                    .map_err(storage_failure)?
                    .ok_or_else(|| {
                        typed_tool_failure(
                            "McpProjectNotFoundError",
                            "This thread's project is gone.",
                        )
                    })?
                    .workspace_root
            }
        };
        Ok(ThreadTarget {
            project_id: thread.project_id.clone(),
            thread,
            cwd,
        })
    }
}

fn refused(message: &str) -> Value {
    invalid_argument(message)
}

const LITERAL_ONLY: &str =
    "paths are literal file paths; globs and pathspec magic are not accepted";

/// Checks `paths`, relative to `cwd`, and returns them normalized (`./` and repeated
/// separators removed). Refuses more than [`MOST_PATHS`], an empty, absolute, too long or NUL
/// path, `..`, a glob or pathspec-magic character (a leading `:`, or `*`, `?`, `[`, `\`), and
/// a path whose parent resolves outside `cwd` through a symlink. A path that is itself a
/// symlink is allowed: Git tracks the link, not its target.
///
/// This reads the file system (each existing parent is canonicalized), so callers on the
/// runtime run it on a blocking thread when it can name many paths.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn validate_paths(cwd: &Path, paths: &[String]) -> Result<Vec<String>, Value> {
    if paths.is_empty() {
        return Err(refused("name at least one path"));
    }
    if paths.len() > MOST_PATHS {
        return Err(refused(&format!(
            "at most {MOST_PATHS} paths per call; split the call"
        )));
    }
    let root = cwd
        .canonicalize()
        .map_err(|_| refused("the thread's folder is missing"))?;
    paths
        .iter()
        .map(|path| validate_path(&root, path))
        .collect()
}

#[cfg_attr(not(test), allow(dead_code))]
fn validate_path(root: &Path, path: &str) -> Result<String, Value> {
    if path.is_empty() || path.chars().count() > MOST_PATH_CHARS {
        return Err(refused(&format!(
            "each path is 1 to {MOST_PATH_CHARS} characters"
        )));
    }
    if path.contains('\0') {
        return Err(refused("a path may not contain NUL"));
    }
    if path.starts_with(':') || path.contains(['*', '?', '[', '\\']) {
        return Err(refused(LITERAL_ONLY));
    }
    let relative = Path::new(path);
    if relative.has_root() || relative.is_absolute() {
        return Err(refused(
            "paths are relative to the thread's folder, not absolute",
        ));
    }
    let mut normal = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => normal.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(refused("a path may not leave the thread's folder"));
            }
        }
    }
    if normal.as_os_str().is_empty() {
        return Err(refused("name a file or folder inside the thread's folder"));
    }
    if let Some(parent) = normal
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        // The deepest parent that exists, resolved through any symlink, stays inside.
        let mut existing = root.join(parent);
        while !existing.exists() {
            match existing.parent() {
                Some(up) if up.starts_with(root) && up != existing => existing = up.to_path_buf(),
                _ => break,
            }
        }
        let resolved = existing
            .canonicalize()
            .map_err(|_| refused("a path may not leave the thread's folder"))?;
        if !resolved.starts_with(root) {
            return Err(refused("a path may not leave the thread's folder"));
        }
    }
    normal
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| refused("paths must be valid Unicode"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(result: Result<Vec<String>, Value>) -> String {
        result.unwrap_err()["structuredContent"]["error"]["_tag"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn literal_relative_paths_inside_the_folder_pass_normalized() {
        let folder = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(folder.path().join("src/nested")).unwrap();
        let paths = validate_paths(
            folder.path(),
            &[
                "src/main.rs".into(),
                "./src//nested/new.rs".into(),
                "missing/dir/file".into(),
                "README.md".into(),
            ],
        )
        .unwrap();
        assert_eq!(
            paths,
            [
                "src/main.rs",
                "src/nested/new.rs",
                "missing/dir/file",
                "README.md"
            ]
        );
    }

    #[test]
    fn absolute_parent_nul_glob_magic_and_too_many_paths_are_refused() {
        let folder = tempfile::tempdir().unwrap();
        for path in [
            "/etc/passwd",
            "../outside",
            "src/../../outside",
            "a\0b",
            ":(glob)**",
            ":/top",
            "*.rs",
            "src/?.rs",
            "src/[ab].rs",
            "src\\main.rs",
            "",
            ".",
        ] {
            let result = validate_paths(folder.path(), &[path.to_owned()]);
            assert_eq!(tag(result), "McpInvalidArgumentError", "{path:?}");
        }
        let long = "a".repeat(MOST_PATH_CHARS + 1);
        assert!(validate_paths(folder.path(), &[long]).is_err());
        let many: Vec<String> = (0..=MOST_PATHS).map(|index| format!("f{index}")).collect();
        let refused = validate_paths(folder.path(), &many).unwrap_err();
        assert!(
            refused["structuredContent"]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("at most 200")
        );
        assert!(validate_paths(folder.path(), &many[..MOST_PATHS]).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_directory_that_leaves_the_folder_is_refused() {
        let folder = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path(), folder.path().join("link")).unwrap();
        let refused = validate_paths(folder.path(), &["link/secret".into()]);
        assert_eq!(tag(refused), "McpInvalidArgumentError");
        let refused = validate_paths(folder.path(), &["link/not-yet/file".into()]);
        assert_eq!(tag(refused), "McpInvalidArgumentError");
        // The link itself is a file Git tracks.
        assert_eq!(
            validate_paths(folder.path(), &["link".into()]).unwrap(),
            ["link"]
        );
    }
}
