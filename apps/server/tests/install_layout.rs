use std::{fmt::Write, path::PathBuf};

use bibcode_server::{
    ServerConfig, ServerRuntime,
    install_layout::{InstallLayoutError, resolve_installed_web_root},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

struct PackagedLayout {
    _temp: TempDir,
    executable: PathBuf,
    root: PathBuf,
    web_root: PathBuf,
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut output, byte| {
            write!(output, "{byte:02x}").expect("write digest");
            output
        })
}

fn write_layout(path_separator: &str) -> PackagedLayout {
    let temp = TempDir::new().expect("temporary package root");
    let root = temp.path().join("relocated-bibcode-server");
    let executable = root.join("bin").join(if cfg!(windows) {
        "bibcode.exe"
    } else {
        "bibcode"
    });
    let share_root = root.join("share/bibcode");
    let web_root = share_root.join("web");
    std::fs::create_dir_all(executable.parent().expect("binary parent")).expect("binary directory");
    std::fs::create_dir_all(web_root.join("assets")).expect("web asset directory");
    std::fs::write(&executable, b"test-binary").expect("test executable");
    std::fs::write(web_root.join("index.html"), b"<main>BiBCode</main>").expect("web index");
    std::fs::write(web_root.join("assets/app.js"), b"console.log('bibcode')").expect("web script");

    let assets = json!({
        "schemaVersion": 1,
        "files": [
            {
                "path": "assets/app.js",
                "size": 22,
                "sha256": sha256_hex(b"console.log('bibcode')")
            },
            {
                "path": "index.html",
                "size": 20,
                "sha256": sha256_hex(b"<main>BiBCode</main>")
            }
        ]
    });
    std::fs::write(
        share_root.join("web-assets.json"),
        serde_json::to_vec_pretty(&assets).expect("asset manifest JSON"),
    )
    .expect("asset manifest");

    let relative_web = ["..", "share", "bibcode", "web"].join(path_separator);
    let relative_assets = ["..", "share", "bibcode", "web-assets.json"].join(path_separator);
    let layout = json!({
        "schemaVersion": 1,
        "product": "bibcode-server",
        "packageVersion": env!("CARGO_PKG_VERSION"),
        "binaryRelativeWebPath": relative_web,
        "binaryRelativeAssetManifestPath": relative_assets
    });
    std::fs::write(
        share_root.join("install-layout.json"),
        serde_json::to_vec_pretty(&layout).expect("layout JSON"),
    )
    .expect("layout manifest");

    PackagedLayout {
        _temp: temp,
        executable,
        root,
        web_root,
    }
}

#[test]
fn resolves_a_relocated_verified_package_without_using_the_current_directory() {
    let package = write_layout("/");
    let hostile_cwd = TempDir::new().expect("hostile current directory");
    std::fs::write(hostile_cwd.path().join("index.html"), "hostile")
        .expect("hostile current-directory asset");

    let resolved = resolve_installed_web_root(&package.executable)
        .expect("valid package resolves")
        .expect("package layout is detected");

    assert_eq!(
        resolved.install_root(),
        package.root.canonicalize().unwrap()
    );
    assert_eq!(
        resolved.web_root(),
        package.web_root.canonicalize().unwrap()
    );
}

#[test]
fn accepts_windows_and_posix_manifest_separators() {
    for separator in ["/", "\\"] {
        let package = write_layout(separator);
        assert!(
            resolve_installed_web_root(&package.executable)
                .expect("separator is normalized")
                .is_some()
        );
    }
}

