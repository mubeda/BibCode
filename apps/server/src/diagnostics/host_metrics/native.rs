//! The native host source over `sysinfo`: CPU and memory refreshes only, never the process table,
//! and one disk at a time for space reads (#292).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use sysinfo::{CpuRefreshKind, Disk, DiskRefreshKind, Disks, MemoryRefreshKind, System};

use super::{
    CpuMemoryReading, HostFacts, HostMetricsSource, SamplingError, VolumeDescriptor, VolumeSpace,
};

#[derive(Debug)]
struct CpuMemory {
    system: System,
    /// CPU usage is a difference between two refreshes; the first call makes both.
    primed: bool,
}

#[derive(Debug)]
pub struct NativeHostMetricsSource {
    cpu_memory: Mutex<CpuMemory>,
    /// The disks of the latest listing, each locked on its own so one hung read holds only it.
    disks: Mutex<HashMap<PathBuf, Arc<Mutex<Disk>>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Default for NativeHostMetricsSource {
    fn default() -> Self {
        Self::new()
    }
}

impl NativeHostMetricsSource {
    /// Does no I/O: an empty `System` and no disks.
    pub fn new() -> Self {
        Self {
            cpu_memory: Mutex::new(CpuMemory {
                system: System::new(),
                primed: false,
            }),
            disks: Mutex::new(HashMap::new()),
        }
    }

    fn refresh_cpu_memory(state: &mut CpuMemory) {
        let cpu = CpuRefreshKind::nothing().with_cpu_usage();
        if !state.primed {
            state.system.refresh_cpu_specifics(cpu);
            // Runs on the blocking pool, never on a Tokio worker.
            std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
            state.primed = true;
        }
        state.system.refresh_cpu_specifics(cpu);
        state
            .system
            .refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
    }
}

impl HostMetricsSource for NativeHostMetricsSource {
    fn host_facts(&self) -> HostFacts {
        let mut state = lock(&self.cpu_memory);
        if state.system.cpus().is_empty() {
            state.system.refresh_cpu_list(CpuRefreshKind::nothing());
        }
        if state.system.total_memory() == 0 {
            state
                .system
                .refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        }
        HostFacts {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            cpu_count: state.system.cpus().len(),
            memory_total_bytes: state.system.total_memory(),
        }
    }

    fn read_cpu_memory(&self) -> Result<CpuMemoryReading, SamplingError> {
        let mut state = lock(&self.cpu_memory);
        Self::refresh_cpu_memory(&mut state);
        let memory_total_bytes = state.system.total_memory();
        if memory_total_bytes == 0 || state.system.cpus().is_empty() {
            return Err(SamplingError::Failed(
                "the host reported no CPU or memory".to_owned(),
            ));
        }
        Ok(CpuMemoryReading {
            cpu_percent: f64::from(state.system.global_cpu_usage()),
            memory_total_bytes,
            // The OS's own used figure on every platform (D24).
            memory_used_bytes: state.system.used_memory(),
        })
    }

    fn list_volumes(&self) -> Vec<VolumeDescriptor> {
        // `nothing()` makes no `statvfs` call, on the first listing too.
        let disks: Vec<Disk> =
            Disks::new_with_refreshed_list_specifics(DiskRefreshKind::nothing()).into();
        #[cfg(target_os = "linux")]
        let read_only = std::fs::read_to_string("/proc/self/mounts")
            .map(|mounts| read_only_mounts(&mounts))
            .unwrap_or_default();
        let mut listed = Vec::with_capacity(disks.len());
        let mut by_mount = HashMap::with_capacity(disks.len());
        for disk in disks {
            let mount_point = disk.mount_point().to_owned();
            let file_system = disk.file_system().to_string_lossy().into_owned();
            // Never `lstat` a network mount point: a hard mount can hang it (D25). Such a
            // volume is hidden as a network one whatever its mount point is.
            let is_file = !super::volumes::is_network(&file_system)
                && std::fs::symlink_metadata(&mount_point).is_ok_and(|metadata| metadata.is_file());
            #[cfg(target_os = "linux")]
            let disk_read_only = read_only.get(&mount_point).copied().unwrap_or(false);
            #[cfg(not(target_os = "linux"))]
            let disk_read_only = disk.is_read_only();
            listed.push(VolumeDescriptor {
                name: disk.name().to_string_lossy().into_owned(),
                file_system,
                removable: disk.is_removable(),
                read_only: disk_read_only,
                is_file,
                mount_point: mount_point.clone(),
            });
            by_mount.insert(mount_point, Arc::new(Mutex::new(disk)));
        }
        *lock(&self.disks) = by_mount;
        listed
    }

