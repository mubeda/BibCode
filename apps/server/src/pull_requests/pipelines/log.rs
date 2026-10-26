//! Job logs: byte windows cut at character boundaries, and `LogCache`, the
//! server-memory store of downloaded logs. Log text can carry unmasked
//! secrets, so it is never written to disk or to a log line: it lives here,
//! keyed by the signed-in account, for at most ten idle minutes.
//!
//! `LogCache` follows `ContextCache`'s conventions: one slot and one
//! in-flight download per key, errors never cached, insertion-order
//! eviction, and `clear`/`remove_host` detach slots so an in-flight download
//! cannot repopulate them. It differs where a log differs from a context: a
//! byte cap beside the entry cap, a long idle TTL because a finished log is
//! immutable, and a `HostFences` check on insert.

use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::model::{LogChunk, LogFrom};
use crate::pull_requests::{error::PullRequestsOperationError, snapshot_store::HostFences};

/// One ranged host read: GitLab's own page reads this much at a time.
pub(crate) const RANGE_WINDOW: u64 = 512_000;
/// What a downloaded log serves per answer, newest first.
pub(crate) const FULL_CHUNK: u64 = 1_048_576;
/// A running ranged log is caught up for at most four reads; past this a
/// read that comes back full answers `too_large_live`.
pub(crate) const LIVE_CATCH_UP: u64 = 4 * RANGE_WINDOW;
/// A running log on the full-download path is downloaded again at most this often.
pub(crate) const LIVE_REDOWNLOAD: Duration = Duration::from_secs(15);
/// ... and only while it is smaller than this.
pub(crate) const LIVE_REDOWNLOAD_MAX: usize = 2 * 1024 * 1024;
/// Every follower of one running ranged log shares the last tail read this long.
pub(crate) const TAIL_SHARE: Duration = Duration::from_secs(4);
/// A memory answer needs a successful job read by the same account this recent.
pub(crate) const AUTHORIZATION_WINDOW: Duration = Duration::from_secs(30);
const IDLE_TTL: Duration = Duration::from_secs(10 * 60);
const BYTE_CAP: usize = 64 * 1024 * 1024;
const ENTRY_CAP: usize = 32;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// Leading UTF-8 continuation bytes of a window that starts mid-character
/// (at most three), which belong to the previous character.
pub(crate) fn leading_continuation(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .take(3)
        .take_while(|byte| (**byte & 0b1100_0000) == 0b1000_0000)
        .count()
}

/// The length of `bytes` without a character its end cuts in two: at most
/// three bytes of an unfinished sequence are left for the next window.
pub(crate) fn complete_prefix(bytes: &[u8]) -> usize {
    let len = bytes.len();
    for back in 1..=len.min(4) {
        let byte = bytes[len - back];
        if (byte & 0b1100_0000) == 0b1000_0000 {
            continue;
        }
        let width = match byte {
            0x00..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            // Not a UTF-8 lead byte: nothing to keep whole.
            _ => return len,
        };
        return if back < width { len - back } else { len };
    }
    len
}

/// A window of a log decoded at character boundaries: `offset` and
/// `next_offset` always point at character starts.
pub(crate) fn decode_window(
    start: u64,
    bytes: &[u8],
    skip_partial_start: bool,
) -> (u64, u64, String) {
    let skip = if skip_partial_start {
        leading_continuation(bytes)
    } else {
        0
    };
    let body = &bytes[skip..];
    let keep = complete_prefix(body);
    let offset = start + skip as u64;
    (
        offset,
        offset + keep as u64,
        String::from_utf8_lossy(&body[..keep]).into_owned(),
    )
}

/// A downloaded log: its kept bytes start at absolute offset `base`, which
/// is above zero when the download dropped the head.
#[derive(Clone, Debug)]
pub(crate) struct FullLog {
    pub bytes: Arc<Vec<u8>>,
    pub base: u64,
    /// The job was terminal when this was downloaded: nothing more will come.
    pub complete: bool,
    pub downloaded_at: Instant,
}

impl FullLog {
    pub(crate) fn end(&self) -> u64 {
        self.base + self.bytes.len() as u64
    }

    /// A running log stays fresh for 15 s, or until it finishes once it is
    /// over 2 MiB.
    pub(crate) fn fresh(&self) -> bool {
        self.complete
            || self.bytes.len() >= LIVE_REDOWNLOAD_MAX
            || self.downloaded_at.elapsed() < LIVE_REDOWNLOAD
    }

