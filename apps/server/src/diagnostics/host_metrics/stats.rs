//! Statistics since server start and the chart tiers (R69, D28). Sizes are fixed or capped, so
//! nothing grows with uptime.

use std::{collections::VecDeque, time::Duration};

pub const RECENT_WINDOW: Duration = Duration::from_secs(15 * 60);
pub const RECENT_MAX_POINTS: usize = 900;
pub const MINUTE_TIER_BUCKETS: usize = 1_440;
pub const OLDEST_TIER_MAX_BUCKETS: usize = 20_000;
const MINUTE_S: u32 = 60;
const OLDEST_WIDTH_S: u32 = 15 * 60;
const BINS: usize = 101;
/// A reading without a weight still counts, a little.
const MIN_WEIGHT_S: f64 = 0.001;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeasureStatistics {
    pub current: f64,
    pub minimum: f64,
    pub maximum: f64,
    pub average: f64,
    pub p95: f64,
}

/// Current, minimum, maximum, a time-weighted average and a p95 from 101 one-point bins.
#[derive(Clone, Debug)]
pub(crate) struct RunningStatistic {
    /// Bin `i` holds the weight of readings in `[i, i + 1)`; bin 100 holds 100.
    bins: [f64; BINS],
    total_weight: f64,
    weighted_sum: f64,
    current: Option<f64>,
    minimum: f64,
    maximum: f64,
}

impl Default for RunningStatistic {
    fn default() -> Self {
        Self {
            bins: [0.0; BINS],
            total_weight: 0.0,
            weighted_sum: 0.0,
            current: None,
            minimum: f64::INFINITY,
            maximum: f64::NEG_INFINITY,
        }
    }
}

pub(super) fn clamp_percent(percent: f64) -> f64 {
    if percent.is_nan() {
        0.0
    } else {
        percent.clamp(0.0, 100.0)
    }
}

fn weight_seconds(weight: Duration) -> f64 {
    weight.as_secs_f64().max(MIN_WEIGHT_S)
}

impl RunningStatistic {
    pub(crate) fn record(&mut self, percent: f64, weight: Duration) {
        let percent = clamp_percent(percent);
        let weight = weight_seconds(weight);
        // Truncation is the bin's lower edge; the value is already within 0..=100.
        let bin = (percent.floor() as usize).min(BINS - 1);
        self.bins[bin] += weight;
        self.total_weight += weight;
        self.weighted_sum += percent * weight;
        self.current = Some(percent);
        self.minimum = self.minimum.min(percent);
        self.maximum = self.maximum.max(percent);
    }

