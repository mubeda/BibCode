use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex, Weak},
};

use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RemoteOperationClass {
    Session,
    Provisioning,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct RemoteOperationFence {
    operation_id: String,
    environment_generation: u64,
    binding_generation: u64,
}

impl RemoteOperationFence {
    pub(crate) fn new(
        operation_id: impl Into<String>,
        environment_generation: u64,
        binding_generation: u64,
    ) -> Result<Self, String> {
        let operation_id = operation_id.into();
        Uuid::parse_str(&operation_id)
            .map_err(|_| "Remote operation identifier must be a UUID.".to_string())?;
        Ok(Self {
            operation_id,
            environment_generation,
            binding_generation,
        })
    }

    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub(crate) fn with_operation_id(
        &self,
        operation_id: impl Into<String>,
    ) -> Result<Self, String> {
        Self::new(
            operation_id,
            self.environment_generation,
            self.binding_generation,
        )
    }

    fn generation(&self) -> (u64, u64) {
        (self.environment_generation, self.binding_generation)
    }
}

struct ActiveRemoteOperation {
    fence: RemoteOperationFence,
    cancellation: CancellationToken,
    completion_claimed: bool,
}

#[derive(Default)]
struct RemoteHostOperationState {
    generation: u64,
    current: Option<(u64, u64)>,
    closing_generation: Option<u64>,
    requires_newer_fence: bool,
    active: HashMap<String, ActiveRemoteOperation>,
}

#[derive(Default)]
struct RemoteOperationState {
    shutting_down: bool,
    hosts: HashMap<String, RemoteHostOperationState>,
}

enum BeginDecision {
    Wait,
    Start {
        host_generation: u64,
        cancellation: CancellationToken,
    },
}

pub(crate) struct RemoteOperationCoordinator {
    state: Mutex<RemoteOperationState>,
    changed: Notify,
    provisioning: Arc<Semaphore>,
    tunnels: Arc<Semaphore>,
}

impl RemoteOperationCoordinator {
    pub(crate) fn new(max_provisioning: usize, max_tunnels: usize) -> Self {
        assert!(
            max_provisioning > 0,
            "remote provisioning capacity must be non-zero"
        );
        assert!(max_tunnels > 0, "remote tunnel capacity must be non-zero");
        Self {
            state: Mutex::new(RemoteOperationState::default()),
            changed: Notify::new(),
            provisioning: Arc::new(Semaphore::new(max_provisioning)),
            tunnels: Arc::new(Semaphore::new(max_tunnels)),
        }
    }

    pub(crate) async fn begin(
        self: &Arc<Self>,
        host_key: &str,
        fence: RemoteOperationFence,
        class: RemoteOperationClass,
    ) -> Result<RemoteOperationLease, String> {
        let host_key = host_key.trim();
        if host_key.is_empty() {
            return Err("Remote operation host key is empty.".to_string());
        }
        let host_key = host_key.to_string();

        let (host_generation, cancellation) = loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let decision = {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|error| format!("Could not access remote operation state: {error}"))?;
                if state.shutting_down {
                    return Err("Remote operation owner is shutting down.".to_string());
                }
                let host = state.hosts.entry(host_key.clone()).or_default();
                if host.closing_generation.is_some() {
                    return Err("Remote environment admission is closing.".to_string());
                }

                let requested = fence.generation();
                if let Some(current) = host.current {
                    if requested < current || host.requires_newer_fence && requested <= current {
                        return Err("Remote operation generation is stale.".to_string());
                    }
                    if requested > current {
                        host.current = Some(requested);
                        host.requires_newer_fence = false;
                        host.generation = host.generation.saturating_add(1);
                        for active in host.active.values() {
                            if !active.completion_claimed {
                                active.cancellation.cancel();
                            }
                        }
                    }
                } else {
                    host.current = Some(requested);
                }

                if !host.active.is_empty() {
                    let only_older_work = host
                        .active
                        .values()
                        .all(|active| active.fence.generation() < requested);
                    if only_older_work {
                        BeginDecision::Wait
                    } else {
                        return Err(
                            "A remote operation is already active for this host generation."
                                .to_string(),
                        );
                    }
                } else {
                    let cancellation = CancellationToken::new();
                    let host_generation = host.generation;
                    host.active.insert(
                        fence.operation_id.clone(),
                        ActiveRemoteOperation {
                            fence: fence.clone(),
                            cancellation: cancellation.clone(),
                            completion_claimed: false,
                        },
                    );
                    BeginDecision::Start {
                        host_generation,
                        cancellation,
                    }
                }
            };
            match decision {
                BeginDecision::Wait => notified.await,
                BeginDecision::Start {
                    host_generation,
                    cancellation,
                } => break (host_generation, cancellation),
            }
        };

        let mut lease = RemoteOperationLease {
            coordinator: Arc::downgrade(self),
            host_key,
            fence,
            host_generation,
            cancellation,
            provisioning_permit: None,
            finished: false,
        };
        if class == RemoteOperationClass::Provisioning {
            let permit = tokio::select! {
                biased;
                () = lease.cancellation.cancelled() => {
                    return Err("Remote provisioning was cancelled before admission.".to_string());
                }
                permit = self.provisioning.clone().acquire_owned() => permit
                    .map_err(|_| "Remote provisioning admission is closed.".to_string())?,
            };
            if !lease.can_publish() {
                drop(permit);
                return Err("Remote provisioning was superseded before admission.".to_string());
            }
            lease.provisioning_permit = Some(permit);
        }
        Ok(lease)
    }

    pub(crate) async fn acquire_tunnel(
        self: &Arc<Self>,
        owner: &RemoteOperationLease,
    ) -> Result<RemoteTunnelPermit, String> {
        if !owner.can_publish() {
            return Err("Remote tunnel owner is stale or closing.".to_string());
        }
        let permit = tokio::select! {
            biased;
            () = owner.cancelled() => {
                return Err("Remote tunnel admission was cancelled.".to_string());
            }
            permit = self.tunnels.clone().acquire_owned() => permit
                .map_err(|_| "Remote tunnel admission is closed.".to_string())?,
        };
        if !owner.can_publish() {
            drop(permit);
            return Err("Remote tunnel owner became stale before publication.".to_string());
        }
        Ok(RemoteTunnelPermit { _permit: permit })
    }

    pub(crate) fn current_fence(
        &self,
        host_key: &str,
        operation_id: impl Into<String>,
    ) -> Result<RemoteOperationFence, String> {
        let current = self
            .state
            .lock()
            .map_err(|error| format!("Could not access remote operation state: {error}"))?
            .hosts
            .get(host_key)
            .and_then(|host| host.current)
            .unwrap_or((0, 0));
        RemoteOperationFence::new(operation_id, current.0, current.1)
    }

    pub(crate) async fn cancel(
        &self,
        host_key: &str,
        fence: &RemoteOperationFence,
    ) -> Result<bool, String> {
        let found = {
            let state = self
                .state
                .lock()
                .map_err(|error| format!("Could not access remote operation state: {error}"))?;
            state
                .hosts
                .get(host_key)
                .and_then(|host| host.active.get(fence.operation_id()))
                .filter(|active| active.fence == *fence)
                .is_some_and(|active| {
                    if active.completion_claimed {
                        return false;
                    }
                    active.cancellation.cancel();
                    true
                })
        };
        if !found {
            return Ok(false);
        }
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let finished = self
                .state
                .lock()
                .map_err(|error| format!("Could not access remote operation state: {error}"))?
                .hosts
                .get(host_key)
                .is_none_or(|host| {
                    !host
                        .active
                        .get(fence.operation_id())
                        .is_some_and(|active| active.fence == *fence)
                });
            if finished {
                return Ok(true);
            }
            notified.await;
        }
    }

    pub(crate) async fn close_host(
        self: &Arc<Self>,
        host_key: &str,
    ) -> Result<RemoteHostCloseGuard, String> {
        let host_key = host_key.trim();
        if host_key.is_empty() {
            return Err("Remote operation host key is empty.".to_string());
        }
        let host_key = host_key.to_string();
        let (close_generation, prior_requires_newer_fence) = {
            let mut state = self
                .state
                .lock()
                .map_err(|error| format!("Could not access remote operation state: {error}"))?;
            if state.shutting_down {
                return Err("Remote operation owner is shutting down.".to_string());
            }
            let host = state.hosts.entry(host_key.clone()).or_default();
            if host.closing_generation.is_some() {
                return Err("Remote environment admission is already closing.".to_string());
            }
            let prior_requires_newer_fence = host.requires_newer_fence;
            host.generation = host.generation.saturating_add(1);
            let close_generation = host.generation;
            host.closing_generation = Some(close_generation);
            host.requires_newer_fence = true;
            for active in host.active.values() {
                if !active.completion_claimed {
                    active.cancellation.cancel();
                }
            }
            (close_generation, prior_requires_newer_fence)
        };

        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let drained = self
                .state
                .lock()
                .map_err(|error| format!("Could not access remote operation state: {error}"))?
                .hosts
                .get(&host_key)
                .is_none_or(|host| host.active.is_empty());
            if drained {
                return Ok(RemoteHostCloseGuard {
                    coordinator: Arc::downgrade(self),
                    host_key,
                    close_generation,
                    prior_requires_newer_fence,
                    reopened: false,
                });
            }
            notified.await;
        }
    }

    pub(crate) async fn shutdown(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.shutting_down = true;
            for host in state.hosts.values_mut() {
                host.generation = host.generation.saturating_add(1);
                host.closing_generation = Some(host.generation);
                for active in host.active.values() {
                    if !active.completion_claimed {
                        active.cancellation.cancel();
                    }
                }
            }
        }
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let drained = self
                .state
                .lock()
                .map(|state| state.hosts.values().all(|host| host.active.is_empty()))
                .unwrap_or(true);
            if drained {
                self.provisioning.close();
                self.tunnels.close();
                return;
            }
            notified.await;
        }
    }

    fn can_publish(&self, owner: &RemoteOperationLease) -> bool {
        self.state.lock().is_ok_and(|state| {
            if state.shutting_down {
                return false;
            }
            state.hosts.get(&owner.host_key).is_some_and(|host| {
                host.closing_generation.is_none()
                    && host.generation == owner.host_generation
                    && host.current == Some(owner.fence.generation())
                    && host
                        .active
                        .get(owner.fence.operation_id())
                        .is_some_and(|active| {
                            active.fence == owner.fence
                                && !active.cancellation.is_cancelled()
                                && !active.completion_claimed
                        })
            })
        })
    }

    fn claim_completion(&self, owner: &RemoteOperationLease) -> bool {
        self.state.lock().is_ok_and(|mut state| {
            if state.shutting_down {
                return false;
            }
            let Some(host) = state.hosts.get_mut(&owner.host_key) else {
                return false;
            };
            if host.closing_generation.is_some()
                || host.generation != owner.host_generation
                || host.current != Some(owner.fence.generation())
            {
                return false;
            }
            host.active
                .get_mut(owner.fence.operation_id())
                .is_some_and(|active| {
                    if active.fence != owner.fence
                        || active.cancellation.is_cancelled()
                        || active.completion_claimed
                    {
                        return false;
                    }
                    active.completion_claimed = true;
                    true
                })
        })
    }

    fn finish(&self, owner: &RemoteOperationLease) {
        if let Ok(mut state) = self.state.lock()
            && let Some(host) = state.hosts.get_mut(&owner.host_key)
            && host
                .active
                .get(owner.fence.operation_id())
                .is_some_and(|active| active.fence == owner.fence)
        {
            host.active.remove(owner.fence.operation_id());
        }
        self.changed.notify_waiters();
    }

    fn reopen(&self, host_key: &str, close_generation: u64) -> bool {
        let reopened = self.state.lock().is_ok_and(|mut state| {
            if state.shutting_down {
                return false;
            }
            let Some(host) = state.hosts.get_mut(host_key) else {
                return false;
            };
            if host.closing_generation != Some(close_generation) || !host.active.is_empty() {
                return false;
            }
            host.closing_generation = None;
            true
        });
        if reopened {
            self.changed.notify_waiters();
        }
        reopened
    }

    fn abort_close(
        &self,
        host_key: &str,
        close_generation: u64,
        prior_requires_newer_fence: bool,
    ) -> bool {
        let reopened = self.state.lock().is_ok_and(|mut state| {
            if state.shutting_down {
                return false;
            }
            let Some(host) = state.hosts.get_mut(host_key) else {
                return false;
            };
            if host.closing_generation != Some(close_generation) || !host.active.is_empty() {
                return false;
            }
            host.closing_generation = None;
            host.requires_newer_fence = prior_requires_newer_fence;
            true
        });
        if reopened {
            self.changed.notify_waiters();
        }
        reopened
    }
}

