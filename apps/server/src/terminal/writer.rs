//! A terminal process's input writer (#139 slice T review).
//!
//! A PTY write blocks while the child reads no input. Every write to one process goes
//! through its [`TerminalWriter`]: callers enqueue under whatever lock orders them, without
//! waiting, and one thread of the writer's own writes the queue in order. So a stuck write
//! holds neither a runtime thread, Tokio's shared blocking pool, nor the terminal's
//! publication lock, and later input queues behind it instead of racing it. The queue is
//! bounded in bytes, and the thread retires after it has been idle for a while.

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{PtyProcess, TerminalError};

/// The bytes one process may have queued or in flight before more input is refused.
pub(crate) const MOST_QUEUED_INPUT_BYTES: usize = 1 << 20;
/// How long an idle writer thread waits for input before it retires.
const IDLE: Duration = Duration::from_secs(30);

struct Job {
    data: String,
    cancel: CancellationToken,
    done: oneshot::Sender<Result<(), TerminalError>>,
}

/// One process's input queue and, while it has work, the thread that drains it.
#[derive(Default)]
pub(crate) struct TerminalWriter {
    /// The running thread's queue; `None` while no thread runs. Jobs are sent under this lock,
    /// so a retiring thread that finds its queue empty under it can never miss one.
    queue: Arc<Mutex<Option<mpsc::Sender<Job>>>>,
    queued: Arc<AtomicUsize>,
}

impl std::fmt::Debug for TerminalWriter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TerminalWriter")
            .field("queued", &self.queued.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

/// A queued write. [`Self::wait`] reads its outcome; a write made with `cancel_on_drop` that
/// has not started is dropped with it.
pub(crate) struct PendingWrite {
    done: oneshot::Receiver<Result<(), TerminalError>>,
    cancel: CancellationToken,
    cancel_on_drop: bool,
}

impl PendingWrite {
    /// Drops the write unless the writer has already started it.
    pub(crate) fn cancel(&self) {
        self.cancel.cancel();
    }

    /// The write's outcome: written, failed, or cancelled before it started.
    pub(crate) async fn wait(&mut self) -> Result<(), TerminalError> {
        (&mut self.done).await.unwrap_or_else(|_| {
            Err(TerminalError::Io(
                "the terminal's input writer stopped".to_owned(),
            ))
        })
    }
}

impl Drop for PendingWrite {
    fn drop(&mut self) {
        if self.cancel_on_drop {
            self.cancel.cancel();
        }
    }
}

impl TerminalWriter {
    /// Queues `data` for `process` without waiting. Refused when the queue would pass
    /// [`MOST_QUEUED_INPUT_BYTES`], or when no writer thread can start.
    pub(crate) fn enqueue(
        &self,
        process: &Arc<dyn PtyProcess>,
        data: &str,
        cancel_on_drop: bool,
    ) -> Result<PendingWrite, TerminalError> {
        let length = data.len();
        let mut queue = self
            .queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.queued.load(Ordering::Acquire) + length > MOST_QUEUED_INPUT_BYTES {
            return Err(TerminalError::Io(
                "the terminal's program is not reading its input, and its input queue is full"
                    .to_owned(),
            ));
        }
        if queue.is_none() {
            *queue = Some(self.start(Arc::clone(process))?);
        }
        let (done, receiver) = oneshot::channel();
        let cancel = CancellationToken::new();
        let job = Job {
            data: data.to_owned(),
            cancel: cancel.clone(),
            done,
        };
        self.queued.fetch_add(length, Ordering::AcqRel);
        if let Err(mpsc::SendError(job)) = queue.as_ref().expect("a writer thread").send(job) {
            // The thread is gone (a panic in the PTY): start another for this job.
            let sender = self.start(Arc::clone(process))?;
            let _ = sender.send(job);
            *queue = Some(sender);
        }
        Ok(PendingWrite {
            done: receiver,
            cancel,
            cancel_on_drop,
        })
    }

    fn start(&self, process: Arc<dyn PtyProcess>) -> Result<mpsc::Sender<Job>, TerminalError> {
        let (sender, receiver) = mpsc::channel::<Job>();
        let queue = Arc::clone(&self.queue);
        let queued = Arc::clone(&self.queued);
        std::thread::Builder::new()
            .name("terminal-input".to_owned())
            .spawn(move || drain(&*process, &receiver, &queue, &queued))
            .map_err(|error| TerminalError::Io(format!("no terminal input writer: {error}")))?;
        Ok(sender)
    }
}

fn drain(
    process: &dyn PtyProcess,
    receiver: &mpsc::Receiver<Job>,
    queue: &Mutex<Option<mpsc::Sender<Job>>>,
    queued: &AtomicUsize,
) {
    loop {
        let job = match receiver.recv_timeout(IDLE) {
            Ok(job) => job,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let mut queue = queue
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                match receiver.try_recv() {
                    Ok(job) => job,
                    Err(_) => {
                        // Retire: the next write starts a new thread.
                        *queue = None;
                        return;
                    }
                }
            }
        };
        let result = if job.cancel.is_cancelled() {
            Err(TerminalError::PublicationCancelled)
        } else {
            process.write(&job.data).map_err(TerminalError::Io)
        };
        queued.fetch_sub(job.data.len(), Ordering::AcqRel);
        let _ = job.done.send(result);
    }
}
