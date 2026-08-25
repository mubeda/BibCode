use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, SigningKey, signature::hazmat::PrehashSigner};
use reqwest::{Client, RequestBuilder, StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub struct DpopSession {
    access_token: String,
    signing_key: SigningKey,
}

impl DpopSession {
    pub fn authorize(&self, request: RequestBuilder, method: &str, url: &str) -> RequestBuilder {
        request
            .header("authorization", format!("DPoP {}", self.access_token))
            .header(
                "dpop",
                dpop_proof(&self.signing_key, method, url, Some(&self.access_token)),
            )
    }
}

pub async fn exchange_pairing(
    client: &Client,
    token_url: &str,
    credential: &str,
    signing_seed: u8,
) -> DpopSession {
    let signing_key = SigningKey::from_bytes((&[signing_seed; 32]).into())
        .expect("valid deterministic DPoP signing key");
    let response = client
        .post(token_url)
        .header("dpop", dpop_proof(&signing_key, "POST", token_url, None))
        .form(&[
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:token-exchange",
            ),
            ("subject_token", credential),
            (
                "subject_token_type",
                "urn:bibcode:params:oauth:token-type:environment-bootstrap",
            ),
            (
                "requested_token_type",
                "urn:ietf:params:oauth:token-type:access_token",
            ),
        ])
        .send()
        .await
        .expect("DPoP pairing exchange response");
    let status = response.status();
    let body = response.text().await.expect("DPoP pairing exchange body");
    assert_eq!(
        status,
        StatusCode::OK,
        "DPoP pairing exchange failed: {body}"
    );
    let access_token =
        serde_json::from_str::<Value>(&body).expect("DPoP pairing exchange JSON")["access_token"]
            .as_str()
            .expect("DPoP access token")
            .to_owned();
    DpopSession {
        access_token,
        signing_key,
    }
}

fn dpop_proof(
    signing_key: &SigningKey,
    method: &str,
    url: &str,
    access_token: Option<&str>,
) -> String {
    let point = signing_key.verifying_key().to_sec1_point(false);
    let header = json!({
        "typ": "dpop+jwt",
        "alg": "ES256",
        "jwk": {
            "kty": "EC",
            "crv": "P-256",
            "x": URL_SAFE_NO_PAD.encode(point.x().expect("P-256 x coordinate")),
            "y": URL_SAFE_NO_PAD.encode(point.y().expect("P-256 y coordinate")),
        }
    });
    let mut normalized_url = url::Url::parse(url).expect("DPoP fixture URL");
    normalized_url.set_query(None);
    normalized_url.set_fragment(None);
    let mut payload = json!({
        "htm": method,
        "htu": normalized_url.to_string(),
        "jti": uuid::Uuid::new_v4().to_string(),
        "iat": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_secs(),
    });
    if let Some(access_token) = access_token {
        payload["ath"] = json!(URL_SAFE_NO_PAD.encode(Sha256::digest(access_token.as_bytes())));
    }
    let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).expect("DPoP header JSON"));
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("DPoP payload JSON"));
    let signing_input = format!("{header}.{payload}");
    let digest = Sha256::digest(signing_input.as_bytes());
    let signature: Signature = signing_key
        .sign_prehash(&digest)
        .expect("sign DPoP fixture");
    format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    )
}
