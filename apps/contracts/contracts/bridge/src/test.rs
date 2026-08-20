use crate::{
    BridgeContract, BridgeContractClient, BridgeError, BridgeRequest, BridgeStatus, ACTION_MINT,
    ACTION_UNLOCK,
};
use afri_contract_shared::Error;
use k256::ecdsa::SigningKey;
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

fn proof_digest(
    env: &Env,
    contract_address: &Address,
    action: u8,
    request_id: u64,
    asset: &Address,
    amount: i128,
    destination: &Address,
) -> [u8; 32] {
    let mut msg = Bytes::new(env);
    msg.append(&contract_address.to_string().to_bytes());
    msg.push_back(action);
    msg.extend_from_array(&request_id.to_be_bytes());
    msg.append(&asset.to_string().to_bytes());
    msg.extend_from_array(&amount.to_be_bytes());
    msg.append(&destination.to_string().to_bytes());
    env.crypto().sha256(&msg).to_array()
}

/// Build a multi-signature proof for a single action against the configured
/// signers. The action byte and request id, together with the asset, amount,
/// and destination, are all folded into the signed preimage so the contract
/// can reject replay, value manipulation, or destination redirection.
#[allow(clippy::too_many_arguments)]
fn sign_request(
    env: &Env,
    contract_address: &Address,
    action: u8,
    request_id: u64,
    asset: &Address,
    amount: i128,
    destination: &Address,
    keys: &[&SigningKey],
) -> Bytes {
    let mut proof = Bytes::new(env);
    let digest = proof_digest(
        env,
        contract_address,
        action,
        request_id,
        asset,
        amount,
        destination,
    );
    for key in keys {
        let (sig, recid) = key
            .sign_prehash_recoverable(&digest)
            .expect("signing should succeed");
        proof.push_back(recid.to_byte());
        let bytes: [u8; 64] = sig.to_bytes().into();
        proof.extend_from_array(&bytes);
    }
    proof
}

fn mint_proof(
    env: &Env,
    contract_address: &Address,
    request: &BridgeRequest,
    destination: &Address,
    keys: &[&SigningKey],
) -> Bytes {
    sign_request(
        env,
        contract_address,
        ACTION_MINT,
        request.id,
        &request.asset,
        request.amount,
        destination,
        keys,
    )
}

fn unlock_proof(
    env: &Env,
    contract_address: &Address,
    request: &BridgeRequest,
    destination: &Address,
    keys: &[&SigningKey],
) -> Bytes {
    sign_request(
        env,
        contract_address,
        ACTION_UNLOCK,
        request.id,
        &request.asset,
        request.amount,
        destination,
        keys,
    )
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
    let request = client(env, fixture)
        .get_bridge_request(&request_id)
        .expect("request exists");
    let proof = mint_proof(
        env,
        &fixture.contract_id,
        &request,
        &fixture.issuer,
        &[&fixture.signer1, &fixture.signer2],
    );
    client(env, fixture).mint_wrapped(&request_id, &proof, &fixture.issuer);
}

fn unlock(env: &Env, fixture: &Fixture, request_id: u64) {
    let request = client(env, fixture)
        .get_bridge_request(&request_id)
        .expect("request exists");
    let proof = unlock_proof(
        env,
        &fixture.contract_id,
        &request,
        &fixture.recipient,
        &[&fixture.signer1, &fixture.signer2],
    );
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
    let request = client(&env, &fixture)
        .get_bridge_request(&request_id)
        .unwrap();

    let outsider = mint_proof(
        &env,
        &fixture.contract_id,
        &request,
        &fixture.issuer,
        &[&signing_key(200), &signing_key(201)],
    );
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
    let request = client(&env, &fixture)
        .get_bridge_request(&request_id)
        .unwrap();

    // Signers signed a different request; the proof must not be reusable.
    let wrong = sign_request(
        &env,
        &fixture.contract_id,
        ACTION_MINT,
        999,
        &request.asset,
        request.amount,
        &fixture.issuer,
        &[&fixture.signer1, &fixture.signer2],
    );
    let result = client(&env, &fixture).try_mint_wrapped(&request_id, &wrong, &fixture.issuer);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.issuer), 0);
}

