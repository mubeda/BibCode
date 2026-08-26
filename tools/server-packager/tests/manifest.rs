use std::{fmt::Write as _, path::Path};

use bibcode_server_packager::verify::verify_manifest_bytes;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut output, byte| {
            write!(output, "{byte:02x}").unwrap();
            output
        })
}

fn fixture(root: &Path) -> Value {
    let artifact = b"portable-server";
    std::fs::write(root.join("server.tar.gz"), artifact).unwrap();
    std::fs::write(root.join("server.tar.gz.minisig"), "signature").unwrap();
    std::fs::write(root.join("server.cdx.json"), "{}").unwrap();
    json!({
        "schemaVersion": 1,
        "product": "bibcode-server",
        "version": "0.4.2",
        "channel": "unsigned-test",
        "sourceSha": "1".repeat(40),
        "generatedAt": "2036-08-25T12:00:00.000Z",
        "requiredMatrix": [{
            "targetTriple": "x86_64-unknown-linux-gnu",
            "os": "linux",
            "architecture": "x86_64",
            "format": "tar.gz"
        }],
        "artifacts": [{
            "product": "bibcode-server",
            "version": "0.4.2",
            "sourceSha": "1".repeat(40),
            "targetTriple": "x86_64-unknown-linux-gnu",
            "os": "linux",
            "architecture": "x86_64",
            "format": "tar.gz",
            "downloadName": "server.tar.gz",
            "size": artifact.len(),
            "sha256": sha256(artifact),
            "signatureName": "server.tar.gz.minisig",
            "sbomName": "server.cdx.json",
            "nativeSigning": { "binary": "none", "package": "none", "verified": false },
            "notarized": false
        }],
        "manifestSignatureName": "artifacts.json.minisig"
    })
}

fn verify(value: &Value, root: &Path) -> Result<(), String> {
    verify_manifest_bytes(&serde_json::to_vec(value).unwrap(), root, true)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[test]
fn accepts_an_exact_unsigned_test_manifest_and_artifact_inventory() {
    let temp = TempDir::new().unwrap();
    assert!(verify(&fixture(temp.path()), temp.path()).is_ok());
}

#[test]
fn rejects_duplicate_missing_and_extra_matrix_records() {
    let temp = TempDir::new().unwrap();
    let mut duplicate = fixture(temp.path());
    let record = duplicate["artifacts"][0].clone();
    duplicate["artifacts"].as_array_mut().unwrap().push(record);
    assert!(verify(&duplicate, temp.path()).is_err());

    let mut missing = fixture(temp.path());
    missing["artifacts"] = json!([]);
    assert!(verify(&missing, temp.path()).is_err());

    let mut extra = fixture(temp.path());
    extra["requiredMatrix"].as_array_mut().unwrap().push(json!({
        "targetTriple": "aarch64-unknown-linux-gnu",
        "os": "linux",
        "architecture": "aarch64",
        "format": "tar.gz"
    }));
    assert!(verify(&extra, temp.path()).is_err());
}

#[test]
fn rejects_unsafe_names_wrong_hashes_identity_and_target_drift() {
    let temp = TempDir::new().unwrap();
    for (field, value) in [
        ("downloadName", json!("../server.tar.gz")),
        ("signatureName", json!("server∕sig")),
        ("sbomName", json!("server.tar.gz.minisig")),
        ("sha256", json!("0".repeat(64))),
        ("sourceSha", json!("2".repeat(40))),
        ("targetTriple", json!("aarch64-unknown-linux-gnu")),
    ] {
        let mut manifest = fixture(temp.path());
        manifest["artifacts"][0][field] = value;
        assert!(verify(&manifest, temp.path()).is_err(), "field {field}");
    }
}

#[test]
fn rejects_unsigned_stable_windows_records() {
    let temp = TempDir::new().unwrap();
    let mut manifest = fixture(temp.path());
    manifest["channel"] = json!("stable");
    for container in ["requiredMatrix", "artifacts"] {
        manifest[container][0]["targetTriple"] = json!("x86_64-pc-windows-msvc");
        manifest[container][0]["os"] = json!("windows");
        manifest[container][0]["format"] = json!("msi");
    }
    assert!(verify(&manifest, temp.path()).is_err());
}

#[test]
fn rejects_unsigned_test_without_explicit_verifier_permission() {
    let temp = TempDir::new().unwrap();
    let manifest = fixture(temp.path());
    assert!(
        verify_manifest_bytes(&serde_json::to_vec(&manifest).unwrap(), temp.path(), false).is_err()
    );
}
