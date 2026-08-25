use std::{fmt, sync::Arc};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(crate) const SECRET_REFERENCE_PREFIX: &str = "bibcode-secret:";
const SECRET_SERVICE: &str = "com.bibcode.desktop";
const SECRET_ENTRY_MAGIC: &[u8] = b"BIBCODE_SECRET_V1\0";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SecretPurpose {
    EnvironmentSession,
    DpopPrivateKey,
    CacheKey,
}

impl SecretPurpose {
    fn tag(self) -> u8 {
        match self {
            Self::EnvironmentSession => 1,
            Self::DpopPrivateKey => 2,
            Self::CacheKey => 3,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SecretStoreError {
    Unavailable,
    Locked,
    InvalidReference,
    Failed,
}

impl SecretStoreError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Locked => "locked",
            Self::InvalidReference => "invalid-reference",
            Self::Failed => "failed",
        }
    }
}

impl fmt::Debug for SecretStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl fmt::Display for SecretStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "The operating-system secret provider is unavailable.",
            Self::Locked => "The operating-system secret provider is locked.",
            Self::InvalidReference => "The secret reference is invalid.",
            Self::Failed => "The operating-system secret operation failed.",
        })
    }
}

impl std::error::Error for SecretStoreError {}

#[derive(Debug, Serialize)]
pub(crate) struct SecretStoreIpcError {
    code: &'static str,
}

