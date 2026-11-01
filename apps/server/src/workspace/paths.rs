use std::path::{Component, Path, PathBuf};

use super::WorkspaceError;

pub async fn normalize_root(
    root: &Path,
    create_if_missing: bool,
) -> Result<PathBuf, WorkspaceError> {
    if create_if_missing && !root.exists() {
        tokio::fs::create_dir_all(root)
            .await
            .map_err(|error| WorkspaceError::operation("make-directory", root, error))?;
    }
    let metadata = tokio::fs::metadata(root).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            WorkspaceError::RootNotFound {
                path: root.to_path_buf(),
            }
        } else {
            WorkspaceError::operation("stat", root, error)
        }
    })?;
    if !metadata.is_dir() {
        return Err(WorkspaceError::RootNotDirectory {
            path: root.to_path_buf(),
        });
    }
    tokio::fs::canonicalize(root)
        .await
        .map_err(|error| WorkspaceError::operation("realpath-workspace-root", root, error))
}

pub fn resolve_relative(root: &Path, relative: &str) -> Result<(PathBuf, String), WorkspaceError> {
    let trimmed = relative.trim();
    let path = Path::new(trimmed);
    let invalid_component = path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    });
    if trimmed.is_empty() || trimmed == "." || path.is_absolute() || invalid_component {
        return Err(WorkspaceError::PathOutsideRoot {
            relative_path: relative.to_owned(),
        });
    }
    let normalized = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value),
            Component::CurDir => None,
            _ => None,
        })
        .collect::<PathBuf>();
    if normalized.as_os_str().is_empty() {
        return Err(WorkspaceError::PathOutsideRoot {
            relative_path: relative.to_owned(),
        });
    }
    Ok((root.join(&normalized), to_posix(&normalized)))
}

/// `target` (under `root`) resolved through every symlink, checked to stay inside `root` and
/// out of Git's own metadata ([`refuse_git_metadata`]).
pub async fn canonical_existing_within(
    root: &Path,
    target: &Path,
) -> Result<(PathBuf, PathBuf), WorkspaceError> {
    refuse_named_git_metadata(root, target)?;
    let (canonical_root, canonical_target) =
        canonical_existing_anywhere_within(root, target).await?;
    refuse_git_metadata(&canonical_root, &canonical_target)?;
    Ok((canonical_root, canonical_target))
}

/// [`canonical_existing_within`] without the Git metadata check, for what an entry that is
/// itself a symlink names: a rename or delete acts on the link, never on its target.
pub async fn canonical_existing_anywhere_within(
    root: &Path,
    target: &Path,
) -> Result<(PathBuf, PathBuf), WorkspaceError> {
    let canonical_root = normalize_root(root, false).await?;
    let canonical_target = tokio::fs::canonicalize(target)
        .await
        .map_err(|error| WorkspaceError::operation("realpath-target", target, error))?;
    ensure_contained(&canonical_root, &canonical_target)?;
    Ok((canonical_root, canonical_target))
}

/// Refuses a canonical `target` under the canonical `root` that is Git's own metadata or is
/// inside it: a path with a `.git` component below the root (any letter case), the checkout's
/// Git directory or common directory wherever its `.git` file puts them below the root, or a
/// folder that holds one of those. Changing Git's metadata can make Git run a command as the
/// server's user (`core.fsmonitor`, `core.hooksPath`, a hook), so neither an agent nor the
/// Files panel reads or changes it (#139 X5 review round 6).
pub fn refuse_git_metadata(root: &Path, target: &Path) -> Result<(), WorkspaceError> {
    refuse_named_git_metadata(root, target)?;
    let inside = crate::git::checkout_git_dirs(root)
        .into_iter()
        .filter(|dir| dir.starts_with(root) && dir != root)
        .any(|dir| target.starts_with(&dir) || (dir.starts_with(target) && target != root));
    if inside {
        return Err(WorkspaceError::GitMetadata {
            path: target.to_path_buf(),
        });
    }
    Ok(())
}

/// The lexical half of [`refuse_git_metadata`]: a `.git` component below `root`.
fn refuse_named_git_metadata(root: &Path, target: &Path) -> Result<(), WorkspaceError> {
    match target.strip_prefix(root) {
        Ok(relative) if crate::git::names_git_metadata(relative) => {
            Err(WorkspaceError::GitMetadata {
                path: target.to_path_buf(),
            })
        }
        _ => Ok(()),
    }
}

pub async fn safe_mutation_target(root: &Path, target: &Path) -> Result<PathBuf, WorkspaceError> {
    refuse_named_git_metadata(root, target)?;
    let canonical_root = normalize_root(root, false).await?;
    let mut existing = target.to_path_buf();
    let mut suffix = Vec::new();
    while !existing.exists() {
        let name = existing
            .file_name()
            .ok_or_else(|| WorkspaceError::PathOutsideRoot {
                relative_path: target.to_string_lossy().into_owned(),
            })?;
        suffix.push(name.to_os_string());
        existing = existing
            .parent()
            .ok_or_else(|| WorkspaceError::PathOutsideRoot {
                relative_path: target.to_string_lossy().into_owned(),
            })?
            .to_path_buf();
    }
    let mut canonical_target = tokio::fs::canonicalize(&existing)
        .await
        .map_err(|error| WorkspaceError::operation("realpath-target", &existing, error))?;
    ensure_contained(&canonical_root, &canonical_target)?;
    for component in suffix.iter().rev() {
        canonical_target.push(component);
    }
    refuse_git_metadata(&canonical_root, &canonical_target)?;
    Ok(canonical_target)
}

