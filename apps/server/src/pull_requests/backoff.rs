//! The host-wide 429 ladder. Merge request pollers, pipelines pollers and
//! unary pipelines reads of one host share one deadline, because provider
//! limits are per user: a 429 from any of them holds every other back.

use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use tokio::time::Instant;

/// Fixed 429 backoff ladder: 60s, then 120s, then 300s, holding at 300s for
/// any further consecutive 429. A success resets the ladder to its first
/// step for the next 429.
pub(crate) const BACKOFF_STEPS: [Duration; 3] = [
    Duration::from_secs(60),
    Duration::from_secs(120),
    Duration::from_secs(300),
];

/// The longest pause a provider's own answer (`Retry-After` or a reset time)
/// can impose; a later reset is treated as this.
pub(crate) const PROVIDER_DELAY_CAP: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Copy)]
struct Backoff {
    /// When the latest 429 took a step: a read that started earlier proves
    /// nothing about the limit.
    set_at: Instant,
    until: Instant,
    step: usize,
}

/// Per lowercased host: GitLab and GitHub hosts share one map.
#[derive(Default)]
pub(crate) struct HostBackoff {
    hosts: Mutex<HashMap<String, Backoff>>,
}

impl HostBackoff {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Backoff>> {
        self.hosts.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn backoff_until(&self, host: &str) -> Option<Instant> {
        self.lock()
            .get(&host.to_ascii_lowercase())
            .map(|backoff| backoff.until)
    }

    /// The remaining pause when the host's deadline is still ahead.
    pub(crate) fn remaining(&self, host: &str) -> Option<Duration> {
        let until = self.backoff_until(host)?;
        let now = Instant::now();
        (until > now).then(|| until - now)
    }

    /// Takes the host's next ladder step and returns its delay: the later of
    /// the step and the provider's own answer, capped at one hour.
    pub(crate) fn back_off(&self, host: &str, provider_hint: Option<Duration>) -> Duration {
        let mut hosts = self.lock();
        let now = Instant::now();
        let entry = hosts.entry(host.to_ascii_lowercase()).or_insert(Backoff {
            set_at: now,
            until: now,
            step: 0,
        });
        let step = BACKOFF_STEPS[entry.step.min(BACKOFF_STEPS.len() - 1)];
        let delay = provider_hint.map_or(step, |hint| step.max(hint.min(PROVIDER_DELAY_CAP)));
        entry.set_at = now;
        entry.until = now + delay;
        entry.step = (entry.step + 1).min(BACKOFF_STEPS.len() - 1);
        delay
    }

    /// A successful read that started at `started` clears the host's ladder;
    /// true when it was set. A read that was already in flight when a 429
    /// arrived leaves the deadline and the step alone.
    pub(crate) fn recovered(&self, host: &str, started: Instant) -> bool {
        let mut hosts = self.lock();
        let host = host.to_ascii_lowercase();
        match hosts.get(&host) {
            Some(entry) if entry.set_at <= started => hosts.remove(&host).is_some(),
            _ => false,
        }
    }
}

/// An HTTP status line and headers, as `glab api -i` and `gh api -i` print
/// them before the body.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ResponseHead {
    pub status: Option<u16>,
    pub headers: Vec<(String, String)>,
}

impl ResponseHead {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Splits `-i` output into its head and body. Output without a status line
/// is all body, so a CLI that does not print headers still reads.
pub(crate) fn split_response(output: &[u8]) -> (ResponseHead, &[u8]) {
    if !output.starts_with(b"HTTP/") {
        return (ResponseHead::default(), output);
    }
    let (head, body) = match find_blank_line(output) {
        Some((end, body_start)) => (&output[..end], &output[body_start..]),
        None => (output, &output[output.len()..]),
    };
    let head = String::from_utf8_lossy(head);
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok());
    let headers = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_owned(), value.trim().to_owned()))
        })
        .collect();
    (ResponseHead { status, headers }, body)
}

/// The end of the head and the start of the body: the first `\r\n\r\n` or
/// `\n\n`.
fn find_blank_line(output: &[u8]) -> Option<(usize, usize)> {
    let mut index = 0;
    while index < output.len() {
        if output[index..].starts_with(b"\r\n\r\n") {
            return Some((index, index + 4));
        }
        if output[index..].starts_with(b"\n\n") {
            return Some((index, index + 2));
        }
        index += 1;
    }
    None
}

/// How long the provider asked for: `Retry-After` in seconds, or a reset
/// time in epoch seconds (GitHub `x-ratelimit-reset`, GitLab
/// `RateLimit-Reset`). `None` when the head says nothing usable.
pub(crate) fn provider_delay(head: &ResponseHead, now_epoch_seconds: u64) -> Option<Duration> {
    if let Some(seconds) = head
        .header("retry-after")
        .and_then(|value| value.trim().parse::<u64>().ok())
    {
        return Some(Duration::from_secs(seconds).min(PROVIDER_DELAY_CAP));
    }
    ["x-ratelimit-reset", "ratelimit-reset"]
        .iter()
        .find_map(|name| head.header(name)?.trim().parse::<u64>().ok())
        .map(|reset| {
            Duration::from_secs(reset.saturating_sub(now_epoch_seconds)).min(PROVIDER_DELAY_CAP)
        })
}

