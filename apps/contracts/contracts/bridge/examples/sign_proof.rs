//! Dev helper for interacting with the bridge contract on a live network.
//!
//! The bridge requires ECDSA secp256k1 multi-signature proofs of the form
//! `sha256(action || request_id_be8)` signed by a configured oracle signer
//! set. The `stellar` CLI cannot produce such proofs, so this example mirrors
//! the exact construction used by the contract's unit tests.
//!
//! # Usage
//!
//! Generate a 2-of-3 oracle key set (prints private keys and the 65-byte
//! uncompressed public keys used by `set_signers`):
//!
//! ```text
//! cargo run -p afri-contract-bridge --example sign_proof -- gen 3
//! ```
//!
//! Sign a proof for a bridge request (prints the hex proof for `mint_wrapped`
//! / `unlock_asset`):
//!
//! ```text
//! cargo run -p afri-contract-bridge --example sign_proof -- sign <priv1> <priv2> mint 1
//! cargo run -p afri-contract-bridge --example sign_proof -- sign <priv1> <priv2> unlock 3
//! ```
//!
//! Private keys are 32-byte hex scalars (e.g. from `openssl rand -hex 32`).

use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use k256::sha2::{Digest, Sha256};
use rand_core::OsRng;

const ACTION_MINT: u8 = 1;
const ACTION_UNLOCK: u8 = 2;
const SIGNATURE_BLOCK_SIZE: usize = 65;

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn parse_hex(input: &str) -> Result<Vec<u8>, String> {
    let input = input.strip_prefix("0x").unwrap_or(input);
    if !input.len().is_multiple_of(2) {
        return Err(format!("odd-length hex string: {input}"));
    }
    (0..input.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&input[i..i + 2], 16)
                .map_err(|_| format!("invalid hex byte: {}", &input[i..i + 2]))
        })
        .collect()
}

fn parse_private_key(hex: &str) -> Result<SigningKey, String> {
    let bytes = parse_hex(hex)?;
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "private key must be exactly 32 bytes".to_string())?;
    SigningKey::from_slice(&array).map_err(|e| format!("invalid secp256k1 scalar: {e}"))
}

fn proof_digest(action: u8, request_id: u64) -> [u8; 32] {
    let mut msg = [0u8; 9];
    msg[0] = action;
    msg[1..].copy_from_slice(&request_id.to_be_bytes());
    Sha256::digest(msg).into()
}

fn sign_proof(keys: &[&SigningKey], action: u8, request_id: u64) -> Vec<u8> {
    let digest = proof_digest(action, request_id);
    let mut proof = Vec::new();
    for key in keys {
        let (sig, recovery_id): (Signature, RecoveryId) = key
            .sign_prehash_recoverable(&digest)
            .expect("signing should succeed");
        proof.push(recovery_id.to_byte());
        proof.extend_from_slice(&sig.to_bytes());
    }
    proof
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("gen") => {
            let count: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(3);
            println!("# Oracle signer set");
            for i in 0..count {
                let key = SigningKey::random(&mut OsRng);
                let pubkey = key
                    .verifying_key()
                    .to_encoded_point(false)
                    .as_bytes()
                    .to_vec();
                println!("KEY{}_PRIV={}", i + 1, hex_encode(&key.to_bytes()));
                println!("KEY{}_PUB=0x{}", i + 1, hex_encode(&pubkey));
            }
        }
        Some("sign") if args.len() >= 5 => {
            let key1 = parse_private_key(&args[1]).expect("invalid key 1");
            let key2 = parse_private_key(&args[2]).expect("invalid key 2");
            let action = match args[3].as_str() {
                "mint" => ACTION_MINT,
                "unlock" => ACTION_UNLOCK,
                other => panic!("action must be 'mint' or 'unlock', got '{other}'"),
            };
            let request_id: u64 = args[4].parse().expect("request_id must be a u64");
            let proof = sign_proof(&[&key1, &key2], action, request_id);
            assert_eq!(proof.len(), 2 * SIGNATURE_BLOCK_SIZE);
            println!("0x{}", hex_encode(&proof));
        }
        _ => {
            eprintln!(
                "usage:\n  sign_proof gen [count]\n  sign_proof sign <priv1_hex> <priv2_hex> mint|unlock <request_id>"
            );
            std::process::exit(1);
        }
    }
}