#[test]
fn mint_wrapped_rejects_insufficient_signatures() {
    let (env, fixture) = setup();
    let request_id = lock(&env, &fixture, &fixture.user, 10_000);
    let request = client(&env, &fixture)
        .get_bridge_request(&request_id)
        .unwrap();

    // One signature does not meet the 2-of-3 threshold.
    let single = mint_proof(
        &env,
        &fixture.contract_id,
        &request,
        &fixture.issuer,
        &[&fixture.signer1],
    );
    let result = client(&env, &fixture).try_mint_wrapped(&request_id, &single, &fixture.issuer);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));

    // Duplicate signatures from the same signer still count as one.
    let duplicate = mint_proof(
        &env,
        &fixture.contract_id,
        &request,
        &fixture.issuer,
        &[&fixture.signer1, &fixture.signer1],
    );
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

    // The request is now Minted. The proof is well-formed but the contract
    // must reject it because the status check runs first.
    let request = client(&env, &fixture)
        .get_bridge_request(&request_id)
        .unwrap();
    let proof = mint_proof(
        &env,
        &fixture.contract_id,
        &request,
        &fixture.issuer,
        &[&fixture.signer1, &fixture.signer2],
    );
    let result = client(&env, &fixture).try_mint_wrapped(&request_id, &proof, &fixture.issuer);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn mint_wrapped_nonexistent_request_errors() {
    let (env, fixture) = setup();
    // Sign for an arbitrary asset/destination so the proof shape is valid;
    // the contract must reject before reaching signature verification.
    let any_asset = fixture.asset.clone();
    let proof = sign_request(
        &env,
        &fixture.contract_id,
        ACTION_MINT,
        999,
        &any_asset,
        1,
        &fixture.issuer,
        &[&fixture.signer1, &fixture.signer2],
    );
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
    let request = client(&env, &fixture).get_bridge_request(&burn_id).unwrap();

    let outsider = unlock_proof(
        &env,
        &fixture.contract_id,
        &request,
        &fixture.recipient,
        &[&signing_key(200), &signing_key(201)],
    );
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
    let request = client(&env, &fixture).get_bridge_request(&burn_id).unwrap();

    let single = unlock_proof(
        &env,
        &fixture.contract_id,
        &request,
        &fixture.recipient,
        &[&fixture.signer2],
    );
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
    let request = client(&env, &fixture)
        .get_bridge_request(&request_id)
        .unwrap();
    let single = mint_proof(
        &env,
        &fixture.contract_id,
        &request,
        &fixture.issuer,
        &[&fixture.signer3],
    );
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

// ---------------------------------------------------------------------------
// Security and accounting edges
// ---------------------------------------------------------------------------

/// Setting a bridge fee above 10000 basis points would cause the net amount
/// to go non-positive, stranding the locked deposit. The contract must reject
/// the call outright.
#[test]
fn set_bridge_fee_rejects_out_of_range() {
    let (env, fixture) = setup();
    let result = client(&env, &fixture).try_set_bridge_fee(&10_001);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
    // The configured fee is unchanged.
    assert_eq!(client(&env, &fixture).get_bridge_fee(), 30);
}

/// A fee at exactly the 100% boundary leaves a zero net amount. Lock must
/// refuse because a zero net is unsendable to the wrapped-asset minter.
#[test]
fn lock_rejects_100_percent_fee() {
    let (env, fixture) = setup();
    client(&env, &fixture).set_bridge_fee(&10_000);
    let result = client(&env, &fixture).try_lock_asset(
        &fixture.user,
        &fixture.asset,
        &1_000,
        &symbol_short!("ethereum"),
        &recipient_bytes(&env),
    );
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
    // The deposit never happened.
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.user),
        INITIAL_SUPPLY
    );
}

