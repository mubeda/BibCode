use super::{GitWatchEvent, event_changes_directories};
use crate::git::HostPathPlatform;
use notify::EventKind;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum MetadataChange {
    Ignore,
    Metadata,
    RefMetadata,
    WorktreeContainer,
}

/// A first-level metadata store that gets a native recursive watch when its
/// metadata root is watched non-recursively (outside the worktree).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Store {
    Refs,
    Logs,
    Reftable,
    Worktrees,
}

const STORES: [(&str, Store); 4] = [
    ("refs", Store::Refs),
    ("logs", Store::Logs),
    ("reftable", Store::Reftable),
    ("worktrees", Store::Worktrees),
];

pub(super) struct MetadataLayout {
    /// The store containing the path, whatever its depth below the store.
    pub(super) store: Option<Store>,
    change: MetadataChange,
}

impl MetadataLayout {
    pub(super) fn event(&self, kind: EventKind) -> Option<GitWatchEvent> {
        match self.change {
            MetadataChange::Ignore => None,
            MetadataChange::Metadata => Some(GitWatchEvent::Metadata),
            MetadataChange::RefMetadata => Some(GitWatchEvent::RefMetadata),
            MetadataChange::WorktreeContainer => {
                event_changes_directories(kind).then_some(GitWatchEvent::RefMetadata)
            }
        }
    }
}

pub(super) fn component_matches(actual: &str, expected: &str, platform: HostPathPlatform) -> bool {
    match platform {
        HostPathPlatform::Windows => actual.eq_ignore_ascii_case(expected),
        HostPathPlatform::Posix => actual == expected,
    }
}

/// The one metadata layout policy used by event routing and native registration.
pub(super) fn metadata_layout(relative: &str, platform: HostPathPlatform) -> MetadataLayout {
    let mut parts = relative.split('/');
    let first = parts.next().unwrap_or_default();
    let is = |actual: &str, expected: &str| component_matches(actual, expected, platform);
    let store = STORES
        .into_iter()
        .find_map(|(name, store)| is(first, name).then_some(store));
    let change = match store {
        Some(Store::Refs | Store::Reftable) => MetadataChange::RefMetadata,
        Some(Store::Logs) => match (parts.next(), parts.next(), parts.next()) {
            (None, _, _) => MetadataChange::RefMetadata,
            (Some(refs), None, _) if is(refs, "refs") => MetadataChange::RefMetadata,
            (Some(refs), Some(stash), None) if is(refs, "refs") && is(stash, "stash") => {
                MetadataChange::RefMetadata
            }
            _ => MetadataChange::Metadata,
        },
        Some(Store::Worktrees) => match (parts.next(), parts.next(), parts.next()) {
            (None, _, _) | (Some(_), None, _) => MetadataChange::WorktreeContainer,
            (Some(_), Some(store), _) if is(store, "reftable") => MetadataChange::RefMetadata,
            (Some(_), Some(head), None) if is(head, "HEAD") => MetadataChange::RefMetadata,
            _ => MetadataChange::Ignore,
        },
        None if is(first, "objects") || is(first, "lfs") => MetadataChange::Ignore,
        // A submodule's Git directory: only its object store is filtered, so a
        // commit or checkout inside the submodule still refreshes local status.
        None if is(first, "modules") => match (parts.next(), parts.next()) {
            (Some(_), Some(objects)) if is(objects, "objects") => MetadataChange::Ignore,
            _ => MetadataChange::Metadata,
        },
        None if !relative.contains('/')
            && (is(first, "HEAD")
                || is(first, "packed-refs")
                || first
                    .rsplit_once('_')
                    .is_some_and(|(_, suffix)| is(suffix, "HEAD"))) =>
        {
            MetadataChange::RefMetadata
        }
        None => MetadataChange::Metadata,
    };
    MetadataLayout { store, change }
}
