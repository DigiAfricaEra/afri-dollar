use crate::{TreasuryContract, TreasuryContractClient, TreasuryError};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    vec, Address, Env,
};

fn setup() -> (
    Env,
    Address,
    TreasuryContractClient<'static>,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    let contract_id = env.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let requester = Address::generate(&env);
    let approver = Address::generate(&env);
    (env, contract_id, client, admin, requester, approver)
}

fn setup_initialized() -> (
    Env,
    Address,
    TreasuryContractClient<'static>,
    Address,
    Address,
    Address,
) {
    let (env, contract_id, client, admin, requester, approver) = setup();
    env.mock_all_auths();
    client.initialize(&admin);
    (env, contract_id, client, admin, requester, approver)
}

fn setup_with_timelock() -> (
    Env,
    Address,
    TreasuryContractClient<'static>,
    Address,
    Address,
    Address,
    Address,
) {
    let (env, contract_id, client, admin, requester, approver) = setup_initialized();
    let asset = Address::generate(&env);
    client.set_timelock(&asset, &3600);
    (env, contract_id, client, admin, requester, approver, asset)
}

fn setup_emergency(
    env: &Env,
    client: &TreasuryContractClient<'static>,
) -> (Address, Address, soroban_sdk::Vec<Address>) {
    let approver1 = Address::generate(env);
    let approver2 = Address::generate(env);
    let approvers = vec![env, approver1.clone(), approver2.clone()];
    client.set_emergency_approvers(&approvers, &2);
    (approver1, approver2, approvers)
}

fn setup_emergency_single(env: &Env, client: &TreasuryContractClient<'static>) -> Address {
    let approver1 = Address::generate(env);
    let approvers = vec![env, approver1.clone()];
    client.set_emergency_approvers(&approvers, &1);
    approver1
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

#[test]
fn initialize_succeeds() {
    let (env, _contract_id, client, admin, _requester, _approver) = setup();
    env.mock_all_auths();
    client.initialize(&admin);
    // No panic = success
}

#[test]
fn initialize_is_one_time_only() {
    let (env, _contract_id, client, admin, _requester, _approver) = setup();
    env.mock_all_auths();
    client.initialize(&admin);
    let result = client.try_initialize(&admin);
    assert_eq!(result, Err(Ok(TreasuryError::AlreadyInitialized)));
}

#[test]
fn uninitialized_contract_returns_not_initialized() {
    let (env, _contract_id, client, _admin, _requester, _approver) = setup();
    env.mock_all_auths();
    let asset = Address::generate(&env);
    let result = client.try_set_timelock(&asset, &100);
    assert_eq!(result, Err(Ok(TreasuryError::NotInitialized)));
}

// ---------------------------------------------------------------------------
// Time-lock config
// ---------------------------------------------------------------------------

#[test]
fn set_timelock_stores_config() {
    let (env, _contract_id, client, _admin, _requester, _approver) = setup_initialized();
    let asset = Address::generate(&env);
    env.mock_all_auths();
    client.set_timelock(&asset, &3600);

    let config = client.get_timelock(&asset);
    assert_eq!(config.asset, asset);
    assert_eq!(config.lock_period_seconds, 3600);
    assert!(config.enabled);
}

#[test]
fn set_timelock_succeeds_with_admin_auth() {
    let (env, _contract_id, client, _admin, _requester, _approver) = setup_initialized();
    let asset = Address::generate(&env);
    env.mock_all_auths();
    client.set_timelock(&asset, &3600);
    // No panic = admin auth succeeded
}

#[test]
fn set_timelock_updates_existing_config() {
    let (env, _contract_id, client, _admin, _requester, _approver) = setup_initialized();
    let asset = Address::generate(&env);
    env.mock_all_auths();
    client.set_timelock(&asset, &3600);
    client.set_timelock(&asset, &7200);

    let config = client.get_timelock(&asset);
    assert_eq!(config.lock_period_seconds, 7200);
}

#[test]
fn get_timelock_returns_default_when_not_configured() {
    let (env, _contract_id, client, _admin, _requester, _approver) = setup_initialized();
    let asset = Address::generate(&env);
    let config = client.get_timelock(&asset);
    assert!(!config.enabled);
    assert_eq!(config.lock_period_seconds, 0);
}

#[test]
fn disable_timelock_disables_config() {
    let (env, _contract_id, client, _admin, _requester, _approver) = setup_initialized();
    let asset = Address::generate(&env);
    env.mock_all_auths();
    client.set_timelock(&asset, &3600);
    client.disable_timelock(&asset);

    let config = client.get_timelock(&asset);
    assert!(!config.enabled);
}

#[test]
fn disable_unconfigured_timelock_fails() {
    let (env, _contract_id, client, _admin, _requester, _approver) = setup_initialized();
    let asset = Address::generate(&env);
    env.mock_all_auths();
    let result = client.try_disable_timelock(&asset);
    assert_eq!(result, Err(Ok(TreasuryError::AssetNotConfigured)));
}

// ---------------------------------------------------------------------------
// Request withdrawal
// ---------------------------------------------------------------------------

#[test]
fn request_withdrawal_creates_request() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    env.mock_all_auths();

    let to = Address::generate(&env);
    let request_id = client.request_withdrawal(&requester, &to, &asset, &1000);
    assert_eq!(request_id, 1);

    let stored = client.get_withdrawal_request(&request_id);
    assert_eq!(stored.id, 1);
    assert_eq!(stored.requester, requester);
    assert_eq!(stored.to, to);
    assert_eq!(stored.asset, asset);
    assert_eq!(stored.amount, 1000);
    assert!(!stored.executed);
    assert!(!stored.cancelled);
    assert_eq!(stored.unlock_at, stored.created_at + 3600);
}