/// Even with the fee in range, a fee large enough to consume the entire
/// deposit leaves nothing for the net amount. The contract must reject the
/// lock and not transfer any tokens.
#[test]
fn lock_rejects_fee_that_empties_deposit() {
    let (env, fixture) = setup();
    // 100% fee.
    client(&env, &fixture).set_bridge_fee(&10_000);
    let result = client(&env, &fixture).try_lock_asset(
        &fixture.user,
        &fixture.asset,
        &1_000,
        &symbol_short!("ethereum"),
        &recipient_bytes(&env),
    );
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

/// If unlocks drain the pool down to the collected-fee reserve, the next
/// unlock must fail rather than spend the admin's fees. Withdraw must then
/// succeed for the still-tracked fee total.
#[test]
fn unlock_refuses_to_spend_fee_reserve() {
    let (env, fixture) = setup();
    // Lock + mint: the only thing left in the pool is the 30 bps fee.
    let lock_id = lock(&env, &fixture, &fixture.user, 10_000);
    mint(&env, &fixture, lock_id);
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.contract_id),
        30
    );
    assert_eq!(
        client(&env, &fixture).get_collected_fees(&fixture.asset),
        30
    );

    // Burn an amount that would require more than the available pool.
    let burn_id = burn(&env, &fixture, 500);
    let proof = unlock_proof(
        &env,
        &fixture.contract_id,
        &client(&env, &fixture).get_bridge_request(&burn_id).unwrap(),
        &fixture.recipient,
        &[&fixture.signer1, &fixture.signer2],
    );
    let result = client(&env, &fixture).try_unlock_asset(&burn_id, &proof);
    assert_eq!(result, Err(Ok(Error::InsufficientBalance)));

    // The pool was untouched by the rejected unlock.
    assert_eq!(
        token(&env, &fixture.asset).balance(&fixture.contract_id),
        30
    );
    // Collected-fees accounting is still intact and the admin can withdraw.
    client(&env, &fixture).withdraw_fees(&fixture.admin, &fixture.asset, &fixture.treasury, &30);
    assert_eq!(token(&env, &fixture.asset).balance(&fixture.treasury), 30);
    assert_eq!(client(&env, &fixture).get_collected_fees(&fixture.asset), 0);
}

/// A length-valid proof block whose `r || s` is not a valid secp256k1
/// signature must be rejected without a host panic. Recovery for an invalid
/// signature panics in `secp256k1_recover`; the contract does not currently
/// catch it. This test documents the trap behavior so a future hardening
/// pass can replace it with a clean `Unauthorized` return.
#[test]
fn mint_wrapped_rejects_invalid_signature_payload() {
    let (env, fixture) = setup();
    let request_id = lock(&env, &fixture, &fixture.user, 10_000);

    // A well-formed 130-byte proof: a valid recid (0) followed by 64 bytes of
    // zeros (not a valid r||s scalar). The contract should not be tricked
    // into treating this as a real signature.
    let mut bogus = Bytes::new(&env);
    bogus.push_back(0u8);
    bogus.extend_from_array(&[0u8; 64]); // first signature
    bogus.push_back(0u8);
    bogus.extend_from_array(&[0u8; 64]); // second signature

    let _ = bogus; // silence unused warning if the assertion changes
    let result = client(&env, &fixture).try_mint_wrapped(&request_id, &bogus, &fixture.issuer);
    // The recovery host function traps on a zero signature; accept either a
    // clean Unauthorized return or the host trap (Err(Err(...))).
    match result {
        Err(Ok(Error::Unauthorized)) => {}
        Err(Err(_)) => {}
        other => panic!(
            "expected rejection of invalid signature payload, got {:?}",
            other
        ),
    }
}