pub(crate) struct RemoteOperationLease {
    coordinator: Weak<RemoteOperationCoordinator>,
    host_key: String,
    fence: RemoteOperationFence,
    host_generation: u64,
    cancellation: CancellationToken,
    provisioning_permit: Option<OwnedSemaphorePermit>,
    finished: bool,
}

impl RemoteOperationLease {
    pub(crate) fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }

    pub(crate) async fn cancelled(&self) {
        self.cancellation.cancelled().await;
    }

    pub(crate) fn can_publish(&self) -> bool {
        self.coordinator
            .upgrade()
            .is_some_and(|coordinator| coordinator.can_publish(self))
    }

    pub(crate) fn claim_completion(&self) -> bool {
        self.coordinator
            .upgrade()
            .is_some_and(|coordinator| coordinator.claim_completion(self))
    }
}

impl fmt::Debug for RemoteOperationLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RemoteOperationLease")
            .field("host_key", &self.host_key)
            .field("fence", &self.fence)
            .field("host_generation", &self.host_generation)
            .field("cancelled", &self.cancellation.is_cancelled())
            .finish_non_exhaustive()
    }
}

impl Drop for RemoteOperationLease {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.provisioning_permit.take();
        if let Some(coordinator) = self.coordinator.upgrade() {
            coordinator.finish(self);
        }
    }
}

