//! Webhook signatures: `X-BibCode-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." +
//! body)>`, where `timestamp` is the `X-BibCode-Timestamp` header (Unix seconds) and the key is
//! the endpoint's secret as shown once (its UTF-8 bytes). A receiver recomputes it over the
//! raw body and refuses a timestamp more than 5 minutes from its clock.

use hmac::{Hmac, KeyInit as _, Mac};
use sha2::Sha256;

pub(crate) const EVENT_HEADER: &str = "X-BibCode-Event";
pub(crate) const DELIVERY_HEADER: &str = "X-BibCode-Delivery";
pub(crate) const TIMESTAMP_HEADER: &str = "X-BibCode-Timestamp";
pub(crate) const SIGNATURE_HEADER: &str = "X-BibCode-Signature";
/// What a secret starts with, so a person can tell it from other credentials.
const SECRET_PREFIX: &str = "whsec_";

/// A new endpoint secret: `whsec_` and 64 hex characters (32 random bytes).
pub(crate) fn generate_secret() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(format!(
        "{SECRET_PREFIX}{}",
        crate::mcp::endpoint::hex(&bytes)
    ))
}

/// The `X-BibCode-Signature` value of `body` sent at `timestamp`.
pub(crate) fn sign(secret: &str, timestamp: i64, body: &[u8]) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    format!(
        "v1={}",
        crate::mcp::endpoint::hex(&mac.finalize().into_bytes())
    )
}

/// What a receiver does: recompute the signature over the raw body, compare in constant time,
/// and refuse a timestamp outside `tolerance_seconds` of `now`.
#[cfg(test)]
pub(crate) fn verify(
    secret: &str,
    timestamp: &str,
    body: &[u8],
    signature: &str,
    now: i64,
    tolerance_seconds: i64,
) -> bool {
    use subtle::ConstantTimeEq as _;
    let Ok(sent) = timestamp.parse::<i64>() else {
        return false;
    };
    if (now - sent).abs() > tolerance_seconds {
        return false;
    }
    let expected = sign(secret, sent, body);
    expected.as_bytes().ct_eq(signature.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signature_verifies_with_its_secret_and_timestamp_only() {
        let secret = generate_secret().expect("random");
        assert!(secret.starts_with("whsec_") && secret.len() == 6 + 64);
        let body = br#"{"id":"e","type":"webhook.test"}"#;
        let signature = sign(&secret, 1_800_000_000, body);
        assert!(signature.starts_with("v1=") && signature.len() == 3 + 64);
        assert!(verify(
            &secret,
            "1800000000",
            body,
            &signature,
            1_800_000_100,
            300
        ));
        // Another secret, another body, another timestamp, or a stale one: refused.
        let other = generate_secret().expect("random");
        assert!(!verify(
            &other,
            "1800000000",
            body,
            &signature,
            1_800_000_000,
            300
        ));
        assert!(!verify(
            &secret,
            "1800000000",
            b"{}",
            &signature,
            1_800_000_000,
            300
        ));
        assert!(!verify(
            &secret,
            "1800000001",
            body,
            &signature,
            1_800_000_001,
            300
        ));
        assert!(!verify(
            &secret,
            "1800000000",
            body,
            &signature,
            1_800_000_301,
            300
        ));
    }

    #[test]
    fn the_signature_matches_a_known_vector() {
        // HMAC-SHA256("whsec_test", "1700000000.{}"), computed with Python's hmac module (the
        // receiver guide's worked example).
        assert_eq!(
            sign("whsec_test", 1_700_000_000, b"{}"),
            "v1=35495024f4ef3f94e5a93e22221544c4b75e9a42300cd965ab81cb85cd994e91"
        );
    }
}
