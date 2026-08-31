//! Byte-weighted outbound admission shared by the RPC session writer and the
//! E2EE transport: a process-wide pool plus a per-connection pool, acquired
//! together in one critical section under one absolute deadline.
//!
//! Granting is push-based: waiters enqueue once and sleep on their own oneshot
//! channel; every release runs exactly one grant pass. Grants are fit-first so
//! small responses are not parked behind large ones, but once the front waiter
//! has aged past [`OUTBOUND_PROCESS_AGING_THRESHOLD`] it accumulates a
//! process-tier reservation from released capacity, so sustained small traffic
//! cannot starve a large waiter indefinitely; the resulting pause for younger
//! waiters is bounded by the head's own size rather than being an open-ended
//! blockade, and the head's cancellation refunds the reservation.

use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use tokio::{
    sync::oneshot,
    time::{Instant, timeout_at},
};
use tokio_util::sync::CancellationToken;

/// How long the front combined waiter may be skipped by fit-first grants
/// before released capacity is reserved for it.
const OUTBOUND_PROCESS_AGING_THRESHOLD: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub(crate) struct RpcOutboundBudget {
    process: RpcOutboundProcessBudget,
    connection: Arc<WeightedByteBudget>,
    pub(super) connection_capacity: usize,
}

impl RpcOutboundBudget {
    pub(crate) fn new(process: RpcOutboundProcessBudget, connection_capacity: usize) -> Self {
        Self {
            process,
            connection: Arc::new(WeightedByteBudget::new(connection_capacity)),
            connection_capacity,
        }
    }

    pub(super) async fn acquire(
        &self,
        bytes: usize,
        deadline: Instant,
    ) -> Result<RpcOutboundBytePermit, ()> {
        let (receiver, mut guard) = self.enqueue(bytes)?;
        match timeout_at(deadline, receiver).await {
            Ok(Ok(())) => {
                guard.active = false;
                Ok(RpcOutboundBytePermit {
                    process: Some(WeightedByteGrant {
                        inner: Arc::clone(&self.process.inner),
                        bytes,
                    }),
                    connection: Some(WeightedByteGrant {
                        inner: Arc::clone(&self.connection),
                        bytes,
                    }),
                    process_budget: self.process.clone(),
                })
            }
            Ok(Err(_)) | Err(_) => Err(()),
        }
    }

    fn enqueue(
        &self,
        bytes: usize,
    ) -> Result<(oneshot::Receiver<()>, RpcOutboundCombinedWaiterGuard), ()> {
        if bytes > self.connection_capacity || bytes > self.process.inner.capacity {
            return Err(());
        }
        let mut state = self.process.combined.lock().map_err(|_| ())?;
        let id = state.next_waiter_id;
        state.next_waiter_id = state.next_waiter_id.wrapping_add(1);
        let (sender, receiver) = oneshot::channel();
        let granted = Arc::new(AtomicBool::new(false));
        state.waiters.push_back(RpcOutboundCombinedWaiter {
            id,
            bytes,
            connection: Arc::clone(&self.connection),
            granted: Arc::clone(&granted),
            sender,
            enqueued_at: Instant::now(),
        });
        drop(state);
        // Capacity may already be idle; the pass grants immediately in that case.
        self.process.grant_combined_waiters();
        Ok((
            receiver,
            RpcOutboundCombinedWaiterGuard {
                process: self.process.clone(),
                connection: Arc::clone(&self.connection),
                id,
                bytes,
                granted,
                active: true,
            },
        ))
    }

    #[cfg(test)]
    pub(super) fn try_acquire(&self, bytes: usize) -> Result<RpcOutboundBytePermit, ()> {
        self.try_acquire_both(bytes).ok_or(())
    }

