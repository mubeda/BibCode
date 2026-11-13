//! The volume filter (D25): which listed volumes are read, and which readings are shown.

use std::path::{Path, PathBuf};

use super::{HiddenReason, HiddenVolume, VolumeDescriptor, VolumeReading};

/// The file system recorded for a Windows remote drive letter: its real one is never asked, since
/// that would reach the share.
pub(crate) const REMOTE_DRIVE: &str = "remote";

/// Network file systems `sysinfo` does not already skip, or that a FUSE mount reports.
const NETWORK_FILE_SYSTEMS: [&str; 7] = [
    "nfs",
    "nfs4",
    "cifs",
    "smbfs",
    "autofs",
    "fuse.sshfs",
    REMOTE_DRIVE,
];

/// A network file system: any call on its mount point, an `lstat` included, can hang.
pub(crate) fn is_network(file_system: &str) -> bool {
    NETWORK_FILE_SYSTEMS.contains(&file_system)
}

/// Whether the mount point is a file, as Docker's `/etc/hosts` bind mount is, from
/// `symlink_metadata`. Never asks it of a network mount point: a hard mount can hang it (D25),
/// and such a volume is hidden as a network one whatever its mount point is.
pub(crate) fn is_file_mount(
    file_system: &str,
    mount_point: &Path,
    symlink_metadata: impl FnOnce(&Path) -> std::io::Result<std::fs::Metadata>,
) -> bool {
    !is_network(file_system)
        && symlink_metadata(mount_point).is_ok_and(|metadata| metadata.is_file())
}

/// The root (`X:\`) of each drive letter set in `mask` (`GetLogicalDrives`) that `is_remote`
/// (`GetDriveTypeW`) calls remote, as a mounted network file system for `add_unlisted_network`.
#[cfg(any(windows, test))]
pub(crate) fn remote_drives(
    mask: u32,
    mut is_remote: impl FnMut(&str) -> bool,
) -> Vec<(PathBuf, String)> {
    (0..26_u8)
        .filter(|bit| mask & (1 << bit) != 0)
        .map(|bit| format!("{}:\\", char::from(b'A' + bit)))
        .filter(|root| is_remote(root))
        .map(|root| (PathBuf::from(root), REMOTE_DRIVE.to_owned()))
        .collect()
}

/// Adds the mounted network file systems the listing left out (on macOS `sysinfo` skips every
/// volume that is not local, on Windows every mapped network drive), so the filter hides and
/// discloses them too. Only the file system type decides; nothing here touches a mount point.
#[cfg(any(target_os = "macos", windows, test))]
pub(crate) fn add_unlisted_network(
    listed: &mut Vec<VolumeDescriptor>,
    mounted: Vec<(PathBuf, String)>,
) {
    for (mount_point, file_system) in mounted {
        // A stock Mac's automount map (the home trigger) is no volume anyone mounted.
        if is_network(&file_system)
            && file_system != "autofs"
            && !listed
                .iter()
                .any(|volume| volume.mount_point == mount_point)
        {
            listed.push(VolumeDescriptor {
                mount_point,
                name: String::new(),
                file_system,
                removable: false,
                read_only: false,
                is_file: false,
            });
        }
    }
}

/// Memory-backed storage the OS mounts for itself (`/dev`, `/dev/shm`, `/run/user/<id>`). A
/// `tmpfs` someone mounted elsewhere is a real volume.
fn is_system_memory_mount(descriptor: &VolumeDescriptor) -> bool {
    matches!(
        descriptor.file_system.as_str(),
        "tmpfs" | "devtmpfs" | "ramfs"
    ) && ["/dev", "/run", "/sys"]
        .iter()
        .any(|root| descriptor.mount_point.starts_with(root))
}

