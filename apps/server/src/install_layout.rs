use std::{
    collections::BTreeMap,
    fmt::Write as _,
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

const INSTALL_LAYOUT_SCHEMA_VERSION: u32 = 1;
const WEB_ASSET_SCHEMA_VERSION: u32 = 1;
const PRODUCT: &str = "bibcode-server";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedInstallLayout {
    install_root: PathBuf,
    web_root: PathBuf,
    asset_manifest: PathBuf,
}

impl VerifiedInstallLayout {
    #[must_use]
    pub fn install_root(&self) -> &Path {
        &self.install_root
    }

    #[must_use]
    pub fn web_root(&self) -> &Path {
        &self.web_root
    }

    #[must_use]
    pub fn asset_manifest(&self) -> &Path {
        &self.asset_manifest
    }
}

#[derive(Debug, Error)]
pub enum InstallLayoutError {
    #[error("packaged server executable must not be a symbolic link: {path}")]
    SymbolicLink { path: PathBuf },
    #[error(
        "packaged server metadata is missing below installation root {install_root}; reinstall BiBCode Server"
    )]
    MissingManifest { install_root: PathBuf },
    #[error("packaged server manifest at {path} is invalid")]
    InvalidManifest {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("packaged server manifest at {path} has unsupported schema version {actual}")]
    UnsupportedSchema { path: PathBuf, actual: u32 },
    #[error("packaged server manifest at {path} describes an unexpected product or version")]
    ProductVersion { path: PathBuf },
    #[error("packaged server path escapes installation root {install_root}")]
    PathEscape {
        install_root: PathBuf,
        path: PathBuf,
    },
    #[error("required packaged web asset is missing: {path}")]
    MissingRequiredAsset { path: PathBuf },
    #[error("packaged web asset failed integrity verification: {path}")]
    AssetIntegrity { path: PathBuf },
    #[error("packaged web asset inventory is invalid at {path}")]
    InvalidAssetManifest {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("packaged web asset inventory contains an invalid or duplicate path: {path}")]
    InvalidAssetPath { path: String },
    #[error("packaged web asset inventory does not match the files below {web_root}")]
    AssetInventory { web_root: PathBuf },
    #[error("failed to {operation} packaged server path {path}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallLayoutManifest {
    schema_version: u32,
    product: String,
    package_version: String,
    binary_relative_web_path: String,
    binary_relative_asset_manifest_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WebAssetManifest {
    schema_version: u32,
    files: Vec<WebAssetRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WebAssetRecord {
    path: String,
    size: u64,
    sha256: String,
}

/// Resolves and verifies the packaged web root adjacent to `executable`.
///
/// Development binaries outside a canonical `bin/` directory return `None`.
/// A `bin/bibcode[.exe]` shape is treated as an installation boundary and
/// fails closed when its signed package metadata or assets are incomplete.
pub fn resolve_installed_web_root(
    executable: &Path,
) -> Result<Option<VerifiedInstallLayout>, InstallLayoutError> {
    reject_symlink(executable)?;
    let executable = canonicalize("canonicalize executable", executable)?;
    let Some(binary_directory) = executable.parent() else {
        return Ok(None);
    };
    if !binary_directory
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("bin"))
    {
        return Ok(None);
    }
    let Some(install_root) = binary_directory.parent() else {
        return Ok(None);
    };
    let install_root = install_root.to_path_buf();
    let manifest_path = install_root.join("share/bibcode/install-layout.json");
    if !manifest_path.exists() {
        return Err(InstallLayoutError::MissingManifest { install_root });
    }
    reject_symlink(&manifest_path)?;
    let manifest_bytes = read_bytes("read install manifest", &manifest_path)?;
    let manifest: InstallLayoutManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|source| {
            InstallLayoutError::InvalidManifest {
                path: manifest_path.clone(),
                source,
            }
        })?;
    if manifest.schema_version != INSTALL_LAYOUT_SCHEMA_VERSION {
        return Err(InstallLayoutError::UnsupportedSchema {
            path: manifest_path,
            actual: manifest.schema_version,
        });
    }
    if manifest.product != PRODUCT || manifest.package_version != env!("CARGO_PKG_VERSION") {
        return Err(InstallLayoutError::ProductVersion {
            path: manifest_path,
        });
    }

    let web_root = resolve_package_path(
        binary_directory,
        &install_root,
        &manifest.binary_relative_web_path,
    )?;
    let asset_manifest = resolve_package_path(
        binary_directory,
        &install_root,
        &manifest.binary_relative_asset_manifest_path,
    )?;
    let web_root = canonicalize("canonicalize web root", &web_root)?;
    let asset_manifest = canonicalize("canonicalize web asset manifest", &asset_manifest)?;
    verify_web_assets(&web_root, &asset_manifest)?;

    Ok(Some(VerifiedInstallLayout {
        install_root,
        web_root,
        asset_manifest,
    }))
}

fn resolve_package_path(
    binary_directory: &Path,
    install_root: &Path,
    value: &str,
) -> Result<PathBuf, InstallLayoutError> {
    if value.is_empty() || value.contains('\0') || value.starts_with('/') || value.starts_with('\\')
    {
        return Err(InstallLayoutError::PathEscape {
            install_root: install_root.to_path_buf(),
            path: PathBuf::from(value),
        });
    }
    let mut resolved = binary_directory.to_path_buf();
    for component in value.replace('\\', "/").split('/') {
        match component {
            "" | "." => {}
            ".." => {
                if !resolved.pop() || !resolved.starts_with(install_root) {
                    return Err(InstallLayoutError::PathEscape {
                        install_root: install_root.to_path_buf(),
                        path: PathBuf::from(value),
                    });
                }
            }
            segment if segment.contains(':') => {
                return Err(InstallLayoutError::PathEscape {
                    install_root: install_root.to_path_buf(),
                    path: PathBuf::from(value),
                });
            }
            segment => resolved.push(segment),
        }
    }
    if !resolved.starts_with(install_root) {
        return Err(InstallLayoutError::PathEscape {
            install_root: install_root.to_path_buf(),
            path: resolved,
        });
    }
    reject_symlinks_below(install_root, &resolved)?;
    let canonical = canonicalize("canonicalize package path", &resolved)?;
    if !canonical.starts_with(install_root) {
        return Err(InstallLayoutError::PathEscape {
            install_root: install_root.to_path_buf(),
            path: canonical,
        });
    }
    Ok(canonical)
}

