use std::sync::{
    Arc, Mutex as StdMutex,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};

#[cfg(test)]
use std::sync::Barrier;
use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedMutexGuard, watch};

const MODE_DISABLED: u64 = 0;
const MODE_ENABLED: u64 = 1;
const MODE_DRAINING: u64 = 2;
const MODE_MASK: u64 = 0b11;
const GENERATION_SHIFT: u32 = 2;
const MAX_GENERATION: u64 = u64::MAX >> GENERATION_SHIFT;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgentActivityState {
    pub enabled: bool,
    pub generation: u64,
}

#[derive(Clone, Debug)]
pub struct AgentActivityController {
    inner: Arc<AgentActivityControllerInner>,
}

#[derive(Debug)]
struct AgentActivityControllerInner {
    state: AtomicU64,
    in_flight: AtomicUsize,
    streams: AtomicUsize,
    gate: StdMutex<AgentActivityGateState>,
    lifecycle: Arc<AsyncMutex<()>>,
    drained: Notify,
    states: watch::Sender<AgentActivityState>,
    #[cfg(test)]
    stream_registration_pause: StdMutex<Option<TestStreamRegistrationPause>>,
    #[cfg(test)]
    disable_gate_attempt: StdMutex<Option<Arc<Barrier>>>,
}

#[derive(Debug)]
struct AgentActivityGateState {
    desired_enabled: bool,
    request_sequence: u64,
    active_report: Option<AgentActivityDisableReport>,
}

#[cfg(test)]
#[derive(Debug)]
struct TestStreamRegistrationPause {
    entered: Arc<Barrier>,
    release: Arc<Barrier>,
}

#[derive(Debug)]
pub struct AgentActivityAdmission {
    inner: Arc<AgentActivityControllerInner>,
    generation: u64,
}

#[derive(Debug)]
pub struct AgentActivityStreamRegistration {
    inner: Arc<AgentActivityControllerInner>,
}

#[derive(Debug)]
pub(crate) struct AgentActivityDisableFinalization {
    controller: AgentActivityController,
    report: AgentActivityDisableReport,
    _lifecycle: OwnedMutexGuard<()>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgentActivityDisableReport {
    pub state: AgentActivityState,
    pub closed_subscriptions: usize,
}

impl AgentActivityController {
    #[must_use]
    pub fn new(enabled: bool) -> Self {
        let state = AgentActivityState {
            enabled,
            generation: 0,
        };
        let (states, _) = watch::channel(state);
        Self {
            inner: Arc::new(AgentActivityControllerInner {
                state: AtomicU64::new(pack_state(
                    state.generation,
                    if enabled { MODE_ENABLED } else { MODE_DISABLED },
                )),
                in_flight: AtomicUsize::new(0),
                streams: AtomicUsize::new(0),
                gate: StdMutex::new(AgentActivityGateState {
                    desired_enabled: enabled,
                    request_sequence: 0,
                    active_report: None,
                }),
                lifecycle: Arc::new(AsyncMutex::new(())),
                drained: Notify::new(),
                states,
                #[cfg(test)]
                stream_registration_pause: StdMutex::new(None),
                #[cfg(test)]
                disable_gate_attempt: StdMutex::new(None),
            }),
        }
    }

    #[must_use]
    pub fn snapshot(&self) -> AgentActivityState {
        public_state(self.inner.state.load(Ordering::Acquire))
    }

