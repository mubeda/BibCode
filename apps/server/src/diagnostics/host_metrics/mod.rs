//! The host collector: CPU, memory and volume space of the machine the server runs on (#292).

use std::path::PathBuf;

// shortcut: allowed until the collector (Task 11.2) consumes these modules.
#[cfg_attr(not(test), allow(dead_code))]
mod stats;
#[cfg_attr(not(test), allow(dead_code))]
mod volumes;

pub use stats::{ChartBucket, ChartPoint, MeasureStatistics};

/// One volume as the source lists it, before any space read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeDescriptor {
    pub mount_point: PathBuf,
    pub name: String,
    pub file_system: String,
    pub removable: bool,
    pub read_only: bool,
    /// The mount point is a file, as Docker's `/etc/hosts` bind mount is.
    pub is_file: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VolumeState {
    Ok,
    NotResponding,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeReading {
    pub descriptor: VolumeDescriptor,
    /// `None` until the volume first answers.
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    pub state: VolumeState,
}

impl VolumeReading {
    pub fn used_bytes(&self) -> Option<u64> {
        Some(self.total_bytes?.saturating_sub(self.free_bytes?))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HiddenReason {
    Network,
    Overlay,
    FileMount,
    Empty,
    SameStorage { as_mount: PathBuf },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HiddenVolume {
    pub descriptor: VolumeDescriptor,
    pub reason: HiddenReason,
}