    fn read_volume_space(&self, mount_point: &Path) -> Result<VolumeSpace, String> {
        // Never hold the map lock across the call: a hung read must not block a listing.
        let disk = lock(&self.disks)
            .get(mount_point)
            .cloned()
            .ok_or_else(|| "the volume is no longer listed".to_owned())?;
        #[cfg(windows)]
        let space = {
            drop(disk);
            caller_space(mount_point).map_err(|error| error.to_string())
        };
        #[cfg(not(windows))]
        let space = storage_space(&disk);
        space
    }
}

/// Total and available blocks from `statvfs` on Linux; total capacity and available capacity for
/// important usage on macOS. `sysinfo` reports success even when its own query fails and keeps
/// the old figures, so `statvfs` decides whether the volume answered.
#[cfg(not(windows))]
fn storage_space(disk: &Mutex<Disk>) -> Result<VolumeSpace, String> {
    let mut disk = lock(disk);
    let space = statvfs_space(disk.mount_point())?;
    if cfg!(target_os = "linux") {
        return Ok(space);
    }
    // macOS: the figures Finder shows, which `statvfs` does not give.
    disk.refresh_specifics(DiskRefreshKind::nothing().with_storage());
    Ok(VolumeSpace {
        total_bytes: disk.total_space(),
        free_bytes: disk.available_space(),
    })
}

/// Total and available-to-the-user bytes from `statvfs`, or why the call failed.
#[cfg(unix)]
fn statvfs_space(mount_point: &Path) -> Result<VolumeSpace, String> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(mount_point.as_os_str().as_bytes())
        .map_err(|_| "the mount point holds a NUL byte".to_owned())?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    loop {
        // SAFETY: `path` is NUL-terminated and `stat` is writable for one `statvfs`.
        if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } == 0 {
            break;
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error.to_string());
        }
    }
    // SAFETY: `statvfs` returned 0, so it filled `stat`.
    let stat = unsafe { stat.assume_init() };
    // `fsblkcnt_t` is `u32` on macOS and `u64` on Linux.
    #[allow(clippy::useless_conversion)]
    let (blocks, available, block_size) = (
        u64::from(stat.f_blocks),
        u64::from(stat.f_bavail),
        u64::from(stat.f_frsize),
    );
    Ok(VolumeSpace {
        total_bytes: blocks.saturating_mul(block_size),
        free_bytes: available.saturating_mul(block_size),
    })
}

/// Total and free bytes relative to the calling user, so a quota applies to both (D31).
#[cfg(windows)]
fn caller_space(mount_point: &Path) -> std::io::Result<VolumeSpace> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = mount_point
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free_to_caller = 0_u64;
    let mut total_for_caller = 0_u64;
    // SAFETY: `wide` is NUL-terminated and outlives the call; the last output may be null.
    let succeeded = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &raw mut free_to_caller,
            &raw mut total_for_caller,
            std::ptr::null_mut(),
        )
    };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(VolumeSpace {
        total_bytes: total_for_caller,
        free_bytes: free_to_caller,
    })
}