    pub(crate) fn summary(&self) -> Option<MeasureStatistics> {
        let current = self.current?;
        let threshold = self.total_weight * 0.95;
        let mut reached = 0.0;
        let mut p95 = 100.0;
        for (bin, weight) in self.bins.iter().enumerate() {
            reached += weight;
            // The tolerance keeps a float sum that lands just under the threshold in its bin.
            if reached >= threshold - self.total_weight * 1e-12 {
                p95 = bin as f64;
                break;
            }
        }
        Some(MeasureStatistics {
            current,
            minimum: self.minimum,
            maximum: self.maximum,
            average: self.weighted_sum / self.total_weight,
            p95,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChartPoint {
    pub sampled_at_ms: i128,
    pub cpu_percent: f64,
    pub memory_percent: f64,
}

/// One bar of the uptime chart, as the stream sends it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChartBucket {
    pub started_at_ms: i128,
    pub duration_ms: u64,
    pub cpu_average: f64,
    pub cpu_peak: f64,
    pub memory_average: f64,
    pub memory_peak: f64,
}

/// A closed bucket, stored compactly: offsets in seconds from the first reading. `weight_s` is
/// the time its readings observed, which a suspend inside `width_s` does not add to.
#[derive(Clone, Copy, Debug, PartialEq)]
struct StoredBucket {
    start_s: u32,
    width_s: u32,
    weight_s: f32,
    cpu_average: f32,
    cpu_peak: f32,
    memory_average: f32,
    memory_peak: f32,
}

impl StoredBucket {
    fn end_s(&self) -> u32 {
        self.start_s.saturating_add(self.width_s)
    }

    /// Merges consecutive buckets, weighting each by the time it observed.
    fn merge(buckets: &[StoredBucket]) -> Option<StoredBucket> {
        let first = buckets.first()?;
        let mut open = OpenBucket::starting_at(first.start_s);
        for bucket in buckets {
            open.add_bucket(bucket);
        }
        Some(open.close())
    }
}

/// The open bucket of a tier: the only place that keeps sums and weights.
#[derive(Clone, Copy, Debug)]
struct OpenBucket {
    start_s: u32,
    end_s: u32,
    weight: f64,
    cpu_sum: f64,
    memory_sum: f64,
    cpu_peak: f64,
    memory_peak: f64,
}

impl OpenBucket {
    fn starting_at(start_s: u32) -> Self {
        Self {
            start_s,
            end_s: start_s,
            weight: 0.0,
            cpu_sum: 0.0,
            memory_sum: 0.0,
            cpu_peak: 0.0,
            memory_peak: 0.0,
        }
    }

    fn add(&mut self, cpu: f64, memory: f64, weight: f64, cpu_peak: f64, memory_peak: f64) {
        self.weight += weight;
        self.cpu_sum += cpu * weight;
        self.memory_sum += memory * weight;
        self.cpu_peak = self.cpu_peak.max(cpu_peak);
        self.memory_peak = self.memory_peak.max(memory_peak);
    }

    fn add_bucket(&mut self, bucket: &StoredBucket) {
        self.add(
            f64::from(bucket.cpu_average),
            f64::from(bucket.memory_average),
            f64::from(bucket.weight_s),
            f64::from(bucket.cpu_peak),
            f64::from(bucket.memory_peak),
        );
        self.end_s = self.end_s.max(bucket.end_s());
    }

    fn close(&self) -> StoredBucket {
        let weight = self.weight.max(MIN_WEIGHT_S);
        // An average never shows above its peak, whatever the float rounding.
        let cpu_peak = self.cpu_peak as f32;
        let memory_peak = self.memory_peak as f32;
        StoredBucket {
            start_s: self.start_s,
            width_s: self.end_s.saturating_sub(self.start_s),
            weight_s: weight as f32,
            cpu_average: ((self.cpu_sum / weight) as f32).min(cpu_peak),
            cpu_peak,
            memory_average: ((self.memory_sum / weight) as f32).min(memory_peak),
            memory_peak,
        }
    }
}

/// Chart history in three tiers: the last 15 minutes of readings, 1-minute buckets for the last
/// 1,440 minutes, and 15-minute buckets beyond, whose pairs merge when the tier is full.
#[derive(Debug)]
pub(crate) struct ChartHistory {
    first_ms: Option<i128>,
    recent: VecDeque<ChartPoint>,
    open_minute: Option<(u32, OpenBucket)>,
    minutes: VecDeque<StoredBucket>,
    oldest: Vec<StoredBucket>,
    open_oldest: Option<OpenBucket>,
    oldest_width_s: u32,
    oldest_capacity: usize,
    #[cfg(test)]
    compactions: u64,
    revision: u64,
}

impl ChartHistory {
    pub(crate) fn new() -> Self {
        Self::with_capacity(OLDEST_TIER_MAX_BUCKETS)
    }

    #[cfg(test)]
    pub(crate) fn with_oldest_capacity(capacity: usize) -> Self {
        Self::with_capacity(capacity)
    }

    fn with_capacity(oldest_capacity: usize) -> Self {
        Self {
            first_ms: None,
            recent: VecDeque::new(),
            open_minute: None,
            minutes: VecDeque::new(),
            oldest: Vec::new(),
            open_oldest: None,
            oldest_width_s: OLDEST_WIDTH_S,
            oldest_capacity: oldest_capacity.max(2),
            #[cfg(test)]
            compactions: 0,
            revision: 0,
        }
    }

    pub(crate) fn record(&mut self, point: ChartPoint, weight: Duration) {
        let point = ChartPoint {
            sampled_at_ms: point.sampled_at_ms,
            cpu_percent: clamp_percent(point.cpu_percent),
            memory_percent: clamp_percent(point.memory_percent),
        };
        let first_ms = *self.first_ms.get_or_insert(point.sampled_at_ms);
        self.push_recent(point);

        let offset_s =
            u32::try_from(((point.sampled_at_ms - first_ms) / 1_000).max(0)).unwrap_or(u32::MAX);
        let minute = offset_s / MINUTE_S;
        if let Some((open_index, open)) = self.open_minute
            && minute > open_index
        {
            self.close_minute(open);
            self.open_minute = None;
        }
        let (_, open) = self.open_minute.get_or_insert_with(|| {
            let start_s = minute * MINUTE_S;
            let mut open = OpenBucket::starting_at(start_s);
            open.end_s = start_s.saturating_add(MINUTE_S);
            (minute, open)
        });
        open.add(
            point.cpu_percent,
            point.memory_percent,
            weight_seconds(weight),
            point.cpu_percent,
            point.memory_percent,
        );
    }

    fn push_recent(&mut self, point: ChartPoint) {
        self.recent.push_back(point);
        let oldest_kept = point.sampled_at_ms - RECENT_WINDOW.as_millis() as i128;
        while self.recent.len() > RECENT_MAX_POINTS
            || self
                .recent
                .front()
                .is_some_and(|front| front.sampled_at_ms < oldest_kept)
        {
            self.recent.pop_front();
        }
    }

    fn close_minute(&mut self, open: OpenBucket) {
        self.minutes.push_back(open.close());
        self.revision += 1;
        while self.minutes.len() > MINUTE_TIER_BUCKETS {
            if let Some(bucket) = self.minutes.pop_front() {
                self.feed_oldest(bucket);
            }
        }
    }

    fn feed_oldest(&mut self, bucket: StoredBucket) {
        let open = self
            .open_oldest
            .get_or_insert_with(|| OpenBucket::starting_at(bucket.start_s));
        open.add_bucket(&bucket);
        if open.end_s.saturating_sub(open.start_s) < self.oldest_width_s {
            return;
        }
        let closed = open.close();
        self.open_oldest = None;
        if self.oldest.len() < self.oldest_capacity {
            self.oldest.push(closed);
            return;
        }
        self.oldest = self
            .oldest
            .chunks(2)
            .filter_map(StoredBucket::merge)
            .collect();
        self.oldest_width_s = self.oldest_width_s.saturating_mul(2);
        #[cfg(test)]
        {
            self.compactions += 1;
        }
        // The bucket that just closed at the old width keeps filling at the new one.
        let mut reopened = OpenBucket::starting_at(closed.start_s);
        reopened.add_bucket(&closed);
        self.open_oldest = Some(reopened);
    }

    /// Rises whenever `uptime` would change.
    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }

    pub(crate) fn recent(&self) -> Vec<ChartPoint> {
        self.recent.iter().copied().collect()
    }

    /// The closed history at most `max_bars` wide; the open minute is not in it yet.
    pub(crate) fn uptime(&self, max_bars: usize) -> Vec<ChartBucket> {
        let closed = self
            .oldest
            .iter()
            .copied()
            .chain(self.open_oldest.map(|open| open.close()))
            .chain(self.minutes.iter().copied())
            .collect::<Vec<_>>();
        if closed.is_empty() || max_bars == 0 {
            return Vec::new();
        }
        let per_bar = closed.len().div_ceil(max_bars);
        closed
            .chunks(per_bar)
            .filter_map(StoredBucket::merge)
            .map(|bucket| self.output(bucket))
            .collect()
    }

    fn output(&self, bucket: StoredBucket) -> ChartBucket {
        let first_ms = self.first_ms.unwrap_or_default();
        ChartBucket {
            started_at_ms: first_ms + i128::from(bucket.start_s) * 1_000,
            duration_ms: u64::from(bucket.width_s) * 1_000,
            cpu_average: f64::from(bucket.cpu_average),
            cpu_peak: f64::from(bucket.cpu_peak),
            memory_average: f64::from(bucket.memory_average),
            memory_peak: f64::from(bucket.memory_peak),
        }
    }

    #[cfg(test)]
    fn minute_buckets(&self) -> usize {
        self.minutes.len()
    }

    #[cfg(test)]
    fn oldest_stored(&self) -> usize {
        self.oldest.len()
    }

    #[cfg(test)]
    fn oldest_compactions(&self) -> u64 {
        self.compactions
    }

    #[cfg(test)]
    fn oldest_buckets(&self) -> Vec<ChartBucket> {
        self.oldest
            .iter()
            .copied()
            .chain(self.open_oldest.map(|open| open.close()))
            .map(|bucket| self.output(bucket))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);
    const SECOND: Duration = Duration::from_secs(1);

    fn point(at_s: i128, cpu: f64) -> ChartPoint {
        ChartPoint {
            sampled_at_ms: at_s * 1_000,
            cpu_percent: cpu,
            memory_percent: cpu / 2.0,
        }
    }

    #[test]
    fn known_values_give_exact_statistics() {
        let mut statistic = RunningStatistic::default();
        for value in [10.0, 20.0, 30.0, 40.0, 90.0] {
            statistic.record(value, MINUTE);
        }

        let summary = statistic.summary().expect("statistics after readings");

        assert_eq!(summary.current, 90.0);
        assert_eq!(summary.minimum, 10.0);
        assert_eq!(summary.maximum, 90.0);
        assert!((summary.average - 38.0).abs() < 1e-9, "{summary:?}");
        assert_eq!(summary.p95, 90.0);
    }

    #[test]
    fn a_watched_minute_does_not_outweigh_an_unwatched_hour() {
        let mut statistic = RunningStatistic::default();
        for _ in 0..60 {
            statistic.record(10.0, MINUTE);
        }
        for _ in 0..60 {
            statistic.record(90.0, SECOND);
        }

        let summary = statistic.summary().expect("statistics after readings");

        assert!(
            (11.3..11.4).contains(&summary.average),
            "average {}",
            summary.average
        );
        assert_eq!(summary.p95, 10.0);
    }

    #[test]
    fn values_outside_0_to_100_are_clamped_into_the_end_bins() {
        let mut statistic = RunningStatistic::default();
        statistic.record(-5.0, MINUTE);
        statistic.record(250.0, MINUTE);

        let summary = statistic.summary().expect("statistics after readings");

        assert_eq!(summary.minimum, 0.0);
        assert_eq!(summary.maximum, 100.0);
        assert_eq!(summary.current, 100.0);
        assert_eq!(summary.p95, 100.0);
        assert_eq!(statistic.bins[0], 60.0);
        assert_eq!(statistic.bins[100], 60.0);
    }

    #[test]
    fn no_reading_has_no_statistics() {
        assert!(RunningStatistic::default().summary().is_none());
    }

    #[test]
    fn a_week_of_background_readings_stays_bounded() {
        let mut history = ChartHistory::new();
        let first_s = 1_700_000_000;
        for index in 0..10_080 {
            let cpu = f64::from(index % 100);
            history.record(point(first_s + i128::from(index) * 60, cpu), MINUTE);
        }

        assert!(history.recent().len() <= 900);
        assert!(history.minute_buckets() <= MINUTE_TIER_BUCKETS);
        let uptime = history.uptime(240);
        assert!(uptime.len() <= 240, "{} bars", uptime.len());
        assert_eq!(uptime[0].started_at_ms, first_s * 1_000);
        for bucket in &uptime {
            assert!(bucket.cpu_peak >= bucket.cpu_average, "{bucket:?}");
            assert!(bucket.memory_peak >= bucket.memory_average, "{bucket:?}");
        }
    }

    #[test]
    fn the_oldest_tier_compacts_and_keeps_its_meaning() {
        let mut history = ChartHistory::with_oldest_capacity(8);
        let first_s = 1_700_000_000;
        let mut at_s = first_s;
        let mut feed = |history: &mut ChartHistory, cpu: f64| {
            history.record(point(at_s, cpu), MINUTE);
            at_s += 60;
        };
        // 64 fifteen-minute buckets of 10 percent, then 64 of 30 with one reading of 95.
        for _ in 0..64 * 15 {
            feed(&mut history, 10.0);
        }
        for index in 0..64 * 15 {
            feed(&mut history, if index == 500 { 95.0 } else { 30.0 });
        }
        // A day more pushes all of them out of the minute tier into the oldest tier.
        let mut revisions = vec![history.revision()];
        let mut compactions = history.oldest_compactions();
        for _ in 0..MINUTE_TIER_BUCKETS + 1 {
            feed(&mut history, 50.0);
            if history.oldest_compactions() != compactions {
                compactions = history.oldest_compactions();
                revisions.push(history.revision());
            }
        }
        let compactions_after_day = history.oldest_compactions();

        let oldest = history.oldest_buckets();
        assert!(
            history.oldest_stored() <= 8,
            "{} stored",
            history.oldest_stored()
        );
        assert!(
            compactions_after_day >= 3,
            "{compactions_after_day} compactions"
        );
        assert_eq!(oldest[0].started_at_ms, first_s * 1_000);
        let weight: f64 = oldest.iter().map(|bucket| bucket.duration_ms as f64).sum();
        let average = oldest
            .iter()
            .map(|bucket| bucket.cpu_average * bucket.duration_ms as f64)
            .sum::<f64>()
            / weight;
        assert!((average - 20.0).abs() < 0.1, "average {average}");
        let peak = oldest
            .iter()
            .map(|bucket| bucket.cpu_peak)
            .fold(0.0, f64::max);
        assert_eq!(peak, 95.0);
        assert!(
            revisions.windows(2).all(|pair| pair[1] > pair[0]),
            "{revisions:?}"
        );
    }

    /// #292 review: an oldest-tier bucket that spans a suspend keeps the weight of the time it
    /// observed, so merging it again (compaction or the 240-bar chart) never counts the gap.
    #[test]
    fn a_bucket_spanning_a_sleep_gap_weighs_only_its_observed_time() {
        let mut history = ChartHistory::new();
        // Five minutes at 90 percent, three hours asleep, then a day and a half at 10 percent.
        for minute in 0..5 {
            history.record(point(minute * 60, 90.0), MINUTE);
        }
        let awake = 200;
        let minutes_after = 1_440 + 120;
        for minute in awake..awake + minutes_after {
            history.record(point(minute * 60, 10.0), MINUTE);
        }

        let all = history.uptime(1);
        assert_eq!(all.len(), 1);
        // Closed minutes: the five at 90 and all but the open one at 10.
        let closed_after = (minutes_after - 1) as f64;
        let expected = (90.0 * 5.0 + 10.0 * closed_after) / (5.0 + closed_after);
        assert!(
            (all[0].cpu_average - expected).abs() < 0.05,
            "average {} instead of {expected}",
            all[0].cpu_average
        );
        assert!(
            history.oldest_buckets()[0].duration_ms > 3 * 3_600_000,
            "the bar still spans the gap"
        );
    }

    #[test]
    fn the_oldest_tier_fits_in_one_mebibyte() {
        assert_eq!(std::mem::size_of::<StoredBucket>(), 28);
        assert!(std::mem::size_of::<StoredBucket>() * OLDEST_TIER_MAX_BUCKETS < 1_048_576);
    }

    #[test]
    fn recent_keeps_the_last_fifteen_minutes() {
        let mut history = ChartHistory::new();
        for second in 0..2_000 {
            history.record(point(second, 5.0), SECOND);
        }

        let recent = history.recent();

        assert_eq!(recent.len(), 900);
        assert_eq!(
            recent.last().map(|point| point.sampled_at_ms),
            Some(1_999_000)
        );
        assert!(recent[0].sampled_at_ms >= (1_999 - 900) * 1_000);
    }

    #[test]
    fn the_revision_rises_when_a_minute_bucket_closes() {
        let mut history = ChartHistory::new();
        history.record(point(0, 5.0), SECOND);
        let before = history.revision();
        history.record(point(30, 5.0), SECOND);
        assert_eq!(history.revision(), before);
        history.record(point(61, 5.0), SECOND);
        assert!(history.revision() > before);
        assert_eq!(history.uptime(240).len(), 1);
    }
}