pub fn ensure_contained(root: &Path, target: &Path) -> Result<(), WorkspaceError> {
    if target == root || target.starts_with(root) {
        Ok(())
    } else {
        Err(WorkspaceError::ResolvedPathOutsideRoot {
            root: root.to_path_buf(),
            resolved_path: target.to_path_buf(),
        })
    }
}

pub fn to_posix(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Git's own metadata is refused by every path check here, however it is named or
    /// reached; ordinary dot-files are not (#139 X5 review round 6).
    #[cfg(unix)]
    #[tokio::test]
    async fn gits_own_metadata_is_refused_however_it_is_reached() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join(".git/hooks")).unwrap();
        std::fs::write(root.join(".git/config"), "[core]\n").unwrap();
        std::fs::create_dir_all(root.join("vendor/lib/.git")).unwrap();
        std::fs::create_dir_all(root.join(".github")).unwrap();
        std::fs::write(root.join(".gitignore"), "x\n").unwrap();
        std::os::unix::fs::symlink(".git", root.join("gitlink")).unwrap();
        let git_metadata = |result: Result<_, WorkspaceError>| {
            matches!(result, Err(WorkspaceError::GitMetadata { .. }))
        };

        for relative in [
            ".git/config",
            ".GIT/config",
            "./.git/config",
            ".git/",
            "gitlink/config",
            "vendor/lib/.git",
        ] {
            let (target, _) = resolve_relative(&root, relative).unwrap();
            assert!(
                git_metadata(canonical_existing_within(&root, &target).await.map(|_| ())),
                "{relative}"
            );
        }
        for relative in [".git/hooks/post-commit", "gitlink/hooks/new", ".Git/new"] {
            let (target, _) = resolve_relative(&root, relative).unwrap();
            assert!(
                git_metadata(safe_mutation_target(&root, &target).await.map(|_| ())),
                "{relative}"
            );
        }
        for relative in [".gitignore", ".github"] {
            let (target, _) = resolve_relative(&root, relative).unwrap();
            canonical_existing_within(&root, &target).await.unwrap();
            safe_mutation_target(&root, &target.join("new"))
                .await
                .unwrap();
        }
        // The link itself is only a link.
        canonical_existing_anywhere_within(&root, &root.join("gitlink"))
            .await
            .unwrap();
    }

    /// A `.git` file that puts the Git directory (and its common directory) inside the root
    /// under another name: both are refused, and so is a folder that holds them.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_git_directory_a_git_file_names_inside_the_root_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("meta/worktree")).unwrap();
        std::fs::create_dir_all(root.join("common/hooks")).unwrap();
        std::fs::write(root.join("meta/worktree/commondir"), "../../common\n").unwrap();
        std::fs::write(root.join(".git"), "gitdir: meta/worktree\n").unwrap();
        std::fs::write(root.join("common/config"), "[core]\n").unwrap();
        std::fs::write(root.join("meta/notes.txt"), "x").unwrap();
        for target in ["meta/worktree/commondir", "common/config", "common", "meta"] {
            assert!(
                matches!(
                    refuse_git_metadata(&root, &root.join(target)),
                    Err(WorkspaceError::GitMetadata { .. })
                ),
                "{target}"
            );
        }
        // A sibling of the Git directory is an ordinary file.
        refuse_git_metadata(&root, &root.join("meta/notes.txt")).unwrap();
        assert_eq!(
            crate::git::checkout_git_dirs(&root),
            [root.join("meta/worktree"), root.join("common")]
        );
    }

    #[tokio::test]
    async fn path_helpers_cover_creation_validation_and_containment() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        assert!(
            normalize_root(&root, true)
                .await
                .unwrap()
                .ends_with("workspace")
        );
        assert!(matches!(
            normalize_root(&temp.path().join("missing"), false).await,
            Err(WorkspaceError::RootNotFound { .. })
        ));

        let file = temp.path().join("file");
        std::fs::write(&file, "file").unwrap();
        assert!(matches!(
            normalize_root(&file, false).await,
            Err(WorkspaceError::RootNotDirectory { .. })
        ));

        let (resolved, normalized) = resolve_relative(&root, "./nested/file.txt").unwrap();
        assert_eq!(resolved, root.join("nested/file.txt"));
        assert_eq!(normalized, "nested/file.txt");
        for invalid in ["", ".", "..", "../outside", "/absolute"] {
            assert!(matches!(
                resolve_relative(&root, invalid),
                Err(WorkspaceError::PathOutsideRoot { .. })
            ));
        }

        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("nested/file.txt"), "contents").unwrap();
        let (canonical_root, canonical_file) =
            canonical_existing_within(&root, &root.join("nested/file.txt"))
                .await
                .unwrap();
        assert!(canonical_file.starts_with(&canonical_root));
        assert_eq!(
            safe_mutation_target(&root, &root.join("new/deep/file.txt"))
                .await
                .unwrap(),
            canonical_root.join("new/deep/file.txt")
        );
        assert!(ensure_contained(&canonical_root, &canonical_root).is_ok());
        assert!(matches!(
            ensure_contained(&canonical_root, temp.path()),
            Err(WorkspaceError::ResolvedPathOutsideRoot { .. })
        ));
        assert_eq!(to_posix(Path::new("nested\\file.txt")), "nested/file.txt");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_targets_cannot_escape_the_workspace() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "secret").unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();

        assert!(matches!(
            canonical_existing_within(root.path(), &root.path().join("escape/secret")).await,
            Err(WorkspaceError::ResolvedPathOutsideRoot { .. })
        ));
        assert!(matches!(
            safe_mutation_target(root.path(), &root.path().join("escape/new-file")).await,
            Err(WorkspaceError::ResolvedPathOutsideRoot { .. })
        ));
    }
}