pub(crate) struct RemoteHostCloseGuard {
    coordinator: Weak<RemoteOperationCoordinator>,
    host_key: String,
    close_generation: u64,
    prior_requires_newer_fence: bool,
    reopened: bool,
}

impl RemoteHostCloseGuard {
    pub(crate) fn reopen(mut self) -> bool {
        self.reopened = self
            .coordinator
            .upgrade()
            .is_some_and(|coordinator| coordinator.reopen(&self.host_key, self.close_generation));
        self.reopened
    }

    pub(crate) fn abort(mut self) -> bool {
        self.reopened = self.coordinator.upgrade().is_some_and(|coordinator| {
            coordinator.abort_close(
                &self.host_key,
                self.close_generation,
                self.prior_requires_newer_fence,
            )
        });
        self.reopened
    }
}

impl fmt::Debug for RemoteHostCloseGuard {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RemoteHostCloseGuard")
            .field("host_key", &self.host_key)
            .field("close_generation", &self.close_generation)
            .field(
                "prior_requires_newer_fence",
                &self.prior_requires_newer_fence,
            )
            .field("reopened", &self.reopened)
            .finish()
    }
}

pub(crate) struct RemoteTunnelPermit {
    _permit: OwnedSemaphorePermit,
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use super::{RemoteOperationClass, RemoteOperationCoordinator, RemoteOperationFence};

