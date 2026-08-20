//! Dev helper for interacting with the bridge contract on a live network.
//!
//! The bridge requires ECDSA secp256k1 multi-signature proofs of the form
//! `sha256(contract || action || request_id_be8 || asset || amount_be16 ||
//! destination)`, signed by a configured oracle signer set. The `stellar`
//! CLI cannot produce such proofs, so this example mirrors the exact
//! construction used by the contract's unit tests.
//!
//! # Usage
//!
//! Generate an oracle signer set (prints private keys and the 65-byte
//! uncompressed public keys used by `set_signers`):
//!
//! ```text
//! cargo run -p afri-contract-bridge --example sign_proof -- gen 3
//! ```
//!
//! Sign a proof for a bridge action. All keys passed before the action are
//! included in the proof; the threshold is whatever the bridge is configured
//! with.
//!
//! ```text
//! cargo run -p afri-contract-bridge --example sign_proof -- sign \
//!     <priv1_hex> <priv2_hex> <priv3_hex> ... mint|unlock <request_id> \
//>     <contract_address_strkey> <asset_strkey> <amount> <destination_strkey>
//! ```
//!
//! # Security caveat
//!
//! Passing private keys as command-line arguments exposes them to the shell
//! history and to any process listing on the host. For real deployments use
//! a HSM, an env var, or read the keys from a secrets manager.

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

/// Build the proof preimage. The bytes are appended in the exact order the
/// contract computes its digest so a recovery on-chain matches the signature.
fn proof_digest(
    contract_address: &str,
    action: u8,
    request_id: u64,
    asset: &str,
    amount: i128,
    destination: &str,
) -> [u8; 32] {
    let mut msg: Vec<u8> = Vec::new();
    msg.extend_from_slice(contract_address.as_bytes());
    msg.push(action);
    msg.extend_from_slice(&request_id.to_be_bytes());
    msg.extend_from_slice(asset.as_bytes());
    msg.extend_from_slice(&amount.to_be_bytes());
    msg.extend_from_slice(destination.as_bytes());
    let hash: [u8; 32] = Sha256::digest(msg).into();
    hash
}

fn sign_proof(
    keys: &[&SigningKey],
    contract_address: &str,
    action: u8,
    request_id: u64,
    asset: &str,
    amount: i128,
    destination: &str,
) -> Vec<u8> {
    let digest = proof_digest(
        contract_address,
        action,
        request_id,
        asset,
        amount,
        destination,
    );
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
        Some("sign") if args.len() >= 9 => {
            // Layout:
            //   sign <priv1_hex> <priv2_hex> ... mint|unlock <request_id>
            //     <contract_strkey> <asset_strkey> <amount> <destination_strkey>
            // The six trailing arguments are: action, request_id, contract,
            // asset, amount, destination. Everything between the first
            // argument (`sign`) and those six is a private key.
            let n = args.len();
            let action_str = &args[n - 6];
            let request_id: u64 = args[n - 5].parse().expect("request_id must be a u64");
            let contract_address = &args[n - 4];
            let asset = &args[n - 3];
            let amount: i128 = args[n - 2].parse().expect("amount must parse as i128");
            let destination = &args[n - 1];
            let action = match action_str.as_str() {
                "mint" => ACTION_MINT,
                "unlock" => ACTION_UNLOCK,
                other => {
                    eprintln!("action must be 'mint' or 'unlock', got '{other}'");
                    std::process::exit(1);
                }
            };
            let key_args: &[String] = &args[1..n - 6];
            if key_args.is_empty() {
                eprintln!("provide at least one private key");
                std::process::exit(1);
            }
            let mut keys = Vec::new();
            for raw in key_args {
                keys.push(parse_private_key(raw).expect("invalid private key"));
            }
            let key_refs: Vec<&SigningKey> = keys.iter().collect();
            let proof = sign_proof(
                &key_refs,
                contract_address,
                action,
                request_id,
                asset,
                amount,
                destination,
            );
            assert_eq!(proof.len(), key_refs.len() * SIGNATURE_BLOCK_SIZE);
            println!("0x{}", hex_encode(&proof));
        }
        _ => {
            eprintln!(
                "usage:\n  sign_proof gen [count]\n  sign_proof sign <priv1_hex> [<priv2_hex> ...] mint|unlock <request_id> <contract_strkey> <asset_strkey> <amount> <destination_strkey>"
            );
            std::process::exit(1);
        }
    }
}
