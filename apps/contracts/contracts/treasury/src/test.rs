use crate::{ClawbackConfig, Error, TreasuryContract, TreasuryContractClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, IssuerFlags},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, String,
};

/// Deploy a Stellar Asset Contract token whose admin is `sac_admin`
/// (must be the treasury contract address in production). Returns the
/// token's address plus ready-made clients for transfers/balances and
/// minting.
///
/// The SAC issuer account is created with `AUTH_REVOCABLE_FLAG` (0x2) so
/// that `set_authorized` and `clawback` work correctly in tests.
fn create_token<'a>(
    env: &Env,
    sac_admin: &Address,
) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let sac = env.register_stellar_asset_contract_v2(sac_admin.clone());
    let address = sac.address();

    // `register_stellar_asset_contract_v2` creates the issuer with `flags: 0`.
    // For clawback to work we need the issuer to have AUTH_REVOCABLE and
    // AUTH_CLAWBACK_ENABLED flags set.
    sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    sac.issuer().set_flag(IssuerFlags::ClawbackEnabledFlag);

    (
        address.clone(),
        TokenClient::new(env, &address),
        StellarAssetClient::new(env, &address),
    )
}

fn setup() -> (Env, TreasuryContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let contract_id = env.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

/// Assert that `env.events().all()` (which only surfaces events from the
/// most recently completed contract invocation) is exactly one event,
/// published by the treasury contract, with the given topics and data.
fn assert_last_event<T, D>(env: &Env, contract_id: &Address, topics: T, data: D)
where
    T: IntoVal<Env, soroban_sdk::Vec<soroban_sdk::Val>>,
    D: IntoVal<Env, soroban_sdk::Val>,
{
    let expected: soroban_sdk::Vec<(
        Address,
        soroban_sdk::Vec<soroban_sdk::Val>,
        soroban_sdk::Val,
    )> = soroban_sdk::vec![
        env,
        (
            contract_id.clone(),
            topics.into_val(env),
            data.into_val(env),
        ),
    ];
    let ours = env.events().all().filter_by_contract(contract_id);
    assert_eq!(ours, expected);
}

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

#[test]
fn initialize_is_one_time_only() {
    let (_env, client, admin) = setup();
    let result = client.try_initialize(&admin);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn initialize_requires_admin_auth() {
    let env = Env::default();
    let contract_id = env.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);
    // Clear auths — admin-gated operations still require the stored admin's auth.
    env.set_auths(&[]);
    let asset = Address::generate(&env);
    let authority = Address::generate(&env);
    let result = client.try_enable_clawback(&asset, &authority, &true);
    assert!(result.is_err());
}

#[test]
fn initialize_fails_without_admin_auth() {
    let env = Env::default();
    let contract_id = env.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    // No auth set — initialize requires the admin to sign.
    let result = client.try_initialize(&admin);
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// Enable clawback
// ---------------------------------------------------------------------------

#[test]
fn enable_clawback_sets_config() {
    let (env, client, _admin) = setup();
    let asset = Address::generate(&env);
    let authority = Address::generate(&env);

    client.enable_clawback(&asset, &authority, &true);

    let config = client.get_clawback_config(&asset).unwrap();
    assert_eq!(
        config,
        ClawbackConfig {
            asset: asset.clone(),
            enabled: true,
            authority: authority.clone(),
            reason_required: true,
        }
    );
}

#[test]
fn enable_clawback_requires_admin_auth() {
    let env = Env::default();
    let contract_id = env.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let authority = Address::generate(&env);
    // Clear auths — the stored admin's `require_auth()` fails.
    env.set_auths(&[]);
    let result = client.try_enable_clawback(&asset, &authority, &true);
    assert!(result.is_err());
}

#[test]
fn enable_clawback_requires_admin_auth_even_for_real_admin() {
    let env = Env::default();
    let contract_id = env.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let authority = Address::generate(&env);
    env.set_auths(&[]);
    let result = client.try_enable_clawback(&asset, &authority, &true);
    assert!(result.is_err());
}

#[test]
fn enable_clawback_emits_full_event_payload() {
    let (env, client, _admin) = setup();
    let asset = Address::generate(&env);
    let authority = Address::generate(&env);

    client.enable_clawback(&asset, &authority, &true);

    assert_last_event(
        &env,
        &client.address,
        (
            symbol_short!("treasury"),
            symbol_short!("enable"),
            asset.clone(),
        ),
        (authority, true),
    );
}

#[test]
fn enable_clawback_overwrites_existing_config() {
    let (env, client, _admin) = setup();
    let asset = Address::generate(&env);
    let authority_a = Address::generate(&env);
    let authority_b = Address::generate(&env);

    client.enable_clawback(&asset, &authority_a, &true);
    client.enable_clawback(&asset, &authority_b, &false);

    let config = client.get_clawback_config(&asset).unwrap();
    assert_eq!(config.authority, authority_b);
    assert!(!config.reason_required);
    assert!(config.enabled);
}

// ---------------------------------------------------------------------------
// Disable clawback
// ---------------------------------------------------------------------------

#[test]
fn disable_clawback_sets_enabled_false() {
    let (env, client, _admin) = setup();
    let asset = Address::generate(&env);
    let authority = Address::generate(&env);

    client.enable_clawback(&asset, &authority, &true);
    client.disable_clawback(&asset);

    let config = client.get_clawback_config(&asset).unwrap();
    assert!(!config.enabled);
    assert_eq!(config.authority, authority);
}

#[test]
fn disable_clawback_fails_without_config() {
    let (env, client, _admin) = setup();
    let asset = Address::generate(&env);
    let result = client.try_disable_clawback(&asset);
    assert_eq!(result, Err(Ok(Error::ConfigNotFound)));
}

#[test]
fn disable_clawback_requires_admin_auth() {
    let env = Env::default();
    let contract_id = env.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let authority = Address::generate(&env);
    // Enable first so the config exists.
    client.enable_clawback(&asset, &authority, &true);

    // Now clear auths — the stored admin's `require_auth()` fails.
    env.set_auths(&[]);
    let result = client.try_disable_clawback(&asset);
    assert!(result.is_err());
}

#[test]
fn disable_clawback_emits_event() {
    let (env, client, _admin) = setup();
    let asset = Address::generate(&env);
    let authority = Address::generate(&env);
    client.enable_clawback(&asset, &authority, &true);

    client.disable_clawback(&asset);

    assert_last_event(
        &env,
        &client.address,
        (
            symbol_short!("treasury"),
            symbol_short!("disable"),
            asset.clone(),
        ),
        env.ledger().timestamp(),
    );
}

// ---------------------------------------------------------------------------
// Execute clawback — authorization and validation
// ---------------------------------------------------------------------------

#[test]
fn execute_clawback_fails_without_config() {
    let (env, client, _admin) = setup();
    let authority = Address::generate(&env);
    let from = Address::generate(&env);
    let asset = Address::generate(&env);
    let reason = String::from_str(&env, "sanctions match");

    let result = client.try_execute_clawback(&authority, &from, &asset, &100i128, &reason);
    assert_eq!(result, Err(Ok(Error::ConfigNotFound)));
}

#[test]
fn execute_clawback_fails_when_disabled() {
    let (env, client, _admin) = setup();
    let asset = Address::generate(&env);
    let authority = Address::generate(&env);
    let from = Address::generate(&env);
    let reason = String::from_str(&env, "regulatory action");

    client.enable_clawback(&asset, &authority, &true);
    client.disable_clawback(&asset);

    let result = client.try_execute_clawback(&authority, &from, &asset, &100i128, &reason);
    assert_eq!(result, Err(Ok(Error::ClawbackDisabled)));
}

#[test]
fn execute_clawback_fails_with_wrong_authority() {
    let (env, client, _admin) = setup();
    let asset = Address::generate(&env);
    let authority = Address::generate(&env);
    let wrong_authority = Address::generate(&env);
    let from = Address::generate(&env);
    let reason = String::from_str(&env, "compliance");

    client.enable_clawback(&asset, &authority, &true);

    let result = client.try_execute_clawback(&wrong_authority, &from, &asset, &100i128, &reason);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn execute_clawback_requires_authority_auth() {
    let env = Env::default();
    let contract_id = env.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);
    let asset = Address::generate(&env);
    let authority = Address::generate(&env);
    let from = Address::generate(&env);
    client.enable_clawback(&asset, &authority, &true);

    env.set_auths(&[]);
    let reason = String::from_str(&env, "freeze");
    let result = client.try_execute_clawback(&authority, &from, &asset, &100i128, &reason);
    assert!(result.is_err());
}

#[test]
fn execute_clawback_rejects_zero_amount() {
    let (env, client, _admin) = setup();
    let asset = Address::generate(&env);
    let authority = Address::generate(&env);
    let from = Address::generate(&env);
    let reason = String::from_str(&env, "invalid");
    client.enable_clawback(&asset, &authority, &false);

    let result = client.try_execute_clawback(&authority, &from, &asset, &0i128, &reason);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn execute_clawback_rejects_negative_amount() {
    let (env, client, _admin) = setup();
    let asset = Address::generate(&env);
    let authority = Address::generate(&env);
    let from = Address::generate(&env);
    let reason = String::from_str(&env, "negative");
    client.enable_clawback(&asset, &authority, &false);

    let result = client.try_execute_clawback(&authority, &from, &asset, &-50i128, &reason);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn execute_clawback_rejects_empty_reason_when_required() {
    let (env, client, _admin) = setup();
    let asset = Address::generate(&env);
    let authority = Address::generate(&env);
    let from = Address::generate(&env);
    let reason = String::from_str(&env, "");
    client.enable_clawback(&asset, &authority, &true);

    let result = client.try_execute_clawback(&authority, &from, &asset, &100i128, &reason);
    assert_eq!(result, Err(Ok(Error::InvalidReason)));
}

// ---------------------------------------------------------------------------
// Execute clawback — success path
// ---------------------------------------------------------------------------

#[test]
fn execute_clawback_transfers_tokens_and_creates_record() {
    let (env, client, _admin) = setup();
    let authority = Address::generate(&env);
    let from = Address::generate(&env);
    let (asset, asset_token, asset_mint) = create_token(&env, &client.address);

    // Set up clawback config with no reason requirement.
    client.enable_clawback(&asset, &authority, &false);

    // Mint tokens to `from` and verify initial balance.
    asset_mint.mint(&from, &1_000i128);
    assert_eq!(asset_token.balance(&from), 1_000);

    // Mark the address as unauthorized so the balance becomes clawbackable.
    asset_mint.set_authorized(&from, &false);

    let reason = String::from_str(&env, "compliance clawback");
    let record = client.execute_clawback(&authority, &from, &asset, &300i128, &reason);

    assert_eq!(record.from_address, from);
    assert_eq!(record.asset, asset);
    assert_eq!(record.amount, 300);
    assert_eq!(record.authority, authority);
    assert_eq!(record.reason, reason);
    assert_eq!(record.timestamp, env.ledger().timestamp());

    // `from` lost 300 tokens.
    assert_eq!(asset_token.balance(&from), 700);

    // The record ID is stored and increments.
    let history = client.get_clawback_history(&Some(asset.clone()), &10u32);
    assert_eq!(history.len(), 1);
    assert_eq!(history.get(0).unwrap().id, 1);
}

#[test]
fn execute_clawback_emits_event() {
    let (env, client, _admin) = setup();
    let authority = Address::generate(&env);
    let from = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &client.address);
    client.enable_clawback(&asset, &authority, &false);
    asset_mint.mint(&from, &1_000i128);
    asset_mint.set_authorized(&from, &false);

    let reason = String::from_str(&env, "sanctions");
    let _record = client.execute_clawback(&authority, &from, &asset, &200i128, &reason);

    // The clawback event is published alongside the token's own transfer
    // event, so we filter by contract to get only our event.
    assert_last_event(
        &env,
        &client.address,
        (
            symbol_short!("treasury"),
            symbol_short!("clawback"),
            from.clone(),
            asset.clone(),
        ),
        (200i128, authority, reason, 1u64),
    );
}

#[test]
fn execute_clawback_increments_record_id() {
    let (env, client, _admin) = setup();
    let authority = Address::generate(&env);
    let from = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &client.address);
    client.enable_clawback(&asset, &authority, &false);
    asset_mint.mint(&from, &10_000i128);
    asset_mint.set_authorized(&from, &false);

    let reason = String::from_str(&env, "audit");
    let r1 = client.execute_clawback(&authority, &from, &asset, &100i128, &reason);
    let r2 = client.execute_clawback(&authority, &from, &asset, &200i128, &reason);
    let r3 = client.execute_clawback(&authority, &from, &asset, &300i128, &reason);

    assert_eq!(r1.id, 1);
    assert_eq!(r2.id, 2);
    assert_eq!(r3.id, 3);
}

#[test]
fn execute_clawback_allows_empty_reason_when_not_required() {
    let (env, client, _admin) = setup();
    let authority = Address::generate(&env);
    let from = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &client.address);
    client.enable_clawback(&asset, &authority, &false);
    asset_mint.mint(&from, &1_000i128);
    asset_mint.set_authorized(&from, &false);

    let empty_reason = String::from_str(&env, "");
    let record = client.execute_clawback(&authority, &from, &asset, &50i128, &empty_reason);
    assert_eq!(record.amount, 50);
}

// ---------------------------------------------------------------------------
// Get clawback config
// ---------------------------------------------------------------------------

#[test]
fn get_clawback_config_returns_none_when_not_set() {
    let (env, client, _admin) = setup();
    let asset = Address::generate(&env);

    let config = client.get_clawback_config(&asset);
    assert!(config.is_none());
}

#[test]
fn get_clawback_config_returns_correct_config_after_disable() {
    let (env, client, _admin) = setup();
    let asset = Address::generate(&env);
    let authority = Address::generate(&env);
    client.enable_clawback(&asset, &authority, &true);
    client.disable_clawback(&asset);

    let config = client.get_clawback_config(&asset).unwrap();
    assert!(!config.enabled);
    assert_eq!(config.authority, authority);
    assert!(config.reason_required);
}

// ---------------------------------------------------------------------------
// Get clawback history
// ---------------------------------------------------------------------------

#[test]
fn get_clawback_history_returns_empty_when_no_records() {
    let (_env, client, _admin) = setup();
    let history = client.get_clawback_history(&None, &10u32);
    assert_eq!(history.len(), 0);
}

#[test]
fn get_clawback_history_returns_records_newest_first() {
    let (env, client, _admin) = setup();
    let authority = Address::generate(&env);
    let from = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &client.address);
    client.enable_clawback(&asset, &authority, &false);
    asset_mint.mint(&from, &10_000i128);
    asset_mint.set_authorized(&from, &false);

    let reason = String::from_str(&env, "batch");
    client.execute_clawback(&authority, &from, &asset, &100i128, &reason);
    client.execute_clawback(&authority, &from, &asset, &200i128, &reason);
    client.execute_clawback(&authority, &from, &asset, &300i128, &reason);

    let history = client.get_clawback_history(&Some(asset.clone()), &5u32);
    assert_eq!(history.len(), 3);
    assert_eq!(history.get(0).unwrap().id, 3);
    assert_eq!(history.get(1).unwrap().id, 2);
    assert_eq!(history.get(2).unwrap().id, 1);
}