#[test]
fn server_config_prefers_an_explicit_static_override_and_otherwise_uses_the_package() {
    let package = write_layout("/");
    let explicit = package.root.join("explicit-web");
    let configured = ServerConfig::new(package.root.join("state"))
        .with_installed_layout_from_executable(&package.executable)
        .expect("installed layout configures web assets");
    assert_eq!(
        configured.static_dir.as_deref(),
        Some(package.web_root.canonicalize().unwrap().as_path())
    );
    assert_eq!(
        configured
            .installed_layout
            .as_ref()
            .expect("installed layout diagnostics")
            .install_root(),
        package.root.canonicalize().unwrap()
    );

    let overridden = ServerConfig::new(package.root.join("state"))
        .with_static_dir(&explicit)
        .with_installed_layout_from_executable(package.root.join("bin/missing"))
        .expect("explicit admin override does not inspect package metadata");
    assert_eq!(overridden.static_dir.as_deref(), Some(explicit.as_path()));
    assert!(overridden.installed_layout.is_none());
}

#[tokio::test]
async fn packaged_runtime_serves_the_verified_same_origin_ui() {
    let package = write_layout("/");
    let state_root = package._temp.path().join("state");
    std::fs::create_dir_all(&state_root).expect("packaged state root");
    let config = ServerConfig::new(&state_root)
        .with_bind("127.0.0.1", 0)
        .with_installed_layout_from_executable(&package.executable)
        .expect("installed layout configures web assets");
    let handle = ServerRuntime::start(config)
        .await
        .expect("packaged server starts");

    let response = reqwest::get(format!("http://{}/", handle.local_addr()))
        .await
        .expect("packaged UI response");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "<main>BiBCode</main>");

    handle.shutdown();
    handle.join().await.expect("packaged server joins");
}

#[test]
fn rejects_missing_or_altered_required_web_assets() {
    let missing = write_layout("/");
    std::fs::remove_file(missing.web_root.join("index.html")).expect("remove index");
    assert!(matches!(
        resolve_installed_web_root(&missing.executable),
        Err(InstallLayoutError::MissingRequiredAsset { .. })
    ));

    let altered = write_layout("/");
    std::fs::write(altered.web_root.join("assets/app.js"), "altered").expect("alter staged asset");
    assert!(matches!(
        resolve_installed_web_root(&altered.executable),
        Err(InstallLayoutError::AssetIntegrity { .. })
    ));
}

#[test]
fn rejects_a_binary_shaped_install_when_package_metadata_is_missing() {
    let temp = TempDir::new().expect("temporary package root");
    let executable = temp.path().join("bin/bibcode");
    std::fs::create_dir_all(executable.parent().unwrap()).expect("binary directory");
    std::fs::write(&executable, "binary").expect("binary fixture");

    assert!(matches!(
        resolve_installed_web_root(&executable),
        Err(InstallLayoutError::MissingManifest { .. })
    ));
}

#[cfg(unix)]
#[test]
fn rejects_executable_and_static_root_symlinks() {
    use std::os::unix::fs::symlink;

    let executable_link = write_layout("/");
    let link = executable_link.root.join("bin/bibcode-link");
    symlink(&executable_link.executable, &link).expect("executable symlink");
    assert!(matches!(
        resolve_installed_web_root(&link),
        Err(InstallLayoutError::SymbolicLink { .. })
    ));

    let escaped_root = write_layout("/");
    let external = TempDir::new().expect("external web root");
    std::fs::write(external.path().join("index.html"), "external").expect("external index");
    std::fs::remove_dir_all(&escaped_root.web_root).expect("remove owned web root");
    symlink(external.path(), &escaped_root.web_root).expect("escaped web symlink");
    assert!(matches!(
        resolve_installed_web_root(&escaped_root.executable),
        Err(InstallLayoutError::SymbolicLink { .. } | InstallLayoutError::PathEscape { .. })
    ));
}

#[cfg(unix)]
#[test]
fn resolves_from_a_read_only_installation() {
    use std::os::unix::fs::PermissionsExt;

    let package = write_layout("/");
    for path in [
        &package.root,
        package.root.join("bin").as_path(),
        package.web_root.as_path(),
    ] {
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o555);
        std::fs::set_permissions(path, permissions).expect("read-only package permissions");
    }

    let result = resolve_installed_web_root(&package.executable);

    let mut permissions = std::fs::metadata(&package.root).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&package.root, permissions).expect("restore temporary root");
    assert!(result.expect("read-only package resolves").is_some());
}
