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
}