fn verify_web_assets(web_root: &Path, manifest_path: &Path) -> Result<(), InstallLayoutError> {
    if !web_root.join("index.html").is_file() {
        return Err(InstallLayoutError::MissingRequiredAsset {
            path: web_root.join("index.html"),
        });
    }
    let manifest_bytes = read_bytes("read web asset manifest", manifest_path)?;
    let manifest: WebAssetManifest = serde_json::from_slice(&manifest_bytes).map_err(|source| {
        InstallLayoutError::InvalidAssetManifest {
            path: manifest_path.to_path_buf(),
            source,
        }
    })?;
    if manifest.schema_version != WEB_ASSET_SCHEMA_VERSION {
        return Err(InstallLayoutError::UnsupportedSchema {
            path: manifest_path.to_path_buf(),
            actual: manifest.schema_version,
        });
    }

    let mut expected = BTreeMap::new();
    for record in manifest.files {
        let relative = normalized_asset_path(&record.path)?;
        let original_path = record.path.clone();
        if expected.insert(relative, record).is_some() {
            return Err(InstallLayoutError::InvalidAssetPath {
                path: original_path,
            });
        }
    }
    let actual = collect_web_files(web_root)?;
    if actual.keys().ne(expected.keys()) {
        return Err(InstallLayoutError::AssetInventory {
            web_root: web_root.to_path_buf(),
        });
    }
    for (relative, path) in actual {
        let record = expected
            .get(&relative)
            .expect("matching key sets were checked");
        let metadata = std::fs::metadata(&path).map_err(|source| InstallLayoutError::Io {
            operation: "inspect web asset",
            path: path.clone(),
            source,
        })?;
        if metadata.len() != record.size
            || !valid_sha256(&record.sha256)
            || hash_file(&path)? != record.sha256
        {
            return Err(InstallLayoutError::AssetIntegrity { path });
        }
    }
    Ok(())
}

fn normalized_asset_path(value: &str) -> Result<String, InstallLayoutError> {
    if value.is_empty() || value.contains('\0') || value.starts_with('/') {
        return Err(InstallLayoutError::InvalidAssetPath {
            path: value.to_owned(),
        });
    }
    let normalized = value.replace('\\', "/");
    if normalized.split('/').any(|component| {
        component.is_empty() || component == "." || component == ".." || component.contains(':')
    }) {
        return Err(InstallLayoutError::InvalidAssetPath {
            path: value.to_owned(),
        });
    }
    Ok(normalized)
}

fn collect_web_files(web_root: &Path) -> Result<BTreeMap<String, PathBuf>, InstallLayoutError> {
    let mut pending = vec![web_root.to_path_buf()];
    let mut files = BTreeMap::new();
    while let Some(directory) = pending.pop() {
        let entries = std::fs::read_dir(&directory).map_err(|source| InstallLayoutError::Io {
            operation: "read web asset directory",
            path: directory.clone(),
            source,
        })?;
        for entry in entries {
            let entry = entry.map_err(|source| InstallLayoutError::Io {
                operation: "read web asset entry",
                path: directory.clone(),
                source,
            })?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|source| InstallLayoutError::Io {
                operation: "inspect web asset entry",
                path: path.clone(),
                source,
            })?;
            if file_type.is_symlink() {
                return Err(InstallLayoutError::SymbolicLink { path });
            }
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            if !file_type.is_file() {
                return Err(InstallLayoutError::AssetIntegrity { path });
            }
            let relative = path
                .strip_prefix(web_root)
                .expect("walk remains below web root")
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            files.insert(relative, path);
        }
    }
    Ok(files)
}

fn reject_symlinks_below(root: &Path, path: &Path) -> Result<(), InstallLayoutError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| InstallLayoutError::PathEscape {
            install_root: root.to_path_buf(),
            path: path.to_path_buf(),
        })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        reject_symlink(&current)?;
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), InstallLayoutError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|source| InstallLayoutError::Io {
        operation: "inspect",
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.file_type().is_symlink() {
        return Err(InstallLayoutError::SymbolicLink {
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

fn canonicalize(operation: &'static str, path: &Path) -> Result<PathBuf, InstallLayoutError> {
    std::fs::canonicalize(path).map_err(|source| InstallLayoutError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    })
}

fn read_bytes(operation: &'static str, path: &Path) -> Result<Vec<u8>, InstallLayoutError> {
    std::fs::read(path).map_err(|source| InstallLayoutError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn hash_file(path: &Path) -> Result<String, InstallLayoutError> {
    let mut file = File::open(path).map_err(|source| InstallLayoutError::Io {
        operation: "open web asset",
        path: path.to_path_buf(),
        source,
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|source| InstallLayoutError::Io {
                operation: "hash web asset",
                path: path.to_path_buf(),
                source,
            })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .fold(String::with_capacity(64), |mut output, byte| {
            write!(output, "{byte:02x}").expect("write digest");
            output
        }))
}
