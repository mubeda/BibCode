use futures_util::StreamExt as _;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::{
    collections::BTreeSet,
    fmt::Write as _,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::AsyncWriteExt as _;
use tokio_util::sync::CancellationToken;

const DEFAULT_SERVER_ARTIFACT_MANIFEST_URL: &str =
    "https://github.com/mubeda/BibCode/releases/latest/download/artifacts.json";
const DEFAULT_SERVER_ARTIFACT_PUBLIC_KEY: &str =
    include_str!("../../../../packaging/server/server-release.pub");
const SERVER_ARTIFACT_MANIFEST_URL_ENV: &str = "BIBCODE_SERVER_ARTIFACT_MANIFEST_URL";
const SERVER_ARTIFACT_MANIFEST_SIGNATURE_URL_ENV: &str =
    "BIBCODE_SERVER_ARTIFACT_MANIFEST_SIGNATURE_URL";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 64 * 1024;
const SERVER_ARTIFACT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServerArtifactRecord {
    pub product: String,
    pub version: String,
    pub source_sha: String,
    pub target_triple: String,
    pub os: String,
    pub architecture: String,
    pub format: String,
    pub download_name: String,
    pub size: u64,
    pub sha256: String,
    pub signature_name: String,
    pub sbom_name: String,
    pub native_signing: NativeSigningState,
    pub notarized: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeSigningState {
    pub binary: String,
    pub package: String,
    pub verified: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ServerArtifactRequest {
    pub version: String,
    pub os: String,
    pub architecture: String,
    pub preferred_formats: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedServerArtifact {
    pub record: ServerArtifactRecord,
    pub manifest_url: url::Url,
    pub artifact_url: url::Url,
    pub signature_url: url::Url,
    public_key: String,
}

#[cfg(test)]
pub(crate) fn resolved_server_artifact_fixture(
    record: ServerArtifactRecord,
) -> ResolvedServerArtifact {
    let manifest_url = url::Url::parse("https://releases.example.test/artifacts.json")
        .expect("artifact fixture manifest URL");
    ResolvedServerArtifact {
        artifact_url: manifest_url
            .join(&record.download_name)
            .expect("artifact fixture download URL"),
        signature_url: manifest_url
            .join(&record.signature_name)
            .expect("artifact fixture signature URL"),
        manifest_url,
        record,
        public_key: String::new(),
    }
}

#[derive(Clone)]
pub(crate) struct ServerArtifactSource {
    client: reqwest::Client,
    manifest_url: url::Url,
    manifest_signature_url: url::Url,
    public_key: String,
}

pub(crate) type ServerArtifactProgress = Arc<dyn Fn(u64, u64) + Send + Sync>;

pub(crate) struct VerifiedServerArtifact {
    pub resolved: ResolvedServerArtifact,
    pub path: PathBuf,
}

impl Drop for VerifiedServerArtifact {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(crate) fn verify_manifest_and_select(
    manifest: &[u8],
    signature: &str,
    public_key: &str,
    manifest_url: &url::Url,
    request: &ServerArtifactRequest,
) -> Result<ResolvedServerArtifact, String> {
    let decoded_public_key = PublicKey::decode(public_key)
        .map_err(|_| "The server artifact public key is invalid.".to_string())?;
    let signature = Signature::decode(signature)
        .map_err(|_| "The server artifact manifest signature is invalid.".to_string())?;
    decoded_public_key
        .verify(manifest, &signature, false)
        .map_err(|_| "The server artifact manifest signature did not verify.".to_string())?;

    let manifest: ServerArtifactManifest = serde_json::from_slice(manifest)
        .map_err(|error| format!("The server artifact manifest is invalid: {error}"))?;
    validate_manifest(&manifest)?;
    if manifest.product != "bibcode-server" || manifest.version != request.version {
        return Err(
            "The server artifact manifest does not match the requested release.".to_string(),
        );
    }
    let matches = manifest
        .artifacts
        .into_iter()
        .filter(|record| {
            let architecture_matches = record.architecture == request.architecture
                || (record.os == "macos" && record.architecture == "universal");
            record.product == "bibcode-server"
                && record.version == request.version
                && record.os == request.os
                && architecture_matches
                && request.preferred_formats.contains(&record.format)
        })
        .collect::<Vec<_>>();
    let [record] = matches.as_slice() else {
        return Err(format!(
            "The signed server artifact manifest must contain exactly one {} {} {} record in the requested formats.",
            request.os, request.architecture, request.version
        ));
    };
    let artifact_url = manifest_url
        .join(&record.download_name)
        .map_err(|error| format!("The server artifact download URL is invalid: {error}"))?;
    let signature_url = manifest_url
        .join(&record.signature_name)
        .map_err(|error| format!("The server artifact signature URL is invalid: {error}"))?;
    validate_source_url(&artifact_url)?;
    validate_source_url(&signature_url)?;
    Ok(ResolvedServerArtifact {
        record: record.clone(),
        manifest_url: manifest_url.clone(),
        artifact_url,
        signature_url,
        public_key: public_key.to_string(),
    })
}

pub(crate) fn verify_artifact_file(
    path: &Path,
    resolved: &ResolvedServerArtifact,
    signature: &str,
) -> Result<(), String> {
    let actual_size = path
        .metadata()
        .map_err(|error| format!("Could not inspect the downloaded server artifact: {error}"))?
        .len();
    if actual_size != resolved.record.size {
        return Err(format!(
            "The downloaded server artifact size was {actual_size} bytes; the signed manifest requires {} bytes.",
            resolved.record.size
        ));
    }
    let public_key = PublicKey::decode(&resolved.public_key)
        .map_err(|_| "The server artifact public key is invalid.".to_string())?;
    let signature = Signature::decode(signature)
        .map_err(|_| "The server artifact detached signature is invalid.".to_string())?;
    let mut signature_verifier = public_key.verify_stream(&signature).map_err(|_| {
        "The server artifact detached signature is not stream-verifiable.".to_string()
    })?;
    let mut sha256 = Sha256::new();
    let mut file = File::open(path)
        .map_err(|error| format!("Could not open the downloaded server artifact: {error}"))?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read the downloaded server artifact: {error}"))?;
        if read == 0 {
            break;
        }
        sha256.update(&buffer[..read]);
        signature_verifier.update(&buffer[..read]);
    }
    let actual_sha256 =
        sha256
            .finalize()
            .iter()
            .fold(String::with_capacity(64), |mut encoded, byte| {
                let _ = write!(encoded, "{byte:02x}");
                encoded
            });
    if actual_sha256 != resolved.record.sha256 {
        return Err(
            "The downloaded server artifact SHA-256 did not match the signed manifest.".to_string(),
        );
    }
    signature_verifier
        .finalize()
        .map_err(|_| "The downloaded server artifact signature did not verify.".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerArtifactManifest {
    schema_version: u8,
    product: String,
    version: String,
    channel: String,
    source_sha: String,
    generated_at: String,
    required_matrix: Vec<ServerArtifactRequirement>,
    artifacts: Vec<ServerArtifactRecord>,
    manifest_signature_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerArtifactRequirement {
    target_triple: String,
    os: String,
    architecture: String,
    format: String,
}

fn safe_artifact_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+'))
}

fn validate_record(record: &ServerArtifactRecord) -> Result<(), String> {
    let certificate_signed = matches!(
        record.native_signing.binary.as_str(),
        "authenticode" | "developer-id"
    ) || record.native_signing.package != "none";
    if record.product != "bibcode-server"
        || record.version.trim().is_empty()
        || !valid_source_sha(&record.source_sha)
        || !matches!(record.os.as_str(), "linux" | "macos" | "windows")
        || !matches!(
            record.architecture.as_str(),
            "x86_64" | "aarch64" | "universal"
        )
        || !matches!(
            record.format.as_str(),
            "zip" | "tar.gz" | "msi" | "pkg" | "deb" | "rpm"
        )
        || record.size == 0
        || !safe_artifact_name(&record.download_name)
        || !safe_artifact_name(&record.signature_name)
        || !safe_artifact_name(&record.sbom_name)
        || BTreeSet::from([
            record.download_name.as_str(),
            record.signature_name.as_str(),
            record.sbom_name.as_str(),
        ])
        .len()
            != 3
        || record.sha256.len() != 64
        || !record
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !matches!(
            record.native_signing.binary.as_str(),
            "none" | "adhoc" | "authenticode" | "developer-id"
        )
        || !matches!(
            record.native_signing.package.as_str(),
            "none" | "authenticode" | "developer-id"
        )
        || record.native_signing.verified != certificate_signed
        || !valid_artifact_tuple(
            &record.target_triple,
            &record.os,
            &record.architecture,
            &record.format,
        )
        || (record.notarized
            && (record.os != "macos"
                || record.native_signing.package != "developer-id"
                || !record.native_signing.verified))
    {
        return Err("The signed server artifact manifest contains an invalid record.".to_string());
    }
    Ok(())
}

fn validate_manifest(manifest: &ServerArtifactManifest) -> Result<(), String> {
    if manifest.schema_version != 1
        || manifest.product != "bibcode-server"
        || manifest.version.trim().is_empty()
        || !matches!(
            manifest.channel.as_str(),
            "stable" | "beta" | "nightly" | "unsigned-test"
        )
        || !valid_source_sha(&manifest.source_sha)
        || !safe_artifact_name(&manifest.manifest_signature_name)
        || manifest.required_matrix.is_empty()
        || manifest.artifacts.is_empty()
        || time::OffsetDateTime::parse(
            &manifest.generated_at,
            &time::format_description::well_known::Rfc3339,
        )
        .is_err()
    {
        return Err("The signed server artifact manifest metadata is invalid.".to_string());
    }
    let required = manifest
        .required_matrix
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if required.len() != manifest.required_matrix.len()
        || required.iter().any(|requirement| {
            !valid_artifact_tuple(
                &requirement.target_triple,
                &requirement.os,
                &requirement.architecture,
                &requirement.format,
            )
        })
    {
        return Err("The signed server artifact required matrix is invalid.".to_string());
    }
    let mut tuples = BTreeSet::new();
    let mut linked_names = BTreeSet::from([manifest.manifest_signature_name.clone()]);
    for record in &manifest.artifacts {
        validate_record(record)?;
        if record.product != manifest.product
            || record.version != manifest.version
            || record.source_sha != manifest.source_sha
        {
            return Err("A server artifact record does not match its signed manifest.".to_string());
        }
        if manifest.channel == "stable"
            && record.os == "windows"
            && (record.native_signing.binary != "authenticode"
                || !record.native_signing.verified
                || (record.format == "msi" && record.native_signing.package != "authenticode"))
        {
            return Err(
                "Stable Windows server artifacts require verified Authenticode signatures."
                    .to_string(),
            );
        }
        let requirement = ServerArtifactRequirement {
            target_triple: record.target_triple.clone(),
            os: record.os.clone(),
            architecture: record.architecture.clone(),
            format: record.format.clone(),
        };
        if !required.contains(&requirement)
            || !tuples.insert(requirement)
            || ![
                &record.download_name,
                &record.signature_name,
                &record.sbom_name,
            ]
            .iter()
            .all(|name| linked_names.insert((*name).clone()))
        {
            return Err(
                "The signed server artifact manifest does not match its required matrix exactly."
                    .to_string(),
            );
        }
    }
    if tuples != required {
        return Err(
            "The signed server artifact manifest does not match its required matrix exactly."
                .to_string(),
        );
    }
    if manifest
        .artifacts
        .iter()
        .any(|record| record.architecture == "universal")
        && !["x86_64", "aarch64"].iter().all(|architecture| {
            manifest
                .artifacts
                .iter()
                .any(|record| record.os == "macos" && record.architecture == *architecture)
        })
    {
        return Err(
            "A universal macOS artifact requires both native architecture slices.".to_string(),
        );
    }
    Ok(())
}

fn valid_artifact_tuple(target_triple: &str, os: &str, architecture: &str, format: &str) -> bool {
    let expected_target = match (os, architecture) {
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "universal") => "universal-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        _ => return false,
    };
    let format_matches = match format {
        "zip" | "msi" => os == "windows",
        "pkg" => os == "macos",
        "deb" | "rpm" => os == "linux",
        "tar.gz" => matches!(os, "macos" | "linux"),
        _ => false,
    };
    target_triple == expected_target && format_matches
}

fn valid_source_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_source_url(url: &url::Url) -> Result<(), String> {
    let loopback_http = url.scheme() == "http"
        && url
            .host_str()
            .and_then(|host| host.parse::<std::net::IpAddr>().ok())
            .is_some_and(|address| address.is_loopback());
    if url.scheme() != "https" && !loopback_http {
        return Err(
            "Server artifacts require HTTPS (or loopback HTTP for local testing).".to_string(),
        );
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Server artifact URLs cannot contain credentials, queries, or fragments.".to_string(),
        );
    }
    Ok(())
}

fn adjacent_manifest_signature_url(manifest_url: &url::Url) -> Result<url::Url, String> {
    let mut signature_url = manifest_url.clone();
    let path = signature_url.path().to_string();
    signature_url.set_path(&format!("{path}.minisig"));
    validate_source_url(&signature_url)?;
    Ok(signature_url)
}

async fn fetch_limited(
    client: &reqwest::Client,
    url: &url::Url,
    maximum_bytes: u64,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, String> {
    let response = tokio::select! {
        biased;
        () = cancellation.cancelled() => return Err("Server artifact request was cancelled.".to_string()),
        response = client.get(url.clone()).send() => response,
    }
    .map_err(|error| format!("Could not fetch server artifact metadata: {error}"))?
    .error_for_status()
    .map_err(|error| format!("Server artifact metadata request failed: {error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes)
    {
        return Err("Server artifact metadata exceeded its size limit.".to_string());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        let chunk = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err("Server artifact request was cancelled.".to_string()),
            chunk = stream.next() => chunk,
        };
        let Some(chunk) = chunk else {
            return Ok(bytes);
        };
        let chunk =
            chunk.map_err(|error| format!("Could not read server artifact metadata: {error}"))?;
        if (bytes.len() as u64).saturating_add(chunk.len() as u64) > maximum_bytes {
            return Err("Server artifact metadata exceeded its size limit.".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
}

impl ServerArtifactSource {
    pub(crate) fn production() -> Result<Self, String> {
        let manifest_url = crate::config::bibcode_env_var(SERVER_ARTIFACT_MANIFEST_URL_ENV)
            .and_then(|value| value.into_string().ok())
            .unwrap_or_else(|| DEFAULT_SERVER_ARTIFACT_MANIFEST_URL.to_string());
        let manifest_url = url::Url::parse(&manifest_url)
            .map_err(|error| format!("The server artifact manifest URL is invalid: {error}"))?;
        validate_source_url(&manifest_url)?;
        let manifest_signature_url =
            match crate::config::bibcode_env_var(SERVER_ARTIFACT_MANIFEST_SIGNATURE_URL_ENV)
                .and_then(|value| value.into_string().ok())
            {
                Some(value) => url::Url::parse(&value).map_err(|error| {
                    format!("The server artifact manifest signature URL is invalid: {error}")
                })?,
                None => adjacent_manifest_signature_url(&manifest_url)?,
            };
        validate_source_url(&manifest_signature_url)?;
        let client = reqwest::Client::builder()
            .timeout(SERVER_ARTIFACT_REQUEST_TIMEOUT)
            .build()
            .map_err(|error| format!("Could not create the server artifact client: {error}"))?;
        Ok(Self {
            client,
            manifest_url,
            manifest_signature_url,
            public_key: DEFAULT_SERVER_ARTIFACT_PUBLIC_KEY.to_string(),
        })
    }

    pub(crate) async fn resolve(
        &self,
        request: &ServerArtifactRequest,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedServerArtifact, String> {
        let manifest = fetch_limited(
            &self.client,
            &self.manifest_url,
            MAX_MANIFEST_BYTES,
            cancellation,
        )
        .await?;
        let signature = fetch_limited(
            &self.client,
            &self.manifest_signature_url,
            MAX_SIGNATURE_BYTES,
            cancellation,
        )
        .await?;
        let signature = String::from_utf8(signature)
            .map_err(|_| "The server artifact manifest signature is not UTF-8.".to_string())?;
        verify_manifest_and_select(
            &manifest,
            &signature,
            &self.public_key,
            &self.manifest_url,
            request,
        )
    }

    pub(crate) async fn download(
        &self,
        resolved: ResolvedServerArtifact,
        staging_root: &Path,
        cancellation: &CancellationToken,
        progress: ServerArtifactProgress,
    ) -> Result<VerifiedServerArtifact, String> {
        let signature = fetch_limited(
            &self.client,
            &resolved.signature_url,
            MAX_SIGNATURE_BYTES,
            cancellation,
        )
        .await?;
        let signature = String::from_utf8(signature)
            .map_err(|_| "The server artifact detached signature is not UTF-8.".to_string())?;
        tokio::fs::create_dir_all(staging_root)
            .await
            .map_err(|error| {
                format!("Could not create the server artifact staging root: {error}")
            })?;
        let path = staging_root.join(format!("{}.part", uuid::Uuid::new_v4().simple()));
        let result = self
            .download_to_path(&resolved, &path, cancellation, progress)
            .await;
        if let Err(error) = result {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(error);
        }
        let verify_path = path.clone();
        let verify_resolved = resolved.clone();
        let verification = tokio::task::spawn_blocking(move || {
            verify_artifact_file(&verify_path, &verify_resolved, &signature)
        })
        .await
        .map_err(|error| format!("Server artifact verification task failed: {error}"))
        .and_then(|result| result);
        if let Err(error) = verification {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(error);
        }
        Ok(VerifiedServerArtifact { resolved, path })
    }

    async fn download_to_path(
        &self,
        resolved: &ResolvedServerArtifact,
        path: &Path,
        cancellation: &CancellationToken,
        progress: ServerArtifactProgress,
    ) -> Result<(), String> {
        let response = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err("Server artifact download was cancelled.".to_string()),
            response = self.client.get(resolved.artifact_url.clone()).send() => response,
        }
        .map_err(|error| format!("Could not download the server artifact: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Server artifact download failed: {error}"))?;
        if response
            .content_length()
            .is_some_and(|length| length != resolved.record.size)
        {
            return Err(
                "The server artifact response size did not match the signed manifest.".to_string(),
            );
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
            .await
            .map_err(|error| {
                format!("Could not create the server artifact staging file: {error}")
            })?;
        let mut received = 0_u64;
        let mut stream = response.bytes_stream();
        loop {
            let chunk = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err("Server artifact download was cancelled.".to_string()),
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk
                .map_err(|error| format!("Could not read the server artifact download: {error}"))?;
            received = received.saturating_add(chunk.len() as u64);
            if received > resolved.record.size {
                return Err("The server artifact download exceeded the signed size.".to_string());
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("Could not stage the server artifact: {error}"))?;
            progress(received, resolved.record.size);
        }
        if received != resolved.record.size {
            return Err(
                "The server artifact download ended before the signed size was reached."
                    .to_string(),
            );
        }
        file.sync_all()
            .await
            .map_err(|error| format!("Could not flush the staged server artifact: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    const FIXTURE_PUBLIC_KEY: &str = DEFAULT_SERVER_ARTIFACT_PUBLIC_KEY;
    const FIXTURE_MANIFEST: &str = include_str!("../fixtures/server-artifacts/artifacts.json");
    const FIXTURE_MANIFEST_SIGNATURE: &str =
        include_str!("../fixtures/server-artifacts/artifacts.json.minisig");
    const FIXTURE_ARTIFACT_SIGNATURE: &str =
        include_str!("../fixtures/server-artifacts/bibcode-server-linux-x86_64.tar.gz.minisig");

    fn request(architecture: &str) -> ServerArtifactRequest {
        ServerArtifactRequest {
            version: "0.4.2".to_string(),
            os: "linux".to_string(),
            architecture: architecture.to_string(),
            preferred_formats: vec!["tar.gz".to_string()],
        }
    }

    #[tokio::test]
    async fn cancellation_preempts_server_artifact_download_admission() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let url =
            url::Url::parse("https://127.0.0.1:9/artifacts.json").expect("cancelled artifact URL");

        let error = fetch_limited(&reqwest::Client::new(), &url, 1024, &cancellation)
            .await
            .expect_err("cancelled downloads must not reach the network");

        assert_eq!(error, "Server artifact request was cancelled.");
    }

    #[test]
    fn server_release_trust_anchor_is_not_the_tauri_updater_key() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.release.conf.json"))
                .expect("release Tauri config");
        let encoded = config
            .pointer("/plugins/updater/pubkey")
            .and_then(serde_json::Value::as_str)
            .expect("Tauri updater public key");
        let updater_key = String::from_utf8(STANDARD.decode(encoded).expect("base64 updater key"))
            .expect("UTF-8 updater key");

        assert_ne!(
            DEFAULT_SERVER_ARTIFACT_PUBLIC_KEY.trim(),
            updater_key.trim(),
            "server releases and desktop updates require independent signing keys"
        );
    }

    #[test]
    fn signed_manifest_selects_one_exact_tuple_without_filename_guessing() {
        let manifest_url =
            url::Url::parse("https://releases.example/artifacts.json").expect("manifest URL");
        let resolved = verify_manifest_and_select(
            FIXTURE_MANIFEST.as_bytes(),
            FIXTURE_MANIFEST_SIGNATURE,
            FIXTURE_PUBLIC_KEY,
            &manifest_url,
            &request("x86_64"),
        )
        .expect("signed manifest should resolve");

        assert_eq!(
            resolved.record.download_name,
            "bibcode-server-linux-x86_64.tar.gz"
        );
        assert_eq!(
            resolved.artifact_url.as_str(),
            "https://releases.example/bibcode-server-linux-x86_64.tar.gz"
        );
        assert_eq!(
            resolved.signature_url.as_str(),
            "https://releases.example/bibcode-server-linux-x86_64.tar.gz.minisig"
        );
    }

    #[test]
    fn signed_manifest_rejects_wrong_architecture_tampering_and_unsafe_names() {
        let manifest_url =
            url::Url::parse("https://releases.example/artifacts.json").expect("manifest URL");
        assert!(
            verify_manifest_and_select(
                FIXTURE_MANIFEST.as_bytes(),
                FIXTURE_MANIFEST_SIGNATURE,
                FIXTURE_PUBLIC_KEY,
                &manifest_url,
                &request("aarch64"),
            )
            .is_err()
        );
        let tampered = FIXTURE_MANIFEST.replace("0.4.2", "0.4.3");
        assert!(
            verify_manifest_and_select(
                tampered.as_bytes(),
                FIXTURE_MANIFEST_SIGNATURE,
                FIXTURE_PUBLIC_KEY,
                &manifest_url,
                &request("x86_64"),
            )
            .is_err()
        );
        let mut unsafe_record = serde_json::from_str::<ServerArtifactManifest>(FIXTURE_MANIFEST)
            .expect("fixture manifest")
            .artifacts
            .remove(0);
        unsafe_record.download_name = "../escape.tar.gz".to_string();
        assert!(validate_record(&unsafe_record).is_err());
    }

    #[test]
    fn payload_verification_requires_exact_size_sha256_and_detached_signature() {
        let temporary = tempfile::tempdir().expect("artifact fixture root");
        let artifact = temporary.path().join("artifact.tar.gz");
        let fixture_artifact =
            include_bytes!("../fixtures/server-artifacts/bibcode-server-linux-x86_64.tar.gz");
        std::fs::write(&artifact, fixture_artifact).expect("fixture artifact");
        let manifest_url =
            url::Url::parse("https://releases.example/artifacts.json").expect("manifest URL");
        let resolved = verify_manifest_and_select(
            FIXTURE_MANIFEST.as_bytes(),
            FIXTURE_MANIFEST_SIGNATURE,
            FIXTURE_PUBLIC_KEY,
            &manifest_url,
            &request("x86_64"),
        )
        .expect("signed manifest should resolve");

        verify_artifact_file(&artifact, &resolved, FIXTURE_ARTIFACT_SIGNATURE)
            .expect("signed artifact should verify");
        std::fs::write(&artifact, b"tampered-server-artifact\n").expect("tampered artifact");
        assert!(verify_artifact_file(&artifact, &resolved, FIXTURE_ARTIFACT_SIGNATURE).is_err());
        std::fs::write(&artifact, fixture_artifact).expect("restore artifact");
        assert!(verify_artifact_file(&artifact, &resolved, FIXTURE_MANIFEST_SIGNATURE).is_err());
    }
}
