use std::{
    fs, io,
    path::{Path, PathBuf},
};

use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum IdentityPathMigrationError {
    #[error("failed to inspect identity path {path}")]
    Inspect {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("legacy identity path is not a directory: {0}")]
    LegacyNotDirectory(PathBuf),
    #[error("identity migration does not follow symbolic links: {0}")]
    SymbolicLink(PathBuf),
    #[error("failed to copy identity data from {source_path} to {destination_path}")]
    Copy {
        source_path: PathBuf,
        destination_path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("canonical identity path appeared during migration: {0}")]
    DestinationCollision(PathBuf),
    #[error("failed to activate canonical identity path {path}")]
    Activate {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

pub fn resolve_bibcode_directory(
    canonical_path: &Path,
    legacy_path: &Path,
) -> Result<PathBuf, IdentityPathMigrationError> {
    if canonical_path.exists() {
        return Ok(canonical_path.to_path_buf());
    }
    let legacy_metadata = match fs::symlink_metadata(legacy_path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            return Ok(canonical_path.to_path_buf());
        }
        Err(source) => {
            return Err(IdentityPathMigrationError::Inspect {
                path: legacy_path.to_path_buf(),
                source,
            });
        }
    };
    if !legacy_metadata.is_dir() {
        return Err(IdentityPathMigrationError::LegacyNotDirectory(
            legacy_path.to_path_buf(),
        ));
    }

    let parent = canonical_path.parent().unwrap_or_else(|| Path::new("."));
    let staging_path = parent.join(format!(
        ".bibcode-migration-{}.stage",
        Uuid::new_v4().simple()
    ));
    let migration = (|| {
        copy_directory(legacy_path, &staging_path)?;
        if canonical_path.exists() {
            return Err(IdentityPathMigrationError::DestinationCollision(
                canonical_path.to_path_buf(),
            ));
        }
        fs::rename(&staging_path, canonical_path).map_err(|source| {
            if canonical_path.exists() {
                IdentityPathMigrationError::DestinationCollision(canonical_path.to_path_buf())
            } else {
                IdentityPathMigrationError::Activate {
                    path: canonical_path.to_path_buf(),
                    source,
                }
            }
        })?;
        Ok(canonical_path.to_path_buf())
    })();
    if migration.is_err() && staging_path.exists() {
        let _ = fs::remove_dir_all(&staging_path);
    }
    migration
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), IdentityPathMigrationError> {
    fs::create_dir(destination).map_err(|error| copy_error(source, destination, error))?;
    for entry in fs::read_dir(source).map_err(|error| copy_error(source, destination, error))? {
        let entry = entry.map_err(|error| copy_error(source, destination, error))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| copy_error(&source_path, &destination_path, error))?;
        if metadata.file_type().is_symlink() {
            return Err(IdentityPathMigrationError::SymbolicLink(source_path));
        }
        if metadata.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| copy_error(&source_path, &destination_path, error))?;
            fs::set_permissions(&destination_path, metadata.permissions())
                .map_err(|error| copy_error(&source_path, &destination_path, error))?;
        } else {
            return Err(IdentityPathMigrationError::LegacyNotDirectory(source_path));
        }
    }
    Ok(())
}

fn copy_error(source: &Path, destination: &Path, error: io::Error) -> IdentityPathMigrationError {
    IdentityPathMigrationError::Copy {
        source_path: source.to_path_buf(),
        destination_path: destination.to_path_buf(),
        source: error,
    }
}
