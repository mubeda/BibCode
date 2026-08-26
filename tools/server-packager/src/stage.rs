use std::{fs, path::Path};

use crate::PackagerError;

pub struct StageInputs<'a> {
    pub binary: &'a Path,
    pub web_root: &'a Path,
    pub web_asset_manifest: &'a Path,
    pub install_layout: &'a Path,
    pub license: &'a Path,
    pub notices: &'a Path,
    pub portable_readme: &'a Path,
    pub build_metadata: &'a Path,
    pub output: &'a Path,
}

pub fn stage_server(inputs: StageInputs<'_>) -> Result<(), PackagerError> {
    if inputs.output.exists() {
        return Err(PackagerError::UnsafePath(
            inputs.output.display().to_string(),
        ));
    }
    for path in [
        inputs.binary,
        inputs.web_root,
        inputs.web_asset_manifest,
        inputs.install_layout,
        inputs.license,
        inputs.notices,
        inputs.portable_readme,
        inputs.build_metadata,
    ] {
        reject_link(path)?;
    }
    let binary_name = inputs
        .binary
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|name| matches!(*name, "bibcode" | "bibcode.exe"))
        .ok_or_else(|| PackagerError::UnsafePath(inputs.binary.display().to_string()))?;
    if !inputs.binary.is_file() || !inputs.web_root.is_dir() {
        return Err(PackagerError::UnsafePath(
            "staging inputs have unexpected file kinds".to_owned(),
        ));
    }
    let parent = inputs
        .output
        .parent()
        .ok_or_else(|| PackagerError::UnsafePath(inputs.output.display().to_string()))?;
    fs::create_dir_all(parent).map_err(|source| PackagerError::Io {
        operation: "create staging parent",
        path: parent.to_path_buf(),
        source,
    })?;
    let temporary = parent.join(format!(
        ".{}.staging-{}",
        inputs
            .output
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("bibcode-server"),
        std::process::id()
    ));
    if temporary.exists() {
        return Err(PackagerError::UnsafePath(temporary.display().to_string()));
    }
    let result = (|| {
        let bin = temporary.join("bin");
        let share = temporary.join("share/bibcode");
        fs::create_dir_all(&bin).map_err(|source| PackagerError::Io {
            operation: "create staged binary directory",
            path: bin.clone(),
            source,
        })?;
        fs::create_dir_all(&share).map_err(|source| PackagerError::Io {
            operation: "create staged share directory",
            path: share.clone(),
            source,
        })?;
        copy_file(inputs.binary, &bin.join(binary_name), true)?;
        copy_tree(inputs.web_root, &share.join("web"))?;
        copy_file(
            inputs.web_asset_manifest,
            &share.join("web-assets.json"),
            false,
        )?;
        copy_file(
            inputs.install_layout,
            &share.join("install-layout.json"),
            false,
        )?;
        copy_file(inputs.license, &share.join("LICENSE"), false)?;
        copy_file(inputs.notices, &share.join("THIRD-PARTY-NOTICES.md"), false)?;
        copy_file(
            inputs.build_metadata,
            &share.join("build-metadata.json"),
            false,
        )?;
        copy_file(inputs.portable_readme, &temporary.join("README.md"), false)?;
        fs::rename(&temporary, inputs.output).map_err(|source| PackagerError::Io {
            operation: "publish staged layout",
            path: inputs.output.to_path_buf(),
            source,
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), PackagerError> {
    reject_link(source)?;
    fs::create_dir_all(destination).map_err(|source_error| PackagerError::Io {
        operation: "create staged directory",
        path: destination.to_path_buf(),
        source: source_error,
    })?;
    for entry in fs::read_dir(source).map_err(|source_error| PackagerError::Io {
        operation: "read staging input directory",
        path: source.to_path_buf(),
        source: source_error,
    })? {
        let entry = entry.map_err(|source_error| PackagerError::Io {
            operation: "read staging input entry",
            path: source.to_path_buf(),
            source: source_error,
        })?;
        let path = entry.path();
        reject_link(&path)?;
        let target = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|source_error| PackagerError::Io {
                operation: "inspect staging input",
                path: path.clone(),
                source: source_error,
            })?;
        if file_type.is_dir() {
            copy_tree(&path, &target)?;
        } else if file_type.is_file() {
            copy_file(&path, &target, false)?;
        } else {
            return Err(PackagerError::UnsafePath(path.display().to_string()));
        }
    }
    set_mode(destination, 0o755)?;
    Ok(())
}

fn copy_file(source: &Path, destination: &Path, executable: bool) -> Result<(), PackagerError> {
    reject_link(source)?;
    fs::copy(source, destination).map_err(|source_error| PackagerError::Io {
        operation: "copy staged file",
        path: source.to_path_buf(),
        source: source_error,
    })?;
    set_mode(destination, if executable { 0o755 } else { 0o644 })
}

fn reject_link(path: &Path) -> Result<(), PackagerError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| PackagerError::Io {
        operation: "inspect staging input",
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.file_type().is_symlink() {
        return Err(PackagerError::UnsafePath(path.display().to_string()));
    }
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), PackagerError> {
    use std::os::unix::fs::PermissionsExt as _;

    let permissions = fs::Permissions::from_mode(mode);
    fs::set_permissions(path, permissions).map_err(|source| PackagerError::Io {
        operation: "normalize staged permissions",
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), PackagerError> {
    Ok(())
}