/// Whether each mount point of `/proc/self/mounts` has the `ro` option; the last line for a mount
/// point wins, as the latest mount covers the earlier ones (D33).
#[cfg(any(target_os = "linux", test))]
fn read_only_mounts(mounts: &str) -> HashMap<PathBuf, bool> {
    mounts
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_ascii_whitespace();
            let mount_point = decode_mount_field(fields.nth(1)?);
            let options = fields.nth(1)?;
            Some((mount_point, options.split(',').any(|option| option == "ro")))
        })
        .collect()
}

/// Decodes the `\ooo` octal escapes the kernel writes for spaces, tabs, newlines and backslashes.
#[cfg(any(target_os = "linux", test))]
fn decode_mount_field(field: &str) -> PathBuf {
    let bytes = field.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escape = bytes.get(index + 1..index + 4).filter(|digits| {
            bytes[index] == b'\\' && digits.iter().all(|digit| (b'0'..=b'7').contains(digit))
        });
        match escape {
            Some(digits) => {
                let value = digits
                    .iter()
                    .fold(0_u32, |value, digit| value * 8 + u32::from(digit - b'0'));
                decoded.push(u8::try_from(value).unwrap_or(b'?'));
                index += 4;
            }
            None => {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
    }
    PathBuf::from(String::from_utf8_lossy(&decoded).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_does_no_io() {
        let source = NativeHostMetricsSource::new();

        let state = lock(&source.cpu_memory);
        assert!(state.system.cpus().is_empty());
        assert!(state.system.processes().is_empty());
        assert_eq!(state.system.total_memory(), 0);
        assert!(lock(&source.disks).is_empty());
    }

    #[test]
    fn native_source_reads_without_refreshing_processes() {
        let source = NativeHostMetricsSource::new();

        for _ in 0..10 {
            let reading = source.read_cpu_memory().expect("a reading");
            assert!((0.0..=100.0).contains(&reading.cpu_percent), "{reading:?}");
            assert!(reading.memory_used_bytes <= reading.memory_total_bytes);
        }

        assert!(lock(&source.cpu_memory).system.processes().is_empty());
        assert!(source.host_facts().cpu_count >= 1);
    }

    #[test]
    fn read_only_comes_from_the_mount_options() {
        let mounts = "overlay / overlay rw,relatime,lowerdir=/x 0 0\n\
                      /dev/loop0 /mnt/ro-test ext4 ro,relatime 0 0\n\
                      /dev/sdb1 /media/my\\040disk exfat rw,nosuid 0 0\n\
                      /dev/sdc1 /mnt/remounted ext4 rw 0 0\n\
                      /dev/sdc1 /mnt/remounted ext4 ro,noatime 0 0\n";

        let read_only = read_only_mounts(mounts);

        assert_eq!(read_only.get(Path::new("/")), Some(&false));
        assert_eq!(read_only.get(Path::new("/mnt/ro-test")), Some(&true));
        assert_eq!(read_only.get(Path::new("/media/my disk")), Some(&false));
        assert_eq!(read_only.get(Path::new("/mnt/remounted")), Some(&true));
    }

    /// #292 review: a failed capacity read is an error, not the volume's old or zero sizes.
    #[cfg(unix)]
    #[test]
    fn statvfs_space_fails_for_a_missing_mount_point() {
        let error = statvfs_space(Path::new("/bibcode-missing-volume/inner"))
            .expect_err("a missing mount point fails");
        assert!(!error.is_empty());

        let root = statvfs_space(Path::new("/")).expect("the root volume answers");
        assert!(root.total_bytes > 0);
        assert!(root.free_bytes <= root.total_bytes);
    }

    #[cfg(windows)]
    #[test]
    fn caller_space_reads_the_system_drive() {
        let drive = std::env::var_os("SystemDrive").unwrap_or_else(|| "C:".into());
        let mut root = PathBuf::from(drive);
        root.push("\\");

        let space = caller_space(&root).expect("the system drive answers");

        assert!(space.total_bytes > 0);
        assert!(space.free_bytes <= space.total_bytes);
    }
}