#[test]
fn get_clawback_history_honors_limit() {
    let (env, client, _admin) = setup();
    let authority = Address::generate(&env);
    let from = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &client.address);
    client.enable_clawback(&asset, &authority, &false);
    asset_mint.mint(&from, &10_000i128);
    asset_mint.set_authorized(&from, &false);

    let reason = String::from_str(&env, "batch");
    client.execute_clawback(&authority, &from, &asset, &100i128, &reason);
    client.execute_clawback(&authority, &from, &asset, &200i128, &reason);
    client.execute_clawback(&authority, &from, &asset, &300i128, &reason);
    client.execute_clawback(&authority, &from, &asset, &400i128, &reason);

    let history = client.get_clawback_history(&Some(asset.clone()), &2u32);
    assert_eq!(history.len(), 2);
    assert_eq!(history.get(0).unwrap().id, 4);
    assert_eq!(history.get(1).unwrap().id, 3);
}

#[test]
fn get_clawback_history_returns_asset_records_when_interleaved() {
    let (env, client, _admin) = setup();
    let authority = Address::generate(&env);
    let from = Address::generate(&env);
    let (asset_a, _at_a, mint_a) = create_token(&env, &client.address);
    let (asset_b, _at_b, mint_b) = create_token(&env, &client.address);
    client.enable_clawback(&asset_a, &authority, &false);
    client.enable_clawback(&asset_b, &authority, &false);
    mint_a.mint(&from, &10_000i128);
    mint_b.mint(&from, &10_000i128);
    mint_a.set_authorized(&from, &false);
    mint_b.set_authorized(&from, &false);

    let reason = String::from_str(&env, "batch");
    // Interleave: A(100), B(200), A(300), B(400), A(500)
    client.execute_clawback(&authority, &from, &asset_a, &100i128, &reason);
    client.execute_clawback(&authority, &from, &asset_b, &200i128, &reason);
    client.execute_clawback(&authority, &from, &asset_a, &300i128, &reason);
    client.execute_clawback(&authority, &from, &asset_b, &400i128, &reason);
    client.execute_clawback(&authority, &from, &asset_a, &500i128, &reason);

    // Query asset A with limit 2 — returns A(500) and A(300), not B records.
    let history = client.get_clawback_history(&Some(asset_a.clone()), &2u32);
    assert_eq!(history.len(), 2);
    assert_eq!(history.get(0).unwrap().id, 5);
    assert_eq!(history.get(0).unwrap().amount, 500);
    assert_eq!(history.get(1).unwrap().id, 3);
    assert_eq!(history.get(1).unwrap().amount, 300);

    // Query asset A with limit 10 — returns all 3 A records.
    let history_all = client.get_clawback_history(&Some(asset_a), &10u32);
    assert_eq!(history_all.len(), 3);
    assert_eq!(history_all.get(0).unwrap().id, 5);
    assert_eq!(history_all.get(1).unwrap().id, 3);
    assert_eq!(history_all.get(2).unwrap().id, 1);
}