/// A refusal that is a rate limit even though its status says otherwise:
/// GitHub answers its primary limit with 403 and `x-ratelimit-remaining: 0`,
/// and its secondary limit with a 403 whose message names it.
pub(crate) fn is_rate_limit(head: &ResponseHead, body: &[u8], stderr: &str) -> bool {
    if head.status == Some(429) {
        return true;
    }
    let remaining_zero = head
        .header("x-ratelimit-remaining")
        .is_some_and(|value| value.trim() == "0");
    let text = format!("{} {}", String::from_utf8_lossy(body), stderr).to_lowercase();
    let secondary = text.contains("secondary rate limit");
    matches!(head.status, Some(403) | None) && (remaining_zero || secondary)
}

pub(crate) fn now_epoch_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn host_backoff_ladder_takes_the_later_of_its_step_and_the_provider_answer() {
        let backoff = HostBackoff::default();
        assert_eq!(backoff.back_off("GitLab.example", None), BACKOFF_STEPS[0]);
        assert!(
            backoff.backoff_until("gitlab.example").is_some(),
            "lowercased"
        );
        // A provider deadline later than the step wins.
        assert_eq!(
            backoff.back_off("gitlab.example", Some(Duration::from_secs(900))),
            Duration::from_secs(900)
        );
        // An earlier one leaves the step (300 s now).
        assert_eq!(
            backoff.back_off("gitlab.example", Some(Duration::from_secs(5))),
            BACKOFF_STEPS[2]
        );
        // Capped at one hour.
        assert_eq!(
            backoff.back_off("gitlab.example", Some(Duration::from_secs(90_000))),
            PROVIDER_DELAY_CAP
        );
        let started = Instant::now();
        assert!(backoff.recovered("gitlab.example", started));
        assert_eq!(backoff.back_off("gitlab.example", None), BACKOFF_STEPS[0]);
    }

    #[tokio::test(start_paused = true)]
    async fn host_backoff_a_read_started_before_the_429_does_not_clear_it() {
        let backoff = HostBackoff::default();
        let started = Instant::now();
        tokio::time::advance(Duration::from_millis(1)).await;
        backoff.back_off("gitlab.example", None);
        assert!(!backoff.recovered("gitlab.example", started));
        assert!(backoff.remaining("gitlab.example").is_some());
        tokio::time::advance(BACKOFF_STEPS[0]).await;
        assert_eq!(backoff.remaining("gitlab.example"), None, "deadline passed");
    }

    #[test]
    fn response_heads_split_from_the_body_and_without_headers_all_is_body() {
        let (head, body) =
            split_response(b"HTTP/2 429 Too Many Requests\r\nRetry-After: 30\r\n\r\n{\"a\":1}");
        assert_eq!(head.status, Some(429));
        assert_eq!(head.header("retry-after"), Some("30"));
        assert_eq!(body, b"{\"a\":1}");
        let (head, body) = split_response(b"HTTP/1.1 200 OK\nX-Total: 4\n\nline one\n\nline two");
        assert_eq!(head.status, Some(200));
        assert_eq!(
            body, b"line one\n\nline two",
            "only the first blank line splits"
        );
        let (head, body) = split_response(b"plain trace text");
        assert_eq!(head, ResponseHead::default());
        assert_eq!(body, b"plain trace text");
    }

    #[test]
    fn provider_delay_reads_retry_after_and_reset_headers() {
        let now = 1_800_000_000;
        let head = |name: &str, value: &str| ResponseHead {
            status: Some(429),
            headers: vec![(name.into(), value.into())],
        };
        assert_eq!(
            provider_delay(&head("Retry-After", "120"), now),
            Some(Duration::from_secs(120))
        );
        assert_eq!(
            provider_delay(&head("x-ratelimit-reset", &(now + 600).to_string()), now),
            Some(Duration::from_secs(600))
        );
        assert_eq!(
            provider_delay(&head("RateLimit-Reset", &(now + 90_000).to_string()), now),
            Some(PROVIDER_DELAY_CAP)
        );
        assert_eq!(provider_delay(&ResponseHead::default(), now), None);
        assert_eq!(provider_delay(&head("Retry-After", "soon"), now), None);
    }

    #[test]
    fn a_github_403_with_no_remaining_requests_is_a_rate_limit() {
        let head = ResponseHead {
            status: Some(403),
            headers: vec![("x-ratelimit-remaining".into(), "0".into())],
        };
        assert!(is_rate_limit(&head, b"{}", ""));
        let forbidden = ResponseHead {
            status: Some(403),
            headers: vec![("x-ratelimit-remaining".into(), "4999".into())],
        };
        assert!(!is_rate_limit(
            &forbidden,
            b"{\"message\":\"Resource not accessible\"}",
            ""
        ));
        assert!(is_rate_limit(
            &ResponseHead {
                status: Some(403),
                headers: vec![]
            },
            b"{\"message\":\"You have exceeded a secondary rate limit.\"}",
            ""
        ));
    }
}