impl From<SecretStoreError> for SecretStoreIpcError {
    fn from(error: SecretStoreError) -> Self {
        Self { code: error.code() }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopSecretInput {
    pub(crate) purpose: SecretPurpose,
    pub(crate) value: String,
}

pub(crate) trait DesktopSecretProvider: Send + Sync {
    fn put(&self, purpose: SecretPurpose, value: &[u8]) -> Result<String, SecretStoreError>;
    fn get(&self, reference: &str) -> Result<Option<Vec<u8>>, SecretStoreError>;
    fn delete(&self, reference: &str) -> Result<(), SecretStoreError>;
}

#[derive(Clone)]
pub(crate) struct DesktopSecretStore {
    provider: Arc<dyn DesktopSecretProvider>,
}

impl DesktopSecretStore {
    pub(crate) fn new() -> Self {
        Self {
            provider: platform_provider(),
        }
    }

    #[cfg(test)]
    fn with_provider(provider: Arc<dyn DesktopSecretProvider>) -> Self {
        Self { provider }
    }

    pub(crate) fn put(
        &self,
        purpose: SecretPurpose,
        value: &[u8],
    ) -> Result<String, SecretStoreError> {
        if value.is_empty() {
            return Err(SecretStoreError::Failed);
        }
        self.provider.put(purpose, value)
    }

    pub(crate) fn get(&self, reference: &str) -> Result<Option<Vec<u8>>, SecretStoreError> {
        validate_secret_reference(reference)?;
        self.provider.get(reference)
    }

    pub(crate) fn delete(&self, reference: &str) -> Result<(), SecretStoreError> {
        validate_secret_reference(reference)?;
        self.provider.delete(reference)
    }
}

pub(crate) fn secret_reference(id: Uuid) -> String {
    format!("{SECRET_REFERENCE_PREFIX}{id}")
}

pub(crate) fn validate_secret_reference(reference: &str) -> Result<Uuid, SecretStoreError> {
    let raw = reference
        .strip_prefix(SECRET_REFERENCE_PREFIX)
        .ok_or(SecretStoreError::InvalidReference)?;
    let id = Uuid::parse_str(raw).map_err(|_| SecretStoreError::InvalidReference)?;
    if secret_reference(id) != reference {
        return Err(SecretStoreError::InvalidReference);
    }
    Ok(id)
}

fn encode_entry(purpose: SecretPurpose, value: &[u8]) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(SECRET_ENTRY_MAGIC.len() + 1 + value.len());
    encoded.extend_from_slice(SECRET_ENTRY_MAGIC);
    encoded.push(purpose.tag());
    encoded.extend_from_slice(value);
    encoded
}

fn decode_entry(encoded: &[u8]) -> Result<Vec<u8>, SecretStoreError> {
    let payload = encoded
        .strip_prefix(SECRET_ENTRY_MAGIC)
        .ok_or(SecretStoreError::Failed)?;
    let (purpose, value) = payload.split_first().ok_or(SecretStoreError::Failed)?;
    if !matches!(purpose, 1..=3) || value.is_empty() {
        return Err(SecretStoreError::Failed);
    }
    Ok(value.to_vec())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn platform_provider() -> Arc<dyn DesktopSecretProvider> {
    Arc::new(KeyringSecretProvider)
}

#[cfg(target_os = "windows")]
fn platform_provider() -> Arc<dyn DesktopSecretProvider> {
    Arc::new(WindowsDpapiSecretProvider)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn platform_provider() -> Arc<dyn DesktopSecretProvider> {
    Arc::new(UnavailableSecretProvider)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
struct KeyringSecretProvider;

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl KeyringSecretProvider {
    fn entry(reference: &str) -> Result<keyring::Entry, SecretStoreError> {
        keyring::Entry::new(SECRET_SERVICE, reference).map_err(map_keyring_error)
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl DesktopSecretProvider for KeyringSecretProvider {
    fn put(&self, purpose: SecretPurpose, value: &[u8]) -> Result<String, SecretStoreError> {
        let reference = secret_reference(Uuid::new_v4());
        Self::entry(&reference)?
            .set_secret(&encode_entry(purpose, value))
            .map_err(map_keyring_error)?;
        Ok(reference)
    }

    fn get(&self, reference: &str) -> Result<Option<Vec<u8>>, SecretStoreError> {
        validate_secret_reference(reference)?;
        match Self::entry(reference)?.get_secret() {
            Ok(encoded) => decode_entry(&encoded).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn delete(&self, reference: &str) -> Result<(), SecretStoreError> {
        validate_secret_reference(reference)?;
        match Self::entry(reference)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn map_keyring_error(error: keyring::Error) -> SecretStoreError {
    match error {
        keyring::Error::NoStorageAccess(_) => SecretStoreError::Locked,
        keyring::Error::NoDefaultStore
        | keyring::Error::PlatformFailure(_)
        | keyring::Error::NotSupportedByStore(_) => SecretStoreError::Unavailable,
        _ => SecretStoreError::Failed,
    }
}

#[cfg(target_os = "windows")]
struct WindowsDpapiSecretProvider;

#[cfg(target_os = "windows")]
impl DesktopSecretProvider for WindowsDpapiSecretProvider {
    fn put(&self, purpose: SecretPurpose, value: &[u8]) -> Result<String, SecretStoreError> {
        let reference = secret_reference(Uuid::new_v4());
        let encrypted = crate::security::protect_secret_bytes(&encode_entry(purpose, value))
            .map_err(|_| SecretStoreError::Failed)?;
        windows_registry::write(&reference, &encrypted)?;
        Ok(reference)
    }

    fn get(&self, reference: &str) -> Result<Option<Vec<u8>>, SecretStoreError> {
        validate_secret_reference(reference)?;
        let Some(encrypted) = windows_registry::read(reference)? else {
            return Ok(None);
        };
        let encoded = crate::security::unprotect_secret_bytes(&encrypted)
            .map_err(|_| SecretStoreError::Failed)?;
        decode_entry(&encoded).map(Some)
    }

    fn delete(&self, reference: &str) -> Result<(), SecretStoreError> {
        validate_secret_reference(reference)?;
        windows_registry::delete(reference)
    }
}

#[cfg(target_os = "windows")]
mod windows_registry {
    use std::ptr;

    use windows_sys::Win32::{
        Foundation::{
            ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
        },
        System::Registry::{
            HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_BINARY, REG_OPTION_NON_VOLATILE,
            RRF_RT_REG_BINARY, RegCloseKey, RegCreateKeyExW, RegDeleteKeyValueW, RegGetValueW,
            RegSetValueExW,
        },
    };

    use super::{SECRET_SERVICE, SecretStoreError};

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn registry_path() -> Vec<u16> {
        wide(&format!(r"Software\{SECRET_SERVICE}\Secrets"))
    }

    fn map_status(status: u32) -> SecretStoreError {
        if status == ERROR_ACCESS_DENIED {
            SecretStoreError::Locked
        } else {
            SecretStoreError::Unavailable
        }
    }

    struct RegistryKey(HKEY);

    impl Drop for RegistryKey {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }

    fn create_key() -> Result<RegistryKey, SecretStoreError> {
        let mut key = ptr::null_mut();
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                registry_path().as_ptr(),
                0,
                ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                ptr::null(),
                &mut key,
                ptr::null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(map_status(status));
        }
        Ok(RegistryKey(key))
    }

    pub(super) fn write(reference: &str, encrypted: &[u8]) -> Result<(), SecretStoreError> {
        let length = u32::try_from(encrypted.len()).map_err(|_| SecretStoreError::Failed)?;
        let key = create_key()?;
        let status = unsafe {
            RegSetValueExW(
                key.0,
                wide(reference).as_ptr(),
                0,
                REG_BINARY,
                encrypted.as_ptr(),
                length,
            )
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(map_status(status))
        }
    }

    pub(super) fn read(reference: &str) -> Result<Option<Vec<u8>>, SecretStoreError> {
        let path = registry_path();
        let name = wide(reference);
        let mut length = 0_u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_BINARY,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut length,
            )
        };
        if matches!(status, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(map_status(status));
        }
        let mut encrypted = vec![0_u8; length as usize];
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_BINARY,
                ptr::null_mut(),
                encrypted.as_mut_ptr().cast(),
                &mut length,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(map_status(status));
        }
        encrypted.truncate(length as usize);
        Ok(Some(encrypted))
    }

    pub(super) fn delete(reference: &str) -> Result<(), SecretStoreError> {
        let status = unsafe {
            RegDeleteKeyValueW(
                HKEY_CURRENT_USER,
                registry_path().as_ptr(),
                wide(reference).as_ptr(),
            )
        };
        if matches!(
            status,
            ERROR_SUCCESS | ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND
        ) {
            Ok(())
        } else {
            Err(map_status(status))
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
struct UnavailableSecretProvider;

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
impl DesktopSecretProvider for UnavailableSecretProvider {
    fn put(&self, _purpose: SecretPurpose, _value: &[u8]) -> Result<String, SecretStoreError> {
        Err(SecretStoreError::Unavailable)
    }

    fn get(&self, _reference: &str) -> Result<Option<Vec<u8>>, SecretStoreError> {
        Err(SecretStoreError::Unavailable)
    }

    fn delete(&self, _reference: &str) -> Result<(), SecretStoreError> {
        Err(SecretStoreError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use super::*;

    #[derive(Default)]
    struct MemoryProvider {
        entries: Mutex<HashMap<String, (SecretPurpose, Vec<u8>)>>,
        next_error: Mutex<Option<SecretStoreError>>,
    }

    impl MemoryProvider {
        fn fail_once(&self, error: SecretStoreError) {
            *self.next_error.lock().expect("test error lock") = Some(error);
        }

        fn take_error(&self) -> Result<(), SecretStoreError> {
            match self.next_error.lock().expect("test error lock").take() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }
    }

    impl DesktopSecretProvider for MemoryProvider {
        fn put(&self, purpose: SecretPurpose, value: &[u8]) -> Result<String, SecretStoreError> {
            self.take_error()?;
            let reference = secret_reference(uuid::Uuid::new_v4());
            self.entries
                .lock()
                .expect("test entries lock")
                .insert(reference.clone(), (purpose, value.to_vec()));
            Ok(reference)
        }

        fn get(&self, reference: &str) -> Result<Option<Vec<u8>>, SecretStoreError> {
            self.take_error()?;
            validate_secret_reference(reference)?;
            Ok(self
                .entries
                .lock()
                .expect("test entries lock")
                .get(reference)
                .map(|(_, value)| value.clone()))
        }

        fn delete(&self, reference: &str) -> Result<(), SecretStoreError> {
            self.take_error()?;
            validate_secret_reference(reference)?;
            self.entries
                .lock()
                .expect("test entries lock")
                .remove(reference);
            Ok(())
        }
    }

    #[test]
    fn round_trips_and_idempotently_deletes_without_inventory() {
        let provider = Arc::new(MemoryProvider::default());
        let store = DesktopSecretStore::with_provider(provider.clone());

        let reference = store
            .put(SecretPurpose::EnvironmentSession, b"secret-value")
            .expect("secret should store");
        assert!(reference.starts_with(SECRET_REFERENCE_PREFIX));
        assert_eq!(
            store.get(&reference).expect("secret should load"),
            Some(b"secret-value".to_vec())
        );
        assert_eq!(
            provider
                .entries
                .lock()
                .expect("test entries lock")
                .get(&reference)
                .map(|(purpose, _)| *purpose),
            Some(SecretPurpose::EnvironmentSession)
        );

        store.delete(&reference).expect("secret should delete");
        store
            .delete(&reference)
            .expect("deleting a missing secret is idempotent");
        assert_eq!(
            store.get(&reference).expect("missing secret should load"),
            None
        );
    }

    #[test]
    fn accepts_only_canonical_opaque_uuid_references() {
        let valid = "bibcode-secret:70a3dd71-952a-4eb6-a9a8-424a462e33c8";
        assert_eq!(
            secret_reference(validate_secret_reference(valid).unwrap()),
            valid
        );

        for invalid in [
            "70a3dd71-952a-4eb6-a9a8-424a462e33c8",
            "bibcode-secret:70A3DD71-952A-4EB6-A9A8-424A462E33C8",
            "bibcode-secret:70a3dd71952a4eb6a9a8424a462e33c8",
            "bibcode-secret:not-a-uuid",
        ] {
            assert_eq!(
                validate_secret_reference(invalid),
                Err(SecretStoreError::InvalidReference)
            );
        }
    }

    #[test]
    fn provider_failures_stay_typed_and_secret_free() {
        let provider = Arc::new(MemoryProvider::default());
        let store = DesktopSecretStore::with_provider(provider.clone());
        for expected in [SecretStoreError::Unavailable, SecretStoreError::Locked] {
            provider.fail_once(expected);
            let error = store
                .put(SecretPurpose::DpopPrivateKey, b"seeded-secret-canary")
                .expect_err("provider failure should fail closed");
            assert_eq!(error, expected);
            assert!(!format!("{error}").contains("seeded-secret-canary"));
            assert!(!format!("{error:?}").contains("seeded-secret-canary"));
        }
    }

    #[test]
    fn ipc_errors_expose_only_a_stable_code() {
        for (error, code) in [
            (SecretStoreError::Unavailable, "unavailable"),
            (SecretStoreError::Locked, "locked"),
            (SecretStoreError::InvalidReference, "invalid-reference"),
            (SecretStoreError::Failed, "failed"),
        ] {
            assert_eq!(
                serde_json::to_value(SecretStoreIpcError::from(error)).unwrap(),
                serde_json::json!({ "code": code })
            );
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn native_provider_distinguishes_unavailable_from_locked() {
        assert_eq!(
            map_keyring_error(keyring::Error::PlatformFailure(Box::new(
                std::io::Error::other("provider offline"),
            ))),
            SecretStoreError::Unavailable
        );
        assert_eq!(
            map_keyring_error(keyring::Error::NoStorageAccess(Box::new(
                std::io::Error::other("provider locked"),
            ))),
            SecretStoreError::Locked
        );
    }
}