/// The running AppImage's own image: a read-only FUSE mount holding this executable that is the
/// AppImage's by identity, from the listing alone. The runtime names the file system
/// `fuse.<image file name>` and mounts it at `.mount_*`; either marks it, so an ordinary FUSE
/// volume holding the executable stays shown. `APPIMAGE` can be inherited from another image, but
/// then it names a file system this mount does not have. `APPDIR` is not used for the same reason.
/// Never `/`, which holds every executable: a read-only FUSE root is still the root volume.
fn is_running_image(
    descriptor: &VolumeDescriptor,
    running_executable: Option<&Path>,
    appimage: Option<&Path>,
) -> bool {
    let file_system = descriptor.file_system.as_str();
    let named_after_image = appimage
        .and_then(Path::file_name)
        .is_some_and(|name| file_system.strip_prefix("fuse.") == Some(&name.to_string_lossy()));
    let runtime_mount = descriptor
        .mount_point
        .file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with(".mount_"));
    descriptor.mount_point != Path::new("/")
        && (file_system == "fuse" || file_system.starts_with("fuse."))
        && descriptor.read_only
        && (named_after_image || runtime_mount)
        && running_executable
            .is_some_and(|executable| executable.starts_with(&descriptor.mount_point))
}

/// The AppImage file the runtime started this process from (`APPIMAGE`).
pub(crate) fn current_appimage() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").map(PathBuf::from)
}

