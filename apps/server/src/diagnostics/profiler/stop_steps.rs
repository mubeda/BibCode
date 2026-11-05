//! Times each step of a server stop (#303), so a slow stop names the step that took the time.
//!
//! A step slower than [`SLOW_STEP`] is logged with `tracing::warn!` at once, and
//! [`StopSteps::emit`] records the slow steps of one stage as a `server.stop` event. The
//! profiler's own teardown is the last step of the quiesce, so steps timed after it, and the
//! join that closes the database, are logged only.

use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// A stop step that takes at least this long is named. A normal stop takes well under a
/// second in total (#303).
pub const SLOW_STEP: Duration = Duration::from_millis(250);

/// One step that took at least [`SLOW_STEP`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlowStep {
    pub step: &'static str,
    pub ms: u64,
}

/// The steps of one stage of a stop, timed from one mark to the next.
#[derive(Debug)]
pub struct StopSteps {
    stage: &'static str,
    started: Instant,
    last: Instant,
    slow: Vec<SlowStep>,
}

impl StopSteps {
    pub fn start(stage: &'static str) -> Self {
        Self::starting_at(stage, Instant::now())
    }

    /// A stage that began at `started`, before the first step's timer could start.
    pub fn starting_at(stage: &'static str, started: Instant) -> Self {
        Self {
            stage,
            started,
            last: started,
            slow: Vec::new(),
        }
    }

    /// Ends `step`, which ran since the previous mark (or the start).
    pub fn mark(&mut self, step: &'static str) {
        let now = Instant::now();
        let took = now.saturating_duration_since(self.last);
        self.last = now;
        self.record(step, took);
    }

    /// Records `step` as having taken `took`, for a step timed elsewhere.
    pub fn record(&mut self, step: &'static str, took: Duration) {
        if took < SLOW_STEP {
            return;
        }
        let ms = u64::try_from(took.as_millis()).unwrap_or(u64::MAX);
        tracing::warn!(stage = self.stage, step, ms, "a server stop step was slow");
        self.slow.push(SlowStep { step, ms });
    }

    pub fn slow_steps(&self) -> &[SlowStep] {
        &self.slow
    }

    /// The `server.stop` payload: the stage, its duration so far and its slow steps.
    pub fn payload(&self) -> Value {
        json!({
            "stage": self.stage,
            "durationMs": u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "slowSteps": self
                .slow
                .iter()
                .map(|slow| json!({ "step": slow.step, "ms": slow.ms }))
                .collect::<Vec<_>>(),
        })
    }

    /// Records a `server.stop` event when a step was slow. Call it before the profiler's
    /// teardown; it does nothing while the profiler is off.
    pub fn emit(&self) {
        if !self.slow.is_empty() {
            super::emit("server.stop", self.payload());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_only_the_steps_that_reach_the_threshold() {
        let mut steps = StopSteps::start("quiesce");
        steps.record("webhooks", Duration::from_millis(3));
        steps.record("orchestration", SLOW_STEP);
        steps.record("profiler", Duration::from_millis(5_300));

        assert_eq!(
            steps.slow_steps(),
            [
                SlowStep {
                    step: "orchestration",
                    ms: 250
                },
                SlowStep {
                    step: "profiler",
                    ms: 5_300
                },
            ]
        );
        let payload = steps.payload();
        assert_eq!(payload["stage"], "quiesce");
        assert_eq!(
            payload["slowSteps"],
            json!([
                { "step": "orchestration", "ms": 250 },
                { "step": "profiler", "ms": 5_300 },
            ])
        );
        assert!(payload["durationMs"].is_u64());
    }

    #[derive(Clone, Default)]
    struct CapturedLog(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for CapturedLog {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("log lock").extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// No production hook slows a stop step cleanly, so the warn path is checked
    /// here with a supplied duration rather than through a real shutdown.
    #[test]
    fn a_record_above_the_threshold_warns_with_stage_step_and_ms() {
        let log = CapturedLog::default();
        let _logging = tracing::subscriber::set_default(
            tracing_subscriber::fmt()
                .with_ansi(false)
                .with_max_level(tracing::Level::WARN)
                .with_writer({
                    let log = log.clone();
                    move || log.clone()
                })
                .finish(),
        );
        let mut steps = StopSteps::start("quiesce");
        steps.record("orchestration", Duration::from_millis(250));

        let log = String::from_utf8(log.0.lock().expect("log lock").clone()).expect("utf8");
        assert!(
            log.contains("a server stop step was slow"),
            "missing warn message:\n{log}"
        );
        assert!(log.contains("stage=\"quiesce\""), "missing stage:\n{log}");
        assert!(
            log.contains("step=\"orchestration\""),
            "missing step:\n{log}"
        );
        assert!(log.contains("ms=250"), "missing ms:\n{log}");
    }

    #[test]
    fn a_mark_times_the_step_since_the_previous_mark() {
        // Backdated rather than slept, so a scheduling pause cannot add a slow step.
        let started = Instant::now() - (SLOW_STEP + Duration::from_millis(20));
        let mut steps = StopSteps::starting_at("join", started);
        steps.mark("slow");

        let slow = steps.slow_steps();
        assert_eq!(slow.len(), 1, "{slow:?}");
        assert_eq!(slow[0].step, "slow");
        assert!(slow[0].ms >= 270, "{slow:?}");
        // The next step is timed from this mark, not from the start.
        assert!(steps.last >= started + SLOW_STEP, "{steps:?}");
    }
}