    #[cfg(test)]
    fn try_acquire_both(&self, bytes: usize) -> Option<RpcOutboundBytePermit> {
        if bytes > self.connection_capacity || bytes > self.process.inner.capacity {
            return None;
        }

        // Every two-tier acquisition takes the process-wide combined queue,
        // shared process lock, and per-connection lock in that order. Capacity
        // is either reserved from both tiers or from neither.
        let combined = self.process.combined.lock().ok()?;
        let mut process_state = self.process.inner.state.lock().ok()?;
        let mut connection_state = self.connection.state.lock().ok()?;
        if !combined.waiters.is_empty()
            || !process_state.waiters.is_empty()
            || !connection_state.waiters.is_empty()
            || process_state.available < bytes
            || connection_state.available < bytes
        {
            return None;
        }
        process_state.available -= bytes;
        connection_state.available -= bytes;
        drop(connection_state);
        drop(process_state);
        drop(combined);

        Some(RpcOutboundBytePermit {
            process: Some(WeightedByteGrant {
                inner: Arc::clone(&self.process.inner),
                bytes,
            }),
            connection: Some(WeightedByteGrant {
                inner: Arc::clone(&self.connection),
                bytes,
            }),
            process_budget: self.process.clone(),
        })
    }
}

#[derive(Clone)]
pub(crate) struct RpcOutboundProcessBudget {
    inner: Arc<WeightedByteBudget>,
    combined: Arc<Mutex<RpcOutboundCombinedState>>,
}

struct RpcOutboundCombinedState {
    next_waiter_id: u64,
    waiters: VecDeque<RpcOutboundCombinedWaiter>,
    /// Process-tier bytes set aside for the aged front waiter, and its id.
    head_reserved: usize,
    head_reserved_for: Option<u64>,
}

struct RpcOutboundCombinedWaiter {
    id: u64,
    bytes: usize,
    connection: Arc<WeightedByteBudget>,
    granted: Arc<AtomicBool>,
    sender: oneshot::Sender<()>,
    enqueued_at: Instant,
}

struct RpcOutboundCombinedWaiterGuard {
    process: RpcOutboundProcessBudget,
    connection: Arc<WeightedByteBudget>,
    id: u64,
    bytes: usize,
    granted: Arc<AtomicBool>,
    active: bool,
}

pub(crate) struct WeightedByteBudget {
    capacity: usize,
    state: Mutex<WeightedByteBudgetState>,
}

struct WeightedByteBudgetState {
    available: usize,
    next_waiter_id: u64,
    waiters: VecDeque<WeightedByteWaiter>,
}

struct WeightedByteWaiter {
    id: u64,
    bytes: usize,
    granted: Arc<AtomicBool>,
    sender: oneshot::Sender<()>,
}

