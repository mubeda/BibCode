use std::{
    collections::HashMap,
    future::pending,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use tokio::{
    sync::{mpsc, watch},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use super::{
    GitCommandError, GitRepository, VcsStatusLocalResult, VcsStatusRemoteResult, VcsStatusResult,
    VcsStatusStreamEvent,
};

#[derive(Clone)]
pub struct StatusBroadcaster {
    inner: Arc<Inner>,
}

struct Inner {
    repository: Arc<GitRepository>,
    ref_refresh_interval: Duration,
    local_status_refresh_interval: Duration,
    automatic_remote_refresh_interval: watch::Sender<Duration>,
    subscriber_capacity: usize,
    state: Mutex<State>,
}

const REMOTE_FAILURE_BACKOFF_INITIAL: Duration = Duration::from_secs(30);
const REMOTE_FAILURE_BACKOFF_MAX: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
struct State {
    next_subscriber_id: u64,
    repositories: HashMap<PathBuf, RepositoryState>,
}

struct RepositoryState {
    local: VcsStatusLocalResult,
    remote: Option<Option<VcsStatusRemoteResult>>,
    subscribers: HashMap<u64, mpsc::Sender<VcsStatusStreamEvent>>,
    poller_cancellation: CancellationToken,
}

pub struct StatusSubscription {
    receiver: mpsc::Receiver<VcsStatusStreamEvent>,
    cancellation: CancellationToken,
    broadcaster: StatusBroadcaster,
    cwd: PathBuf,
    subscriber_id: u64,
}

impl StatusBroadcaster {
    #[must_use]
    pub fn new(
        repository: Arc<GitRepository>,
        refresh_interval: Duration,
        subscriber_capacity: usize,
    ) -> Self {
        Self::with_refresh_intervals(
            repository,
            refresh_interval,
            refresh_interval,
            subscriber_capacity,
        )
    }

    #[must_use]
    pub fn with_refresh_intervals(
        repository: Arc<GitRepository>,
        ref_refresh_interval: Duration,
        status_refresh_interval: Duration,
        subscriber_capacity: usize,
    ) -> Self {
        let (automatic_remote_refresh_interval, _) = watch::channel(status_refresh_interval);
        Self::with_automatic_remote_refresh_interval(
            repository,
            ref_refresh_interval,
            status_refresh_interval,
            automatic_remote_refresh_interval,
            subscriber_capacity,
        )
    }

    #[must_use]
    pub fn with_automatic_remote_refresh_interval(
        repository: Arc<GitRepository>,
        ref_refresh_interval: Duration,
        local_status_refresh_interval: Duration,
        automatic_remote_refresh_interval: watch::Sender<Duration>,
        subscriber_capacity: usize,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                repository,
                ref_refresh_interval,
                local_status_refresh_interval,
                automatic_remote_refresh_interval,
                subscriber_capacity: subscriber_capacity.max(1),
                state: Mutex::new(State::default()),
            }),
        }
    }

    pub async fn subscribe(
        &self,
        cwd: PathBuf,
        cancellation: CancellationToken,
    ) -> Result<StatusSubscription, GitCommandError> {
        let cwd = tokio::fs::canonicalize(&cwd).await.unwrap_or(cwd);
        let local = self
            .inner
            .repository
            .local_status(&cwd, &cancellation)
            .await?;
        let (sender, receiver) = mpsc::channel(self.inner.subscriber_capacity);

        let (subscriber_id, start_poller, poller_cancellation) = {
            let mut state = self.lock_state();
            let subscriber_id = state.next_subscriber_id;
            state.next_subscriber_id = state.next_subscriber_id.wrapping_add(1);
            let start_poller = !state.repositories.contains_key(&cwd);
            let entry = state
                .repositories
                .entry(cwd.clone())
                .or_insert_with(|| RepositoryState {
                    local: local.clone(),
                    remote: None,
                    subscribers: HashMap::new(),
                    poller_cancellation: CancellationToken::new(),
                });
            entry.subscribers.insert(subscriber_id, sender);
            let initial_remote = entry.remote.clone().flatten();
            entry
                .subscribers
                .get(&subscriber_id)
                .expect("subscriber was just registered")
                .try_send(VcsStatusStreamEvent::Snapshot {
                    local,
                    remote: initial_remote.clone(),
                })
                .expect("new bounded subscription has capacity for its snapshot");
            (
                subscriber_id,
                start_poller,
                entry.poller_cancellation.clone(),
            )
        };
        if start_poller {
            self.spawn_status_poller(cwd.clone(), poller_cancellation);
        }
        Ok(StatusSubscription {
            receiver,
            cancellation,
            broadcaster: self.clone(),
            cwd,
            subscriber_id,
        })
    }

    pub async fn refresh_local(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<VcsStatusLocalResult, GitCommandError> {
        let cwd = tokio::fs::canonicalize(cwd)
            .await
            .unwrap_or_else(|_| cwd.to_path_buf());
        let local = self
            .inner
            .repository
            .local_status(&cwd, cancellation)
            .await?;
        let event = VcsStatusStreamEvent::LocalUpdated {
            local: local.clone(),
        };
        let mut state = self.lock_state();
        let mut remove_repository = false;
        if let Some(entry) = state.repositories.get_mut(&cwd)
            && entry.local != local
        {
            entry.local = local.clone();
            publish(entry, event);
            remove_repository = entry.subscribers.is_empty();
        }
        if remove_repository && let Some(entry) = state.repositories.remove(&cwd) {
            entry.poller_cancellation.cancel();
        }
        Ok(local)
    }

    async fn refresh_ref(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        let cwd = tokio::fs::canonicalize(cwd)
            .await
            .unwrap_or_else(|_| cwd.to_path_buf());
        let ref_name = self
            .inner
            .repository
            .current_ref(&cwd, cancellation)
            .await?;
        let mut state = self.lock_state();
        if let Some(entry) = state.repositories.get_mut(&cwd)
            && entry.local.ref_name != ref_name
        {
            entry.local.ref_name = ref_name;
            entry.local.is_default_ref = entry.local.ref_name.is_some()
                && entry.local.ref_name == entry.local.default_ref_name;
            publish(
                entry,
                VcsStatusStreamEvent::LocalUpdated {
                    local: entry.local.clone(),
                },
            );
        }
        Ok(())
    }

    async fn refresh_remote(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
        fetch: bool,
    ) -> Result<(), GitCommandError> {
        let remote = if fetch {
            self.inner
                .repository
                .refresh_remote_status(cwd, cancellation)
                .await?
        } else {
            self.inner
                .repository
                .remote_status(cwd, cancellation)
                .await?
        };
        let mut state = self.lock_state();
        let Some(entry) = state.repositories.get_mut(cwd) else {
            return Ok(());
        };
        if entry.remote.as_ref() != Some(&remote) {
            entry.remote = Some(remote.clone());
            publish(entry, VcsStatusStreamEvent::RemoteUpdated { remote });
        }
        if entry.subscribers.is_empty()
            && let Some(entry) = state.repositories.remove(cwd)
        {
            entry.poller_cancellation.cancel();
        }
        Ok(())
    }

    pub async fn refresh_status(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<VcsStatusResult, GitCommandError> {
        let cwd = tokio::fs::canonicalize(cwd)
            .await
            .unwrap_or_else(|_| cwd.to_path_buf());
        let status = self.inner.repository.status(&cwd, cancellation).await?;
        let remote = status.local.is_repo.then(|| status.remote.clone());
        let event = VcsStatusStreamEvent::Snapshot {
            local: status.local.clone(),
            remote: remote.clone(),
        };
        let mut state = self.lock_state();
        let mut remove_repository = false;
        if let Some(entry) = state.repositories.get_mut(&cwd)
            && (entry.local != status.local || entry.remote.as_ref() != Some(&remote))
        {
            entry.local = status.local.clone();
            entry.remote = Some(remote);
            publish(entry, event);
            remove_repository = entry.subscribers.is_empty();
        }
        if remove_repository && let Some(entry) = state.repositories.remove(&cwd) {
            entry.poller_cancellation.cancel();
        }
        Ok(status)
    }

    #[must_use]
    pub fn active_poller_count(&self) -> usize {
        self.lock_state().repositories.len()
    }

    fn spawn_status_poller(&self, cwd: PathBuf, cancellation: CancellationToken) {
        let broadcaster = self.clone();
        tokio::spawn(async move {
            let mut ref_interval = tokio::time::interval(broadcaster.inner.ref_refresh_interval);
            ref_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut local_status_interval =
                tokio::time::interval(broadcaster.inner.local_status_refresh_interval);
            local_status_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut automatic_remote_refresh_interval = broadcaster
                .inner
                .automatic_remote_refresh_interval
                .subscribe();
            let configured_interval = *automatic_remote_refresh_interval.borrow_and_update();
            let mut next_remote_fetch =
                (!configured_interval.is_zero()).then(|| Instant::now() + configured_interval);
            let mut failure_backoff = Duration::ZERO;
            let _ = broadcaster.refresh_remote(&cwd, &cancellation, false).await;
            loop {
                tokio::select! {
                    _ = cancellation.cancelled() => break,
                    _ = local_status_interval.tick() => {
                        let _ = broadcaster.refresh_local(&cwd, &cancellation).await;
                    }
                    changed = automatic_remote_refresh_interval.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        failure_backoff = Duration::ZERO;
                        let interval = *automatic_remote_refresh_interval.borrow_and_update();
                        next_remote_fetch = (!interval.is_zero())
                            .then(|| Instant::now() + interval);
                    }
                    _ = wait_for_deadline(next_remote_fetch) => {
                        if broadcaster.refresh_remote(&cwd, &cancellation, true).await.is_ok() {
                            failure_backoff = Duration::ZERO;
                        } else {
                            failure_backoff = next_remote_failure_backoff(failure_backoff);
                        }
                        let interval = *automatic_remote_refresh_interval.borrow();
                        next_remote_fetch = (!interval.is_zero()).then(|| {
                            Instant::now() + interval.max(failure_backoff)
                        });
                    }
                    _ = ref_interval.tick() => {
                        let _ = broadcaster.refresh_ref(&cwd, &cancellation).await;
                    }
                }
            }
        });
    }

    fn release(&self, cwd: &Path, subscriber_id: u64) {
        let mut state = self.lock_state();
        let should_remove = if let Some(entry) = state.repositories.get_mut(cwd) {
            entry.subscribers.remove(&subscriber_id);
            entry.subscribers.is_empty()
        } else {
            false
        };
        if should_remove && let Some(entry) = state.repositories.remove(cwd) {
            entry.poller_cancellation.cancel();
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

async fn wait_for_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => pending().await,
    }
}

fn next_remote_failure_backoff(current: Duration) -> Duration {
    if current.is_zero() {
        REMOTE_FAILURE_BACKOFF_INITIAL
    } else {
        current.saturating_mul(2).min(REMOTE_FAILURE_BACKOFF_MAX)
    }
}

impl StatusSubscription {
    pub async fn recv(&mut self) -> Option<VcsStatusStreamEvent> {
        tokio::select! {
            _ = self.cancellation.cancelled() => None,
            event = self.receiver.recv() => event,
        }
    }
}

impl Drop for StatusSubscription {
    fn drop(&mut self) {
        self.broadcaster.release(&self.cwd, self.subscriber_id);
    }
}

fn publish(entry: &mut RepositoryState, event: VcsStatusStreamEvent) {
    entry
        .subscribers
        .retain(|_, subscriber| match subscriber.try_send(event.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => false,
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscriber_capacity_is_never_zero() {
        let broadcaster =
            StatusBroadcaster::new(Arc::new(GitRepository::default()), Duration::ZERO, 0);
        assert_eq!(broadcaster.inner.subscriber_capacity, 1);
    }

    #[test]
    fn remote_failure_backoff_is_capped() {
        let mut backoff = Duration::ZERO;
        assert_eq!(
            next_remote_failure_backoff(backoff),
            Duration::from_secs(30)
        );
        for _ in 0..10 {
            backoff = next_remote_failure_backoff(backoff);
        }
        assert_eq!(backoff, REMOTE_FAILURE_BACKOFF_MAX);
    }
}