#[test]
fn request_withdrawal_succeeds_with_auth() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();
    let id = client.request_withdrawal(&requester, &to, &asset, &1000);
    assert_eq!(id, 1);
}

#[test]
fn request_withdrawal_rejects_zero_amount() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();
    let result = client.try_request_withdrawal(&requester, &to, &asset, &0);
    assert_eq!(result, Err(Ok(TreasuryError::AmountZero)));
}

#[test]
fn request_withdrawal_rejects_negative_amount() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();
    let result = client.try_request_withdrawal(&requester, &to, &asset, &(-100));
    assert_eq!(result, Err(Ok(TreasuryError::AmountZero)));
}

#[test]
fn request_withdrawal_requires_configured_asset() {
    let (env, _contract_id, client, _admin, requester, _approver, _asset) = setup_with_timelock();
    let to = Address::generate(&env);
    let unknown = Address::generate(&env);
    env.mock_all_auths();
    let result = client.try_request_withdrawal(&requester, &to, &unknown, &1000);
    assert_eq!(result, Err(Ok(TreasuryError::AssetNotConfigured)));
}

#[test]
fn request_withdrawal_returns_incremented_ids() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();

    let id1 = client.request_withdrawal(&requester, &to, &asset, &100);
    let id2 = client.request_withdrawal(&requester, &to, &asset, &200);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}

#[test]
fn request_withdrawal_fails_when_disabled() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();
    client.disable_timelock(&asset);

    let result = client.try_request_withdrawal(&requester, &to, &asset, &1000);
    assert_eq!(result, Err(Ok(TreasuryError::AssetNotConfigured)));
}

// ---------------------------------------------------------------------------
// Execute withdrawal
// ---------------------------------------------------------------------------

#[test]
fn execute_withdrawal_after_unlock() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();

    let id = client.request_withdrawal(&requester, &to, &asset, &1000);

    // Advance ledger time past the lock period
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    env.mock_all_auths();
    client.execute_withdrawal(&id);

    let stored = client.get_withdrawal_request(&id);
    assert!(stored.executed);
    assert!(!stored.cancelled);
}

#[test]
fn execute_withdrawal_before_unlock_fails() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();

    let id = client.request_withdrawal(&requester, &to, &asset, &1000);

    // No time advance — still within lock period
    let result = client.try_execute_withdrawal(&id);
    assert_eq!(result, Err(Ok(TreasuryError::TimeLockNotElapsed)));
}

