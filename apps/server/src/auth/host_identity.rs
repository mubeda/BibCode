use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use thiserror::Error;

use super::secret_store::{SecretStore, SecretStoreError};

pub(crate) const NOISE_NK_PARAMS: &str = "Noise_NK_25519_ChaChaPoly_SHA256";
pub(crate) const HOST_IDENTITY_SECRET_NAME: &str = "host-identity-x25519";

#[derive(Debug, Error)]
pub enum HostIdentityError {
    #[error("failed to access the host identity secret")]
    Store(#[from] SecretStoreError),
    #[error("failed to generate the host identity keypair: {0}")]
    Generate(String),
    #[error("host identity record at {name:?} has {len} bytes; expected 64")]
    Corrupt { name: &'static str, len: usize },
    #[error("host identity secret disappeared after a concurrent creator won the race")]
    ConcurrentRead,
}

/// The server's static Noise NK responder keypair (spec section 4.1).
/// The public key is distributed only inside pairing codes.
#[derive(Clone)]
pub struct HostIdentity {
    private: [u8; 32],
    public: [u8; 32],
}

impl std::fmt::Debug for HostIdentity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HostIdentity")
            .field("public", &self.public_key_base64url())
            .finish_non_exhaustive()
    }
}

impl HostIdentity {
    pub(crate) async fn load_or_generate(store: &SecretStore) -> Result<Self, HostIdentityError> {
        if let Some(existing) = store.get(HOST_IDENTITY_SECRET_NAME).await? {
            return Self::from_record(&existing);
        }
        let generated = Self::generate()?;
        let mut record = [0_u8; 64];
        record[..32].copy_from_slice(&generated.private);
        record[32..].copy_from_slice(&generated.public);
        match store.create(HOST_IDENTITY_SECRET_NAME, &record).await {
            Ok(()) => Ok(generated),
            Err(error) if error.is_already_exists() => store
                .get(HOST_IDENTITY_SECRET_NAME)
                .await?
                .ok_or(HostIdentityError::ConcurrentRead)
                .and_then(|winner| Self::from_record(&winner)),
            Err(error) => Err(error.into()),
        }
    }

    /// Test-mode and `AuthService::new`-without-persistence identity.
    #[cfg(test)]
    pub(crate) fn generate_ephemeral() -> Self {
        Self::generate().expect("X25519 keypair generation cannot fail")
    }

    fn generate() -> Result<Self, HostIdentityError> {
        let keypair = snow::Builder::new(
            NOISE_NK_PARAMS
                .parse()
                .map_err(|error| HostIdentityError::Generate(format!("{error:?}")))?,
        )
        .generate_keypair()
        .map_err(|error| HostIdentityError::Generate(format!("{error:?}")))?;
        let mut private = [0_u8; 32];
        let mut public = [0_u8; 32];
        private.copy_from_slice(&keypair.private);
        public.copy_from_slice(&keypair.public);
        Ok(Self { private, public })
    }

    fn from_record(record: &[u8]) -> Result<Self, HostIdentityError> {
        if record.len() != 64 {
            return Err(HostIdentityError::Corrupt {
                name: HOST_IDENTITY_SECRET_NAME,
                len: record.len(),
            });
        }
        let mut private = [0_u8; 32];
        let mut public = [0_u8; 32];
        private.copy_from_slice(&record[..32]);
        public.copy_from_slice(&record[32..]);
        Ok(Self { private, public })
    }

    #[must_use]
    pub fn public_key_base64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.public)
    }

    #[must_use]
    pub(crate) fn private_key_bytes(&self) -> &[u8; 32] {
        &self.private
    }

    #[must_use]
    #[cfg(test)]
    pub(crate) fn public_key_bytes(&self) -> &[u8; 32] {
        &self.public
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;

    use super::*;
    use crate::auth::secret_store::SecretStore;

    async fn test_store() -> (tempfile::TempDir, SecretStore) {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = SecretStore::new(dir.path().join("secrets"))
            .await
            .expect("secret store");
        (dir, store)
    }

    #[tokio::test]
    async fn generates_once_and_reloads_the_same_keypair() {
        let (_dir, store) = test_store().await;
        let first = HostIdentity::load_or_generate(&store).await.unwrap();
        let second = HostIdentity::load_or_generate(&store).await.unwrap();
        assert_eq!(first.public_key_bytes(), second.public_key_bytes());
        assert_eq!(first.private_key_bytes(), second.private_key_bytes());
    }

    #[tokio::test]
    async fn public_key_encoding_is_unpadded_base64url_of_32_bytes() {
        let identity = HostIdentity::generate_ephemeral();
        let encoded = identity.public_key_base64url();
        assert_eq!(encoded.len(), 43);
        assert!(!encoded.contains('='));
        assert!(!encoded.contains('+') && !encoded.contains('/'));
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&encoded)
            .expect("decodes");
        assert_eq!(decoded.as_slice(), identity.public_key_bytes());
    }

    #[tokio::test]
    async fn persisted_record_is_private_then_public_64_bytes() {
        let (_dir, store) = test_store().await;
        let identity = HostIdentity::load_or_generate(&store).await.unwrap();
        let raw = store
            .get(HOST_IDENTITY_SECRET_NAME)
            .await
            .unwrap()
            .expect("secret exists");
        assert_eq!(raw.len(), 64);
        assert_eq!(&raw[..32], identity.private_key_bytes());
        assert_eq!(&raw[32..], identity.public_key_bytes());
    }

    #[tokio::test]
    async fn corrupt_record_is_reported_not_silently_regenerated() {
        let (_dir, store) = test_store().await;
        store
            .create(HOST_IDENTITY_SECRET_NAME, b"short")
            .await
            .unwrap();
        assert!(matches!(
            HostIdentity::load_or_generate(&store).await,
            Err(HostIdentityError::Corrupt { .. })
        ));
    }
}