    /// Returns accepted stream registrations for black-box integration diagnostics.
    #[doc(hidden)]
    #[must_use]
    pub fn active_stream_count_for_integration_test(&self) -> usize {
        self.inner.streams.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn admit(&self) -> Option<AgentActivityAdmission> {
        let observed = self.inner.state.load(Ordering::Acquire);
        if mode(observed) != MODE_ENABLED {
            return None;
        }
        increment_bounded(&self.inner.in_flight)?;
        let current = self.inner.state.load(Ordering::Acquire);
        if current != observed {
            decrement_and_notify(&self.inner, &self.inner.in_flight);
            return None;
        }
        Some(AgentActivityAdmission {
            inner: Arc::clone(&self.inner),
            generation: generation(observed),
        })
    }

    #[must_use]
    pub fn register_stream(&self) -> Option<AgentActivityStreamRegistration> {
        if mode(self.inner.state.load(Ordering::Acquire)) != MODE_ENABLED {
            return None;
        }
        let _gate = self
            .inner
            .gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let observed = self.inner.state.load(Ordering::Acquire);
        if mode(observed) != MODE_ENABLED {
            return None;
        }
        increment_bounded(&self.inner.streams)?;
        #[cfg(test)]
        self.pause_stream_registration_after_increment();
        if self.inner.state.load(Ordering::Acquire) != observed {
            decrement_and_notify(&self.inner, &self.inner.streams);
            return None;
        }
        Some(AgentActivityStreamRegistration {
            inner: Arc::clone(&self.inner),
        })
    }

    pub async fn disable(&self) -> AgentActivityDisableReport {
        let request_sequence = self.request_disabled();
        let _lifecycle = Arc::clone(&self.inner.lifecycle).lock_owned().await;
        let Some(report) = self.begin_disable(request_sequence) else {
            return AgentActivityDisableReport {
                state: self.snapshot(),
                closed_subscriptions: 0,
            };
        };
        self.wait_for_drain().await;
        self.finish_disable(report.state.generation);
        report
    }

    pub fn enable(&self) -> AgentActivityState {
        let mut gate = self
            .inner
            .gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        gate.request_sequence = next_request_sequence(gate.request_sequence);
        gate.desired_enabled = true;
        let observed = self.inner.state.load(Ordering::Acquire);
        match mode(observed) {
            MODE_ENABLED | MODE_DRAINING => public_state(observed),
            MODE_DISABLED => {
                let enabled = pack_state(next_generation(generation(observed)), MODE_ENABLED);
                self.inner.state.store(enabled, Ordering::Release);
                let state = public_state(enabled);
                self.inner.states.send_replace(state);
                state
            }
            _ => unreachable!("invalid agent activity controller mode"),
        }
    }

    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<AgentActivityState> {
        self.inner.states.subscribe()
    }

    pub(crate) fn publish_if_current(
        &self,
        admission: &AgentActivityAdmission,
        publish: impl FnOnce(),
    ) -> bool {
        let _gate = self
            .inner
            .gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !admission.is_current() {
            return false;
        }
        publish();
        true
    }

    pub(crate) async fn disable_for_finalization(
        &self,
    ) -> Option<AgentActivityDisableFinalization> {
        let request_sequence = self.request_disabled();
        let lifecycle = Arc::clone(&self.inner.lifecycle).lock_owned().await;
        let report = self.begin_disable(request_sequence)?;
        self.wait_for_drain().await;
        {
            let _gate = self
                .inner
                .gate
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let observed = self.inner.state.load(Ordering::Acquire);
            if generation(observed) == report.state.generation
                && matches!(mode(observed), MODE_DRAINING | MODE_DISABLED)
            {
                self.inner.state.store(
                    pack_state(report.state.generation, MODE_DRAINING),
                    Ordering::Release,
                );
            }
        }
        Some(AgentActivityDisableFinalization {
            controller: self.clone(),
            report,
            _lifecycle: lifecycle,
        })
    }

    fn request_disabled(&self) -> u64 {
        #[cfg(test)]
        self.notify_disable_gate_attempt();
        let mut gate = self
            .inner
            .gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        gate.request_sequence = next_request_sequence(gate.request_sequence);
        gate.desired_enabled = false;
        gate.request_sequence
    }

    fn begin_disable(&self, request_sequence: u64) -> Option<AgentActivityDisableReport> {
        let mut gate = self
            .inner
            .gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if gate.request_sequence != request_sequence && gate.desired_enabled {
            return None;
        }
        let observed = self.inner.state.load(Ordering::Acquire);
        let report = match mode(observed) {
            MODE_ENABLED => {
                let draining = pack_state(next_generation(generation(observed)), MODE_DRAINING);
                self.inner.state.store(draining, Ordering::Release);
                let report = AgentActivityDisableReport {
                    state: public_state(draining),
                    closed_subscriptions: self.inner.streams.load(Ordering::Acquire),
                };
                gate.active_report = Some(report);
                self.inner.states.send_replace(report.state);
                report
            }
            MODE_DRAINING | MODE_DISABLED => gate
                .active_report
                .filter(|report| report.state.generation == generation(observed))
                .unwrap_or(AgentActivityDisableReport {
                    state: public_state(observed),
                    closed_subscriptions: 0,
                }),
            _ => unreachable!("invalid agent activity controller mode"),
        };
        Some(report)
    }

    fn finish_disable(&self, disabled_generation: u64) {
        let gate = self
            .inner
            .gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let observed = self.inner.state.load(Ordering::Acquire);
        if generation(observed) != disabled_generation || mode(observed) != MODE_DRAINING {
            return;
        }
        if gate.desired_enabled {
            let enabled = pack_state(next_generation(disabled_generation), MODE_ENABLED);
            self.inner.state.store(enabled, Ordering::Release);
            self.inner.states.send_replace(public_state(enabled));
        } else {
            self.inner.state.store(
                pack_state(disabled_generation, MODE_DISABLED),
                Ordering::Release,
            );
        }
    }

    async fn wait_for_drain(&self) {
        loop {
            let notified = self.inner.drained.notified();
            if self.inner.in_flight.load(Ordering::Acquire) == 0
                && self.inner.streams.load(Ordering::Acquire) == 0
            {
                return;
            }
            notified.await;
        }
    }

    #[cfg(test)]
    fn pause_stream_registration_after_increment_for_test(&self) -> (Arc<Barrier>, Arc<Barrier>) {
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        *self
            .inner
            .stream_registration_pause
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(TestStreamRegistrationPause {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
            });
        (entered, release)
    }

    #[cfg(test)]
    fn pause_stream_registration_after_increment(&self) {
        let pause = self
            .inner
            .stream_registration_pause
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(pause) = pause {
            pause.entered.wait();
            pause.release.wait();
        }
    }

    #[cfg(test)]
    fn notify_disable_gate_attempt_for_test(&self) -> Arc<Barrier> {
        let attempted = Arc::new(Barrier::new(2));
        *self
            .inner
            .disable_gate_attempt
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Arc::clone(&attempted));
        attempted
    }