pub(crate) struct WeightedByteGrant {
    inner: Arc<WeightedByteBudget>,
    bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WeightedByteAcquireError {
    Oversized,
    Cancelled,
    Deadline,
}

struct WeightedByteWaiterGuard {
    inner: Arc<WeightedByteBudget>,
    id: u64,
    bytes: usize,
    granted: Arc<AtomicBool>,
    active: bool,
}

impl RpcOutboundProcessBudget {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            inner: Arc::new(WeightedByteBudget::new(capacity)),
            combined: Arc::new(Mutex::new(RpcOutboundCombinedState {
                next_waiter_id: 0,
                waiters: VecDeque::new(),
                head_reserved: 0,
                head_reserved_for: None,
            })),
        }
    }

    // The aged-head pop is conditional on reservation completion and a second
    // (connection-tier) lock taken between the front() check and the pop, so it
    // cannot be expressed as a `pop_front_if` predicate.
    #[allow(clippy::manual_pop_if)]
    fn grant_combined_waiters(&self) {
        let mut combined = self.combined.lock().expect("combined outbound budget lock");
        let mut process_state = self.inner.state.lock().expect("process byte budget lock");
        // The combined queue is the only waiter machinery over the outbound
        // tiers; single-tier waiters would race the reservation accounting.
        debug_assert!(process_state.waiters.is_empty());
        let now = Instant::now();
        let combined = &mut *combined;

        // A reservation only ever belongs to the current front waiter.
        if combined.head_reserved > 0
            && combined.head_reserved_for != combined.waiters.front().map(|waiter| waiter.id)
        {
            process_state.available = process_state
                .available
                .saturating_add(std::mem::take(&mut combined.head_reserved))
                .min(self.inner.capacity);
            combined.head_reserved_for = None;
        }

        loop {
            // Aged front waiter: accumulate a process-tier reservation so
            // fit-first grants to younger waiters cannot starve it.
            let mut aged_head = None;
            if let Some(head) = combined.waiters.front()
                && now.saturating_duration_since(head.enqueued_at)
                    >= OUTBOUND_PROCESS_AGING_THRESHOLD
            {
                aged_head = Some(head.id);
                combined.head_reserved_for = Some(head.id);
                let claim = (head.bytes - combined.head_reserved).min(process_state.available);
                process_state.available -= claim;
                combined.head_reserved += claim;
                if combined.head_reserved == head.bytes {
                    let connection = Arc::clone(&head.connection);
                    let mut connection_state = connection
                        .state
                        .lock()
                        .expect("connection byte budget lock");
                    if connection_state.waiters.is_empty()
                        && head.bytes <= connection_state.available
                    {
                        let waiter = combined
                            .waiters
                            .pop_front()
                            .expect("aged front combined waiter exists");
                        combined.head_reserved = 0;
                        combined.head_reserved_for = None;
                        connection_state.available -= waiter.bytes;
                        waiter.granted.store(true, Ordering::Release);
                        if waiter.sender.send(()).is_err() {
                            waiter.granted.store(false, Ordering::Release);
                            process_state.available = process_state
                                .available
                                .saturating_add(waiter.bytes)
                                .min(self.inner.capacity);
                            connection_state.available = connection_state
                                .available
                                .saturating_add(waiter.bytes)
                                .min(connection.capacity);
                        }
                        drop(connection_state);
                        continue;
                    }
                    // Reservation complete but the head's own connection tier is
                    // full; hold the reservation and keep granting younger
                    // waiters from the surplus until that connection drains.
                    drop(connection_state);
                }
            }

            let candidate = combined
                .waiters
                .iter()
                .enumerate()
                .find_map(|(index, waiter)| {
                    if Some(waiter.id) == aged_head {
                        return None;
                    }
                    let connection_state = waiter.connection.state.lock().ok()?;
                    let fits = connection_state.waiters.is_empty()
                        && waiter.bytes <= process_state.available
                        && waiter.bytes <= connection_state.available;
                    drop(connection_state);
                    fits.then(|| (index, Arc::clone(&waiter.connection)))
                });
            let Some((index, connection)) = candidate else {
                return;
            };
            let mut connection_state = connection
                .state
                .lock()
                .expect("connection byte budget lock");
            let waiter = combined
                .waiters
                .remove(index)
                .expect("selected combined outbound waiter exists");
            debug_assert!(waiter.bytes <= process_state.available);
            debug_assert!(waiter.bytes <= connection_state.available);
            process_state.available -= waiter.bytes;
            connection_state.available -= waiter.bytes;
            waiter.granted.store(true, Ordering::Release);
            if waiter.sender.send(()).is_err() {
                waiter.granted.store(false, Ordering::Release);
                process_state.available = process_state
                    .available
                    .saturating_add(waiter.bytes)
                    .min(self.inner.capacity);
                connection_state.available = connection_state
                    .available
                    .saturating_add(waiter.bytes)
                    .min(connection.capacity);
            }
        }
    }

    /// Test-only capacity hold that, unlike production permits, is acquired
    /// from the process tier alone; its release still runs a combined grant
    /// pass so blocked waiters observe it.
    #[cfg(test)]
    pub(crate) fn try_acquire(&self, bytes: usize) -> Result<ProcessCapacityHold, ()> {
        let combined = self.combined.lock().map_err(|_| ())?;
        if !combined.waiters.is_empty() {
            return Err(());
        }
        let grant = Arc::clone(&self.inner).try_acquire(bytes).ok_or(())?;
        drop(combined);
        Ok(ProcessCapacityHold {
            grant: Some(grant),
            process: self.clone(),
        })
    }
}

#[cfg(test)]
pub(crate) struct ProcessCapacityHold {
    grant: Option<WeightedByteGrant>,
    process: RpcOutboundProcessBudget,
}

#[cfg(test)]
impl ProcessCapacityHold {
    pub(crate) fn bytes(&self) -> usize {
        self.grant.as_ref().map_or(0, WeightedByteGrant::bytes)
    }
}

#[cfg(test)]
impl Drop for ProcessCapacityHold {
    fn drop(&mut self) {
        drop(self.grant.take());
        self.process.grant_combined_waiters();
    }
}

