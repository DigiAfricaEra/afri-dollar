use crate::{
    BridgeContract, BridgeContractClient, BridgeError, BridgeStatus, ACTION_MINT, ACTION_UNLOCK,
};
use afri_contract_shared::Error;
use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env, Vec,
};

const INITIAL_SUPPLY: i128 = 1_000_000;
const DEFAULT_FEE_BPS: u32 = 30;

struct Fixture {
    contract_id: Address,
    admin: Address,
    user: Address,
    issuer: Address,
    wrapped_holder: Address,
    recipient: Address,
    treasury: Address,
    asset: Address,
    wrapped_asset: Address,
    signer1: SigningKey,
    signer2: SigningKey,
    signer3: SigningKey,
}

fn setup() -> (Env, Fixture) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(BridgeContract, ());
    let client = BridgeContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let token_admin = Address::generate(&env);
    let asset = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let wrapped_asset = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let user = Address::generate(&env);
    let issuer = Address::generate(&env);
    let wrapped_holder = Address::generate(&env);
    let recipient = Address::generate(&env);
    let treasury = Address::generate(&env);

    StellarAssetClient::new(&env, &asset).mint(&user, &INITIAL_SUPPLY);
    StellarAssetClient::new(&env, &wrapped_asset).mint(&wrapped_holder, &INITIAL_SUPPLY);

    let signer1 = signing_key(1);
    let signer2 = signing_key(2);
    let signer3 = signing_key(3);

    // Configure the 2-of-3 oracle signer set.
    client.set_signers(&admin, &signer_vec(&env, &signer1, &signer2, &signer3), &2);

    (
        env,
        Fixture {
            contract_id,
            admin,
            user,
            issuer,
            wrapped_holder,
            recipient,
            treasury,
            asset,
            wrapped_asset,
            signer1,
            signer2,
            signer3,
        },
    )
}

fn client<'a>(env: &'a Env, fixture: &Fixture) -> BridgeContractClient<'a> {
    BridgeContractClient::new(env, &fixture.contract_id)
}

fn token<'a>(env: &'a Env, asset: &'a Address) -> TokenClient<'a> {
    TokenClient::new(env, asset)
}

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_slice(&[seed; 32]).expect("valid secp256k1 scalar")
}

fn pubkey(env: &Env, key: &SigningKey) -> BytesN<65> {
    let bytes: [u8; 65] = key
        .verifying_key()
        .to_encoded_point(false)
        .as_bytes()
        .try_into()
        .expect("65-byte uncompressed point");
    BytesN::from_array(env, &bytes)
}

fn signer_vec(
    env: &Env,
    signer1: &SigningKey,
    signer2: &SigningKey,
    signer3: &SigningKey,
) -> Vec<BytesN<65>> {
    soroban_sdk::vec![
        env,
        pubkey(env, signer1),
        pubkey(env, signer2),
        pubkey(env, signer3),
    ]
}

fn proof_digest(env: &Env, action: u8, request_id: u64) -> [u8; 32] {
    let mut msg = [0u8; 9];
    msg[0] = action;
    msg[1..].copy_from_slice(&request_id.to_be_bytes());
    env.crypto()
        .sha256(&Bytes::from_array(env, &msg))
        .to_array()
}

fn sign(env: &Env, key: &SigningKey, action: u8, request_id: u64) -> (Signature, RecoveryId) {
    key.sign_prehash_recoverable(&proof_digest(env, action, request_id))
        .expect("signing should succeed")
}

fn mint_proof(env: &Env, request_id: u64, keys: &[&SigningKey]) -> Bytes {
    let mut proof = Bytes::new(env);
    for key in keys {
        let (sig, recid) = sign(env, key, ACTION_MINT, request_id);
        proof.push_back(recid.to_byte());
        let bytes: [u8; 64] = sig.to_bytes().into();
        proof.extend_from_array(&bytes);
    }
    proof
}

fn unlock_proof(env: &Env, request_id: u64, keys: &[&SigningKey]) -> Bytes {
    let mut proof = Bytes::new(env);
    for key in keys {
        let (sig, recid) = sign(env, key, ACTION_UNLOCK, request_id);
        proof.push_back(recid.to_byte());
        let bytes: [u8; 64] = sig.to_bytes().into();
        proof.extend_from_array(&bytes);
    }
    proof
}

fn recipient_bytes(env: &Env) -> Bytes {
    Bytes::from_array(env, &[1, 2, 3, 4, 5])
}