    fn fence(operation_id: &str, environment: u64, binding: u64) -> RemoteOperationFence {
        RemoteOperationFence::new(operation_id, environment, binding)
            .expect("fixture operation fence")
    }

    #[tokio::test]
    async fn newer_generation_cancels_and_drains_the_old_owner_before_publication() {
        let coordinator = Arc::new(RemoteOperationCoordinator::new(2, 2));
        let old = coordinator
            .begin(
                "ssh:host-a",
                fence("019d2a2e-0000-7000-8000-000000000001", 4, 7),
                RemoteOperationClass::Provisioning,
            )
            .await
            .expect("old operation owns the host");

        let next_coordinator = coordinator.clone();
        let next = tokio::spawn(async move {
            next_coordinator
                .begin(
                    "ssh:host-a",
                    fence("019d2a2e-0000-7000-8000-000000000002", 4, 8),
                    RemoteOperationClass::Provisioning,
                )
                .await
        });

        tokio::time::timeout(Duration::from_secs(1), old.cancelled())
            .await
            .expect("new generation cancels the prior owner");
        assert!(old.cancellation().is_cancelled());
        assert!(
            !old.can_publish(),
            "superseded work must fail its publication fence"
        );
        assert!(
            !next.is_finished(),
            "replacement waits until the old owner drains"
        );

        drop(old);
        let current = next
            .await
            .expect("replacement task joins")
            .expect("new generation becomes the owner");
        assert!(current.can_publish());
    }

    #[tokio::test]
    async fn duplicate_generation_is_rejected_instead_of_running_twice() {
        let coordinator = Arc::new(RemoteOperationCoordinator::new(2, 2));
        let active = coordinator
            .begin(
                "ssh:host-a",
                fence("019d2a2e-0000-7000-8000-000000000003", 2, 3),
                RemoteOperationClass::Session,
            )
            .await
            .expect("first operation owns the host");

        let error = coordinator
            .begin(
                "ssh:host-a",
                fence("019d2a2e-0000-7000-8000-000000000004", 2, 3),
                RemoteOperationClass::Session,
            )
            .await
            .expect_err("duplicate generation must not create another owner");
        assert!(error.contains("already active"));
        assert!(active.can_publish());
    }

