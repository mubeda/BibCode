//! Shared wire format for HMAC-signed, JSON-encoded tokens: base64url JSON claims,
//! `.`, base64url HMAC-SHA256 over the caller's purpose and the claims payload. Used by
//! [`crate::assets`] and [`crate::transfer`] to issue and verify short-lived, tamper-evident
//! URLs; each caller keeps its own claim type, TTL, and expiry check.
//!
//! The `purpose` is domain separation: assets and transfers share one server secret, so
//! without it a read-only asset capability and a write-capable upload capability would be
//! distinguished only by the `kind` tag inside the claims each caller happens to deserialize.
//! Mixing the purpose into the MAC input makes a token minted for one purpose unverifiable
//! under any other, whatever its payload says.

use base64::Engine;
use hmac::{Hmac, KeyInit as _, Mac};
use serde::Serialize;
use serde::de::DeserializeOwned;
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

/// Encodes `claims` as base64url JSON and appends a base64url HMAC-SHA256 signature over
/// `purpose`, a separator, and that payload, keyed by `secret`. The wire shape stays
/// `payload.signature`; only the MAC input widens.
pub fn sign<T: Serialize>(
    secret: &[u8],
    purpose: &'static str,
    claims: &T,
) -> Result<String, serde_json::Error> {
    let payload =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims)?);
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts arbitrary key lengths");
    mac_input(&mut mac, purpose, &payload);
    let signature =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!("{payload}.{signature}"))
}

/// Verifies `token`'s signature against `secret` and `purpose` in constant time, then decodes
/// the claims. Returns `None` for any malformed, mis-keyed, mis-purposed, or tampered token;
/// callers apply their own expiry check to the decoded claims.
pub fn verify<T: DeserializeOwned>(secret: &[u8], purpose: &'static str, token: &str) -> Option<T> {
    let (payload, signature) = token.split_once('.')?;
    let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(signature)
        .ok()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).ok()?;
    mac_input(&mut mac, purpose, payload);
    mac.verify_slice(&signature).ok()?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Feeds the MAC `purpose`, a `.` separator, and the payload. The separator is unambiguous
/// because neither a purpose (an ASCII identifier chosen in this crate) nor a base64url
/// payload can contain a `.`, so no pair of distinct inputs can produce the same MAC input.
fn mac_input(mac: &mut Hmac<Sha256>, purpose: &'static str, payload: &str) {
    debug_assert!(
        !purpose.contains('.'),
        "purpose must not contain a separator"
    );
    mac.update(purpose.as_bytes());
    mac.update(b".");
    mac.update(payload.as_bytes());
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
        let token = sign(b"secret", "asset", &claims).unwrap();
        assert_eq!(verify::<Claims>(b"secret", "asset", &token), Some(claims));
        assert_eq!(verify::<Claims>(b"other", "asset", &token), None);
        assert_eq!(
            verify::<Claims>(b"secret", "asset", &format!("{token}x")),
            None
        );
        assert_eq!(verify::<Claims>(b"secret", "asset", "not-a-token"), None);
    }

    #[test]
    fn a_token_minted_for_one_purpose_never_verifies_under_another() {
        let claims = Claims {
            value: "hello".to_owned(),
        };
        // Same secret, same claims, different purpose: only the MAC input separates them.
        let asset = sign(b"secret", "asset", &claims).unwrap();
        let transfer = sign(b"secret", "transfer", &claims).unwrap();
        assert_ne!(asset, transfer);
        assert_eq!(verify::<Claims>(b"secret", "transfer", &asset), None);
        assert_eq!(verify::<Claims>(b"secret", "asset", &transfer), None);
        // The claims -- and so the payloads -- are identical: the signature is the only thing
        // that separates the two capabilities, which is exactly what the purpose buys.
        assert_eq!(
            asset.split_once('.').map(|(payload, _)| payload),
            transfer.split_once('.').map(|(payload, _)| payload)
        );
        assert_eq!(verify::<Claims>(b"secret", "asset", &asset), Some(claims));
    }
}
