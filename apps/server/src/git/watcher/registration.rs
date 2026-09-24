//! Native recursion for the worktree, with targeted external metadata stores.
use super::layout::metadata_layout;
use super::{GitWatcherBackend, host_path_platform, normalize_worktree_path_key, relative_to_root};
use crate::git::HostPathPlatform;
use notify::RecursiveMode;
use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

/// Defensive bound: only store roots are queued, so events stay far below it; a
/// full rescan (which invalidates refs) replaces the queue if it is ever reached.
const MAX_PENDING_PATHS: usize = 256;

/// How the native watch plan covers a normalized path. The worktree root is
/// watched recursively; a metadata root outside it is watched non-recursively
/// and its first-level stores get native recursive watches once they exist.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Coverage {
    /// Outside every root, or a plain entry of a non-recursive metadata root
    /// (only changes to the entry itself are reported).
    Uncovered,
    /// A registered root, or inside native recursion (the worktree or a store).
    Native,
    /// A first-level store directly beneath a non-recursive metadata root. Only
    /// its creation, removal, or replacement needs registration work; native
    /// recursion covers every directory below it.
    StoreRoot,
}

/// The one coverage policy shared by the watch plan and registration.
pub(super) fn coverage(
    registered_roots: &[(String, RecursiveMode)],
    path: &str,
    platform: HostPathPlatform,
) -> Coverage {
    let mut coverage = Coverage::Uncovered;
    for (root, mode) in registered_roots {
        let Some(relative) = relative_to_root(path, root) else {
            continue;
        };
        if relative.is_empty() || *mode == RecursiveMode::Recursive {
            return Coverage::Native;
        }
        if metadata_layout(relative, platform).store.is_some() {
            if relative.contains('/') {
                return Coverage::Native;
            }
            coverage = Coverage::StoreRoot;
        }
    }
    coverage
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum DirectoryChange {
    Created,
    Replaced,
}

pub(super) struct PendingPath {
    pub(super) native_path: PathBuf,
    pub(super) change: DirectoryChange,
}

#[derive(Default)]
pub(super) struct PendingRegistrations {
    paths: HashMap<String, PendingPath>,
    full: bool,
}

impl PendingRegistrations {
    pub(super) fn add(&mut self, key: String, path: PendingPath) {
        if self.full {
            return;
        }
        if self.paths.len() == MAX_PENDING_PATHS && !self.paths.contains_key(&key) {
            self.rescan();
        } else {
            let change = path.change;
            let pending = self.paths.entry(key).or_insert(path);
            if change == DirectoryChange::Replaced {
                pending.change = change;
            }
        }
    }
    pub(super) fn rescan(&mut self) {
        self.full = true;
        self.paths.clear();
    }
    pub(super) fn is_full_rescan(&self) -> bool {
        self.full
    }
    pub(super) fn is_empty(&self) -> bool {
        !self.full && self.paths.is_empty()
    }
}

pub(super) struct WatchRegistration {
    roots: Vec<(PathBuf, RecursiveMode)>,
    installed: HashMap<String, PathBuf>,
}

impl WatchRegistration {
    pub(super) fn new(roots: Vec<(PathBuf, RecursiveMode)>) -> Self {
        Self {
            roots,
            installed: HashMap::new(),
        }
    }

    pub(super) fn install(
        &mut self,
        backend: &mut dyn GitWatcherBackend,
        cancellation: &CancellationToken,
    ) -> notify::Result<()> {
        for (root, mode) in self.roots.clone() {
            self.add_directory(backend, &root, mode, cancellation)?;
            if mode == RecursiveMode::NonRecursive {
                self.install_metadata_stores(backend, &root, cancellation)?;
            }
        }
        Ok(())
    }

    fn install_metadata_stores(
        &mut self,
        backend: &mut dyn GitWatcherBackend,
        root: &Path,
        cancellation: &CancellationToken,
    ) -> notify::Result<()> {
        for entry in fs::read_dir(root).map_err(notify::Error::io)? {
            check_cancelled(cancellation)?;
            let entry = entry.map_err(notify::Error::io)?;
            // Inspect only this root's children, never enumerate an object store.
            if metadata_layout(&entry.file_name().to_string_lossy(), host_path_platform())
                .store
                .is_some()
                && directory_exists(&entry.path()).map_err(notify::Error::io)?
            {
                self.add_directory(
                    backend,
                    &entry.path(),
                    RecursiveMode::Recursive,
                    cancellation,
                )?;
            }
        }
        Ok(())
    }

    pub(super) fn refresh(
        &mut self,
        backend: &mut dyn GitWatcherBackend,
        pending: PendingRegistrations,
        cancellation: &CancellationToken,
    ) -> notify::Result<bool> {
        if pending.full {
            self.remove_subtree(backend, None)?;
            self.install(backend, cancellation)?;
            return Ok(true);
        }
        let before = self.installed.len();
        let mut changed = false;
        // Only store roots are queued (`Coverage::StoreRoot`): the native recursive
        // backend owns descendants. Re-register a watched store root that was
        // removed/replaced, and discover late stores.
        for (key, pending_path) in pending.paths {
            if self.installed.contains_key(&key)
                && (pending_path.change == DirectoryChange::Replaced
                    || !directory_exists(&pending_path.native_path).map_err(notify::Error::io)?)
            {
                changed |= self.remove_subtree(backend, Some(&key))?;
            }
        }
        for (root, mode) in self.roots.clone() {
            if mode == RecursiveMode::NonRecursive {
                self.install_metadata_stores(backend, &root, cancellation)?;
            }
        }
        Ok(changed || self.installed.len() != before)
    }

    fn add_directory(
        &mut self,
        backend: &mut dyn GitWatcherBackend,
        path: &Path,
        mode: RecursiveMode,
        cancellation: &CancellationToken,
    ) -> notify::Result<()> {
        check_cancelled(cancellation)?;
        let key = normalize_worktree_path_key(path, host_path_platform());
        if self.installed.contains_key(&key) {
            return Ok(());
        }
        match backend.watch(path, mode) {
            Ok(()) => {
                self.installed.insert(key, path.to_path_buf());
                Ok(())
            }
            Err(_)
                if !directory_exists(path).map_err(notify::Error::io)?
                    && !self.roots.iter().any(|(root, _)| path == root) =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    pub(super) fn remove_subtree(
        &mut self,
        backend: &mut dyn GitWatcherBackend,
        root: Option<&str>,
    ) -> notify::Result<bool> {
        let keys: Vec<_> = self
            .installed
            .keys()
            .filter(|key| root.is_none_or(|root| relative_to_root(key, root).is_some()))
            .cloned()
            .collect();
        for key in &keys {
            match backend.unwatch(&self.installed[key]) {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.kind,
                        notify::ErrorKind::WatchNotFound | notify::ErrorKind::PathNotFound
                    ) => {}
                Err(error) => return Err(error),
            }
            self.installed.remove(key);
        }
        Ok(!keys.is_empty())
    }
}

fn directory_exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.is_dir() && !metadata.file_type().is_symlink()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn check_cancelled(cancellation: &CancellationToken) -> notify::Result<()> {
    if cancellation.is_cancelled() {
        Err(notify::Error::generic("Git watch registration cancelled"))
    } else {
        Ok(())
    }
}