impl Drop for RpcOutboundCombinedWaiterGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut combined = self
            .process
            .combined
            .lock()
            .expect("combined outbound budget lock");
        let mut process_state = self
            .process
            .inner
            .state
            .lock()
            .expect("process byte budget lock");
        let mut connection_state = self
            .connection
            .state
            .lock()
            .expect("connection byte budget lock");
        if let Some(index) = combined
            .waiters
            .iter()
            .position(|waiter| waiter.id == self.id)
        {
            combined.waiters.remove(index);
            if combined.head_reserved_for == Some(self.id) {
                process_state.available = process_state
                    .available
                    .saturating_add(std::mem::take(&mut combined.head_reserved))
                    .min(self.process.inner.capacity);
                combined.head_reserved_for = None;
            }
        } else if self.granted.swap(false, Ordering::AcqRel) {
            process_state.available = process_state
                .available
                .saturating_add(self.bytes)
                .min(self.process.inner.capacity);
            connection_state.available = connection_state
                .available
                .saturating_add(self.bytes)
                .min(self.connection.capacity);
        }
        drop(connection_state);
        drop(process_state);
        drop(combined);
        self.process.grant_combined_waiters();
    }
}

impl WeightedByteBudget {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity,
            state: Mutex::new(WeightedByteBudgetState {
                available: capacity,
                next_waiter_id: 0,
                waiters: VecDeque::new(),
            }),
        }
    }

    pub(crate) async fn acquire_cancellable(
        self: Arc<Self>,
        bytes: usize,
        cancellation: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<WeightedByteGrant, WeightedByteAcquireError> {
        let (receiver, mut guard) = Arc::clone(&self).enqueue(bytes)?;
        match deadline {
            Some(deadline) => {
                tokio::select! {
                    () = cancellation.cancelled() => {
                        return Err(WeightedByteAcquireError::Cancelled);
                    }
                    result = timeout_at(deadline, receiver) => {
                        result
                            .map_err(|_| WeightedByteAcquireError::Deadline)?
                            .map_err(|_| WeightedByteAcquireError::Cancelled)?;
                    }
                }
            }
            None => {
                tokio::select! {
                    () = cancellation.cancelled() => {
                        return Err(WeightedByteAcquireError::Cancelled);
                    }
                    result = receiver => {
                        result.map_err(|_| WeightedByteAcquireError::Cancelled)?;
                    }
                }
            }
        }
        guard.active = false;
        Ok(WeightedByteGrant { inner: self, bytes })
    }

    fn enqueue(
        self: Arc<Self>,
        bytes: usize,
    ) -> Result<(oneshot::Receiver<()>, WeightedByteWaiterGuard), WeightedByteAcquireError> {
        if bytes > self.capacity {
            return Err(WeightedByteAcquireError::Oversized);
        }
        let mut state = self.state.lock().expect("weighted byte budget lock");
        let id = state.next_waiter_id;
        state.next_waiter_id = state.next_waiter_id.wrapping_add(1);
        let (sender, receiver) = oneshot::channel();
        let granted = Arc::new(AtomicBool::new(false));
        state.waiters.push_back(WeightedByteWaiter {
            id,
            bytes,
            granted: Arc::clone(&granted),
            sender,
        });
        grant_weighted_byte_waiters(&mut state);
        drop(state);
        Ok((
            receiver,
            WeightedByteWaiterGuard {
                inner: self,
                id,
                bytes,
                granted,
                active: true,
            },
        ))
    }

    #[cfg(test)]
    pub(crate) fn try_acquire(self: Arc<Self>, bytes: usize) -> Option<WeightedByteGrant> {
        if bytes > self.capacity {
            return None;
        }
        let mut state = self.state.lock().ok()?;
        if !state.waiters.is_empty() || state.available < bytes {
            return None;
        }
        state.available -= bytes;
        drop(state);
        Some(WeightedByteGrant { inner: self, bytes })
    }
}

impl WeightedByteGrant {
    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }

    fn shrink_to(&mut self, bytes: usize) -> Result<(), ()> {
        if bytes > self.bytes {
            return Err(());
        }
        let released = self.bytes - bytes;
        self.bytes = bytes;
        release_weighted_bytes(Arc::clone(&self.inner), released);
        Ok(())
    }

    pub(crate) fn merge(&mut self, mut other: Self) -> Result<(), ()> {
        if !Arc::ptr_eq(&self.inner, &other.inner) {
            return Err(());
        }
        self.bytes = self.bytes.checked_add(other.bytes).ok_or(())?;
        other.bytes = 0;
        Ok(())
    }
}

