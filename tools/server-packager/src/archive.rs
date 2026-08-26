use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use flate2::{Compression, GzBuilder};
use tar::{Builder as TarBuilder, EntryType, Header};
use zip::{CompressionMethod, DateTime, ZipWriter, write::SimpleFileOptions};

use crate::PackagerError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArchiveFormat {
    Zip,
    TarGz,
}

struct ArchiveEntry {
    source: PathBuf,
    archive_path: String,
    directory: bool,
    executable: bool,
}

pub fn archive_directory(
    source_root: &Path,
    output: &Path,
    format: ArchiveFormat,
    source_date_epoch: i64,
) -> Result<(), PackagerError> {
    if output.exists() {
        return Err(PackagerError::UnsafePath(output.display().to_string()));
    }
    let entries = collect_entries(source_root)?;
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|source| PackagerError::Io {
            operation: "create archive directory",
            path: parent.to_path_buf(),
            source,
        })?;
    }
    match format {
        ArchiveFormat::Zip => write_zip(output, &entries, source_date_epoch),
        ArchiveFormat::TarGz => write_tar_gz(output, &entries, source_date_epoch),
    }
}

fn collect_entries(root: &Path) -> Result<Vec<ArchiveEntry>, PackagerError> {
    let root = std::fs::canonicalize(root).map_err(|source| PackagerError::Io {
        operation: "canonicalize staging root",
        path: root.to_path_buf(),
        source,
    })?;
    let package_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PackagerError::UnsafePath(root.display().to_string()))?;
    let mut pending = vec![root.clone()];
    let mut entries = Vec::new();
    while let Some(directory) = pending.pop() {
        let children = std::fs::read_dir(&directory).map_err(|source| PackagerError::Io {
            operation: "read staging directory",
            path: directory.clone(),
            source,
        })?;
        for child in children {
            let child = child.map_err(|source| PackagerError::Io {
                operation: "read staging entry",
                path: directory.clone(),
                source,
            })?;
            let path = child.path();
            let file_type = child.file_type().map_err(|source| PackagerError::Io {
                operation: "inspect staging entry",
                path: path.clone(),
                source,
            })?;
            if file_type.is_symlink() || (!file_type.is_dir() && !file_type.is_file()) {
                return Err(PackagerError::UnsafePath(path.display().to_string()));
            }
            let relative = path
                .strip_prefix(&root)
                .expect("walk remains below staging root")
                .components()
                .map(|component| {
                    component
                        .as_os_str()
                        .to_str()
                        .ok_or_else(|| PackagerError::UnsafePath(path.display().to_string()))
                })
                .collect::<Result<Vec<_>, _>>()?
                .join("/");
            let archive_path = format!("{package_name}/{relative}");
            let executable = !file_type.is_dir()
                && path
                    .parent()
                    .and_then(Path::file_name)
                    .is_some_and(|parent| parent == "bin");
            entries.push(ArchiveEntry {
                source: path.clone(),
                archive_path,
                directory: file_type.is_dir(),
                executable,
            });
            if file_type.is_dir() {
                pending.push(path);
            }
        }
    }
    entries.sort_by(|left, right| {
        left.archive_path
            .as_bytes()
            .cmp(right.archive_path.as_bytes())
    });
    Ok(entries)
}

fn write_tar_gz(
    output: &Path,
    entries: &[ArchiveEntry],
    source_date_epoch: i64,
) -> Result<(), PackagerError> {
    let epoch = u64::try_from(source_date_epoch).map_err(|_| {
        PackagerError::Manifest("SOURCE_DATE_EPOCH must be non-negative".to_owned())
    })?;
    let gzip_epoch = u32::try_from(epoch).unwrap_or(u32::MAX);
    let output_file = File::create(output).map_err(|source| PackagerError::Io {
        operation: "create tar.gz archive",
        path: output.to_path_buf(),
        source,
    })?;
    let encoder = GzBuilder::new()
        .mtime(gzip_epoch)
        .write(output_file, Compression::best());
    let mut builder = TarBuilder::new(encoder);
    for entry in entries {
        let mut header = Header::new_gnu();
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(epoch);
        header.set_mode(if entry.directory || entry.executable {
            0o755
        } else {
            0o644
        });
        if entry.directory {
            header.set_entry_type(EntryType::Directory);
            header.set_size(0);
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    format!("{}/", entry.archive_path),
                    std::io::empty(),
                )
                .map_err(|source| PackagerError::Io {
                    operation: "append tar directory",
                    path: entry.source.clone(),
                    source,
                })?;
        } else {
            let mut file = File::open(&entry.source).map_err(|source| PackagerError::Io {
                operation: "open staged file",
                path: entry.source.clone(),
                source,
            })?;
            let size = file
                .metadata()
                .map_err(|source| PackagerError::Io {
                    operation: "inspect staged file",
                    path: entry.source.clone(),
                    source,
                })?
                .len();
            header.set_entry_type(EntryType::Regular);
            header.set_size(size);
            header.set_cksum();
            builder
                .append_data(&mut header, &entry.archive_path, &mut file)
                .map_err(|source| PackagerError::Io {
                    operation: "append tar file",
                    path: entry.source.clone(),
                    source,
                })?;
        }
    }
    let encoder = builder.into_inner().map_err(|source| PackagerError::Io {
        operation: "finish tar archive",
        path: output.to_path_buf(),
        source,
    })?;
    encoder.finish().map_err(|source| PackagerError::Io {
        operation: "finish gzip archive",
        path: output.to_path_buf(),
        source,
    })?;
    Ok(())
}

fn write_zip(
    output: &Path,
    entries: &[ArchiveEntry],
    source_date_epoch: i64,
) -> Result<(), PackagerError> {
    let timestamp = time::OffsetDateTime::from_unix_timestamp(source_date_epoch)
        .map_err(|_| PackagerError::Manifest("SOURCE_DATE_EPOCH is invalid".to_owned()))?;
    let year = timestamp.year().clamp(1980, 2107) as u16;
    let modified = DateTime::from_date_and_time(
        year,
        u8::from(timestamp.month()),
        timestamp.day(),
        timestamp.hour(),
        timestamp.minute(),
        timestamp.second().min(58),
    )
    .map_err(|_| PackagerError::Manifest("SOURCE_DATE_EPOCH is not ZIP-compatible".to_owned()))?;
    let output_file = File::create(output).map_err(|source| PackagerError::Io {
        operation: "create ZIP archive",
        path: output.to_path_buf(),
        source,
    })?;
    let mut writer = ZipWriter::new(output_file);
    for entry in entries {
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .last_modified_time(modified)
            .unix_permissions(if entry.directory || entry.executable {
                0o755
            } else {
                0o644
            });
        if entry.directory {
            writer.add_directory(format!("{}/", entry.archive_path), options)?;
        } else {
            writer.start_file(&entry.archive_path, options)?;
            let mut file = File::open(&entry.source).map_err(|source| PackagerError::Io {
                operation: "open staged file",
                path: entry.source.clone(),
                source,
            })?;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = file.read(&mut buffer).map_err(|source| PackagerError::Io {
                    operation: "read staged file",
                    path: entry.source.clone(),
                    source,
                })?;
                if read == 0 {
                    break;
                }
                writer
                    .write_all(&buffer[..read])
                    .map_err(|source| PackagerError::Io {
                        operation: "write ZIP archive",
                        path: output.to_path_buf(),
                        source,
                    })?;
            }
        }
    }
    writer.finish()?;
    Ok(())
}
