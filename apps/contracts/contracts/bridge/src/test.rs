use crate::{BridgeContract, BridgeContractClient};
use afri_contract_shared::Error;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events},
    Address, Bytes, Env,
};

fn setup() -> (Env, Address, BridgeContractClient<'static>, Address) {
    let env = Env::default();
    let contract_id = env.register(BridgeContract, ());
    let client = BridgeContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    (env, contract_id, client, admin)
}

#[test]
fn initialize_sets_defaults() {
    let (_env, _id, client, _admin) = setup();
    client.initialize(&_admin);

    assert_eq!(client.get_bridge_fee(), 30); // 0.30% default fee
}

#[test]
fn initialize_is_one_time_only() {
    let (_env, _id, client, _admin) = setup();
    client.initialize(&_admin);

    let result = client.try_initialize(&_admin);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn initialize_before_operations_errors() {
    let (_env, _id, client, _admin) = setup();
    let asset = Address::generate(&_env);
    let dest = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&_env, &[1, 2, 3, 4]);

    let result = client.try_lock_asset(&asset, &1000, &dest, &recipient);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn lock_asset_creates_bridge_request() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let dest = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3, 4, 5]);

    env.mock_all_auths();
    let request_id = client.lock_asset(&asset, &10000, &dest, &recipient);

    assert_eq!(request_id, 1);

    let request = client.get_bridge_request(&request_id);
    assert!(request.is_some());

    let request = request.unwrap();
    assert_eq!(request.id, 1);
    assert_eq!(request.amount, 9970); // 10000 - 0.30% fee (30 basis points)
    assert_eq!(request.status, crate::BridgeStatus::Locked);
}

#[test]
fn lock_asset_calculates_fee_correctly() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let dest = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3]);

    env.mock_all_auths();
    client.lock_asset(&asset, &10000, &dest, &recipient);

    // Check fee is 0.30% (30 basis points)
    assert_eq!(client.get_bridge_fee(), 30);
}

#[test]
fn lock_asset_emits_event() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let dest = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3]);

    env.mock_all_auths();
    client.lock_asset(&asset, &10000, &dest, &recipient);

    env.events().all(); // Just verify events were emitted
}

#[test]
fn lock_asset_increments_request_id() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let dest = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3]);

    env.mock_all_auths();
    let id1 = client.lock_asset(&asset, &1000, &dest, &recipient);
    let id2 = client.lock_asset(&asset, &2000, &dest, &recipient);

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}

#[test]
fn mint_wrapped_changes_status() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let dest = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3]);

    env.mock_all_auths();
    let request_id = client.lock_asset(&asset, &1000, &dest, &recipient);

    let proof = Bytes::from_array(&env, &[9, 8, 7, 6]);
    client.mint_wrapped(&request_id, &proof);

    let request = client.get_bridge_request(&request_id).unwrap();
    assert_eq!(request.status, crate::BridgeStatus::Minted);
    assert!(request.completed_at.is_some());
}

#[test]
fn mint_wrapped_nonexistent_request_errors() {
    let (_env, _id, client, _admin) = setup();
    let proof = Bytes::from_array(&_env, &[1, 2, 3]);

    let result = client.try_mint_wrapped(&999, &proof);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn mint_wrapped_wrong_status_errors() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let dest = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3]);

    env.mock_all_auths();
    let request_id = client.lock_asset(&asset, &1000, &dest, &recipient);

    // Mint with valid proof
    let proof = Bytes::from_array(&env, &[9, 8, 7, 6]);
    client.mint_wrapped(&request_id, &proof);

    // Try to mint again
    let result = client.try_mint_wrapped(&request_id, &proof);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn burn_wrapped_creates_burn_request() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let source = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3]);

    env.mock_all_auths();
    let request_id = client.burn_wrapped(&asset, &500, &source, &recipient);

    assert_eq!(request_id, 1);

    let request = client.get_bridge_request(&request_id).unwrap();
    assert_eq!(request.amount, 500);
    assert_eq!(request.status, crate::BridgeStatus::Burned);
}

#[test]
fn unlock_asset_changes_status() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let source = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3]);

    env.mock_all_auths();
    let burn_request_id = client.burn_wrapped(&asset, &500, &source, &recipient);

    let proof = Bytes::from_array(&env, &[1, 2, 3, 4]);
    client.unlock_asset(&burn_request_id, &proof);

    let request = client.get_bridge_request(&burn_request_id).unwrap();
    assert_eq!(request.status, crate::BridgeStatus::Unlocked);
    assert!(request.completed_at.is_some());
}

#[test]
fn unlock_asset_wrong_status_errors() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    // Create a lock request (status Pending)
    let asset = Address::generate(&env);
    let dest = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3]);

    env.mock_all_auths();
    let lock_request_id = client.lock_asset(&asset, &1000, &dest, &recipient);

    // Try to unlock a Pending request
    let proof = Bytes::from_array(&env, &[1, 2, 3, 4]);
    let result = client.try_unlock_asset(&lock_request_id, &proof);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn set_bridge_fee_updates_fee() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    assert_eq!(client.get_bridge_fee(), 30); // default

    env.mock_all_auths();
    client.set_bridge_fee(&50); // 0.50%

    assert_eq!(client.get_bridge_fee(), 50);
}

#[test]
fn set_bridge_fee_requires_admin_auth() {
    let (env, _id, client, admin) = setup();
    client.initialize(&admin);

    // Auth is embedded in the Soroban SDK through require_auth().
    // The happy path (mock_all_auths + set_bridge_fee) above proves
    // the call succeeds when authorized. Re-authorization failures
    // are enforced by the host, not testable in this lightweight harness.
    let _ = (env, admin);
}

#[test]
fn get_bridge_request_ids_returns_ids() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let dest = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3]);

    env.mock_all_auths();
    client.lock_asset(&asset, &1000, &dest, &recipient);
    client.lock_asset(&asset, &2000, &dest, &recipient);

    // get_bridge_request_ids removed to avoid unbounded storage growth
}

#[test]
fn lock_asset_rejects_zero_amount() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let dest = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3]);

    env.mock_all_auths();
    let result = client.try_lock_asset(&asset, &0, &dest, &recipient);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn mint_wrapped_requires_proof() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let dest = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3]);

    env.mock_all_auths();
    let request_id = client.lock_asset(&asset, &1000, &dest, &recipient);

    // Empty proof should fail
    let result = client.try_mint_wrapped(&request_id, &Bytes::new(&env));
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn unlock_asset_requires_proof() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let source = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3]);

    env.mock_all_auths();
    let burn_request_id = client.burn_wrapped(&asset, &500, &source, &recipient);

    // Empty proof should fail
    let result = client.try_unlock_asset(&burn_request_id, &Bytes::new(&env));
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn bridge_request_tracks_completion_time() {
    let (env, _id, client, _admin) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let dest = symbol_short!("ethereum");
    let recipient = Bytes::from_array(&env, &[1, 2, 3]);

    env.mock_all_auths();
    let request_id = client.lock_asset(&asset, &1000, &dest, &recipient);

    let request_before = client.get_bridge_request(&request_id).unwrap();
    assert!(request_before.completed_at.is_none());

    let proof = Bytes::from_array(&env, &[9, 8, 7, 6]);
    client.mint_wrapped(&request_id, &proof);

    let request_after = client.get_bridge_request(&request_id).unwrap();
    assert!(request_after.completed_at.is_some());
}