#[test]
fn execute_withdrawal_not_found() {
    let (env, _contract_id, client, _admin, _requester, _approver, _asset) = setup_with_timelock();
    env.mock_all_auths();

    let result = client.try_execute_withdrawal(&999);
    assert_eq!(result, Err(Ok(TreasuryError::RequestNotFound)));
}

#[test]
fn execute_withdrawal_already_executed_fails() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();

    let id = client.request_withdrawal(&requester, &to, &asset, &1000);
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    client.execute_withdrawal(&id);

    let result = client.try_execute_withdrawal(&id);
    assert_eq!(result, Err(Ok(TreasuryError::RequestAlreadyExecuted)));
}

#[test]
fn execute_withdrawal_cancelled_fails() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();

    let id = client.request_withdrawal(&requester, &to, &asset, &1000);

    // Cancel the request first (requester.require_auth passes with mock_all_auths)
    client.cancel_withdrawal(&id);

    // Now try to execute
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    let result = client.try_execute_withdrawal(&id);
    assert_eq!(result, Err(Ok(TreasuryError::RequestAlreadyCancelled)));
}

// ---------------------------------------------------------------------------
// Cancel withdrawal
// ---------------------------------------------------------------------------

#[test]
fn cancel_withdrawal_by_requester() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();

    let id = client.request_withdrawal(&requester, &to, &asset, &500);
    client.cancel_withdrawal(&id);

    let stored = client.get_withdrawal_request(&id);
    assert!(stored.cancelled);
    assert!(!stored.executed);
}

#[test]
fn cancel_withdrawal_succeeds_with_auth() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();

    let id = client.request_withdrawal(&requester, &to, &asset, &500);
    client.cancel_withdrawal(&id);

    let stored = client.get_withdrawal_request(&id);
    assert!(stored.cancelled);
}

#[test]
fn cancel_withdrawal_not_found() {
    let (env, _contract_id, client, _admin, _requester, _approver, _asset) = setup_with_timelock();
    env.mock_all_auths();
    let result = client.try_cancel_withdrawal(&999);
    assert_eq!(result, Err(Ok(TreasuryError::RequestNotFound)));
}

#[test]
fn cancel_withdrawal_already_executed_fails() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();

    let id = client.request_withdrawal(&requester, &to, &asset, &500);
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    client.execute_withdrawal(&id);

    let result = client.try_cancel_withdrawal(&id);
    assert_eq!(result, Err(Ok(TreasuryError::RequestAlreadyExecuted)));
}

#[test]
fn cancel_withdrawal_already_cancelled_fails() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();

    let id = client.request_withdrawal(&requester, &to, &asset, &500);
    client.cancel_withdrawal(&id);

    let result = client.try_cancel_withdrawal(&id);
    assert_eq!(result, Err(Ok(TreasuryError::RequestAlreadyCancelled)));
}

// ---------------------------------------------------------------------------
// Emergency override
// ---------------------------------------------------------------------------

#[test]
fn emergency_override_executes_before_unlock() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();
    let (approver1, approver2, _) = setup_emergency(&env, &client);

    let id = client.request_withdrawal(&requester, &to, &asset, &1000);

    // Execute emergency override BEFORE unlock time
    let override_approvers = vec![&env, approver1, approver2];
    client.emergency_override(&id, &override_approvers);

    let stored = client.get_withdrawal_request(&id);
    assert!(stored.executed);
}

#[test]
fn emergency_override_insufficient_approvals_fails() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();
    let (approver1, _, _) = setup_emergency(&env, &client);

    let id = client.request_withdrawal(&requester, &to, &asset, &1000);

    // Only 1 approver, threshold is 2
    let single_approver = vec![&env, approver1];
    let result = client.try_emergency_override(&id, &single_approver);
    assert_eq!(result, Err(Ok(TreasuryError::InsufficientApprovals)));
}

#[test]
fn emergency_override_invalid_approver_fails() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();
    let stranger = Address::generate(&env);

    let _approver1 = setup_emergency_single(&env, &client);
    let id = client.request_withdrawal(&requester, &to, &asset, &1000);

    // Use an address NOT in the approver list
    let invalid_approvers = vec![&env, stranger];
    let result = client.try_emergency_override(&id, &invalid_approvers);
    assert_eq!(result, Err(Ok(TreasuryError::InvalidApprover)));
}