    /// One answer from the downloaded log, at most `FULL_CHUNK` long.
    pub(crate) fn window(&self, from: LogFrom) -> LogChunk {
        let end = self.end();
        let (start, stop) = match from {
            LogFrom::Tail => (end.saturating_sub(FULL_CHUNK), end),
            LogFrom::Offset { offset } => {
                let start = offset.clamp(self.base, end);
                (start, (start + FULL_CHUNK).min(end))
            }
            LogFrom::Before { offset } => {
                let stop = offset.clamp(self.base, end);
                (stop.saturating_sub(FULL_CHUNK), stop)
            }
        };
        let start = start.max(self.base);
        let slice = &self.bytes[(start - self.base) as usize..(stop - self.base) as usize];
        // Only a computed start can fall inside a character; a client offset
        // came from an earlier `nextOffset`.
        let computed_start = !matches!(from, LogFrom::Offset { .. });
        let (offset, next_offset, text) = decode_window(start, slice, computed_start);
        let first_line = (self.base == 0).then(|| {
            self.bytes[..offset as usize]
                .iter()
                .filter(|byte| **byte == b'\n')
                .count() as u64
        });
        LogChunk {
            text,
            offset,
            next_offset,
            total_bytes: self.complete.then_some(end),
            complete: self.complete && next_offset == end,
            truncated_head: self.base > 0,
            first_line,
        }
    }
}

/// One downloaded log's identity: the account login is part of it, so a
/// different signed-in account never matches another account's copy.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct LogKey {
    pub host: String,
    pub login: String,
    pub project: String,
    pub job: u64,
    pub attempt: Option<u64>,
}

impl LogKey {
    fn job_key(&self) -> JobKey {
        (
            self.host.clone(),
            self.login.clone(),
            self.project.clone(),
            self.job,
        )
    }
}

type JobKey = (String, String, String, u64);

/// What the log path needs to know about a job, from its last read by the
/// same account.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct JobFacts {
    /// Nothing more will run. Until then GitLab answers 404 for a log not yet written.
    pub terminal: bool,
    pub erased: bool,
    /// The archived trace's size, once the job finished.
    pub log_bytes: Option<u64>,
    pub raw_log_url: Option<String>,
}

/// The last tail one running ranged log read, shared by its followers.
#[derive(Clone, Debug)]
pub(crate) struct SharedTail {
    pub offset: u64,
    pub bytes: Arc<Vec<u8>>,
    /// The read filled its window, so more text may follow its end.
    pub full: bool,
    pub read_at: Instant,
}

impl SharedTail {
    /// The answer for a follower at `offset`, while the tail is recent and
    /// covers it.
    pub(crate) fn answer(&self, offset: u64) -> Option<(u64, &[u8])> {
        let end = self.offset + self.bytes.len() as u64;
        // At the end of a full read the log goes on: only the host knows how.
        let covered = offset < end || (offset == end && !self.full);
        (self.read_at.elapsed() < TAIL_SHARE && offset >= self.offset && covered)
            .then(|| (offset, &self.bytes[(offset - self.offset) as usize..]))
    }
}

/// Whether a GitLab host honors `byte_offset`/`byte_limit`, proved once per
/// process by a one-byte probe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RangeSupport {
    Unknown,
    Supported,
    Unsupported,
}

type Slot = Arc<tokio::sync::Mutex<Option<(Instant, FullLog)>>>;
type TailSlot = Arc<tokio::sync::Mutex<Option<SharedTail>>>;

#[derive(Default)]
struct Logs {
    slots: HashMap<LogKey, Slot>,
    order: VecDeque<LogKey>,
    /// Bytes held per key, for the byte cap.
    sizes: HashMap<LogKey, usize>,
}

#[derive(Default)]
pub(crate) struct LogCache {
    logs: Mutex<Logs>,
    tails: Mutex<HashMap<JobKey, TailSlot>>,
    jobs: Mutex<HashMap<JobKey, (Instant, JobFacts)>>,
    ranges: Mutex<HashMap<String, RangeSupport>>,
}

/// Whether a fresh cached copy may answer `get_or_download`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LogReuse {
    /// A running read may answer from a copy that is still growing.
    Fresh,
    /// A finished job. An unfinished copy stops before the job's last lines.
    Complete,
}

