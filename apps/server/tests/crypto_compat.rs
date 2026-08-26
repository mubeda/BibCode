use hmac::{Hmac, KeyInit as _, Mac};
use p256::ecdsa::{
    Signature as P256Signature, SigningKey as P256SigningKey,
    signature::hazmat::{PrehashSigner as _, PrehashVerifier as _},
};
use sha2::{Digest as _, Sha256};

type HmacSha256 = Hmac<Sha256>;

fn encode_hex(input: &[u8]) -> String {
    input.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn p256_dpop_key_and_deterministic_signature_are_stable() {
    let mut secret = [0_u8; 32];
    secret[31] = 1;
    let signing_key = P256SigningKey::from_slice(&secret).expect("valid P-256 scalar");
    let verifying_key = signing_key.verifying_key();
    let public_point = verifying_key.to_sec1_point(false);

    assert_eq!(
        encode_hex(public_point.as_bytes()),
        "046b17d1f2e12c4247f8bce6e563a440\
         f277037d812deb33a0f4a13945d898c296\
         4fe342e2fe1a7f9b8ee7eb4a7c0f9e16\
         2bce33576b315ececbb6406837bf51f5"
            .replace(' ', "")
    );

    let signing_input = b"eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.\
        eyJqdGkiOiJmaXhlZC1qdGkiLCJodG0iOiJHRVQiLCJodHUiOiJodHRwczovL2V4YW1wbGUuY29tIn0";
    let digest = Sha256::digest(signing_input);
    let signature: P256Signature = signing_key
        .sign_prehash(&digest)
        .expect("sign fixed DPoP prehash");
    verifying_key
        .verify_prehash(&digest, &signature)
        .expect("verify fixed DPoP prehash");
    assert_eq!(
        encode_hex(&signature.to_bytes()),
        "ad3527305c7f882f640d871e77b7dc3d\
         35abfca65fa639efb12362cafcaced1c\
         dec2e4a9299433eb3d695b964cdc242\
         627393a1779354b46a69c4b8153f4fa27"
            .replace(' ', "")
    );
}

#[test]
fn sha256_hmac_and_os_random_apis_remain_compatible() {
    assert_eq!(
        encode_hex(&Sha256::digest(b"abc")),
        "ba7816bf8f01cfea414140de5dae2223\
         b00361a396177a9cb410ff61f20015ad"
            .replace(' ', "")
    );

    let mut mac =
        HmacSha256::new_from_slice(&[0x0b; 20]).expect("HMAC accepts secrets of any length");
    mac.update(b"Hi There");
    assert_eq!(
        encode_hex(&mac.finalize().into_bytes()),
        "b0344c61d8db38535ca8afceaf0bf12b\
         881dc200c9833da726e9376c2e32cff7"
            .replace(' ', "")
    );

    let mut random = [0_u8; 32];
    getrandom::fill(&mut random).expect("operating-system randomness");
    assert_ne!(random, [0_u8; 32]);
}