impl Drop for WeightedByteGrant {
    fn drop(&mut self) {
        let bytes = std::mem::take(&mut self.bytes);
        release_weighted_bytes(Arc::clone(&self.inner), bytes);
    }
}

impl Drop for WeightedByteWaiterGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        cancel_weighted_byte_waiter(
            Arc::clone(&self.inner),
            self.id,
            self.bytes,
            Arc::clone(&self.granted),
        );
    }
}

fn grant_weighted_byte_waiters(state: &mut WeightedByteBudgetState) {
    loop {
        let Some(candidate) = state
            .waiters
            .iter()
            .position(|waiter| waiter.bytes <= state.available)
        else {
            return;
        };
        let waiter = state
            .waiters
            .remove(candidate)
            .expect("selected weighted waiter exists");
        state.available -= waiter.bytes;
        waiter.granted.store(true, Ordering::Release);
        if waiter.sender.send(()).is_err() {
            waiter.granted.store(false, Ordering::Release);
            state.available = state.available.saturating_add(waiter.bytes);
        }
    }
}

fn release_weighted_bytes(inner: Arc<WeightedByteBudget>, bytes: usize) {
    if bytes == 0 {
        return;
    }
    let mut state = inner.state.lock().expect("weighted byte budget lock");
    state.available = state.available.saturating_add(bytes).min(inner.capacity);
    grant_weighted_byte_waiters(&mut state);
}

fn cancel_weighted_byte_waiter(
    inner: Arc<WeightedByteBudget>,
    id: u64,
    bytes: usize,
    granted: Arc<AtomicBool>,
) {
    let mut state = inner.state.lock().expect("weighted byte budget lock");
    if let Some(index) = state.waiters.iter().position(|waiter| waiter.id == id) {
        state.waiters.remove(index);
    } else if granted.swap(false, Ordering::AcqRel) {
        state.available = state.available.saturating_add(bytes).min(inner.capacity);
    }
    grant_weighted_byte_waiters(&mut state);
}

pub(crate) struct RpcOutboundBytePermit {
    process: Option<WeightedByteGrant>,
    connection: Option<WeightedByteGrant>,
    process_budget: RpcOutboundProcessBudget,
}

impl RpcOutboundBytePermit {
    pub(super) fn shrink_to(&mut self, bytes: usize) -> Result<(), ()> {
        let (Some(process), Some(connection)) = (&mut self.process, &mut self.connection) else {
            return Err(());
        };
        let current = process.bytes();
        if bytes > current || connection.bytes() != current {
            return Err(());
        }
        process.shrink_to(bytes)?;
        connection.shrink_to(bytes)?;
        self.process_budget.grant_combined_waiters();
        Ok(())
    }

    #[cfg(test)]
    fn tier_bytes(&self) -> (usize, usize) {
        (
            self.process.as_ref().map_or(0, WeightedByteGrant::bytes),
            self.connection.as_ref().map_or(0, WeightedByteGrant::bytes),
        )
    }
}

impl Drop for RpcOutboundBytePermit {
    fn drop(&mut self) {
        drop(self.process.take());
        drop(self.connection.take());
        self.process_budget.grant_combined_waiters();
    }
}

#[cfg(test)]
mod tests {
    use tokio::time::timeout;

    use super::*;

    fn combined(
        process: &RpcOutboundProcessBudget,
        connection_capacity: usize,
    ) -> RpcOutboundBudget {
        RpcOutboundBudget::new(process.clone(), connection_capacity)
    }

    #[tokio::test(start_paused = true)]
    async fn outbound_process_budget_admits_a_large_waiter_after_sufficient_release() {
        let process = RpcOutboundProcessBudget::new(10);
        let blocker = process.try_acquire(8).expect("initial process bytes");
        let large_budget = combined(&process, 10);
        let large = tokio::spawn(async move {
            large_budget
                .acquire(8, Instant::now() + Duration::from_secs(10))
                .await
        });
        tokio::task::yield_now().await;

        let small = combined(&process, 10)
            .acquire(2, Instant::now() + Duration::from_secs(10))
            .await
            .expect("small fitting waiter bypasses the blocked unaged large waiter");
        assert!(!large.is_finished());
        drop(small);
        drop(blocker);

        let large = large
            .await
            .expect("large waiter task")
            .expect("large waiter makes progress after release");
        assert_eq!(large.tier_bytes(), (8, 8));
    }

