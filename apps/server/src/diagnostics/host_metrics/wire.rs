//! `server.subscribeHostMetrics` on the wire: serde mirrors of `ServerHostMetricsEvent` in
//! `packages/contracts/src/server.ts`, the two encoders, and the subscriber loop (R72, R85).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{
    ChartBucket, ChartPoint, HostFacts, HostMetricsCollector, HostMetricsSnapshot,
    HostMetricsUpdate, HostReading, MeasureStatistics, VolumeReading, VolumeState,
};
use crate::rpc::RpcStreamChunk;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub(crate) enum HostMetricsEventWire {
    Snapshot(SnapshotWire),
    Sample(SampleWire),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostFactsWire {
    os: String,
    arch: String,
    cpu_count: u64,
    memory_total_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum VolumeStateWire {
    Ok,
    NotResponding,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VolumeWire {
    mount_point: String,
    name: String,
    file_system: String,
    total_bytes: Option<u64>,
    free_bytes: Option<u64>,
    used_bytes: Option<u64>,
    removable: bool,
    read_only: bool,
    state: VolumeStateWire,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostSampleWire {
    sampled_at: String,
    cpu_percent: f64,
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    memory_available_bytes: u64,
    volumes: Vec<VolumeWire>,
    volumes_paused: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StatisticWire {
    current: f64,
    minimum: f64,
    average: f64,
    p95: f64,
    maximum: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChartPointWire {
    sampled_at: String,
    cpu_percent: f64,
    memory_percent: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChartBucketWire {
    started_at: String,
    duration_ms: u64,
    cpu_average: f64,
    cpu_peak: f64,
    memory_average: f64,
    memory_peak: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SnapshotWire {
    host: HostFactsWire,
    boot_id: Option<String>,
    started_at: String,
    statistics_since: Option<String>,
    sample: Option<HostSampleWire>,
    cpu: Option<StatisticWire>,
    memory: Option<StatisticWire>,
    recent: Vec<ChartPointWire>,
    uptime: Vec<ChartBucketWire>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SampleWire {
    sample: HostSampleWire,
    cpu: StatisticWire,
    memory: StatisticWire,
    /// The latest chart when the subscriber has not been sent it yet; `null` otherwise.
    uptime: Option<Vec<ChartBucketWire>>,
}

fn format_ms(ms: i128) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(ms.saturating_mul(1_000_000))
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        .format(&Rfc3339)
        .unwrap_or_default()
}

fn facts(facts: &HostFacts) -> HostFactsWire {
    HostFactsWire {
        os: facts.os.to_owned(),
        arch: facts.arch.to_owned(),
        cpu_count: facts.cpu_count as u64,
        memory_total_bytes: facts.memory_total_bytes,
    }
}

fn volume(volume: &VolumeReading) -> VolumeWire {
    VolumeWire {
        mount_point: volume.descriptor.mount_point.to_string_lossy().into_owned(),
        name: volume.descriptor.name.clone(),
        file_system: volume.descriptor.file_system.clone(),
        total_bytes: volume.total_bytes,
        free_bytes: volume.free_bytes,
        used_bytes: volume.used_bytes(),
        removable: volume.descriptor.removable,
        read_only: volume.descriptor.read_only,
        state: match volume.state {
            VolumeState::Ok => VolumeStateWire::Ok,
            VolumeState::NotResponding => VolumeStateWire::NotResponding,
        },
    }
}

fn sample(reading: &HostReading) -> HostSampleWire {
    HostSampleWire {
        sampled_at: format_ms(reading.sampled_at_ms),
        cpu_percent: reading.cpu_percent,
        memory_total_bytes: reading.memory_total_bytes,
        memory_used_bytes: reading.memory_used_bytes,
        memory_available_bytes: reading.memory_available_bytes,
        volumes: reading.volumes.iter().map(volume).collect(),
        volumes_paused: reading.volumes_paused,
    }
}

fn statistic(statistic: &MeasureStatistics) -> StatisticWire {
    StatisticWire {
        current: statistic.current,
        minimum: statistic.minimum,
        average: statistic.average,
        p95: statistic.p95,
        maximum: statistic.maximum,
    }
}

fn point(point: &ChartPoint) -> ChartPointWire {
    ChartPointWire {
        sampled_at: format_ms(point.sampled_at_ms),
        cpu_percent: point.cpu_percent,
        memory_percent: point.memory_percent,
    }
}

fn bucket(bucket: &ChartBucket) -> ChartBucketWire {
    ChartBucketWire {
        started_at: format_ms(bucket.started_at_ms),
        duration_ms: bucket.duration_ms,
        cpu_average: bucket.cpu_average,
        cpu_peak: bucket.cpu_peak,
        memory_average: bucket.memory_average,
        memory_peak: bucket.memory_peak,
    }
}

fn to_value(event: &HostMetricsEventWire) -> Value {
    serde_json::to_value(event).unwrap_or(Value::Null)
}

pub(crate) fn encode_snapshot(snapshot: &HostMetricsSnapshot) -> Value {
    to_value(&HostMetricsEventWire::Snapshot(SnapshotWire {
        host: facts(&snapshot.facts),
        boot_id: snapshot.identity.boot_id.clone(),
        started_at: format_ms(snapshot.identity.started_at_ms),
        statistics_since: snapshot.statistics_since_ms.map(format_ms),
        sample: snapshot.current.as_ref().map(sample),
        cpu: snapshot.cpu.as_ref().map(statistic),
        memory: snapshot.memory.as_ref().map(statistic),
        recent: snapshot.recent.iter().map(point).collect(),
        uptime: snapshot.chart.uptime.iter().map(bucket).collect(),
    }))
}

pub(crate) fn encode_update(update: &HostMetricsUpdate, include_chart: bool) -> Value {
    to_value(&HostMetricsEventWire::Sample(SampleWire {
        sample: sample(&update.reading),
        cpu: statistic(&update.cpu),
        memory: statistic(&update.memory),
        uptime: include_chart.then(|| update.chart.uptime.iter().map(bucket).collect()),
    }))
}

/// Sends a snapshot, then one sample per live reading, for as long as the subscriber stays.
/// Each item is built only once a slot in the subscriber's queue is free, from the latest
/// reading and chart at that moment, so a slow subscriber skips readings but never misses a
/// chart (R85).
pub(crate) async fn send_host_metrics(
    collector: Arc<HostMetricsCollector>,
    sender: mpsc::Sender<RpcStreamChunk>,
    cancellation: CancellationToken,
) {
    let mut subscription = collector.subscribe();
    let Ok(permit) = reserve(&sender, &cancellation).await else {
        return;
    };
    let snapshot = tokio::select! {
        () = cancellation.cancelled() => return,
        snapshot = collector.snapshot() => snapshot,
    };
    // Whatever the snapshot already shows is not sent again.
    subscription.receiver().borrow_and_update();
    let mut sent_revision = snapshot.chart.revision;
    let mut sent_at_ms = snapshot
        .current
        .as_ref()
        .map(|reading| reading.sampled_at_ms);
    permit.send(Ok(vec![encode_snapshot(&snapshot)]));
    loop {
        let Ok(permit) = reserve(&sender, &cancellation).await else {
            return;
        };
        let update = loop {
            let latest = subscription.receiver().borrow_and_update().clone();
            if let Some(update) = latest
                && Some(update.reading.sampled_at_ms) != sent_at_ms
            {
                break update;
            }
            tokio::select! {
                () = cancellation.cancelled() => return,
                () = sender.closed() => return,
                changed = subscription.receiver().changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
            }
        };
        let include_chart = update.chart.revision != sent_revision;
        permit.send(Ok(vec![encode_update(&update, include_chart)]));
        sent_revision = update.chart.revision;
        sent_at_ms = Some(update.reading.sampled_at_ms);
    }
}

async fn reserve<'a>(
    sender: &'a mpsc::Sender<RpcStreamChunk>,
    cancellation: &CancellationToken,
) -> Result<mpsc::Permit<'a, RpcStreamChunk>, ()> {
    tokio::select! {
        () = cancellation.cancelled() => Err(()),
        permit = sender.reserve() => permit.map_err(|_| ()),
    }
}

#[cfg(test)]
mod tests {
    use std::{path::PathBuf, time::Duration};

    use super::*;
    use crate::diagnostics::host_metrics::{
        ChartState, HostMetricsIdentity, HostMetricsRates, VolumeDescriptor,
        tests::{FakeHostMetricsSource, run_for},
    };

    fn parse_ms(value: &Value) -> i128 {
        let text = value.as_str().expect("a timestamp");
        OffsetDateTime::parse(text, &Rfc3339)
            .expect("an RFC 3339 timestamp")
            .unix_timestamp_nanos()
            / 1_000_000
    }

    fn fixture(name: &str) -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/contracts/fixtures/rpc-wire/stream-shapes")
            .join(name);
        let text = std::fs::read_to_string(path).expect("stream shape fixture");
        let fixture: Value = serde_json::from_str(&text).expect("fixture JSON");
        fixture["values"][0].clone()
    }

    #[test]
    fn host_metrics_stream_fixtures_round_trip() {
        for name in [
            "server__subscribeHostMetrics-00.json",
            "server__subscribeHostMetrics-01.json",
        ] {
            let wire = fixture(name);
            let event: HostMetricsEventWire =
                serde_json::from_value(wire.clone()).expect("the Rust mirror decodes the TS shape");
            assert_eq!(
                serde_json::to_value(&event).expect("re-encodes"),
                wire,
                "{name} must stay byte-identical to the TypeScript contract"
            );
        }
    }

    #[test]
    fn encoded_snapshot_stays_under_128_kib() {
        let reading = HostReading {
            sampled_at_ms: 1_700_000_000_123,
            cpu_percent: 23.456_789,
            memory_total_bytes: 34_359_738_368,
            memory_used_bytes: 12_025_908_428,
            memory_available_bytes: 22_333_829_940,
            volumes: (0..20)
                .map(|index| VolumeReading {
                    descriptor: VolumeDescriptor {
                        mount_point: PathBuf::from(format!("/mnt/volume-with-a-long-name-{index}")),
                        name: format!("Volume with a long name {index}"),
                        file_system: "ext4".to_owned(),
                        removable: index % 2 == 0,
                        read_only: false,
                        is_file: false,
                    },
                    total_bytes: Some(2_147_483_648_000),
                    free_bytes: Some(671_088_640_000),
                    state: VolumeState::Ok,
                })
                .collect(),
            volumes_paused: false,
        };
        let statistic = MeasureStatistics {
            current: 23.456_789,
            minimum: 1.234_567,
            maximum: 97.654_321,
            average: 11.111_111,
            p95: 40.0,
        };
        let snapshot = HostMetricsSnapshot {
            identity: HostMetricsIdentity {
                boot_id: Some("00000000-0000-0000-0000-000000000000".to_owned()),
                started_at_ms: 1_700_000_000_000,
            },
            facts: HostFacts {
                os: "linux",
                arch: "x86_64",
                cpu_count: 128,
                memory_total_bytes: 34_359_738_368,
            },
            statistics_since_ms: Some(1_700_000_000_000),
            current: Some(reading),
            cpu: Some(statistic),
            memory: Some(statistic),
            recent: (0..900)
                .map(|index| ChartPoint {
                    sampled_at_ms: 1_700_000_000_123 + index * 1_000,
                    cpu_percent: 23.456_789,
                    memory_percent: 35.123_456,
                })
                .collect(),
            chart: Arc::new(ChartState {
                revision: 1,
                uptime: (0..240)
                    .map(|index| ChartBucket {
                        started_at_ms: 1_700_000_000_000 + i128::from(index) * 60_000,
                        duration_ms: 60_000,
                        cpu_average: 12.345_678,
                        cpu_peak: 98.765_432,
                        memory_average: 35.123_456,
                        memory_peak: 36.543_21,
                    })
                    .collect(),
                hidden_volumes: Vec::new(),
            }),
        };

        let bytes = serde_json::to_vec(&encode_snapshot(&snapshot)).expect("encodes");

        assert!(bytes.len() < 128 * 1_024, "{} bytes", bytes.len());
    }

    /// R85: a subscriber that stops reading while a minute bucket closes still holds that
    /// bucket once its queue drains, and no item is built while its queue is full.
    #[tokio::test(start_paused = true)]
    async fn a_slow_subscriber_holds_the_latest_chart_after_the_queue_drains() {
        let collector = Arc::new(HostMetricsCollector::new(
            Arc::new(FakeHostMetricsSource::new(vec![])),
            HostMetricsRates::default(),
            HostMetricsIdentity {
                boot_id: None,
                started_at_ms: 1_700_000_000_000,
            },
        ));
        let (sender, mut receiver) = mpsc::channel(64);
        let cancellation = CancellationToken::new();
        let task = tokio::spawn(send_host_metrics(
            collector.clone(),
            sender,
            cancellation.clone(),
        ));

        // The queue fills about 64 s in; the minute that closes at about 121 s closes while it
        // is full, and nothing is read until 130 s.
        run_for(Duration::from_secs(130), Duration::from_secs(1)).await;
        let resumed_at = collector.shared.now_ms();
        let mut items = Vec::new();
        while let Ok(chunk) = receiver.try_recv() {
            items.extend(chunk.expect("a value"));
        }
        assert_eq!(items.len(), 64, "the queue was full");
        let queued = items[1..]
            .iter()
            .map(|item| parse_ms(&item["sample"]["sampledAt"]))
            .collect::<Vec<_>>();
        run_for(Duration::from_secs(3), Duration::from_secs(1)).await;
        while let Ok(chunk) = receiver.try_recv() {
            items.extend(chunk.expect("a value"));
        }

        let mut chart = items[0]["uptime"].clone();
        assert_eq!(items[0]["_tag"], "Snapshot");
        for item in &items[1..] {
            assert_eq!(item["_tag"], "Sample");
            if !item["uptime"].is_null() {
                chart = item["uptime"].clone();
            }
        }
        let started = chart
            .as_array()
            .expect("uptime bars")
            .iter()
            .map(|bar| bar["startedAt"].as_str().expect("startedAt").to_owned())
            .collect::<Vec<_>>();
        let first = collector
            .snapshot()
            .await
            .statistics_since_ms
            .expect("statistics started");
        assert!(
            started.contains(&format_ms(first + 60_000)),
            "the bucket closed while the queue was full is held: {started:?}"
        );
        let after = &items[64..];
        assert!(!after.is_empty());
        for item in after {
            let sampled_at = parse_ms(&item["sample"]["sampledAt"]);
            assert!(
                sampled_at >= resumed_at - 1_500,
                "an item sent after the resume carries a reading from {sampled_at}, before {resumed_at}"
            );
        }
        // Nothing was built between the queue filling and the resume.
        let full_at = queued.iter().copied().max().expect("queued samples");
        assert!(
            full_at < first + 70_000,
            "the last queued item was built at {full_at}"
        );
        // The chart was sent once; later items that bring nothing new carry no chart.
        assert!(after.len() >= 2);
        assert!(after[after.len() - 1]["uptime"].is_null());

        cancellation.cancel();
        task.await.expect("the subscriber loop ends");
        collector.shutdown().await;
    }
}