/// Drops, before any space read, the volumes that must never be read.
/// `running_executable` is this process's own executable, which an AppImage runs from its mount.
pub(crate) fn pre_filter(
    listed: Vec<VolumeDescriptor>,
    running_executable: Option<&Path>,
    appimage: Option<&Path>,
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
        } else if is_system_memory_mount(&descriptor)
            || is_running_image(&descriptor, running_executable, appimage)
        {
            Some(HiddenReason::System)
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
        let file = tempfile::NamedTempFile::new().expect("a temporary file");
        for file_system in [
            "nfs",
            "nfs4",
            "cifs",
            "smbfs",
            "autofs",
            "fuse.sshfs",
            REMOTE_DRIVE,
        ] {
            assert!(is_network(file_system), "{file_system}");
            let is_file = is_file_mount(file_system, Path::new("/mnt/share"), |_| {
                panic!("{file_system}: a network mount point was stat")
            });
            assert!(!is_file, "{file_system}");
            let (_, hidden) = pre_filter(vec![descriptor("/mnt/share", file_system)], None, None);
            assert_eq!(hidden[0].reason, HiddenReason::Network, "{file_system}");
        }
        for file_system in ["ext4", "apfs", "tmpfs", "overlay", "ntfs"] {
            assert!(!is_network(file_system), "{file_system}");
            let mut asked = None;
            let is_file = is_file_mount(file_system, file.path(), |path| {
                asked = Some(path.to_owned());
                std::fs::symlink_metadata(path)
            });
            assert!(is_file, "{file_system}: the reader's answer is used");
            assert_eq!(asked.as_deref(), Some(file.path()), "{file_system}");
        }
    }

    /// A network mount the listing left out is added once, to be hidden as a network volume.
    /// An automount map is not: every stock Mac has one, and nobody mounted it (#292).
    #[test]
    fn mounted_network_volumes_missing_from_the_listing_are_added() {
        let mut listed = vec![
            descriptor("/", "apfs"),
            descriptor("/Volumes/listed-share", "smbfs"),
        ];
        let mounted = [
            ("/", "apfs"),
            ("/Volumes/listed-share", "smbfs"),
            ("/Volumes/share", "nfs"),
            ("/Volumes/map", "autofs"),
            ("/Volumes/usb", "msdos"),
        ]
        .map(|(mount_point, file_system)| (PathBuf::from(mount_point), file_system.to_owned()));

        add_unlisted_network(&mut listed, mounted.to_vec());

        let added = listed
            .iter()
            .map(|volume| (volume.mount_point.as_path(), volume.file_system.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            added,
            [
                (Path::new("/"), "apfs"),
                (Path::new("/Volumes/listed-share"), "smbfs"),
                (Path::new("/Volumes/share"), "nfs"),
            ]
        );
        assert!(listed[2].name.is_empty() && !listed[2].is_file);
    }

    /// Windows: a remote drive letter the listing left out is added and hidden as a network
    /// volume, from the drive table alone; a listed or local letter is left as it is (#292).
    #[test]
    fn unlisted_remote_drive_letters_are_added_as_hidden_network_volumes() {
        // C:, D:, Y: and Z: are present; Y: and Z: are remote, and Z: is already listed.
        let mask = 1 << 2 | 1 << 3 | 1 << 24 | 1 << 25;
        let mut asked = Vec::new();
        let drives = remote_drives(mask, |root| {
            asked.push(root.to_owned());
            matches!(root, "Y:\\" | "Z:\\")
        });
        assert_eq!(asked, ["C:\\", "D:\\", "Y:\\", "Z:\\"]);
        assert_eq!(
            drives,
            [
                (PathBuf::from("Y:\\"), REMOTE_DRIVE.to_owned()),
                (PathBuf::from("Z:\\"), REMOTE_DRIVE.to_owned()),
            ]
        );

        let mut listed = vec![descriptor("C:\\", "NTFS"), descriptor("Z:\\", "NTFS")];
        add_unlisted_network(&mut listed, drives);
        let (kept, hidden) = pre_filter(listed, None, None);
        let kept = kept
            .iter()
            .map(|volume| volume.mount_point.as_path())
            .collect::<Vec<_>>();
        assert_eq!(kept, [Path::new("C:\\"), Path::new("Z:\\")]);
        assert_eq!(hidden.len(), 1, "{hidden:?}");
        assert_eq!(reason_of(&hidden, "Y:\\"), &HiddenReason::Network);
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
        let (kept, mut hidden) =
            pre_filter(listed.into_iter().map(|(d, _, _)| d).collect(), None, None);
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
        for file_system in [
            "nfs",
            "nfs4",
            "cifs",
            "smbfs",
            "autofs",
            "fuse.sshfs",
            REMOTE_DRIVE,
        ] {
            let (kept, hidden) = pre_filter(
                vec![
                    descriptor("/", "ext4"),
                    descriptor("/mnt/share", file_system),
                ],
                None,
                None,
            );

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

    /// #292: with `linux-tmpfs` the listing has the OS's own memory-backed mounts; they are
    /// hidden as system mounts by type and place alone. A tmpfs mounted elsewhere stays shown.
    #[test]
    fn memory_backed_system_mounts_are_hidden_before_they_are_read() {
        let (kept, hidden) = pre_filter(
            vec![
                descriptor("/", "ext4"),
                descriptor("/dev", "tmpfs"),
                descriptor("/dev/shm", "tmpfs"),
                descriptor("/run/user/1000", "tmpfs"),
                descriptor("/sys/firmware", "tmpfs"),
                descriptor("/dev/hugepages", "ramfs"),
                descriptor("/dev", "devtmpfs"),
                descriptor("/tmp", "tmpfs"),
                descriptor("/mnt/scratch", "tmpfs"),
                descriptor("/devices", "tmpfs"),
                descriptor("/dev/sdb1-mount", "ext4"),
            ],
            None,
            None,
        );

        let kept = kept
            .iter()
            .map(|volume| volume.mount_point.as_path())
            .collect::<Vec<_>>();
        assert_eq!(
            kept,
            [
                Path::new("/"),
                Path::new("/tmp"),
                Path::new("/mnt/scratch"),
                Path::new("/devices"),
                Path::new("/dev/sdb1-mount"),
            ]
        );
        assert_eq!(hidden.len(), 6, "{hidden:?}");
        assert!(
            hidden
                .iter()
                .all(|volume| volume.reason == HiddenReason::System),
            "{hidden:?}"
        );
    }

    /// #292: the AppImage's own mount (read-only FUSE, 0 B free) holds the running executable,
    /// which decides it without reading the volume. Another app's FUSE mount, a writable FUSE
    /// mount holding the executable, and the mounts above the image stay shown.
    #[test]
    fn the_running_app_image_mount_is_hidden_before_it_is_read() {
        let read_only = |mount_point: &str, file_system: &str| {
            let mut volume = descriptor(mount_point, file_system);
            volume.read_only = true;
            volume
        };
        let (kept, hidden) = pre_filter(
            vec![
                read_only("/", "ext4"),
                descriptor("/tmp", "ext4"),
                read_only("/tmp/.mount_BiBCodX", "fuse.BiBCode-1.0.AppImage"),
                read_only("/tmp/.mount_OtherY", "fuse.Other.AppImage"),
            ],
            Some(Path::new("/tmp/.mount_BiBCodX/usr/bin/bibcode-desktop")),
            None,
        );
        assert_eq!(
            reason_of(&hidden, "/tmp/.mount_BiBCodX"),
            &HiddenReason::System
        );
        assert_eq!(hidden.len(), 1, "{hidden:?}");
        assert_eq!(kept.len(), 3);

        let (_, hidden) = pre_filter(
            vec![descriptor("/home", "fuse.mergerfs")],
            Some(Path::new("/home/test-user/bin/bibcode")),
            None,
        );
        assert!(hidden.is_empty(), "a writable FUSE home is a real volume");
        let (_, hidden) = pre_filter(
            vec![read_only(
                "/tmp/.mount_BiBCodX",
                "fuse.BiBCode-1.0.AppImage",
            )],
            None,
            None,
        );
        assert!(hidden.is_empty(), "without the executable nothing matches");
    }

    /// #292 review: a read-only FUSE root holds the executable too, and is still the root volume.
    #[test]
    fn a_read_only_fuse_root_holding_the_executable_stays_shown() {
        for file_system in ["fuse", "fuse.rootfs"] {
            let mut root = descriptor("/", file_system);
            root.read_only = true;
            let (kept, hidden) = pre_filter(
                vec![root],
                Some(Path::new("/usr/bin/bibcode-desktop")),
                None,
            );
            assert!(hidden.is_empty(), "{file_system}: {hidden:?}");
            assert_eq!(kept.len(), 1, "{file_system}");
        }
    }

    /// #292 review: only the AppImage's own mount is the running image. An ordinary read-only FUSE
    /// volume holding the executable stays shown, and an `APPIMAGE` inherited from another image
    /// does not hide a mount that is not that image's.
    #[test]
    fn only_the_app_image_identity_hides_a_fuse_mount() {
        let read_only = |mount_point: &str, file_system: &str| {
            let mut volume = descriptor(mount_point, file_system);
            volume.read_only = true;
            volume
        };
        let hidden_mounts = |volume: VolumeDescriptor, executable: &str, appimage: Option<&str>| {
            pre_filter(
                vec![volume],
                Some(Path::new(executable)),
                appimage.map(Path::new),
            )
            .1
            .len()
        };

        // An ordinary read-only FUSE volume holding the executable.
        for appimage in [None, Some("/home/test-user/Apps/BiBCode-1.0.AppImage")] {
            assert_eq!(
                hidden_mounts(
                    read_only("/mnt/tools", "fuse.gocryptfs"),
                    "/mnt/tools/bin/bibcode",
                    appimage
                ),
                0,
                "{appimage:?}"
            );
        }
        // The real descriptor: named after the image file, mounted under `.mount_`.
        let image = Some("/home/test-user/Apps/BiBCode-1.0.AppImage");
        let executable = "/tmp/.mount_BiBCodX/usr/bin/bibcode-desktop";
        assert_eq!(
            hidden_mounts(
                read_only("/tmp/.mount_BiBCodX", "fuse.BiBCode-1.0.AppImage"),
                executable,
                image
            ),
            1
        );
        // The runtime's mount point alone identifies it, with no `APPIMAGE` at all.
        assert_eq!(
            hidden_mounts(read_only("/tmp/.mount_BiBCodX", "fuse"), executable, None),
            1
        );
        // The image's file name alone identifies it, wherever it is mounted.
        assert_eq!(
            hidden_mounts(
                read_only("/opt/image", "fuse.BiBCode-1.0.AppImage"),
                "/opt/image/bin/bibcode",
                image
            ),
            1
        );
        // An environment inherited from a foreign image names another file system and mount.
        assert_eq!(
            hidden_mounts(
                read_only("/mnt/tools", "fuse.gocryptfs"),
                "/mnt/tools/bin/bibcode",
                Some("/home/test-user/Apps/Other.AppImage")
            ),
            0
        );
        // The root is never the image.
        assert_eq!(
            hidden_mounts(
                read_only("/", "fuse.BiBCode-1.0.AppImage"),
                "/usr/bin/bibcode",
                image
            ),
            0
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
