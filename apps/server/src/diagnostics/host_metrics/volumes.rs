//! The volume filter (D25): which listed volumes are read, and which readings are shown.

use std::path::{Path, PathBuf};

use super::{HiddenReason, HiddenVolume, VolumeDescriptor, VolumeReading};

/// Network file systems `sysinfo` does not already skip, or that a FUSE mount reports.
const NETWORK_FILE_SYSTEMS: [&str; 6] = ["nfs", "nfs4", "cifs", "smbfs", "autofs", "fuse.sshfs"];

/// A network file system: any call on its mount point, an `lstat` included, can hang.
pub(crate) fn is_network(file_system: &str) -> bool {
    NETWORK_FILE_SYSTEMS.contains(&file_system)
}

/// Drops, before any space read, the volumes that must never be read.
pub(crate) fn pre_filter(
    listed: Vec<VolumeDescriptor>,
) -> (Vec<VolumeDescriptor>, Vec<HiddenVolume>) {
    let mut kept = Vec::with_capacity(listed.len());
    let mut hidden = Vec::new();
    for descriptor in listed {
        let reason = if is_network(&descriptor.file_system) {
            Some(HiddenReason::Network)
        } else if descriptor.file_system == "overlay" && descriptor.mount_point != Path::new("/") {
            Some(HiddenReason::Overlay)
        } else if descriptor.is_file {
            Some(HiddenReason::FileMount)
        } else {
            None
        };
        match reason {
            Some(reason) => hidden.push(HiddenVolume { descriptor, reason }),
            None => kept.push(descriptor),
        }
    }
    (kept, hidden)
}

