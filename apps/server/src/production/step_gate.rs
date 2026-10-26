//! A point an RPC handler waits at in integration tests, so a test can act while the handler is
//! known to be between two steps. Production services hold none.

use std::sync::Arc;

use tokio::sync::Semaphore;

#[doc(hidden)]
#[derive(Clone, Debug)]
pub struct StepGate {
    reached: Arc<Semaphore>,
    released: Arc<Semaphore>,
}

impl Default for StepGate {
    fn default() -> Self {
        Self::new()
    }
}

impl StepGate {
    #[must_use]
    pub fn new() -> Self {
        Self {
            reached: Arc::new(Semaphore::new(0)),
            released: Arc::new(Semaphore::new(0)),
        }
    }

    /// Returns once a handler waits at the gate.
    pub async fn wait_until_reached(&self) {
        if let Ok(permit) = self.reached.acquire().await {
            permit.forget();
        }
    }

    /// Lets one waiting (or the next arriving) handler continue.
    pub fn release(&self) {
        self.released.add_permits(1);
    }

    pub(crate) async fn pass(&self) {
        self.reached.add_permits(1);
        if let Ok(permit) = self.released.acquire().await {
            permit.forget();
        }
    }
}