    #[cfg(test)]
    fn notify_disable_gate_attempt(&self) {
        let attempted = self
            .inner
            .disable_gate_attempt
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(attempted) = attempted {
            attempted.wait();
        }
    }
}

impl AgentActivityAdmission {
    #[must_use]
    pub(crate) fn is_current(&self) -> bool {
        self.inner.state.load(Ordering::Acquire) == pack_state(self.generation, MODE_ENABLED)
    }
}

impl Drop for AgentActivityAdmission {
    fn drop(&mut self) {
        decrement_and_notify(&self.inner, &self.inner.in_flight);
    }
}

impl Drop for AgentActivityStreamRegistration {
    fn drop(&mut self) {
        decrement_and_notify(&self.inner, &self.inner.streams);
    }
}

impl AgentActivityDisableFinalization {
    #[must_use]
    pub(crate) const fn report(&self) -> AgentActivityDisableReport {
        self.report
    }
}

impl Drop for AgentActivityDisableFinalization {
    fn drop(&mut self) {
        self.controller.finish_disable(self.report.state.generation);
    }
}

fn increment_bounded(counter: &AtomicUsize) -> Option<()> {
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
            count.checked_add(1)
        })
        .ok()
        .map(drop)
}

fn decrement_and_notify(inner: &AgentActivityControllerInner, counter: &AtomicUsize) {
    let previous = counter.fetch_sub(1, Ordering::AcqRel);
    debug_assert!(previous > 0, "agent activity counter underflow");
    inner.drained.notify_waiters();
}

const fn pack_state(generation: u64, mode: u64) -> u64 {
    (generation << GENERATION_SHIFT) | mode
}

const fn generation(state: u64) -> u64 {
    state >> GENERATION_SHIFT
}

const fn mode(state: u64) -> u64 {
    state & MODE_MASK
}

const fn public_state(state: u64) -> AgentActivityState {
    AgentActivityState {
        enabled: mode(state) == MODE_ENABLED,
        generation: generation(state),
    }
}

const fn next_generation(generation: u64) -> u64 {
    if generation == MAX_GENERATION {
        0
    } else {
        generation + 1
    }
}

