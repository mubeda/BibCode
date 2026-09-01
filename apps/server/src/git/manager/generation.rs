//! Repository-state generations shared by Git Manager reads.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const INITIAL_GENERATION: u64 = 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum RepositoryHeadState {
    Symbolic(String),
    Detached(String),
    Missing,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct RepositoryStateObservation {
    tip_shas: Box<[String]>,
    head: Option<RepositoryHeadState>,
}

impl RepositoryStateObservation {
    pub(super) fn from_tip_shas<'a>(tip_shas: impl IntoIterator<Item = &'a str>) -> Self {
        let mut tip_shas = tip_shas.into_iter().map(str::to_owned).collect::<Vec<_>>();
        tip_shas.sort_unstable();
        Self {
            tip_shas: tip_shas.into_boxed_slice(),
            head: None,
        }
    }

    pub(super) fn with_head(mut self, head: RepositoryHeadState) -> Self {
        self.head = Some(head);
        self
    }
}

#[derive(Debug)]
struct RepositoryGeneration {
    generation: u64,
    tip_shas: Option<Box<[String]>>,
    head: Option<RepositoryHeadState>,
}

impl Default for RepositoryGeneration {
    fn default() -> Self {
        Self {
            generation: INITIAL_GENERATION,
            tip_shas: None,
            head: None,
        }
    }
}

static REPOSITORY_GENERATIONS: OnceLock<Mutex<HashMap<PathBuf, RepositoryGeneration>>> =
    OnceLock::new();

pub(super) async fn observe_repository_state(
    cwd: &Path,
    observation: RepositoryStateObservation,
) -> u64 {
    let key = repository_key(cwd).await;
    let mut repositories = repository_generations()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let repository = repositories.entry(key).or_default();

    match repository.tip_shas.as_deref() {
        None => {
            repository.tip_shas = Some(observation.tip_shas);
            repository.head = observation.head;
        }
        Some(tip_shas) if tip_shas != observation.tip_shas.as_ref() => {
            repository.generation = repository.generation.saturating_add(1);
            repository.tip_shas = Some(observation.tip_shas);
            // A tips-only page cannot prove whether HEAD also changed. Forget the
            // prior HEAD so a later complete observation enriches this state
            // without manufacturing a second change.
            repository.head = observation.head;
        }
        Some(_) => {
            if let Some(head) = observation.head {
                if repository
                    .head
                    .as_ref()
                    .is_some_and(|current| current != &head)
                {
                    repository.generation = repository.generation.saturating_add(1);
                }
                repository.head = Some(head);
            }
        }
    }

    repository.generation
}

pub(super) async fn current_repository_generation(cwd: &Path) -> u64 {
    let key = repository_key(cwd).await;
    repository_generations()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .entry(key)
        .or_default()
        .generation
}

fn repository_generations() -> &'static Mutex<HashMap<PathBuf, RepositoryGeneration>> {
    REPOSITORY_GENERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn repository_key(cwd: &Path) -> PathBuf {
    // PHASE-09 may source observations from StatusBroadcaster's
    // refs/HEAD/worktree signature; keeping identity and bump policy here makes
    // that replacement local to this module.
    tokio::fs::canonicalize(cwd)
        .await
        .unwrap_or_else(|_| cwd.to_path_buf())
}
