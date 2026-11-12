//! Probes run by hand on a real host (`--ignored --exact`), never in CI. They print to the
//! terminal only; what they print names local volumes, so it never goes into a file or report.

use std::sync::Arc;

use super::{
    HostMetricsSource, VolumeReading, VolumeState, merge_shared, native::NativeHostMetricsSource,
    pre_filter, volume_reading,
};

/// Lists every volume the native source returns and says whether the filter keeps or hides it.
#[test]
#[ignore = "probe: run by hand on a real host"]
fn volume_probe() {
    let source = Arc::new(NativeHostMetricsSource::new());
    let listed = source.list_volumes();
    let (kept, mut hidden) = pre_filter(listed.clone());
    let read = kept
        .into_iter()
        .map(
            |descriptor| match source.read_volume_space(&descriptor.mount_point) {
                Ok(space) => volume_reading(descriptor, space),
                Err(error) => {
                    println!(
                        "space read failed for {}: {error}",
                        descriptor.mount_point.display()
                    );
                    VolumeReading {
                        descriptor,
                        total_bytes: None,
                        free_bytes: None,
                        state: VolumeState::NotResponding,
                    }
                }
            },
        )
        .collect::<Vec<_>>();
    let readings = read.clone();
    let (shown, merged) = merge_shared(read);
    hidden.extend(merged);

    println!("{} volumes listed", listed.len());
    for descriptor in &listed {
        let reading = readings
            .iter()
            .find(|reading| reading.descriptor.mount_point == descriptor.mount_point);
        let verdict = if shown
            .iter()
            .any(|shown| shown.descriptor.mount_point == descriptor.mount_point)
        {
            "kept".to_owned()
        } else {
            hidden
                .iter()
                .find(|hidden| hidden.descriptor.mount_point == descriptor.mount_point)
                .map_or_else(
                    || "missing".to_owned(),
                    |hidden| format!("hidden: {:?}", hidden.reason),
                )
        };
        println!(
            "{} fs={} total={:?} free={:?} removable={} read_only={} file={} -> {verdict}",
            descriptor.mount_point.display(),
            descriptor.file_system,
            reading.and_then(|reading| reading.total_bytes),
            reading.and_then(|reading| reading.free_bytes),
            descriptor.removable,
            descriptor.read_only,
            descriptor.is_file,
        );
    }
}
