use std::{
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

use tokio::sync::Notify;

/// Wall-clock budget for one fixture wait. A healthy wait finishes in
/// milliseconds; the budget only turns an event that never arrives into a
/// failure that names it, instead of a test that hangs.
const FIXTURE_WAIT_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Debug, Default)]
pub(crate) struct FixtureEvent {
    generation: AtomicU64,
    changed: Notify,
}

impl FixtureEvent {
    pub(crate) fn checkpoint(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub(crate) fn publish(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.changed.notify_waiters();
    }

    pub(crate) async fn wait_after(&self, checkpoint: u64) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.generation.load(Ordering::Acquire) > checkpoint {
                return;
            }
            notified.await;
        }
    }

    /// Waits like [`Self::wait_after`], but fails the test naming `what` once
    /// [`FIXTURE_WAIT_DEADLINE`] passes.
    pub(crate) async fn wait_after_bounded(&self, checkpoint: u64, what: &str) {
        within_fixture_deadline(what, self.wait_after(checkpoint)).await;
    }
}

/// Resolves `future`, or fails the test naming `what` after
/// [`FIXTURE_WAIT_DEADLINE`] of wall-clock time.
pub(crate) async fn within_fixture_deadline<F: Future>(what: &str, future: F) -> F::Output {
    within_wall_clock_deadline(FIXTURE_WAIT_DEADLINE, what, future).await
}

/// Resolves `future`, or panics naming `what` once `deadline` of wall-clock
/// time passes.
///
/// The deadline runs on a watchdog thread, not a Tokio timer. A test with a
/// paused clock auto-advances to its next timer whenever the runtime idles,
/// including while a real child process has yet to exit, so a Tokio deadline
/// would expire early there. The watchdog registers no timer, so it never
/// changes when a paused clock advances.
async fn within_wall_clock_deadline<F: Future>(
    deadline: Duration,
    what: &str,
    future: F,
) -> F::Output {
    let (expired_sender, mut expired) = tokio::sync::oneshot::channel::<()>();
    let (cancel, cancelled) = mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("fixture-deadline".to_owned())
        .spawn(move || {
            if matches!(
                cancelled.recv_timeout(deadline),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                let _ = expired_sender.send(());
            }
        })
        .expect("start the fixture deadline watchdog");
    // Dropping the only sender wakes the watchdog, so it exits as soon as this
    // wait resolves or is cancelled.
    let _cancel = cancel;
    tokio::pin!(future);
    tokio::select! {
        biased;
        output = &mut future => output,
        Ok(()) = &mut expired => panic!("fixture wait exceeded its {deadline:?} deadline: {what}"),
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use super::{FixtureEvent, within_wall_clock_deadline};

    #[tokio::test(start_paused = true)]
    async fn bounded_wait_outlasts_paused_clock_auto_advance() {
        let event = Arc::new(FixtureEvent::default());
        let (advanced, advanced_signal) = std::sync::mpsc::channel::<()>();
        let publisher = {
            let event = event.clone();
            std::thread::spawn(move || {
                // A closed channel means the test already failed; stay quiet.
                if advanced_signal.recv().is_ok() {
                    event.publish();
                }
            })
        };
        let paused_at = tokio::time::Instant::now();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            advanced.send(()).expect("publisher waits for the signal");
        });

        event
            .wait_after_bounded(0, "a publication that follows an hour of auto-advance")
            .await;

        assert!(
            paused_at.elapsed() >= Duration::from_secs(3600),
            "the idle runtime auto-advanced far past the fixture deadline during the wait"
        );
        publisher.join().expect("publisher thread");
    }

    #[tokio::test]
    #[should_panic(expected = "fixture wait exceeded its 50ms deadline: an event nobody publishes")]
    async fn bounded_wait_fails_naming_the_missing_event() {
        let event = FixtureEvent::default();
        within_wall_clock_deadline(
            Duration::from_millis(50),
            "an event nobody publishes",
            event.wait_after(0),
        )
        .await;
    }
}