    #[tokio::test]
    async fn exact_operation_cancellation_waits_for_only_the_matching_owner() {
        let coordinator = Arc::new(RemoteOperationCoordinator::new(2, 2));
        let first_fence = fence("019d2a2e-0000-7000-8000-000000000013", 3, 4);
        let first = coordinator
            .begin(
                "ssh:host-a",
                first_fence.clone(),
                RemoteOperationClass::Session,
            )
            .await
            .expect("first owner");
        assert_eq!(
            coordinator
                .current_fence("ssh:host-a", "019d2a2e-0000-7000-8000-000000000015",)
                .expect("current fence")
                .generation(),
            (3, 4),
        );
        let other = coordinator
            .begin(
                "ssh:host-b",
                fence("019d2a2e-0000-7000-8000-000000000014", 3, 4),
                RemoteOperationClass::Session,
            )
            .await
            .expect("other host owner");
        let cancel_coordinator = coordinator.clone();
        let cancellation =
            tokio::spawn(
                async move { cancel_coordinator.cancel("ssh:host-a", &first_fence).await },
            );

        tokio::time::timeout(Duration::from_secs(1), first.cancelled())
            .await
            .expect("matching cancellation reaches its owner");
        assert!(!other.cancellation().is_cancelled());
        assert!(
            !cancellation.is_finished(),
            "acknowledgement waits for exact owner drain"
        );
        drop(first);
        assert!(
            cancellation
                .await
                .expect("cancellation task joins")
                .expect("cancellation state is readable")
        );
        assert!(other.can_publish());
    }

