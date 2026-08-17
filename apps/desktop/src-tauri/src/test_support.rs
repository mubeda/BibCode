use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::Notify;

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

    pub(crate) async fn wait_until_at_least(&self, expected: u64) {
        loop {
            let checkpoint = self.checkpoint();
            if checkpoint >= expected {
                return;
            }
            self.wait_after(checkpoint).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::FixtureEvent;

    #[tokio::test]
    async fn publication_before_wait_is_observed() {
        let event = FixtureEvent::default();
        let checkpoint = event.checkpoint();

        event.publish();
        event.wait_after(checkpoint).await;
    }

    #[tokio::test]
    async fn fixture_events_have_independent_generations() {
        let first = FixtureEvent::default();
        let second = FixtureEvent::default();
        let first_checkpoint = first.checkpoint();
        let second_checkpoint = second.checkpoint();

        first.publish();

        first.wait_after(first_checkpoint).await;
        assert_eq!(second.checkpoint(), second_checkpoint);
    }

    #[tokio::test]
    async fn waits_for_an_expected_generation_without_skipping_publication() {
        let event = FixtureEvent::default();

        event.publish();

        event.wait_until_at_least(1).await;
    }
}
