use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReleaseChannel {
    Stable,
    Beta,
    Nightly,
    UnsignedTest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactOs {
    Linux,
    Macos,
    Windows,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactArchitecture {
    X86_64,
    Aarch64,
    Universal,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
pub enum ArtifactFormat {
    #[serde(rename = "zip")]
    Zip,
    #[serde(rename = "tar.gz")]
    TarGz,
    #[serde(rename = "msi")]
    Msi,
    #[serde(rename = "pkg")]
    Pkg,
    #[serde(rename = "deb")]
    Deb,
    #[serde(rename = "rpm")]
    Rpm,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BinarySigning {
    None,
    Adhoc,
    Authenticode,
    DeveloperId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PackageSigning {
    None,
    Authenticode,
    DeveloperId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeSigningState {
    pub binary: BinarySigning,
    pub package: PackageSigning,
    pub verified: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactRequirement {
    pub target_triple: String,
    pub os: ArtifactOs,
    pub architecture: ArtifactArchitecture,
    pub format: ArtifactFormat,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactRecord {
    pub product: String,
    pub version: String,
    pub source_sha: String,
    pub target_triple: String,
    pub os: ArtifactOs,
    pub architecture: ArtifactArchitecture,
    pub format: ArtifactFormat,
    pub download_name: String,
    pub size: u64,
    pub sha256: String,
    pub signature_name: String,
    pub sbom_name: String,
    pub native_signing: NativeSigningState,
    pub notarized: bool,
}

impl ArtifactRecord {
    #[must_use]
    pub fn requirement(&self) -> ArtifactRequirement {
        ArtifactRequirement {
            target_triple: self.target_triple.clone(),
            os: self.os.clone(),
            architecture: self.architecture.clone(),
            format: self.format.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactManifest {
    pub schema_version: u8,
    pub product: String,
    pub version: String,
    pub channel: ReleaseChannel,
    pub source_sha: String,
    pub generated_at: String,
    pub required_matrix: Vec<ArtifactRequirement>,
    pub artifacts: Vec<ArtifactRecord>,
    pub manifest_signature_name: String,
}