    #[tokio::test]
    async fn completion_claim_linearizes_against_cancellation_and_replacement() {
        let coordinator = Arc::new(RemoteOperationCoordinator::new(2, 2));
        let completed_fence = fence("019d2a2e-0000-7000-8000-000000000017", 5, 8);
        let completed = coordinator
            .begin(
                "ssh:host-a",
                completed_fence.clone(),
                RemoteOperationClass::Provisioning,
            )
            .await
            .expect("operation owns finalization");

        assert!(
            completed.claim_completion(),
            "the current owner may atomically commit its terminal result"
        );
        assert!(
            !coordinator
                .cancel("ssh:host-a", &completed_fence)
                .await
                .expect("claimed completion cancellation is readable"),
            "cancellation that loses the terminal claim must report no cancellation"
        );
        assert!(!completed.cancellation().is_cancelled());

        let replacement_coordinator = coordinator.clone();
        let replacement = tokio::spawn(async move {
            replacement_coordinator
                .begin(
                    "ssh:host-a",
                    fence("019d2a2e-0000-7000-8000-000000000018", 5, 9),
                    RemoteOperationClass::Provisioning,
                )
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !replacement.is_finished(),
            "a newer generation waits while claimed final cleanup retains host ownership"
        );
        drop(completed);
        replacement
            .await
            .expect("replacement task joins")
            .expect("replacement begins after claimed cleanup drains");

        let cancelled_fence = fence("019d2a2e-0000-7000-8000-000000000019", 6, 1);
        let cancelled = coordinator
            .begin(
                "ssh:host-b",
                cancelled_fence.clone(),
                RemoteOperationClass::Provisioning,
            )
            .await
            .expect("cancellable finalization owner");
        let cancellation_coordinator = coordinator.clone();
        let cancellation = tokio::spawn(async move {
            cancellation_coordinator
                .cancel("ssh:host-b", &cancelled_fence)
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), cancelled.cancelled())
            .await
            .expect("cancellation wins before terminal claim");
        assert!(
            !cancelled.claim_completion(),
            "a cancelled owner cannot later report completion"
        );
        drop(cancelled);
        assert!(
            cancellation
                .await
                .expect("cancellation task joins")
                .expect("winning cancellation is acknowledged")
        );
    }

    #[tokio::test]
    async fn closing_a_host_cancels_waits_and_blocks_new_admission() {
        let coordinator = Arc::new(RemoteOperationCoordinator::new(2, 2));
        let active = coordinator
            .begin(
                "ssh:host-a",
                fence("019d2a2e-0000-7000-8000-000000000005", 9, 1),
                RemoteOperationClass::Session,
            )
            .await
            .expect("operation owns the host");
        let closer_coordinator = coordinator.clone();
        let closer = tokio::spawn(async move { closer_coordinator.close_host("ssh:host-a").await });

        tokio::time::timeout(Duration::from_secs(1), active.cancelled())
            .await
            .expect("closing cancels active work");
        assert!(
            !active.can_publish(),
            "late completion after close/Forget must fail its publication fence"
        );
        let admission_error = coordinator
            .begin(
                "ssh:host-a",
                fence("019d2a2e-0000-7000-8000-000000000006", 9, 2),
                RemoteOperationClass::Session,
            )
            .await
            .expect_err("closing host rejects new work");
        assert!(admission_error.contains("closing"));
        assert!(
            !closer.is_finished(),
            "close acknowledgement waits for the owner"
        );

        drop(active);
        let close_guard = closer
            .await
            .expect("close task joins")
            .expect("host closes after drain");
        let cleanup_admission = coordinator
            .begin(
                "ssh:host-a",
                fence("019d2a2e-0000-7000-8000-000000000016", 10, 1),
                RemoteOperationClass::Session,
            )
            .await
            .expect_err("the close guard must retain admission through host cleanup");
        assert!(cleanup_admission.contains("closing"));
        close_guard.reopen();
        let stale_after_reopen = coordinator
            .begin(
                "ssh:host-a",
                fence("019d2a2e-0000-7000-8000-000000000020", 9, 1),
                RemoteOperationClass::Session,
            )
            .await
            .expect_err("reopening must not admit the generation closed by Forget");
        assert!(stale_after_reopen.contains("stale"));
        coordinator
            .begin(
                "ssh:host-a",
                fence("019d2a2e-0000-7000-8000-000000000007", 10, 1),
                RemoteOperationClass::Session,
            )
            .await
            .expect("a later environment generation may reopen admission");
    }

    #[tokio::test]
    async fn shutdown_cancels_and_drains_every_owner_before_becoming_terminal() {
        let coordinator = Arc::new(RemoteOperationCoordinator::new(2, 2));
        let first = coordinator
            .begin(
                "ssh:host-a",
                fence("019d2a2e-0000-7000-8000-000000000008", 1, 1),
                RemoteOperationClass::Session,
            )
            .await
            .expect("first owner");
        let second = coordinator
            .begin(
                "ssh:host-b",
                fence("019d2a2e-0000-7000-8000-000000000009", 1, 1),
                RemoteOperationClass::Session,
            )
            .await
            .expect("second owner");
        let shutdown_coordinator = coordinator.clone();
        let shutdown = tokio::spawn(async move { shutdown_coordinator.shutdown().await });

        tokio::time::timeout(Duration::from_secs(1), first.cancelled())
            .await
            .expect("shutdown cancels first owner");
        tokio::time::timeout(Duration::from_secs(1), second.cancelled())
            .await
            .expect("shutdown cancels second owner");
        assert!(!shutdown.is_finished(), "shutdown waits for active owners");
        drop(first);
        drop(second);
        shutdown.await.expect("shutdown task joins");

        let error = coordinator
            .begin(
                "ssh:host-c",
                fence("019d2a2e-0000-7000-8000-000000000010", 1, 1),
                RemoteOperationClass::Session,
            )
            .await
            .expect_err("shutdown permanently closes admission");
        assert!(error.contains("shutting down"));
    }

    #[tokio::test]
    async fn provisioning_and_tunnel_capacity_are_bounded_and_recover_after_release() {
        let coordinator = Arc::new(RemoteOperationCoordinator::new(1, 1));
        let first = coordinator
            .begin(
                "ssh:host-a",
                fence("019d2a2e-0000-7000-8000-000000000011", 1, 1),
                RemoteOperationClass::Provisioning,
            )
            .await
            .expect("first provisioning permit");
        let next_coordinator = coordinator.clone();
        let second = tokio::spawn(async move {
            next_coordinator
                .begin(
                    "ssh:host-b",
                    fence("019d2a2e-0000-7000-8000-000000000012", 1, 1),
                    RemoteOperationClass::Provisioning,
                )
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !second.is_finished(),
            "global provisioning capacity applies across hosts"
        );
        drop(first);
        let second = second
            .await
            .expect("second provisioning task joins")
            .expect("released provisioning permit is reusable");

        let tunnel = coordinator
            .acquire_tunnel(&second)
            .await
            .expect("first tunnel permit");
        let tunnel_coordinator = coordinator.clone();
        let tunnel_waiter =
            tokio::spawn(async move { tunnel_coordinator.acquire_tunnel(&second).await });
        tokio::task::yield_now().await;
        assert!(
            !tunnel_waiter.is_finished(),
            "active tunnel capacity is bounded"
        );
        drop(tunnel);
        tunnel_waiter
            .await
            .expect("tunnel waiter joins")
            .expect("released tunnel permit is reusable");
    }
}