    #[tokio::test(start_paused = true)]
    async fn aged_large_waiter_reserves_releases_until_granted() {
        let process = RpcOutboundProcessBudget::new(10);
        let blocker = process.try_acquire(8).expect("initial process bytes");
        let large_budget = combined(&process, 10);
        let large = tokio::spawn(async move {
            large_budget
                .acquire(8, Instant::now() + Duration::from_secs(10))
                .await
        });
        tokio::task::yield_now().await;
        tokio::time::advance(OUTBOUND_PROCESS_AGING_THRESHOLD).await;

        let small_budget = combined(&process, 10);
        let small = tokio::spawn(async move {
            small_budget
                .acquire(2, Instant::now() + Duration::from_secs(10))
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !small.is_finished(),
            "released capacity is reserved for the aged large waiter first"
        );
        assert!(!large.is_finished());

        drop(blocker);
        let large = timeout(Duration::from_secs(1), large)
            .await
            .expect("aged large waiter is granted from the reservation")
            .expect("large waiter task")
            .expect("large waiter acquires both tiers");
        assert_eq!(large.tier_bytes(), (8, 8));
        drop(large);

        let small = timeout(Duration::from_secs(1), small)
            .await
            .expect("small waiter resumes once the aged head is granted")
            .expect("small waiter task")
            .expect("small waiter acquires both tiers");
        assert_eq!(small.tier_bytes(), (2, 2));
    }

    /// The regression behind the aging rule: with pure fit-first granting a
    /// stream of small waiters absorbs every release and a large waiter never
    /// accumulates enough contiguous capacity.
    #[tokio::test(start_paused = true)]
    async fn sustained_small_churn_cannot_starve_an_aged_large_waiter() {
        let process = RpcOutboundProcessBudget::new(10);
        let small_budget = combined(&process, 10);
        let first = small_budget
            .acquire(2, Instant::now() + Duration::from_secs(10))
            .await
            .expect("first small hold");
        let second = small_budget
            .acquire(2, Instant::now() + Duration::from_secs(10))
            .await
            .expect("second small hold");
        let third = small_budget
            .acquire(2, Instant::now() + Duration::from_secs(10))
            .await
            .expect("third small hold");

        let large_budget = combined(&process, 10);
        let large = tokio::spawn(async move {
            large_budget
                .acquire(8, Instant::now() + Duration::from_secs(10))
                .await
        });
        tokio::task::yield_now().await;
        tokio::time::advance(OUTBOUND_PROCESS_AGING_THRESHOLD).await;

        // A younger small waiter keeps competing for every released byte.
        let churn_budget = combined(&process, 10);
        let churn = tokio::spawn(async move {
            churn_budget
                .acquire(2, Instant::now() + Duration::from_secs(10))
                .await
        });
        tokio::task::yield_now().await;

        drop(first);
        tokio::task::yield_now().await;
        drop(second);
        tokio::task::yield_now().await;
        assert!(
            large.is_finished(),
            "releases accumulate in the aged waiter's reservation instead of \
             feeding younger waiters"
        );
        let large = large
            .await
            .expect("large waiter task")
            .expect("large waiter acquires both tiers");
        assert!(!churn.is_finished());

        drop(third);
        drop(large);
        let churn = timeout(Duration::from_secs(1), churn)
            .await
            .expect("younger waiter resumes after the aged waiter is granted")
            .expect("churn waiter task")
            .expect("churn waiter acquires both tiers");
        assert_eq!(churn.tier_bytes(), (2, 2));
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_weighted_waiter_is_removed_and_capacity_is_refunded_once() {
        let process = RpcOutboundProcessBudget::new(10);
        let blocker = process.try_acquire(10).expect("initial process bytes");
        let waiting_budget = combined(&process, 10);
        let waiting = tokio::spawn(async move {
            waiting_budget
                .acquire(10, Instant::now() + Duration::from_secs(10))
                .await
        });
        tokio::task::yield_now().await;
        waiting.abort();
        assert!(matches!(waiting.await, Err(error) if error.is_cancelled()));

        drop(blocker);
        let recovered = process
            .try_acquire(10)
            .expect("cancelled waiter does not retain process bytes");
        assert_eq!(recovered.bytes(), 10);
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_aged_head_refunds_its_reservation() {
        let process = RpcOutboundProcessBudget::new(10);
        let blocker = process.try_acquire(6).expect("initial process bytes");
        let waiting_budget = combined(&process, 10);
        let waiting = tokio::spawn(async move {
            waiting_budget
                .acquire(8, Instant::now() + Duration::from_secs(10))
                .await
        });
        tokio::task::yield_now().await;
        tokio::time::advance(OUTBOUND_PROCESS_AGING_THRESHOLD).await;

        // Trigger a grant pass so the aged head claims the idle capacity.
        let probe_budget = combined(&process, 10);
        let probe = tokio::spawn(async move {
            probe_budget
                .acquire(1, Instant::now() + Duration::from_secs(10))
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !probe.is_finished(),
            "idle capacity belongs to the aged head"
        );

        waiting.abort();
        assert!(matches!(waiting.await, Err(error) if error.is_cancelled()));
        let probe = timeout(Duration::from_secs(1), probe)
            .await
            .expect("cancelled aged head refunds its reservation")
            .expect("probe waiter task")
            .expect("probe waiter acquires both tiers");
        assert_eq!(probe.tier_bytes(), (1, 1));
        drop(probe);
        drop(blocker);
        assert_eq!(process.try_acquire(10).expect("full refund").bytes(), 10);
    }

    #[tokio::test(start_paused = true)]
    async fn outbound_connection_wait_uses_the_same_absolute_deadline_as_process_wait() {
        let budget = RpcOutboundBudget::new(RpcOutboundProcessBudget::new(10), 1);
        let blocker = budget.try_acquire(1).expect("initial connection byte");
        let waiting_budget = budget.clone();
        let waiting = tokio::spawn(async move {
            waiting_budget
                .acquire(1, Instant::now() + Duration::from_secs(5))
                .await
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        tokio::task::yield_now().await;

        assert!(
            waiting.is_finished(),
            "connection-tier admission must observe the shared absolute deadline"
        );
        assert!(waiting.await.expect("connection waiter task").is_err());
        drop(blocker);
    }

    #[tokio::test]
    async fn two_tier_admission_does_not_hold_connection_bytes_while_process_bytes_are_blocked() {
        let process = RpcOutboundProcessBudget::new(10);
        let process_blocker = process.try_acquire(9).expect("hold most process bytes");
        let budget = combined(&process, 8);

        let large_budget = budget.clone();
        let large = tokio::spawn(async move {
            large_budget
                .acquire(8, Instant::now() + Duration::from_secs(5))
                .await
        });
        tokio::task::yield_now().await;

        let small = timeout(
            Duration::from_millis(250),
            budget.acquire(1, Instant::now() + Duration::from_secs(5)),
        )
        .await
        .expect("small response is not blocked by a large response holding connection bytes")
        .expect("one byte fits both admission tiers");
        assert!(!large.is_finished());

        drop(small);
        drop(process_blocker);
        let large = timeout(Duration::from_secs(1), large)
            .await
            .expect("large response proceeds after process capacity is released")
            .expect("large response task joins")
            .expect("large response acquires both tiers");
        assert_eq!(large.tier_bytes(), (8, 8));
    }

    /// Granting is push-based: a release made after a waiter enqueues reaches
    /// it with no polling loop involved.
    #[tokio::test]
    async fn release_after_enqueue_is_granted_without_polling() {
        let process = RpcOutboundProcessBudget::new(1);
        let blocker = process.try_acquire(1).expect("hold process byte");
        let budget = combined(&process, 1);
        let waiting = tokio::spawn(async move {
            budget
                .acquire(1, Instant::now() + Duration::from_secs(5))
                .await
        });
        tokio::task::yield_now().await;
        drop(blocker);

        let permit = timeout(Duration::from_millis(250), waiting)
            .await
            .expect("release after enqueue grants the waiter")
            .expect("waiting admission task joins")
            .expect("both tiers become available");
        assert_eq!(permit.tier_bytes(), (1, 1));
    }
}