#[test]
fn emergency_override_no_approvers_set_up_fails() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();

    let id = client.request_withdrawal(&requester, &to, &asset, &1000);

    let some_approvers = vec![&env, Address::generate(&env)];
    let result = client.try_emergency_override(&id, &some_approvers);
    assert_eq!(result, Err(Ok(TreasuryError::NoEmergencyApprovers)));
}

// ---------------------------------------------------------------------------
// Emergency approver management
// ---------------------------------------------------------------------------

#[test]
fn set_emergency_approvers_stores_values() {
    let (env, _contract_id, client, _admin, _requester, _approver) = setup_initialized();
    let approver1 = Address::generate(&env);
    let approver2 = Address::generate(&env);
    let approvers = vec![&env, approver1, approver2];

    env.mock_all_auths();
    client.set_emergency_approvers(&approvers, &2);

    let stored = client.get_emergency_approvers();
    assert_eq!(stored.len(), 2);
    assert_eq!(client.get_emergency_threshold(), 2);
}

#[test]
fn get_emergency_approvers_defaults_empty() {
    let (_env, _contract_id, client, _admin, _requester, _approver) = setup_initialized();
    let stored = client.get_emergency_approvers();
    assert_eq!(stored.len(), 0);
    assert_eq!(client.get_emergency_threshold(), 0);
}

#[test]
fn set_emergency_approvers_succeeds_with_admin_auth() {
    let (env, _contract_id, client, _admin, _requester, _approver) = setup_initialized();
    let approvers = vec![&env, Address::generate(&env)];
    env.mock_all_auths();
    client.set_emergency_approvers(&approvers, &1);
    // No panic = admin auth succeeded
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[test]
fn request_withdrawal_emits_event() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();

    client.request_withdrawal(&requester, &to, &asset, &1000);

    let events = env.events().all();
    let empty: soroban_sdk::Vec<(
        Address,
        soroban_sdk::Vec<soroban_sdk::Val>,
        soroban_sdk::Val,
    )> = vec![&env];
    assert_ne!(events, empty, "expected at least one event to be emitted");
}

// ---------------------------------------------------------------------------
// Get withdrawal request
// ---------------------------------------------------------------------------

#[test]
fn get_withdrawal_request_not_found() {
    let (_env, _contract_id, client, _admin, _requester, _approver, _asset) = setup_with_timelock();
    let result = client.try_get_withdrawal_request(&999);
    assert_eq!(result, Err(Ok(TreasuryError::RequestNotFound)));
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

#[test]
fn multiple_withdrawals_tracked_independently() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();

    let id1 = client.request_withdrawal(&requester, &to, &asset, &100);
    let id2 = client.request_withdrawal(&requester, &to, &asset, &200);

    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    client.execute_withdrawal(&id1);

    let r1 = client.get_withdrawal_request(&id1);
    let r2 = client.get_withdrawal_request(&id2);

    assert!(r1.executed);
    assert!(!r2.executed);
}

#[test]
fn emergency_override_already_executed_fails() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();
    let approver1 = setup_emergency_single(&env, &client);

    let id = client.request_withdrawal(&requester, &to, &asset, &1000);

    // First, execute normally after timelock expires
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    client.execute_withdrawal(&id);

    // Now try to execute emergency override
    let override_approvers = vec![&env, approver1];
    let result = client.try_emergency_override(&id, &override_approvers);
    assert_eq!(result, Err(Ok(TreasuryError::RequestAlreadyExecuted)));
}

#[test]
fn emergency_override_already_cancelled_fails() {
    let (env, _contract_id, client, _admin, requester, _approver, asset) = setup_with_timelock();
    let to = Address::generate(&env);
    env.mock_all_auths();
    let approver1 = setup_emergency_single(&env, &client);

    let id = client.request_withdrawal(&requester, &to, &asset, &1000);

    // First, cancel the request
    client.cancel_withdrawal(&id);

    // Now try to execute emergency override
    let override_approvers = vec![&env, approver1];
    let result = client.try_emergency_override(&id, &override_approvers);
    assert_eq!(result, Err(Ok(TreasuryError::RequestAlreadyCancelled)));
}