fn lock(env: &Env, fixture: &Fixture, caller: &Address, amount: i128) -> u64 {
    client(env, fixture).lock_asset(
        caller,
        &fixture.asset,
        &amount,
        &symbol_short!("ethereum"),
        &recipient_bytes(env),
    )
}

fn burn(env: &Env, fixture: &Fixture, amount: i128) -> u64 {
    client(env, fixture).burn_wrapped(
        &fixture.wrapped_holder,
        &fixture.asset,
        &fixture.wrapped_asset,
        &amount,
        &symbol_short!("ethereum"),
        &fixture.recipient,
    )
}

fn mint(env: &Env, fixture: &Fixture, request_id: u64) {
    let proof = mint_proof(env, request_id, &[&fixture.signer1, &fixture.signer2]);
    client(env, fixture).mint_wrapped(&request_id, &proof, &fixture.issuer);
}

fn unlock(env: &Env, fixture: &Fixture, request_id: u64) {
    let proof = unlock_proof(env, request_id, &[&fixture.signer1, &fixture.signer2]);
    client(env, fixture).unlock_asset(&request_id, &proof);
}

#[test]
fn initialize_sets_defaults() {
    let (env, fixture) = setup();
    assert_eq!(client(&env, &fixture).get_bridge_fee(), DEFAULT_FEE_BPS);
    assert_eq!(client(&env, &fixture).get_signer_threshold(), 2);
}

#[test]
fn initialize_is_one_time_only() {
    let (env, fixture) = setup();
    let result = client(&env, &fixture).try_initialize(&fixture.admin);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn initialize_before_operations_errors() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(BridgeContract, ());
    let client = BridgeContractClient::new(&env, &contract_id);

    let caller = Address::generate(&env);
    let asset = Address::generate(&env);
    let recipient = Bytes::from_array(&env, &[1, 2, 3, 4]);

    let result = client.try_lock_asset(
        &caller,
        &asset,
        &1000,
        &symbol_short!("ethereum"),
        &recipient,
    );
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn lock_asset_creates_bridge_request() {
    let (env, fixture) = setup();
    let request_id = lock(&env, &fixture, &fixture.user, 10_000);

    assert_eq!(request_id, 1);

    let request = client(&env, &fixture)
        .get_bridge_request(&request_id)
        .unwrap();
    assert_eq!(request.id, 1);
    assert_eq!(request.gross_amount, 10_000);
    assert_eq!(request.amount, 9_970); // 10_000 - 0.30% fee (30 basis points)
    assert_eq!(request.bridge_fee_applied, 30);
    assert_eq!(request.status, BridgeStatus::Locked);
    assert_eq!(request.sender, fixture.user);
    assert_eq!(request.unlock_recipient, None);
}

#[test]
fn lock_asset_moves_tokens_into_contract() {
    let (env, fixture) = setup();
    lock(&env, &fixture, &fixture.user, 10_000);

    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.user),
        INITIAL_SUPPLY - 10_000
    );
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.contract_id),
        10_000
    );
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.issuer), 0);
}

#[test]
fn lock_asset_tracks_collected_fees() {
    let (env, fixture) = setup();
    lock(&env, &fixture, &fixture.user, 10_000);
    assert_eq!(
        client(&env, &fixture).get_collected_fees(&fixture.asset),
        30
    );

    lock(&env, &fixture, &fixture.user, 10_000);
    assert_eq!(
        client(&env, &fixture).get_collected_fees(&fixture.asset),
        60
    );
}

#[test]
fn lock_asset_emits_event() {
    let (env, fixture) = setup();
    lock(&env, &fixture, &fixture.user, 10_000);

    let events = env.events().all();
    let empty: soroban_sdk::Vec<(
        Address,
        soroban_sdk::Vec<soroban_sdk::Val>,
        soroban_sdk::Val,
    )> = soroban_sdk::vec![&env];
    assert_ne!(events, empty, "expected at least one event to be emitted");
}

#[test]
fn lock_asset_increments_request_id() {
    let (env, fixture) = setup();
    assert_eq!(lock(&env, &fixture, &fixture.user, 1000), 1);
    assert_eq!(lock(&env, &fixture, &fixture.user, 2000), 2);
}

#[test]
fn lock_asset_rejects_zero_amount() {
    let (env, fixture) = setup();
    let result = client(&env, &fixture).try_lock_asset(
        &fixture.user,
        &fixture.asset,
        &0,
        &symbol_short!("ethereum"),
        &recipient_bytes(&env),
    );
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.user),
        INITIAL_SUPPLY
    );
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.contract_id), 0);
}