/// Hides empty volumes and folds volumes that share storage (same file system, total and free
/// bytes) into the one at `/`, or else the shortest mount point. A volume without sizes is kept.
pub(crate) fn merge_shared(read: Vec<VolumeReading>) -> (Vec<VolumeReading>, Vec<HiddenVolume>) {
    let key = |reading: &VolumeReading| -> Option<(String, u64, u64)> {
        Some((
            reading.descriptor.file_system.clone(),
            reading.total_bytes?,
            reading.free_bytes?,
        ))
    };
    let rank = |reading: &VolumeReading| {
        let mount_point = &reading.descriptor.mount_point;
        (mount_point != Path::new("/"), mount_point.as_os_str().len())
    };
    // The winner of each storage group, by index into `read`.
    let winners = read
        .iter()
        .map(|reading| {
            let own = key(reading)?;
            read.iter()
                .enumerate()
                .filter(|(_, other)| key(other).as_ref() == Some(&own))
                .min_by_key(|(_, other)| rank(other))
                .map(|(index, _)| index)
        })
        .collect::<Vec<_>>();
    let winner_mounts: Vec<Option<PathBuf>> = winners
        .iter()
        .map(|winner| winner.map(|index| read[index].descriptor.mount_point.clone()))
        .collect();

    // A merged entry stands for every member, so it is read-only only when all of them are
    // (macOS: `/` is the sealed system volume, its Data volume is writable).
    let writable_groups = winners
        .iter()
        .zip(&read)
        .filter(|(_, reading)| !reading.descriptor.read_only)
        .filter_map(|(winner, _)| *winner)
        .collect::<Vec<_>>();
    let mut shown = Vec::with_capacity(read.len());
    let mut hidden = Vec::new();
    for (index, mut reading) in read.into_iter().enumerate() {
        if reading.total_bytes == Some(0) {
            hidden.push(HiddenVolume {
                descriptor: reading.descriptor,
                reason: HiddenReason::Empty,
            });
        } else if winners[index].is_some_and(|winner| winner != index)
            && let Some(as_mount) = winner_mounts[index].clone()
        {
            hidden.push(HiddenVolume {
                descriptor: reading.descriptor,
                reason: HiddenReason::SameStorage { as_mount },
            });
        } else {
            if writable_groups.contains(&index) {
                reading.descriptor.read_only = false;
            }
            shown.push(reading);
        }
    }
    (shown, hidden)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::diagnostics::host_metrics::VolumeState;

    const GB: u64 = 1_000_000_000;

    fn descriptor(mount_point: &str, file_system: &str) -> VolumeDescriptor {
        VolumeDescriptor {
            mount_point: PathBuf::from(mount_point),
            name: String::new(),
            file_system: file_system.to_owned(),
            removable: false,
            read_only: false,
            is_file: false,
        }
    }

    /// The listing skips its `lstat` for exactly the file systems the filter hides as network.
    #[test]
    fn network_file_systems_are_never_stat_by_the_listing() {
        for file_system in ["nfs", "nfs4", "cifs", "smbfs", "autofs", "fuse.sshfs"] {
            assert!(is_network(file_system), "{file_system}");
            let (_, hidden) = pre_filter(vec![descriptor("/mnt/share", file_system)]);
            assert_eq!(hidden[0].reason, HiddenReason::Network, "{file_system}");
        }
        for file_system in ["ext4", "apfs", "tmpfs", "overlay", "ntfs"] {
            assert!(!is_network(file_system), "{file_system}");
        }
    }

    fn reading(descriptor: VolumeDescriptor, total: u64, free: u64) -> VolumeReading {
        VolumeReading {
            descriptor,
            total_bytes: Some(total),
            free_bytes: Some(free),
            state: VolumeState::Ok,
        }
    }

    /// Filters a list the way the collector does: `pre_filter` before reading, then
    /// `merge_shared` over the readings.
    fn filter(
        listed: Vec<(VolumeDescriptor, u64, u64)>,
    ) -> (Vec<VolumeReading>, Vec<HiddenVolume>) {
        let sizes = listed
            .iter()
            .map(|(descriptor, total, free)| (descriptor.mount_point.clone(), (*total, *free)))
            .collect::<Vec<_>>();
        let (kept, mut hidden) = pre_filter(listed.into_iter().map(|(d, _, _)| d).collect());
        let read = kept
            .into_iter()
            .map(|descriptor| {
                let (total, free) = sizes
                    .iter()
                    .find(|(mount_point, _)| *mount_point == descriptor.mount_point)
                    .map(|(_, sizes)| *sizes)
                    .expect("sizes");
                reading(descriptor, total, free)
            })
            .collect();
        let (shown, merged) = merge_shared(read);
        hidden.extend(merged);
        (shown, hidden)
    }

    fn mount_points(readings: &[VolumeReading]) -> Vec<&Path> {
        readings
            .iter()
            .map(|reading| reading.descriptor.mount_point.as_path())
            .collect()
    }

    fn reason_of<'a>(hidden: &'a [HiddenVolume], mount_point: &str) -> &'a HiddenReason {
        &hidden
            .iter()
            .find(|volume| volume.descriptor.mount_point == Path::new(mount_point))
            .unwrap_or_else(|| panic!("{mount_point} is hidden"))
            .reason
    }

    #[test]
    fn container_and_apfs_lists_show_each_volume_once() {
        let mut hosts = descriptor("/etc/hosts", "ext4");
        hosts.is_file = true;
        let mut usb = descriptor("/media/usb", "exfat");
        usb.removable = true;
        let (container, hidden) = filter(vec![
            (descriptor("/", "overlay"), 100 * GB, 40 * GB),
            (hosts, 100 * GB, 40 * GB),
            (
                descriptor("/var/lib/docker/overlay2/x/merged", "overlay"),
                100 * GB,
                40 * GB,
            ),
            (descriptor("/snap/core/1", "squashfs"), 0, 0),
            (usb, 64 * GB, 10 * GB),
        ]);
        assert_eq!(
            mount_points(&container),
            [Path::new("/"), Path::new("/media/usb")]
        );
        assert!(container[1].descriptor.removable);
        assert_eq!(reason_of(&hidden, "/etc/hosts"), &HiddenReason::FileMount);
        assert_eq!(
            reason_of(&hidden, "/var/lib/docker/overlay2/x/merged"),
            &HiddenReason::Overlay
        );
        assert_eq!(reason_of(&hidden, "/snap/core/1"), &HiddenReason::Empty);

        let (apfs, hidden) = filter(vec![
            (
                descriptor("/System/Volumes/Data", "apfs"),
                2_000 * GB,
                600 * GB,
            ),
            (descriptor("/", "apfs"), 2_000 * GB, 600 * GB),
        ]);
        assert_eq!(mount_points(&apfs), [Path::new("/")]);
        assert_eq!(
            reason_of(&hidden, "/System/Volumes/Data"),
            &HiddenReason::SameStorage {
                as_mount: PathBuf::from("/")
            }
        );
    }

    #[test]
    fn two_volumes_that_only_look_alike_are_both_kept() {
        let (shown, hidden) = filter(vec![
            (descriptor("/", "ext4"), 500 * GB, 200 * GB),
            (descriptor("/data", "ext4"), 500 * GB, 199 * GB),
        ]);

        assert_eq!(mount_points(&shown), [Path::new("/"), Path::new("/data")]);
        assert!(hidden.is_empty());
    }

    #[test]
    fn a_network_volume_is_hidden_before_it_is_read() {
        for file_system in ["nfs", "nfs4", "cifs", "smbfs", "autofs", "fuse.sshfs"] {
            let (kept, hidden) = pre_filter(vec![
                descriptor("/", "ext4"),
                descriptor("/mnt/share", file_system),
            ]);

            assert_eq!(kept.len(), 1, "{file_system}");
            assert_eq!(kept[0].mount_point, Path::new("/"));
            assert_eq!(reason_of(&hidden, "/mnt/share"), &HiddenReason::Network);
        }
    }

    #[test]
    fn shared_storage_without_root_keeps_the_shortest_mount_point() {
        let (shown, hidden) = filter(vec![
            (descriptor("/mnt/data/inner", "ext4"), 500 * GB, 200 * GB),
            (descriptor("/mnt/data", "ext4"), 500 * GB, 200 * GB),
        ]);

        assert_eq!(mount_points(&shown), [Path::new("/mnt/data")]);
        assert_eq!(
            reason_of(&hidden, "/mnt/data/inner"),
            &HiddenReason::SameStorage {
                as_mount: PathBuf::from("/mnt/data")
            }
        );
    }

    #[test]
    fn a_volume_not_read_yet_is_kept() {
        let unread = VolumeReading {
            descriptor: descriptor("/mnt/slow", "ext4"),
            total_bytes: None,
            free_bytes: None,
            state: VolumeState::NotResponding,
        };
        let (shown, hidden) = merge_shared(vec![
            reading(descriptor("/", "ext4"), 500 * GB, 200 * GB),
            unread,
        ]);

        assert_eq!(
            mount_points(&shown),
            [Path::new("/"), Path::new("/mnt/slow")]
        );
        assert!(hidden.is_empty());
    }

    #[test]
    fn removable_and_read_only_markers_survive_the_filter() {
        let mut usb = descriptor("/media/usb", "exfat");
        usb.removable = true;
        let mut image = descriptor("/mnt/ro-test", "ext4");
        image.read_only = true;

        let (shown, _) = filter(vec![
            (descriptor("/", "ext4"), 500 * GB, 200 * GB),
            (usb, 64 * GB, 10 * GB),
            (image, GB, GB / 2),
        ]);

        assert_eq!(shown.len(), 3);
        assert!(shown[1].descriptor.removable && !shown[1].descriptor.read_only);
        assert!(shown[2].descriptor.read_only && !shown[2].descriptor.removable);
    }

    /// #292 review: the APFS container shown at `/` stands for the writable Data volume too, so
    /// a merged entry is read-only only when every merged member is.
    #[test]
    fn a_merged_entry_is_read_only_only_when_every_member_is() {
        let sealed = |mount_point: &str, read_only: bool| {
            let mut volume = descriptor(mount_point, "apfs");
            volume.read_only = read_only;
            (volume, 2_000 * GB, 600 * GB)
        };

        let (shown, _) = filter(vec![
            sealed("/System/Volumes/Data", false),
            sealed("/", true),
        ]);
        assert_eq!(mount_points(&shown), [Path::new("/")]);
        assert!(!shown[0].descriptor.read_only, "{shown:?}");

        let (shown, hidden) = filter(vec![sealed("/Volumes/Image", true), sealed("/", true)]);
        assert!(shown[0].descriptor.read_only, "{shown:?}");
        assert!(
            hidden[0].descriptor.read_only,
            "a hidden member keeps its own flag"
        );
    }

    #[test]
    fn a_hidden_volume_carries_its_reason() {
        let mut file = descriptor("/etc/hostname", "ext4");
        file.is_file = true;
        let (shown, hidden) = filter(vec![
            (descriptor("/", "ext4"), 500 * GB, 200 * GB),
            (descriptor("/home", "ext4"), 500 * GB, 200 * GB),
            (descriptor("/mnt/share", "cifs"), 500 * GB, 1),
            (descriptor("/run/overlay", "overlay"), 500 * GB, 1),
            (file, 500 * GB, 200 * GB),
            (descriptor("/mnt/empty", "ext4"), 0, 0),
        ]);

        assert_eq!(mount_points(&shown), [Path::new("/")]);
        let reasons = hidden
            .iter()
            .map(|volume| (volume.descriptor.mount_point.as_path(), &volume.reason))
            .collect::<Vec<_>>();
        assert_eq!(
            reasons,
            [
                (Path::new("/mnt/share"), &HiddenReason::Network),
                (Path::new("/run/overlay"), &HiddenReason::Overlay),
                (Path::new("/etc/hostname"), &HiddenReason::FileMount),
                (
                    Path::new("/home"),
                    &HiddenReason::SameStorage {
                        as_mount: PathBuf::from("/")
                    }
                ),
                (Path::new("/mnt/empty"), &HiddenReason::Empty),
            ]
        );
    }
}