impl LogCache {
    /// Rescan and sign-in changes: every account's logs and job reads go.
    /// Range support is a fact about the host and stays.
    pub(crate) fn clear(&self) {
        let mut logs = lock(&self.logs);
        logs.slots.clear();
        logs.order.clear();
        logs.sizes.clear();
        drop(logs);
        lock(&self.tails).clear();
        lock(&self.jobs).clear();
    }

    /// A sign-in failure on one host.
    pub(crate) fn remove_host(&self, host: &str) {
        let host = host.to_ascii_lowercase();
        let mut logs = lock(&self.logs);
        logs.slots.retain(|key, _| key.host != host);
        logs.order.retain(|key| key.host != host);
        logs.sizes.retain(|key, _| key.host != host);
        drop(logs);
        lock(&self.tails).retain(|key, _| key.0 != host);
        lock(&self.jobs).retain(|key, _| key.0 != host);
    }

    pub(crate) fn range_support(&self, host: &str) -> RangeSupport {
        lock(&self.ranges)
            .get(&host.to_ascii_lowercase())
            .copied()
            .unwrap_or(RangeSupport::Unknown)
    }

    pub(crate) fn set_range_support(&self, host: &str, support: RangeSupport) {
        lock(&self.ranges).insert(host.to_ascii_lowercase(), support);
    }

    /// A successful job read by this account, which authorizes memory answers
    /// for the next 30 s.
    pub(crate) fn record_job(&self, key: &LogKey, facts: JobFacts) {
        self.sweep();
        lock(&self.jobs).insert(key.job_key(), (Instant::now(), facts));
    }

    /// Releases what no read may answer from any more, on every use of the
    /// cache rather than only on the same key's next read: logs idle for ten
    /// minutes (and slots a failed download left empty), tails past their
    /// 4 s, and job reads past their 30 s. A slot in use is left alone.
    pub(crate) fn sweep(&self) {
        let mut logs = lock(&self.logs);
        let expired: Vec<LogKey> = logs
            .slots
            .iter()
            .filter(|(_, slot)| {
                slot.try_lock().is_ok_and(|entry| {
                    entry
                        .as_ref()
                        .is_none_or(|(used, _)| used.elapsed() >= IDLE_TTL)
                })
            })
            .map(|(key, _)| key.clone())
            .collect();
        if !expired.is_empty() {
            for key in &expired {
                logs.slots.remove(key);
                logs.sizes.remove(key);
            }
            logs.order.retain(|key| !expired.contains(key));
        }
        drop(logs);
        lock(&self.tails).retain(|_, slot| match slot.try_lock() {
            Ok(tail) => tail
                .as_ref()
                .is_some_and(|tail| tail.read_at.elapsed() < TAIL_SHARE),
            // A follower is reading or answering from it.
            Err(_) => true,
        });
        lock(&self.jobs).retain(|_, (at, _)| at.elapsed() < AUTHORIZATION_WINDOW);
    }

    /// The facts of a job read by this account within the authorization window.
    pub(crate) fn recent_job(&self, key: &LogKey) -> Option<JobFacts> {
        lock(&self.jobs)
            .get(&key.job_key())
            .filter(|(at, _)| at.elapsed() < AUTHORIZATION_WINDOW)
            .map(|(_, facts)| facts.clone())
    }

    fn tail_slot(&self, key: &LogKey) -> TailSlot {
        self.sweep();
        lock(&self.tails).entry(key.job_key()).or_default().clone()
    }

