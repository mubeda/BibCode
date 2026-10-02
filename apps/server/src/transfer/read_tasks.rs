//! Runtime-owned read work: interruption stops publication, then cleanup joins actual I/O.
use std::{
    future::Future,
    sync::{Arc, Mutex},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

#[derive(Clone, Default)]
pub(crate) struct ReadTaskOwner {
    inner: Arc<ReadTasks>,
}
#[derive(Default)]
struct ReadTasks {
    closed: Mutex<bool>,
    stop: CancellationToken,
    tasks: TaskTracker,
}
impl ReadTaskOwner {
    pub(crate) fn spawn(
        &self,
        cancellation: CancellationToken,
        work: impl Future<Output = ()> + Send + 'static,
    ) -> bool {
        let closed = self.inner.closed.lock().expect("read task admission");
        if *closed {
            return false;
        }
        let stop = self.inner.stop.clone();
        self.inner.tasks.spawn(async move {
            tokio::pin!(work);
            tokio::select! {biased; ()=stop.cancelled()=>cancellation.cancel(),()=&mut work=>{return;}}
            // Retain the future after cancellation; it owns cleanup of already-started I/O.
            work.await;
        });
        true
    }
    pub(crate) fn close(&self) {
        {
            let mut closed = self.inner.closed.lock().expect("read task admission");
            *closed = true;
            self.inner.stop.cancel();
            self.inner.tasks.close();
        }
    }
    pub(crate) async fn wait(&self) {
        self.inner.tasks.wait().await;
    }
}
