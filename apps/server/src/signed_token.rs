//! Shared wire format for HMAC-signed, JSON-encoded tokens: base64url JSON claims,
//! `.`, base64url HMAC-SHA256 over the claims payload. Used by [`crate::assets`] and
//! [`crate::transfer`] to issue and verify short-lived, tamper-evident URLs; each caller
//! keeps its own claim type, TTL, and expiry check.

use base64::Engine;
use hmac::{Hmac, KeyInit as _, Mac};
use serde::Serialize;
use serde::de::DeserializeOwned;
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

/// Encodes `claims` as base64url JSON and appends a base64url HMAC-SHA256 signature over
/// that payload, keyed by `secret`.
pub fn sign<T: Serialize>(secret: &[u8], claims: &T) -> Result<String, serde_json::Error> {
    let payload =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims)?);
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts arbitrary key lengths");
    mac.update(payload.as_bytes());
    let signature =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!("{payload}.{signature}"))
}

/// Verifies `token`'s signature against `secret` in constant time, then decodes the claims.
/// Returns `None` for any malformed, mis-keyed, or tampered token; callers apply their own
/// expiry check to the decoded claims.
pub fn verify<T: DeserializeOwned>(secret: &[u8], token: &str) -> Option<T> {
    let (payload, signature) = token.split_once('.')?;
    let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(signature)
        .ok()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature).ok()?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Current time in milliseconds since the Unix epoch, saturating to `0` if the clock is
/// somehow set before it and to `u64::MAX` on overflow.
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    struct Claims {
        value: String,
    }

    #[test]
    fn round_trips_and_rejects_tampering_and_wrong_key() {
        let claims = Claims {
            value: "hello".to_owned(),
        };
        let token = sign(b"secret", &claims).unwrap();
        assert_eq!(verify::<Claims>(b"secret", &token), Some(claims));
        assert_eq!(verify::<Claims>(b"other", &token), None);
        assert_eq!(verify::<Claims>(b"secret", &format!("{token}x")), None);
        assert_eq!(verify::<Claims>(b"secret", "not-a-token"), None);
    }
}