    /// Serializes the followers of one running log: the first reads the
    /// host and keeps the tail; the rest answer from it within 4 s.
    pub(crate) async fn with_tail<T, E>(
        &self,
        key: &LogKey,
        cancellation: &CancellationToken,
        cancelled: impl Fn() -> E,
        read: impl AsyncFnOnce(&mut Option<SharedTail>) -> Result<T, E>,
    ) -> Result<T, E> {
        let slot = self.tail_slot(key);
        let mut tail = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            tail = slot.lock() => tail,
        };
        read(&mut tail).await
    }

    /// A copy downloaded while the job ran is stale once the job is
    /// terminal: its last lines are only on the host. Detaches it, as `clear`
    /// does, so the next read downloads the finished log. A slot whose
    /// download is in flight is left to finish.
    pub(crate) fn forget_unfinished(&self, key: &LogKey) {
        let mut logs = lock(&self.logs);
        let unfinished = logs.slots.get(key).is_some_and(|slot| {
            slot.try_lock()
                .is_ok_and(|entry| entry.as_ref().is_some_and(|(_, log)| !log.complete))
        });
        if unfinished {
            logs.slots.remove(key);
            logs.order.retain(|kept| kept != key);
            logs.sizes.remove(key);
        }
    }

    /// The downloaded log for `key`, while it is fresh.
    pub(crate) fn cached(&self, key: &LogKey) -> Option<FullLog> {
        self.sweep();
        let slot = lock(&self.logs).slots.get(key)?.clone();
        let mut entry = slot.try_lock().ok()?;
        let (used, log) = entry.as_mut()?;
        if used.elapsed() >= IDLE_TTL || !log.fresh() {
            return None;
        }
        *used = Instant::now();
        Some(log.clone())
    }

    /// One download per key at a time: a second caller waits for the first
    /// and takes its answer. A download that started before a logout
    /// (`generation` at or below the host's fence) is answered but not kept.
    /// `reuse` says whether a fresh unfinished copy may answer; a finished
    /// job's read must not, because that copy is missing the job's last lines.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn get_or_download(
        &self,
        key: LogKey,
        fences: &HostFences,
        generation: i64,
        cancellation: &CancellationToken,
        cancelled: impl Fn() -> PullRequestsOperationError,
        reuse: LogReuse,
        download: impl Future<Output = Result<FullLog, PullRequestsOperationError>>,
    ) -> Result<FullLog, PullRequestsOperationError> {
        self.sweep();
        let slot = {
            let mut logs = lock(&self.logs);
            if let Some(slot) = logs.slots.get(&key) {
                slot.clone()
            } else {
                while logs.slots.len() >= ENTRY_CAP {
                    let Some(oldest) = logs.order.pop_front() else {
                        break;
                    };
                    logs.slots.remove(&oldest);
                    logs.sizes.remove(&oldest);
                }
                let slot: Slot = Arc::default();
                logs.order.push_back(key.clone());
                logs.slots.insert(key.clone(), slot.clone());
                slot
            }
        };
        let mut entry = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            entry = slot.lock() => entry,
        };
        if let Some((used, log)) = entry.as_mut()
            && used.elapsed() < IDLE_TTL
            && log.fresh()
            && (reuse == LogReuse::Fresh || log.complete)
        {
            *used = Instant::now();
            return Ok(log.clone());
        }
        let log = download.await?;
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        if fences.blocks(&key.host, generation) {
            return Ok(log);
        }
        *entry = Some((Instant::now(), log.clone()));
        drop(entry);
        self.account(&key, log.bytes.len());
        Ok(log)
    }

    /// Records a kept log's size and evicts the oldest past the byte cap. A
    /// slot detached meanwhile (by `clear`) is not counted.
    fn account(&self, key: &LogKey, size: usize) {
        let mut logs = lock(&self.logs);
        if !logs.slots.contains_key(key) {
            return;
        }
        logs.sizes.insert(key.clone(), size);
        while logs.sizes.values().sum::<usize>() > BYTE_CAP {
            let Some(oldest) = logs.order.pop_front() else {
                break;
            };
            logs.slots.remove(&oldest);
            logs.sizes.remove(&oldest);
        }
    }

    #[cfg(test)]
    pub(crate) fn held_logs(&self) -> usize {
        lock(&self.logs).slots.len()
    }

    #[cfg(test)]
    pub(crate) fn held_tails(&self) -> usize {
        lock(&self.tails).len()
    }

    /// Holds the downloaded log for `job`, if one is cached, until `hold`
    /// finishes. `locked` fires once the slot is held. Test code uses this
    /// to keep `forget_unfinished` from removing a running copy.
    #[cfg(test)]
    pub(crate) async fn hold_job_log_for_test(
        &self,
        job: u64,
        locked: &tokio::sync::Notify,
        hold: impl Future<Output = ()>,
    ) {
        let slot = {
            let logs = lock(&self.logs);
            logs.slots
                .iter()
                .find(|(key, _)| key.job == job)
                .map(|(_, slot)| slot.clone())
        };
        let Some(slot) = slot else {
            panic!("no cached log for job {job}");
        };
        let _guard = slot.lock().await;
        locked.notify_one();
        hold.await;
    }

    /// Makes every recorded job read `by` older.
    #[cfg(all(test, unix))]
    pub(crate) fn age_job_reads(&self, by: Duration) {
        for (at, _) in lock(&self.jobs).values_mut() {
            *at -= by;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full(bytes: &[u8], base: u64, complete: bool) -> FullLog {
        FullLog {
            bytes: Arc::new(bytes.to_vec()),
            base,
            complete,
            downloaded_at: Instant::now(),
        }
    }

    fn key(login: &str, job: u64) -> LogKey {
        LogKey {
            host: "gitlab.example".into(),
            login: login.into(),
            project: "team/repo".into(),
            job,
            attempt: None,
        }
    }

    #[test]
    fn pipelines_log_windows_never_split_two_three_or_four_byte_characters() {
        for character in ["é", "€", "😀"] {
            let bytes = format!("ab{character}cd").into_bytes();
            let width = character.len();
            // A window that ends inside the character leaves it for the next.
            for cut in 3..(2 + width) {
                let (offset, next, text) = decode_window(0, &bytes[..cut], false);
                assert_eq!(
                    (offset, next, text.as_str()),
                    (0, 2, "ab"),
                    "{character} {cut}"
                );
                // The next window starts where this one ended, on the character.
                let (offset, _, text) = decode_window(next, &bytes[next as usize..], false);
                assert_eq!(offset, 2);
                assert!(text.starts_with(character));
            }
            // A computed start inside the character skips to the next one.
            let (offset, _, text) = decode_window(3, &bytes[3..], true);
            assert_eq!(offset, 2 + width as u64, "{character}");
            assert_eq!(text, "cd");
        }
    }

    #[test]
    fn pipelines_full_log_tail_before_and_offset_windows_carry_line_numbers() {
        let mut text = String::new();
        for line in 0..200_000 {
            text.push_str(&format!("line {line}\n"));
        }
        let log = full(text.as_bytes(), 0, true);
        let tail = log.window(LogFrom::Tail);
        assert_eq!(tail.next_offset, log.end());
        assert!(tail.complete);
        assert_eq!(tail.total_bytes, Some(log.end()));
        assert!(tail.offset > 0 && tail.offset + FULL_CHUNK >= log.end());
        let prefix_lines = text.as_bytes()[..tail.offset as usize]
            .iter()
            .filter(|b| **b == b'\n')
            .count() as u64;
        assert_eq!(tail.first_line, Some(prefix_lines));
        let earlier = log.window(LogFrom::Before {
            offset: tail.offset,
        });
        assert_eq!(earlier.next_offset, tail.offset);
        assert!(!earlier.complete);
        let start = log.window(LogFrom::Offset { offset: 0 });
        assert_eq!((start.offset, start.first_line), (0, Some(0)));
        assert!(start.text.starts_with("line 0\nline 1\n"));
    }

    #[test]
    fn pipelines_a_log_with_a_dropped_head_has_no_line_numbers_and_says_so() {
        let log = full(b"tail of a long log\n", 40_000_000, true);
        let chunk = log.window(LogFrom::Tail);
        assert_eq!(chunk.offset, 40_000_000);
        assert!(chunk.truncated_head);
        assert_eq!(chunk.first_line, None);
        let before = log.window(LogFrom::Before { offset: 40_000_000 });
        assert_eq!((before.offset, before.text.as_str()), (40_000_000, ""));
    }

    #[test]
    fn pipelines_a_running_log_stays_fresh_for_15s_or_once_it_is_over_2_mib() {
        let mut log = full(b"x", 0, false);
        assert!(log.fresh());
        log.downloaded_at -= LIVE_REDOWNLOAD;
        assert!(!log.fresh());
        log.bytes = Arc::new(vec![b'x'; LIVE_REDOWNLOAD_MAX]);
        assert!(log.fresh(), "live updates pause for logs over 2 MB");
        assert!(full(b"x", 0, true).fresh());
    }

    #[tokio::test]
    async fn pipelines_two_concurrent_opens_of_one_log_run_one_download() {
        let cache = LogCache::default();
        let fences = HostFences::default();
        let c = CancellationToken::new();
        let downloads = std::sync::atomic::AtomicUsize::new(0);
        let started = tokio::sync::Notify::new();
        let release = tokio::sync::Notify::new();
        let generation = crate::pull_requests::snapshot_store::next_generation();
        let first = cache.get_or_download(
            key("ana", 1),
            &fences,
            generation,
            &c,
            || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
            LogReuse::Fresh,
            async {
                downloads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                started.notify_one();
                release.notified().await;
                Ok(full(b"log", 0, true))
            },
        );
        let second = async {
            started.notified().await;
            release.notify_one();
            cache
                .get_or_download(
                    key("ana", 1),
                    &fences,
                    generation,
                    &c,
                    || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
                    LogReuse::Fresh,
                    async {
                        downloads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        Ok(full(b"other", 0, true))
                    },
                )
                .await
        };
        let (a, b) = tokio::join!(first, second);
        assert_eq!(a.unwrap().bytes.as_slice(), b"log");
        assert_eq!(b.unwrap().bytes.as_slice(), b"log");
        assert_eq!(downloads.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(cache.cached(&key("ana", 1)).is_some());
        assert!(
            cache.cached(&key("bo", 1)).is_none(),
            "another account never matches"
        );
    }

    #[tokio::test]
    async fn pipelines_a_finished_read_replaces_a_cached_unfinished_log() {
        let cache = LogCache::default();
        let fences = HostFences::default();
        let c = CancellationToken::new();
        let generation = crate::pull_requests::snapshot_store::next_generation();
        cache
            .get_or_download(
                key("ana", 1),
                &fences,
                generation,
                &c,
                || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
                LogReuse::Fresh,
                async { Ok(full(b"running\n", 0, false)) },
            )
            .await
            .unwrap();
        let downloads = std::sync::atomic::AtomicUsize::new(0);
        let log = cache
            .get_or_download(
                key("ana", 1),
                &fences,
                generation,
                &c,
                || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
                LogReuse::Complete,
                async {
                    downloads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(full(b"running\nJob succeeded\n", 0, true))
                },
            )
            .await
            .unwrap();
        assert_eq!(downloads.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(log.complete);
        assert!(log.bytes.ends_with(b"Job succeeded\n"));
        let again = cache
            .get_or_download(
                key("ana", 1),
                &fences,
                generation,
                &c,
                || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
                LogReuse::Complete,
                async {
                    downloads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(full(b"other", 0, true))
                },
            )
            .await
            .unwrap();
        assert_eq!(downloads.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(again.bytes.as_slice(), b"running\nJob succeeded\n");
    }

    #[tokio::test]
    async fn pipelines_a_cleared_slot_is_not_repopulated_by_an_inflight_download() {
        let cache = LogCache::default();
        let fences = HostFences::default();
        let c = CancellationToken::new();
        let started = tokio::sync::Notify::new();
        let release = tokio::sync::Notify::new();
        let generation = crate::pull_requests::snapshot_store::next_generation();
        let download = cache.get_or_download(
            key("ana", 1),
            &fences,
            generation,
            &c,
            || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
            LogReuse::Fresh,
            async {
                started.notify_one();
                release.notified().await;
                Ok(full(b"log", 0, true))
            },
        );
        let rescan = async {
            started.notified().await;
            cache.clear();
            release.notify_one();
        };
        let (result, ()) = tokio::join!(download, rescan);
        assert!(result.is_ok(), "the caller still gets its answer");
        assert!(cache.cached(&key("ana", 1)).is_none());
        assert_eq!(cache.held_logs(), 0);

        // A download that started before a logout is answered but not kept.
        let generation = crate::pull_requests::snapshot_store::next_generation();
        fences.raise("gitlab.example");
        cache
            .get_or_download(
                key("ana", 2),
                &fences,
                generation,
                &c,
                || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
                LogReuse::Fresh,
                async { Ok(full(b"log", 0, true)) },
            )
            .await
            .unwrap();
        assert!(cache.cached(&key("ana", 2)).is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_log_cache_evicts_by_size_and_idle_time_and_clears_a_host() {
        let cache = LogCache::default();
        let fences = HostFences::default();
        let c = CancellationToken::new();
        let big = vec![b'x'; 20 * 1024 * 1024];
        for job in 1..=4 {
            let bytes = big.clone();
            cache
                .get_or_download(
                    key("ana", job),
                    &fences,
                    crate::pull_requests::snapshot_store::next_generation(),
                    &c,
                    || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
                    LogReuse::Fresh,
                    async move { Ok(full(&bytes, 0, true)) },
                )
                .await
                .unwrap();
        }
        // 80 MiB asked for, 64 MiB kept: the oldest went first.
        assert!(cache.cached(&key("ana", 1)).is_none());
        assert!(cache.cached(&key("ana", 4)).is_some());
        tokio::time::advance(IDLE_TTL).await;
        assert!(cache.cached(&key("ana", 4)).is_none(), "ten idle minutes");

        cache
            .get_or_download(
                key("ana", 5),
                &fences,
                crate::pull_requests::snapshot_store::next_generation(),
                &c,
                || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
                LogReuse::Fresh,
                async { Ok(full(b"log", 0, true)) },
            )
            .await
            .unwrap();
        let other_host = LogKey {
            host: "other.example".into(),
            ..key("ana", 6)
        };
        cache
            .get_or_download(
                other_host.clone(),
                &fences,
                crate::pull_requests::snapshot_store::next_generation(),
                &c,
                || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
                LogReuse::Fresh,
                async { Ok(full(b"log", 0, true)) },
            )
            .await
            .unwrap();
        cache.record_job(&key("ana", 5), facts());
        cache.remove_host("GitLab.Example");
        assert!(cache.cached(&key("ana", 5)).is_none());
        assert!(cache.recent_job(&key("ana", 5)).is_none());
        assert!(cache.cached(&other_host).is_some());
    }

    fn facts() -> JobFacts {
        JobFacts {
            terminal: true,
            erased: false,
            log_bytes: Some(3),
            raw_log_url: None,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_job_reads_authorize_memory_answers_for_30s() {
        let cache = LogCache::default();
        cache.record_job(&key("ana", 1), facts());
        assert_eq!(cache.recent_job(&key("ana", 1)), Some(facts()));
        assert_eq!(cache.recent_job(&key("bo", 1)), None);
        tokio::time::advance(AUTHORIZATION_WINDOW).await;
        assert_eq!(cache.recent_job(&key("ana", 1)), None);
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_a_shared_tail_answers_followers_inside_it_for_4s() {
        let mut tail = SharedTail {
            offset: 100,
            bytes: Arc::new(b"abcdef".to_vec()),
            full: false,
            read_at: Instant::now(),
        };
        assert_eq!(tail.answer(102), Some((102, &b"cdef"[..])));
        assert_eq!(tail.answer(106), Some((106, &b""[..])));
        assert_eq!(tail.answer(99), None);
        assert_eq!(tail.answer(107), None);
        tail.full = true;
        assert_eq!(tail.answer(106), None, "a full read's end is not the log's");
        assert_eq!(tail.answer(105), Some((105, &b"f"[..])));
        tokio::time::advance(TAIL_SHARE).await;
        assert_eq!(tail.answer(102), None);
    }

    async fn download(cache: &LogCache, key: LogKey, bytes: &[u8]) {
        let log = full(bytes, 0, true);
        cache
            .get_or_download(
                key,
                &HostFences::default(),
                crate::pull_requests::snapshot_store::next_generation(),
                &CancellationToken::new(),
                || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
                LogReuse::Fresh,
                async move { Ok(log) },
            )
            .await
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_logs_idle_for_ten_minutes_go_on_any_later_read_not_only_their_own() {
        let cache = LogCache::default();
        download(&cache, key("ana", 1), b"private text").await;
        tokio::time::advance(IDLE_TTL).await;
        // Another job's log is read: the idle one is released with it.
        download(&cache, key("ana", 2), b"other").await;
        assert_eq!(cache.held_logs(), 1);
        tokio::time::advance(IDLE_TTL).await;
        cache.record_job(&key("ana", 3), facts());
        assert_eq!(cache.held_logs(), 0, "a job read releases them too");
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_shared_tails_are_released_once_their_4s_have_passed() {
        let cache = LogCache::default();
        let c = CancellationToken::new();
        for job in 1..=200 {
            cache
                .with_tail(
                    &key("ana", job),
                    &c,
                    || (),
                    async |tail: &mut Option<SharedTail>| {
                        *tail = Some(SharedTail {
                            offset: 0,
                            bytes: Arc::new(vec![b'x'; 1024]),
                            full: false,
                            read_at: Instant::now(),
                        });
                        Ok::<(), ()>(())
                    },
                )
                .await
                .unwrap();
        }
        assert_eq!(cache.held_tails(), 200, "each follower window is shared");
        tokio::time::advance(TAIL_SHARE).await;
        cache
            .with_tail(
                &key("ana", 201),
                &c,
                || (),
                async |_: &mut Option<SharedTail>| Ok::<(), ()>(()),
            )
            .await
            .unwrap();
        assert_eq!(cache.held_tails(), 1, "only the job just followed");
    }
}