const fn next_request_sequence(sequence: u64) -> u64 {
    sequence.wrapping_add(1)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::{AgentActivityController, AgentActivityState};

    #[test]
    fn constructor_preserves_the_requested_default_state() {
        // Mutation caught: ignoring the initial setting or starting at a non-zero generation.
        assert_eq!(
            AgentActivityController::new(true).snapshot(),
            AgentActivityState {
                enabled: true,
                generation: 0,
            }
        );
        assert_eq!(
            AgentActivityController::new(false).snapshot(),
            AgentActivityState {
                enabled: false,
                generation: 0,
            }
        );
    }

    #[tokio::test]
    async fn disable_closes_admission_and_waits_for_existing_work() {
        // Mutation caught: closing admission after waiting, or failing to drain admitted work.
        let controller = AgentActivityController::new(true);
        let admission = controller.admit().expect("enabled admission");
        let before = controller.snapshot();

        let disabling = tokio::spawn({
            let controller = controller.clone();
            async move { controller.disable().await }
        });
        tokio::task::yield_now().await;

        assert!(controller.admit().is_none());
        assert!(!disabling.is_finished());
        drop(admission);

        let disabled = disabling.await.expect("disable task");
        assert!(!disabled.state.enabled);
        assert!(disabled.state.generation > before.generation);
    }

    #[tokio::test]
    async fn enable_advances_generation_publishes_once_and_reopens_admission() {
        // Mutation caught: reopening without a generation fence or duplicate watch publication.
        let controller = AgentActivityController::new(true);
        controller.disable().await;
        let disabled = controller.snapshot();
        let mut states = controller.subscribe();

        let enabled = controller.enable();

        assert!(enabled.enabled);
        assert!(enabled.generation > disabled.generation);
        states.changed().await.expect("enabled state publication");
        assert_eq!(*states.borrow_and_update(), enabled);
        assert!(!states.has_changed().expect("watch remains open"));
        assert!(controller.admit().is_some());
    }

    #[tokio::test]
    async fn disable_waits_for_streams_and_reports_the_closed_registration_count() {
        // Mutation caught: omitting stream registrations from drain accounting.
        let controller = AgentActivityController::new(true);
        let first = controller.register_stream().expect("first stream");
        let second = controller.register_stream().expect("second stream");

        let disabling = tokio::spawn({
            let controller = controller.clone();
            async move { controller.disable().await }
        });
        tokio::task::yield_now().await;

        assert!(controller.register_stream().is_none());
        assert!(!disabling.is_finished());
        drop(first);
        tokio::task::yield_now().await;
        assert!(!disabling.is_finished());
        drop(second);

        let report = disabling.await.expect("disable task");
        assert_eq!(report.closed_subscriptions, 2);
    }

    #[tokio::test]
    async fn publication_is_ordered_before_the_closed_generation_transition() {
        // Mutation caught: separating current-generation validation from synchronous publication.
        let controller = AgentActivityController::new(true);
        let admission = controller.admit().expect("admission");
        let mut states = controller.subscribe();
        let (events, mut receiver) = tokio::sync::broadcast::channel(1);
        let publication_entered = Arc::new(Barrier::new(2));
        let publication_release = Arc::new(Barrier::new(2));
        let disable_attempted = controller.notify_disable_gate_attempt_for_test();
        let publisher = std::thread::spawn({
            let controller = controller.clone();
            let publication_entered = Arc::clone(&publication_entered);
            let publication_release = Arc::clone(&publication_release);
            move || {
                assert!(controller.publish_if_current(&admission, || {
                    publication_entered.wait();
                    publication_release.wait();
                    let _ = events.send("delta");
                }));
            }
        });
        publication_entered.wait();

        let disabling = std::thread::spawn({
            let controller = controller.clone();
            move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("disable runtime")
                    .block_on(controller.disable())
            }
        });
        disable_attempted.wait();

        assert!(
            !states.has_changed().expect("watch open"),
            "disable cannot publish its closed generation while publication owns the fence"
        );
        publication_release.wait();
        publisher.join().expect("publisher");
        assert_eq!(receiver.recv().await.expect("published event"), "delta");

        disabling.join().expect("disable");
        states.changed().await.expect("closed generation");
        assert!(!states.borrow().enabled);
    }

    #[tokio::test]
    async fn enable_requested_during_drain_reopens_after_the_disable_transition() {
        // Mutation caught: reopening admission before finalization or discarding a pending enable.
        let controller = AgentActivityController::new(true);
        let admission = controller.admit().expect("admission");
        let before = controller.snapshot();
        let disabling = tokio::spawn({
            let controller = controller.clone();
            async move {
                controller
                    .disable_for_finalization()
                    .await
                    .expect("finalization")
            }
        });
        tokio::task::yield_now().await;
        assert!(!controller.enable().enabled);

        drop(admission);
        let finalization = disabling.await.expect("disable");
        let disabled = finalization.report().state;
        assert!(!controller.snapshot().enabled);
        assert!(controller.admit().is_none());
        drop(finalization);
        let enabled = controller.snapshot();

        assert!(!disabled.enabled);
        assert!(enabled.enabled);
        assert!(enabled.generation > disabled.generation);
        assert!(enabled.generation > before.generation);
        assert!(controller.admit().is_some());
    }

    #[tokio::test]
    async fn stream_report_counts_only_registrations_that_were_accepted() {
        // Mutation caught: snapshotting the stream count before an accepted registration commits.
        let controller = AgentActivityController::new(true);
        let mut states = controller.subscribe();
        let (entered, release) = controller.pause_stream_registration_after_increment_for_test();
        let disable_attempted = controller.notify_disable_gate_attempt_for_test();
        let registering = std::thread::spawn({
            let controller = controller.clone();
            move || controller.register_stream()
        });
        entered.wait();

        let disabling = std::thread::spawn({
            let controller = controller.clone();
            move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("disable runtime")
                    .block_on(controller.disable())
            }
        });
        disable_attempted.wait();
        release.wait();
        let registration = registering.join().expect("registration thread");
        assert!(registration.is_some());

        states.changed().await.expect("draining state");
        assert!(!states.borrow().enabled);
        drop(registration);

        let report = disabling.join().expect("disable");
        assert_eq!(report.closed_subscriptions, 1);
    }
}