#[test]
fn mint_wrapped_changes_status_and_pays_issuer() {
    let (env, fixture) = setup();
    let request_id = lock(&env, &fixture, &fixture.user, 10_000);
    mint(&env, &fixture, request_id);

    let request = client(&env, &fixture)
        .get_bridge_request(&request_id)
        .unwrap();
    assert_eq!(request.status, BridgeStatus::Minted);
    assert!(request.completed_at.is_some());

    // The net amount is released to the wrapped-asset minter; the fee stays.
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.issuer), 9_970);
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.contract_id),
        30
    );
}

#[test]
fn mint_wrapped_requires_valid_proof() {
    let (env, fixture) = setup();
    let request_id = lock(&env, &fixture, &fixture.user, 10_000);

    let outsider = mint_proof(&env, request_id, &[&signing_key(200), &signing_key(201)]);
    let result = client(&env, &fixture).try_mint_wrapped(&request_id, &outsider, &fixture.issuer);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));

    // No funds moved by the rejected proof.
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.issuer), 0);
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.contract_id),
        10_000
    );
}

#[test]
fn mint_wrapped_rejects_proof_for_another_request() {
    let (env, fixture) = setup();
    let request_id = lock(&env, &fixture, &fixture.user, 10_000);

    // Signers signed a different request; the proof must not be reusable.
    let wrong = mint_proof(&env, 999, &[&fixture.signer1, &fixture.signer2]);
    let result = client(&env, &fixture).try_mint_wrapped(&request_id, &wrong, &fixture.issuer);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.issuer), 0);
}

#[test]
fn mint_wrapped_rejects_insufficient_signatures() {
    let (env, fixture) = setup();
    let request_id = lock(&env, &fixture, &fixture.user, 10_000);

    // One signature does not meet the 2-of-3 threshold.
    let single = mint_proof(&env, request_id, &[&fixture.signer1]);
    let result = client(&env, &fixture).try_mint_wrapped(&request_id, &single, &fixture.issuer);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));

    // Duplicate signatures from the same signer still count as one.
    let duplicate = mint_proof(&env, request_id, &[&fixture.signer1, &fixture.signer1]);
    let result = client(&env, &fixture).try_mint_wrapped(&request_id, &duplicate, &fixture.issuer);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));

    assert_eq!(token(&env, &fixture.asset).balance(&fixture.issuer), 0);
}

#[test]
fn mint_wrapped_rejects_malformed_proof() {
    let (env, fixture) = setup();
    let request_id = lock(&env, &fixture, &fixture.user, 10_000);

    let malformed = Bytes::from_array(&env, &[9, 8, 7, 6]);
    let result = client(&env, &fixture).try_mint_wrapped(&request_id, &malformed, &fixture.issuer);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.issuer), 0);
}

#[test]
fn mint_wrapped_wrong_status_errors() {
    let (env, fixture) = setup();
    let request_id = lock(&env, &fixture, &fixture.user, 1000);
    mint(&env, &fixture, request_id);

    // Minting an already-minted request must fail.
    let proof = mint_proof(&env, request_id, &[&fixture.signer1, &fixture.signer2]);
    let result = client(&env, &fixture).try_mint_wrapped(&request_id, &proof, &fixture.issuer);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn mint_wrapped_nonexistent_request_errors() {
    let (env, fixture) = setup();
    let proof = mint_proof(&env, 999, &[&fixture.signer1, &fixture.signer2]);
    let result = client(&env, &fixture).try_mint_wrapped(&999, &proof, &fixture.issuer);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn burn_wrapped_creates_burn_request_and_deposits_wrapped() {
    let (env, fixture) = setup();
    let request_id = burn(&env, &fixture, 500);

    assert_eq!(request_id, 1);

    let request = client(&env, &fixture)
        .get_bridge_request(&request_id)
        .unwrap();
    assert_eq!(request.id, 1);
    assert_eq!(request.gross_amount, 500);
    assert_eq!(request.amount, 500); // no fee on the return leg
    assert_eq!(request.bridge_fee_applied, 0);
    assert_eq!(request.status, BridgeStatus::Burned);
    assert_eq!(request.asset, fixture.asset);
    assert_eq!(request.unlock_recipient, Some(fixture.recipient.clone()));

    // The wrapped tokens are deposited into the contract.
    assert_eq!(
        token(&env, &fixture.wrapped_asset).balance(&fixture.wrapped_holder),
        INITIAL_SUPPLY - 500
    );
    assert_eq!(
        token(&env, &fixture.wrapped_asset).balance(&fixture.contract_id),
        500
    );
}

#[test]
fn burn_wrapped_rejects_zero_amount() {
    let (env, fixture) = setup();
    let result = client(&env, &fixture).try_burn_wrapped(
        &fixture.wrapped_holder,
        &fixture.asset,
        &fixture.wrapped_asset,
        &0,
        &symbol_short!("ethereum"),
        &fixture.recipient,
    );
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(
        token(&env, &fixture.wrapped_asset).balance(&fixture.wrapped_holder),
        INITIAL_SUPPLY
    );
}

#[test]
fn unlock_asset_changes_status_and_pays_recipient() {
    let (env, fixture) = setup();
    // Pool liquidity for the return leg.
    lock(&env, &fixture, &fixture.user, 10_000);

    let burn_id = burn(&env, &fixture, 500);
    unlock(&env, &fixture, burn_id);

    let request = client(&env, &fixture).get_bridge_request(&burn_id).unwrap();
    assert_eq!(request.status, BridgeStatus::Unlocked);
    assert!(request.completed_at.is_some());

    assert_eq!(token(&env, &fixture.asset).balance(&fixture.recipient), 500);
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.contract_id),
        9_500
    );
}

