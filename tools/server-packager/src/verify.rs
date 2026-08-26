use std::{
    collections::BTreeSet,
    fmt::Write as _,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use crate::{
    PackagerError,
    model::{
        ArtifactArchitecture, ArtifactFormat, ArtifactManifest, ArtifactOs, ArtifactRecord,
        BinarySigning, PackageSigning, ReleaseChannel,
    },
};

pub fn verify_manifest_bytes(
    bytes: &[u8],
    artifact_root: &Path,
    allow_unsigned_test: bool,
) -> Result<ArtifactManifest, PackagerError> {
    let manifest: ArtifactManifest = serde_json::from_slice(bytes)
        .map_err(|error| PackagerError::Manifest(error.to_string()))?;
    verify_manifest(&manifest, artifact_root, allow_unsigned_test)?;
    Ok(manifest)
}

pub fn verify_manifest(
    manifest: &ArtifactManifest,
    artifact_root: &Path,
    allow_unsigned_test: bool,
) -> Result<(), PackagerError> {
    if manifest.schema_version != 1
        || manifest.product != "bibcode-server"
        || manifest.version.trim().is_empty()
        || !valid_source_sha(&manifest.source_sha)
        || time::OffsetDateTime::parse(
            &manifest.generated_at,
            &time::format_description::well_known::Rfc3339,
        )
        .is_err()
        || manifest.required_matrix.is_empty()
        || manifest.artifacts.is_empty()
        || !safe_basename(&manifest.manifest_signature_name)
    {
        return Err(PackagerError::Manifest(
            "manifest metadata is incomplete or invalid".to_owned(),
        ));
    }
    if manifest.channel == ReleaseChannel::UnsignedTest && !allow_unsigned_test {
        return Err(PackagerError::Manifest(
            "unsigned-test releases require an explicit verifier opt-in".to_owned(),
        ));
    }
    let required = manifest
        .required_matrix
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if required.len() != manifest.required_matrix.len() {
        return Err(PackagerError::Manifest(
            "required matrix contains duplicate tuples".to_owned(),
        ));
    }
    for requirement in &required {
        validate_tuple(
            &requirement.target_triple,
            &requirement.os,
            &requirement.architecture,
            &requirement.format,
        )?;
    }

    let mut records = BTreeSet::new();
    let mut names = BTreeSet::from([manifest.manifest_signature_name.clone()]);
    for record in &manifest.artifacts {
        validate_record(manifest, record)?;
        let requirement = record.requirement();
        if !required.contains(&requirement)
            || !records.insert(requirement)
            || ![
                &record.download_name,
                &record.signature_name,
                &record.sbom_name,
            ]
            .iter()
            .all(|name| names.insert((*name).clone()))
        {
            return Err(PackagerError::Manifest(
                "artifact records do not match the required matrix exactly".to_owned(),
            ));
        }
        verify_record_files(record, artifact_root)?;
    }
    if records != required {
        return Err(PackagerError::Manifest(
            "a required artifact tuple has no record".to_owned(),
        ));
    }
    let has_universal = manifest
        .artifacts
        .iter()
        .any(|record| record.architecture == ArtifactArchitecture::Universal);
    if has_universal
        && ![ArtifactArchitecture::X86_64, ArtifactArchitecture::Aarch64]
            .iter()
            .all(|architecture| {
                manifest.artifacts.iter().any(|record| {
                    record.os == ArtifactOs::Macos && &record.architecture == architecture
                })
            })
    {
        return Err(PackagerError::Manifest(
            "universal macOS output requires both native slices".to_owned(),
        ));
    }
    if manifest.channel != ReleaseChannel::UnsignedTest {
        verify_plain_file(artifact_root, &manifest.manifest_signature_name)?;
    }
    Ok(())
}

fn validate_record(
    manifest: &ArtifactManifest,
    record: &ArtifactRecord,
) -> Result<(), PackagerError> {
    validate_tuple(
        &record.target_triple,
        &record.os,
        &record.architecture,
        &record.format,
    )?;
    if record.product != manifest.product
        || record.version != manifest.version
        || record.source_sha != manifest.source_sha
        || record.size == 0
        || !valid_sha256(&record.sha256)
        || !safe_basename(&record.download_name)
        || !safe_basename(&record.signature_name)
        || !safe_basename(&record.sbom_name)
        || BTreeSet::from([
            record.download_name.as_str(),
            record.signature_name.as_str(),
            record.sbom_name.as_str(),
        ])
        .len()
            != 3
    {
        return Err(PackagerError::Manifest(
            "artifact record identity or file links are invalid".to_owned(),
        ));
    }
    let certificate_signed = matches!(
        record.native_signing.binary,
        BinarySigning::Authenticode | BinarySigning::DeveloperId
    ) || record.native_signing.package != PackageSigning::None;
    if record.native_signing.verified != certificate_signed {
        return Err(PackagerError::Manifest(
            "native signing verification state is inconsistent".to_owned(),
        ));
    }
    if record.notarized
        && (record.os != ArtifactOs::Macos
            || record.native_signing.package != PackageSigning::DeveloperId
            || !record.native_signing.verified)
    {
        return Err(PackagerError::Manifest(
            "notarization state is inconsistent".to_owned(),
        ));
    }
    if manifest.channel == ReleaseChannel::Stable
        && record.os == ArtifactOs::Windows
        && (record.native_signing.binary != BinarySigning::Authenticode
            || !record.native_signing.verified
            || (record.format == ArtifactFormat::Msi
                && record.native_signing.package != PackageSigning::Authenticode))
    {
        return Err(PackagerError::Manifest(
            "stable Windows artifacts require verified Authenticode signatures".to_owned(),
        ));
    }
    Ok(())
}

fn validate_tuple(
    target_triple: &str,
    os: &ArtifactOs,
    architecture: &ArtifactArchitecture,
    format: &ArtifactFormat,
) -> Result<(), PackagerError> {
    let expected = match (os, architecture) {
        (ArtifactOs::Windows, ArtifactArchitecture::X86_64) => "x86_64-pc-windows-msvc",
        (ArtifactOs::Windows, ArtifactArchitecture::Aarch64) => "aarch64-pc-windows-msvc",
        (ArtifactOs::Macos, ArtifactArchitecture::X86_64) => "x86_64-apple-darwin",
        (ArtifactOs::Macos, ArtifactArchitecture::Aarch64) => "aarch64-apple-darwin",
        (ArtifactOs::Macos, ArtifactArchitecture::Universal) => "universal-apple-darwin",
        (ArtifactOs::Linux, ArtifactArchitecture::X86_64) => "x86_64-unknown-linux-gnu",
        (ArtifactOs::Linux, ArtifactArchitecture::Aarch64) => "aarch64-unknown-linux-gnu",
        _ => "",
    };
    let format_matches = match format {
        ArtifactFormat::Zip | ArtifactFormat::Msi => *os == ArtifactOs::Windows,
        ArtifactFormat::Pkg => *os == ArtifactOs::Macos,
        ArtifactFormat::Deb | ArtifactFormat::Rpm => *os == ArtifactOs::Linux,
        ArtifactFormat::TarGz => matches!(os, ArtifactOs::Macos | ArtifactOs::Linux),
    };
    if target_triple != expected || !format_matches {
        return Err(PackagerError::Manifest(
            "artifact target triple or OS format is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn verify_record_files(record: &ArtifactRecord, root: &Path) -> Result<(), PackagerError> {
    let artifact = verify_plain_file(root, &record.download_name)?;
    verify_plain_file(root, &record.signature_name)?;
    verify_plain_file(root, &record.sbom_name)?;
    let metadata = artifact.metadata().map_err(|source| PackagerError::Io {
        operation: "inspect artifact",
        path: artifact.clone(),
        source,
    })?;
    if metadata.len() != record.size || hash_file(&artifact)? != record.sha256 {
        return Err(PackagerError::Integrity(record.download_name.clone()));
    }
    Ok(())
}

fn verify_plain_file(root: &Path, name: &str) -> Result<PathBuf, PackagerError> {
    if !safe_basename(name) {
        return Err(PackagerError::UnsafePath(name.to_owned()));
    }
    let path = root.join(name);
    let metadata = std::fs::symlink_metadata(&path).map_err(|source| PackagerError::Io {
        operation: "inspect artifact file",
        path: path.clone(),
        source,
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PackagerError::UnsafePath(name.to_owned()));
    }
    Ok(path)
}

fn safe_basename(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-' | b'+'))
        })
}

fn valid_source_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hash_file(path: &Path) -> Result<String, PackagerError> {
    let mut file = File::open(path).map_err(|source| PackagerError::Io {
        operation: "open artifact",
        path: path.to_path_buf(),
        source,
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|source| PackagerError::Io {
            operation: "hash artifact",
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