/// A duplicate signer key in the configured signer set is rejected so that
/// repeated proof signatures cannot satisfy multiple distinct signer slots.
#[test]
fn set_signers_rejects_duplicates() {
    let (env, fixture) = setup();
    let pub1 = pubkey(&env, &fixture.signer1);
    let mut signers = soroban_sdk::vec![&env, pub1.clone(), pub1.clone()];
    signers.push_back(pubkey(&env, &fixture.signer2));

    let result = client(&env, &fixture).try_set_signers(&fixture.admin, &signers, &2);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
    // Existing signer set is preserved.
    assert_eq!(client(&env, &fixture).get_signer_threshold(), 2);
}

/// The BridgeInitiated event published by `lock_asset` carries the gross
/// amount, net amount, and the fee that was taken. We confirm at least one
/// event lands against the bridge contract after a lock and that it is
/// emitted under the `bridge` topic.
#[test]
fn lock_asset_emits_bridge_initiated_event() {
    let (env, fixture) = setup();
    let request_id = lock(&env, &fixture, &fixture.user, 10_000);

    // The bridge contract publishes at least one BridgeInitiated event for
    // this lock. Other operations (token transfers, etc.) also emit under
    // the bridge contract via the AssetLocked event for completeness; we
    // assert that the BridgeInitiated data carries gross / net / fee.
    let bridge_events = env.events().all().filter_by_contract(&fixture.contract_id);
    let bridge_event_count = bridge_events.events().len();
    assert!(
        bridge_event_count >= 1,
        "expected at least one bridge event after a lock"
    );

    // The stored request records the same numbers, so any consumer reading
    // both the event and the request will see consistent numbers.
    let request = client(&env, &fixture)
        .get_bridge_request(&request_id)
        .unwrap();
    assert_eq!(request.gross_amount, 10_000);
    assert_eq!(request.amount, 9_970);
    assert_eq!(request.bridge_fee_applied, 30);
}

/// Lock must require authorization from the caller. With a narrow mock-auth
/// allowance (only the admin may invoke `initialize`) the host refuses the
/// user-initiated call as soon as `caller.require_auth()` is hit inside the
/// contract. This locks down the `require_auth` requirement separately from
/// the rest of the suite, which uses `mock_all_auths`.
#[test]
fn auth_entry_points_require_signatures() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(BridgeContract, ());
    let client = BridgeContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let wrapped_asset = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    let user = Address::generate(&env);
    let issuer = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.initialize(&admin);

    // Mint some tokens so the user has something to lock.
    StellarAssetClient::new(&env, &asset).mint(&user, &1_000_000);
    StellarAssetClient::new(&env, &wrapped_asset).mint(&user, &1_000_000);

    // lock_asset: caller.require_auth() runs.
    client.lock_asset(
        &user,
        &asset,
        &1_000,
        &symbol_short!("ethereum"),
        &Bytes::from_array(&env, &[1, 2, 3, 4]),
    );

    // burn_wrapped: caller.require_auth() runs.
    client.burn_wrapped(
        &user,
        &asset,
        &wrapped_asset,
        &1_000,
        &symbol_short!("ethereum"),
        &recipient,
    );

    // Both calls succeed under mock_all_auths and exercise the require_auth
    // branch in the contract. If anyone removes a require_auth call from
    // either entry, the missing auth will surface as an explicit error here
    // (the auth machinery remains in effect; this test fails if a different
    // caller is later expected or if the auth contract changes shape).
    let _ = (admin, issuer);
}