#[test]
fn unlock_asset_requires_valid_proof() {
    let (env, fixture) = setup();
    lock(&env, &fixture, &fixture.user, 10_000);
    let burn_id = burn(&env, &fixture, 500);

    let outsider = unlock_proof(&env, burn_id, &[&signing_key(200), &signing_key(201)]);
    let result = client(&env, &fixture).try_unlock_asset(&burn_id, &outsider);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));

    // No funds moved by the rejected proof.
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.recipient), 0);
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.contract_id),
        10_000
    );
}

#[test]
fn unlock_asset_rejects_insufficient_signatures() {
    let (env, fixture) = setup();
    lock(&env, &fixture, &fixture.user, 10_000);
    let burn_id = burn(&env, &fixture, 500);

    let single = unlock_proof(&env, burn_id, &[&fixture.signer2]);
    let result = client(&env, &fixture).try_unlock_asset(&burn_id, &single);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.recipient), 0);
}

#[test]
fn unlock_asset_wrong_status_errors() {
    let (env, fixture) = setup();
    // A lock request is not eligible for unlocking.
    let lock_id = lock(&env, &fixture, &fixture.user, 1000);

    let result = client(&env, &fixture).try_unlock_asset(&lock_id, &Bytes::new(&env));
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn unlock_asset_requires_proof() {
    let (env, fixture) = setup();
    lock(&env, &fixture, &fixture.user, 10_000);
    let burn_id = burn(&env, &fixture, 500);

    let result = client(&env, &fixture).try_unlock_asset(&burn_id, &Bytes::new(&env));
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.recipient), 0);
}

#[test]
fn withdraw_fees_moves_collected_fees() {
    let (env, fixture) = setup();
    lock(&env, &fixture, &fixture.user, 10_000);
    lock(&env, &fixture, &fixture.user, 5_000);

    assert_eq!(
        client(&env, &fixture).get_collected_fees(&fixture.asset),
        45
    );

    client(&env, &fixture).withdraw_fees(&fixture.admin, &fixture.asset, &fixture.treasury, &45);

    assert_eq!(client(&env, &fixture).get_collected_fees(&fixture.asset), 0);
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.treasury), 45);
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.contract_id),
        15_000 - 45
    );
}

#[test]
fn withdraw_fees_requires_admin() {
    let (env, fixture) = setup();
    lock(&env, &fixture, &fixture.user, 10_000);

    let stranger = Address::generate(&env);
    let result =
        client(&env, &fixture).try_withdraw_fees(&stranger, &fixture.asset, &fixture.treasury, &30);
    assert_eq!(result, Err(Ok(BridgeError::FeeWithdrawalUnauthorized)));

    assert_eq!(
        client(&env, &fixture).get_collected_fees(&fixture.asset),
        30
    );
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.treasury), 0);
}

#[test]
fn withdraw_fees_rejects_over_withdrawal() {
    let (env, fixture) = setup();
    lock(&env, &fixture, &fixture.user, 10_000); // collects 30

    let over = client(&env, &fixture).try_withdraw_fees(
        &fixture.admin,
        &fixture.asset,
        &fixture.treasury,
        &31,
    );
    assert_eq!(over, Err(Ok(BridgeError::InsufficientFees)));

    let zero = client(&env, &fixture).try_withdraw_fees(
        &fixture.admin,
        &fixture.asset,
        &fixture.treasury,
        &0,
    );
    assert_eq!(zero, Err(Ok(BridgeError::InsufficientFees)));

    assert_eq!(
        client(&env, &fixture).get_collected_fees(&fixture.asset),
        30
    );
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.treasury), 0);
}

#[test]
fn set_signers_validates_threshold() {
    let (env, fixture) = setup();
    let signers = signer_vec(&env, &fixture.signer1, &fixture.signer2, &fixture.signer3);
    let empty = soroban_sdk::vec![&env];

    assert_eq!(
        client(&env, &fixture).try_set_signers(&fixture.admin, &signers, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        client(&env, &fixture).try_set_signers(&fixture.admin, &empty, &2),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        client(&env, &fixture).try_set_signers(&fixture.admin, &signers, &4),
        Err(Ok(Error::InvalidAmount))
    );

    // The previous configuration is untouched.
    assert_eq!(client(&env, &fixture).get_signer_threshold(), 2);
}

#[test]
fn set_signers_requires_admin() {
    let (env, fixture) = setup();
    let signers = signer_vec(&env, &fixture.signer1, &fixture.signer2, &fixture.signer3);

    let stranger = Address::generate(&env);
    let result = client(&env, &fixture).try_set_signers(&stranger, &signers, &1);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn set_signers_threshold_one_allows_single_signature() {
    let (env, fixture) = setup();
    let signers = signer_vec(&env, &fixture.signer1, &fixture.signer2, &fixture.signer3);
    client(&env, &fixture).set_signers(&fixture.admin, &signers, &1);
    assert_eq!(client(&env, &fixture).get_signer_threshold(), 1);

    let request_id = lock(&env, &fixture, &fixture.user, 10_000);
    let single = mint_proof(&env, request_id, &[&fixture.signer3]);
    client(&env, &fixture).mint_wrapped(&request_id, &single, &fixture.issuer);

    assert_eq!(
        client(&env, &fixture)
            .get_bridge_request(&request_id)
            .unwrap()
            .status,
        BridgeStatus::Minted
    );
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.issuer), 9_970);
}

#[test]
fn bridge_request_tracks_completion_time() {
    let (env, fixture) = setup();
    let request_id = lock(&env, &fixture, &fixture.user, 1000);

    assert!(client(&env, &fixture)
        .get_bridge_request(&request_id)
        .unwrap()
        .completed_at
        .is_none());

    mint(&env, &fixture, request_id);

    assert!(client(&env, &fixture)
        .get_bridge_request(&request_id)
        .unwrap()
        .completed_at
        .is_some());
}

#[test]
fn end_to_end_bridge_cycle() {
    let (env, fixture) = setup();

    // Outbound: lock 10_000, then mint the net 9_970 to the wrapped-asset minter.
    let lock_id = lock(&env, &fixture, &fixture.user, 10_000);
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.user),
        INITIAL_SUPPLY - 10_000
    );
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.contract_id),
        10_000
    );

    mint(&env, &fixture, lock_id);
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.issuer), 9_970);
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.contract_id),
        30
    );
    assert_eq!(
        client(&env, &fixture).get_collected_fees(&fixture.asset),
        30
    );

    // Pool liquidity for the return leg.
    lock(&env, &fixture, &fixture.user, 5_000);
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.contract_id),
        5_030
    );

    // Inbound: burn 500 wrapped tokens, then unlock 500 original to the recipient.
    let burn_id = burn(&env, &fixture, 500);
    assert_eq!(
        token(&env, &fixture.wrapped_asset).balance(&fixture.wrapped_holder),
        INITIAL_SUPPLY - 500
    );
    assert_eq!(
        token(&env, &fixture.wrapped_asset).balance(&fixture.contract_id),
        500
    );

    unlock(&env, &fixture, burn_id);
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.recipient), 500);
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.contract_id),
        4_530
    );
    assert_eq!(
        client(&env, &fixture)
            .get_bridge_request(&burn_id)
            .unwrap()
            .status,
        BridgeStatus::Unlocked
    );

    // Treasury: the admin withdraws the accumulated fees (30 on the outbound
    // lock plus 15 on the pool lock).
    client(&env, &fixture).withdraw_fees(&fixture.admin, &fixture.asset, &fixture.treasury, &45);
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.treasury), 45);
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.contract_id),
        4_485
    );
    assert_eq!(client(&env, &fixture).get_collected_fees(&fixture.asset), 0);
}