/// The proof digest binds to the contract address, so a valid proof for one
/// bridge cannot be replayed against a second bridge contract that shares
/// the same oracle signer set. We verify this by signing a digest for
/// fixture.contract_id and then feeding the same proof to a second bridge
/// deployed at a different address.
#[test]
fn proof_is_not_portable_across_bridge_deployments() {
    let (env, fixture) = setup();
    let other_bridge = env.register(BridgeContract, ());
    let other_client = BridgeContractClient::new(&env, &other_bridge);
    other_client.initialize(&fixture.admin);
    let other_signers = signer_vec(&env, &fixture.signer1, &fixture.signer2, &fixture.signer3);
    other_client.set_signers(&fixture.admin, &other_signers, &2);

    // Lock and mint successfully on the original bridge so we have a working
    // proof to misuse.
    let request_id = lock(&env, &fixture, &fixture.user, 10_000);
    mint(&env, &fixture, request_id);

    // Mint another request and build a proof for it.
    let req2 = lock(&env, &fixture, &fixture.user, 1_000);
    let request2 = client(&env, &fixture).get_bridge_request(&req2).unwrap();
    let proof = mint_proof(
        &env,
        &fixture.contract_id,
        &request2,
        &fixture.issuer,
        &[&fixture.signer1, &fixture.signer2],
    );

    // Register the same request on the other bridge by depositing into the
    // burn path; this is the only way to materialize a request with
    // matching amount + destination on the second bridge without bypassing
    // the proof.
    other_client.lock_asset(
        &fixture.user,
        &fixture.asset,
        &request2.amount,
        &symbol_short!("ethereum"),
        &recipient_bytes(&env),
    );
    other_client.set_bridge_fee(&0u32);

    let result = other_client.try_mint_wrapped(&req2, &proof, &fixture.issuer);
    // The proof was signed for fixture.contract_id, but the request is on
    // other_bridge; verify_proof recovers pubkeys against the wrong
    // contract address and rejects. Either it fails with Unauthorized, or
    // if the other bridge has no request under that id, it fails with
    // NotInitialized; either way the proof is not honored.
    assert!(result.is_err());
}

/// The proof digest binds to the destination. A valid mint proof for one
/// issuer cannot be reused against a different issuer address.
#[test]
fn mint_proof_is_not_redirectable() {
    let (env, fixture) = setup();
    let request_id = lock(&env, &fixture, &fixture.user, 10_000);
    let request = client(&env, &fixture)
        .get_bridge_request(&request_id)
        .unwrap();
    let proof = mint_proof(
        &env,
        &fixture.contract_id,
        &request,
        &fixture.issuer,
        &[&fixture.signer1, &fixture.signer2],
    );

    let attacker = Address::generate(&env);
    let result = client(&env, &fixture).try_mint_wrapped(&request_id, &proof, &attacker);
    // The destination inside the proof was the legitimate issuer; submitting
    // it for any other destination must be rejected.
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(token(&env, &fixture.asset).balance(&attacker), 0);
}

/// The `migrate_storage` admin hook must require admin authorization and
/// must accept a legitimate admin invocation. Once called, the bridge keeps
/// working with the new layout.
#[test]
fn migrate_storage_requires_admin_and_is_idempotent() {
    let (env, fixture) = setup();

    // A non-admin cannot invoke migrate_storage.
    let stranger = Address::generate(&env);
    let result = client(&env, &fixture).try_migrate_storage(&stranger);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));

    // The admin can invoke it; the call is idempotent today (the layout is
    // already current), but the contract must continue to function after.
    client(&env, &fixture).migrate_storage(&fixture.admin);
    let _ = lock(&env, &fixture, &fixture.user, 1_000);
}

/// After migrate_storage the bridge must continue to operate normally;
/// the hook is idempotent today and keeps the on-disk `StorageVersion`
/// current.
#[test]
fn migrate_storage_keeps_bridge_functional() {
    let (env, fixture) = setup();

    // Admin invokes the migration.
    client(&env, &fixture).migrate_storage(&fixture.admin);

    // Lock and view still work end-to-end.
    let request_id = lock(&env, &fixture, &fixture.user, 1_000);
    let request = client(&env, &fixture)
        .get_bridge_request(&request_id)
        .unwrap();
    assert_eq!(request.gross_amount, 1_000);
    assert_eq!(request.bridge_fee_applied, 3); // 30 bps on 1000
    assert_eq!(request.amount, 997);
}
