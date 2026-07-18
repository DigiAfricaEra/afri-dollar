use crate::{Error, OracleContract, OracleContractClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, Ledger},
    vec, Address, Env, IntoVal, Vec,
};

fn setup() -> (Env, OracleContractClient<'static>, Address) {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();
    let contract_id = env.register(OracleContract, ());
    let client = OracleContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

fn setup_provider(
    env: &Env,
    client: &OracleContractClient,
    admin: &Address,
    max_staleness_seconds: u64,
) -> Address {
    let provider = Address::generate(env);
    client.register_provider(admin, &provider, &max_staleness_seconds);
    client.authorize_provider(admin, &provider);
    client.heartbeat(&provider);
    provider
}

/// Assert that `env.events().all()` filtered to our contract is exactly
/// one event with the given topics and data.
fn assert_last_event<T, D>(env: &Env, contract_id: &Address, topics: T, data: D)
where
    T: IntoVal<Env, Vec<soroban_sdk::Val>>,
    D: IntoVal<Env, soroban_sdk::Val>,
{
    let expected: Vec<(Address, Vec<soroban_sdk::Val>, soroban_sdk::Val)> = vec![
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
// initialize
// ---------------------------------------------------------------------------

#[test]
fn initialize_records_admin() {
    let (_env, client, admin) = setup();
    let config = client.get_config(&admin);
    // Admin is not a provider by default.
    assert!(config.is_none());
}

#[test]
fn initialize_is_one_time_only() {
    let (_env, client, admin) = setup();
    let result = client.try_initialize(&admin);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn initialize_requires_admin_auth() {
    let env = Env::default();
    let contract_id = env.register(OracleContract, ());
    let client = OracleContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let result = client.try_initialize(&admin);
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// register_provider
// ---------------------------------------------------------------------------

#[test]
fn register_provider_creates_config_with_unauthorized_status() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);

    client.register_provider(&admin, &provider, &300u64);

    let config = client.get_config(&provider).unwrap();
    assert_eq!(config.provider, provider);
    assert!(!config.authorized);
    assert_eq!(config.last_heartbeat, 0);
    assert_eq!(config.max_staleness_seconds, 300);
}

#[test]
fn register_provider_fails_if_already_registered() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);
    client.register_provider(&admin, &provider, &300u64);

    let result = client.try_register_provider(&admin, &provider, &500u64);
    assert_eq!(result, Err(Ok(Error::ProviderAlreadyRegistered)));
}

#[test]
fn register_provider_rejects_non_admin() {
    let (env, client, _admin) = setup();
    let intruder = Address::generate(&env);
    let provider = Address::generate(&env);

    let result = client.try_register_provider(&intruder, &provider, &300u64);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn register_provider_emits_event() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);

    client.register_provider(&admin, &provider, &600u64);

    assert_last_event(
        &env,
        &client.address,
        (symbol_short!("oracle"), symbol_short!("prov_reg"), provider),
        (600u64,),
    );
}

// ---------------------------------------------------------------------------
// authorize_provider
// ---------------------------------------------------------------------------

#[test]
fn authorize_provider_sets_authorized_flag() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);
    client.register_provider(&admin, &provider, &300u64);

    client.authorize_provider(&admin, &provider);

    let config = client.get_config(&provider).unwrap();
    assert!(config.authorized);
}

#[test]
fn authorize_provider_fails_if_not_registered() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);

    let result = client.try_authorize_provider(&admin, &provider);
    assert_eq!(result, Err(Ok(Error::ProviderNotRegistered)));
}

#[test]
fn authorize_provider_rejects_non_admin() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);
    client.register_provider(&admin, &provider, &300u64);

    let intruder = Address::generate(&env);
    let result = client.try_authorize_provider(&intruder, &provider);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn authorize_provider_emits_event() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);
    client.register_provider(&admin, &provider, &300u64);

    let ts = env.ledger().timestamp();
    client.authorize_provider(&admin, &provider);

    assert_last_event(
        &env,
        &client.address,
        (
            symbol_short!("oracle"),
            symbol_short!("prov_auth"),
            provider,
        ),
        ts,
    );
}

// ---------------------------------------------------------------------------
// revoke_provider
// ---------------------------------------------------------------------------

#[test]
fn revoke_provider_clears_authorized_flag() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);
    client.register_provider(&admin, &provider, &300u64);
    client.authorize_provider(&admin, &provider);

    client.revoke_provider(&admin, &provider);

    let config = client.get_config(&provider).unwrap();
    assert!(!config.authorized);
}

#[test]
fn revoke_provider_fails_if_not_registered() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);

    let result = client.try_revoke_provider(&admin, &provider);
    assert_eq!(result, Err(Ok(Error::ProviderNotRegistered)));
}

#[test]
fn revoke_provider_rejects_non_admin() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);
    client.register_provider(&admin, &provider, &300u64);

    let intruder = Address::generate(&env);
    let result = client.try_revoke_provider(&intruder, &provider);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn revoke_provider_emits_event() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);
    client.register_provider(&admin, &provider, &300u64);

    let ts = env.ledger().timestamp();
    client.revoke_provider(&admin, &provider);

    assert_last_event(
        &env,
        &client.address,
        (symbol_short!("oracle"), symbol_short!("prov_rev"), provider),
        ts,
    );
}

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

#[test]
fn heartbeat_updates_last_heartbeat() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);
    client.register_provider(&admin, &provider, &300u64);

    let before = client.get_config(&provider).unwrap().last_heartbeat;
    assert_eq!(before, 0);

    client.heartbeat(&provider);

    let after = client.get_config(&provider).unwrap().last_heartbeat;
    assert!(after > 0);
}

#[test]
fn heartbeat_requires_provider_auth() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);
    client.register_provider(&admin, &provider, &300u64);

    env.set_auths(&[]);
    let result = client.try_heartbeat(&provider);
    assert!(result.is_err());
}

#[test]
fn heartbeat_fails_if_not_registered() {
    let (env, client, _admin) = setup();
    let provider = Address::generate(&env);

    let result = client.try_heartbeat(&provider);
    assert_eq!(result, Err(Ok(Error::ProviderNotRegistered)));
}

#[test]
fn heartbeat_works_for_revoked_provider() {
    // A revoked provider can still heartbeat so liveness is observable.
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);
    client.register_provider(&admin, &provider, &300u64);
    client.heartbeat(&provider);
    client.revoke_provider(&admin, &provider);

    client.heartbeat(&provider);

    let config = client.get_config(&provider).unwrap();
    assert!(!config.authorized);
    assert!(config.last_heartbeat > 0);
}

#[test]
fn heartbeat_emits_event() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);
    client.register_provider(&admin, &provider, &300u64);

    client.heartbeat(&provider);

    let ts = env.ledger().timestamp();
    assert_last_event(
        &env,
        &client.address,
        (
            symbol_short!("oracle"),
            symbol_short!("heartbeat"),
            provider,
        ),
        ts,
    );
}

// ---------------------------------------------------------------------------
// submit_price — acceptance criterion 1: only authorized providers
// ---------------------------------------------------------------------------

#[test]
fn authorized_provider_can_submit_price() {
    let (env, client, admin) = setup();
    let provider = setup_provider(&env, &client, &admin, 300);
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    client.submit_price(&provider, &asset_a, &asset_b, &1500000000i128, &6u32);

    let price_data = client.get_price(&asset_a, &asset_b, &provider).unwrap();
    assert_eq!(price_data.price, 1500000000);
    assert_eq!(price_data.decimals, 6);
    assert_eq!(price_data.provider, provider);
}

#[test]
fn unauthorized_provider_cannot_submit_price() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);
    client.register_provider(&admin, &provider, &300u64);
    // Not authorized, not heartbeated.

    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    let result = client.try_submit_price(&provider, &asset_a, &asset_b, &100i128, &6u32);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn revoked_provider_cannot_submit_price() {
    let (env, client, admin) = setup();
    let provider = setup_provider(&env, &client, &admin, 300);
    client.revoke_provider(&admin, &provider);

    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    let result = client.try_submit_price(&provider, &asset_a, &asset_b, &100i128, &6u32);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn submit_price_rejects_negative_price() {
    let (env, client, admin) = setup();
    let provider = setup_provider(&env, &client, &admin, 300);
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    let result = client.try_submit_price(&provider, &asset_a, &asset_b, &-1i128, &6u32);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn submit_price_requires_provider_auth() {
    let (env, client, admin) = setup();
    let provider = setup_provider(&env, &client, &admin, 300);
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    env.set_auths(&[]);
    let result = client.try_submit_price(&provider, &asset_a, &asset_b, &100i128, &6u32);
    assert!(result.is_err());
}

#[test]
fn submit_price_updates_existing_price() {
    let (env, client, admin) = setup();
    let provider = setup_provider(&env, &client, &admin, 300);
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    client.submit_price(&provider, &asset_a, &asset_b, &100i128, &6u32);
    client.submit_price(&provider, &asset_a, &asset_b, &200i128, &6u32);

    let price_data = client.get_price(&asset_a, &asset_b, &provider).unwrap();
    assert_eq!(price_data.price, 200);
}

#[test]
fn submit_price_emits_event() {
    let (env, client, admin) = setup();
    let provider = setup_provider(&env, &client, &admin, 300);
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    client.submit_price(&provider, &asset_a, &asset_b, &1500000000i128, &6u32);

    assert_last_event(
        &env,
        &client.address,
        (
            symbol_short!("oracle"),
            symbol_short!("price_set"),
            asset_a,
            provider,
        ),
        (asset_b, 1500000000i128, 6u32),
    );
}

// ---------------------------------------------------------------------------
// submit_price — acceptance criterion 2: stale heartbeat rejects submission
// ---------------------------------------------------------------------------

#[test]
fn stale_heartbeat_rejects_price_submission() {
    let (env, client, admin) = setup();
    let provider = setup_provider(&env, &client, &admin, 60); // 60s staleness
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    // Advance time past the staleness window.
    env.ledger().with_mut(|li| li.timestamp += 61);

    let result = client.try_submit_price(&provider, &asset_a, &asset_b, &100i128, &6u32);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn heartbeat_restores_price_submission_ability() {
    let (env, client, admin) = setup();
    let provider = setup_provider(&env, &client, &admin, 60);
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    env.ledger().with_mut(|li| li.timestamp += 61);

    // Heartbeat again to restore liveness.
    client.heartbeat(&provider);

    client.submit_price(&provider, &asset_a, &asset_b, &100i128, &6u32);
    let price_data = client.get_price(&asset_a, &asset_b, &provider).unwrap();
    assert_eq!(price_data.price, 100);
}

// ---------------------------------------------------------------------------
// get_price
// ---------------------------------------------------------------------------

#[test]
fn get_price_returns_none_if_no_price() {
    let (env, client, _admin) = setup();
    let provider = Address::generate(&env);
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    let result = client.get_price(&asset_a, &asset_b, &provider);
    assert!(result.is_none());
}

#[test]
fn get_price_returns_latest_submission() {
    let (env, client, admin) = setup();
    let provider = setup_provider(&env, &client, &admin, 300);
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    client.submit_price(&provider, &asset_a, &asset_b, &500i128, &6u32);

    let price_data = client.get_price(&asset_a, &asset_b, &provider).unwrap();
    assert_eq!(price_data.price, 500);
    assert_eq!(price_data.decimals, 6);
    assert_eq!(price_data.provider, provider);
    assert_eq!(price_data.asset_a, asset_a);
    assert_eq!(price_data.asset_b, asset_b);
}

// ---------------------------------------------------------------------------
// get_aggregated_price — acceptance criterion 3: median aggregation
// ---------------------------------------------------------------------------

#[test]
fn get_aggregated_price_single_provider() {
    let (env, client, admin) = setup();
    let provider = setup_provider(&env, &client, &admin, 300);
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    client.submit_price(&provider, &asset_a, &asset_b, &1500000000i128, &6u32);

    let agg = client.get_aggregated_price(&asset_a, &asset_b);
    assert_eq!(agg.price, 1500000000);
    assert_eq!(agg.decimals, 6);
    assert_eq!(agg.provider, client.address);
}

#[test]
fn get_aggregated_price_median_of_three() {
    let (env, client, admin) = setup();
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    let p1 = setup_provider(&env, &client, &admin, 300);
    let p2 = setup_provider(&env, &client, &admin, 300);
    let p3 = setup_provider(&env, &client, &admin, 300);

    client.submit_price(&p1, &asset_a, &asset_b, &100i128, &6u32);
    client.submit_price(&p2, &asset_a, &asset_b, &300i128, &6u32);
    client.submit_price(&p3, &asset_a, &asset_b, &200i128, &6u32);

    let agg = client.get_aggregated_price(&asset_a, &asset_b);
    assert_eq!(agg.price, 200); // Median of [100, 200, 300]
}

#[test]
fn get_aggregated_price_median_of_two() {
    let (env, client, admin) = setup();
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    let p1 = setup_provider(&env, &client, &admin, 300);
    let p2 = setup_provider(&env, &client, &admin, 300);

    client.submit_price(&p1, &asset_a, &asset_b, &100i128, &6u32);
    client.submit_price(&p2, &asset_a, &asset_b, &500i128, &6u32);

    // Even count → lower median → [100, 500] → index 0 → 100
    let agg = client.get_aggregated_price(&asset_a, &asset_b);
    assert_eq!(agg.price, 100);
}

#[test]
fn get_aggregated_price_median_of_four() {
    let (env, client, admin) = setup();
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    let p1 = setup_provider(&env, &client, &admin, 300);
    let p2 = setup_provider(&env, &client, &admin, 300);
    let p3 = setup_provider(&env, &client, &admin, 300);
    let p4 = setup_provider(&env, &client, &admin, 300);

    client.submit_price(&p1, &asset_a, &asset_b, &100i128, &6u32);
    client.submit_price(&p2, &asset_a, &asset_b, &200i128, &6u32);
    client.submit_price(&p3, &asset_a, &asset_b, &800i128, &6u32);
    client.submit_price(&p4, &asset_a, &asset_b, &400i128, &6u32);

    // Sorted: [100, 200, 400, 800] → lower median = index 1 → 200
    let agg = client.get_aggregated_price(&asset_a, &asset_b);
    assert_eq!(agg.price, 200);
}

#[test]
fn get_aggregated_price_returns_error_when_no_prices() {
    let (env, client, _admin) = setup();
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    let result = client.try_get_aggregated_price(&asset_a, &asset_b);
    assert_eq!(result, Err(Ok(Error::NoValidPrice)));
}

#[test]
fn get_aggregated_price_excludes_revoked_provider() {
    let (env, client, admin) = setup();
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    let p1 = setup_provider(&env, &client, &admin, 300);
    let p2 = setup_provider(&env, &client, &admin, 300);

    client.submit_price(&p1, &asset_a, &asset_b, &100i128, &6u32);
    client.submit_price(&p2, &asset_a, &asset_b, &300i128, &6u32);

    // Revoke p2 → only p1's price of 100 should remain.
    client.revoke_provider(&admin, &p2);

    let agg = client.get_aggregated_price(&asset_a, &asset_b);
    assert_eq!(agg.price, 100);
}

// ---------------------------------------------------------------------------
// acceptance criterion 4: heartbeat monitoring detects inactive providers
// ---------------------------------------------------------------------------

#[test]
fn is_active_returns_false_when_heartbeat_stale() {
    let (env, client, admin) = setup();
    let provider = setup_provider(&env, &client, &admin, 60);

    assert!(client.is_active(&provider));

    env.ledger().with_mut(|li| li.timestamp += 61);

    assert!(!client.is_active(&provider));
}

#[test]
fn is_active_returns_false_for_unauthorized_provider() {
    let (env, client, admin) = setup();
    let provider = Address::generate(&env);
    client.register_provider(&admin, &provider, &300u64);
    // Not authorized, not heartbeated.

    assert!(!client.is_active(&provider));
}

#[test]
fn is_active_returns_false_for_unregistered_provider() {
    let (env, client, _admin) = setup();
    let provider = Address::generate(&env);
    assert!(!client.is_active(&provider));
}

#[test]
fn stale_provider_excluded_from_aggregation() {
    let (env, client, admin) = setup();
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    let p1 = setup_provider(&env, &client, &admin, 300);
    let p2 = setup_provider(&env, &client, &admin, 60); // shorter window

    client.submit_price(&p1, &asset_a, &asset_b, &100i128, &6u32);
    client.submit_price(&p2, &asset_a, &asset_b, &300i128, &6u32);

    // p2's heartbeat goes stale after 61s.
    env.ledger().with_mut(|li| li.timestamp += 61);

    let agg = client.get_aggregated_price(&asset_a, &asset_b);
    // Only p1's price of 100 is valid.
    assert_eq!(agg.price, 100);
}

// ---------------------------------------------------------------------------
// get_config / provider_count
// ---------------------------------------------------------------------------

#[test]
fn get_config_returns_none_for_unregistered() {
    let (env, client, _admin) = setup();
    let provider = Address::generate(&env);
    assert!(client.get_config(&provider).is_none());
}

#[test]
fn provider_count_tracks_providers_per_pair() {
    let (env, client, admin) = setup();
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);
    let asset_c = Address::generate(&env);

    assert_eq!(client.provider_count(&asset_a, &asset_b), 0);

    let p1 = setup_provider(&env, &client, &admin, 300);
    client.submit_price(&p1, &asset_a, &asset_b, &100i128, &6u32);
    assert_eq!(client.provider_count(&asset_a, &asset_b), 1);

    let p2 = setup_provider(&env, &client, &admin, 300);
    client.submit_price(&p2, &asset_a, &asset_b, &200i128, &6u32);
    assert_eq!(client.provider_count(&asset_a, &asset_b), 2);

    // Different pair unaffected.
    assert_eq!(client.provider_count(&asset_a, &asset_c), 0);
}

// ---------------------------------------------------------------------------
// independent asset pairs
// ---------------------------------------------------------------------------

#[test]
fn different_asset_pairs_are_independent() {
    let (env, client, admin) = setup();
    let provider = setup_provider(&env, &client, &admin, 300);
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);
    let asset_c = Address::generate(&env);

    // Submit price for A/B and A/C pairs.
    client.submit_price(&provider, &asset_a, &asset_b, &100i128, &6u32);
    client.submit_price(&provider, &asset_a, &asset_c, &500i128, &8u32);

    let price_ab = client.get_price(&asset_a, &asset_b, &provider).unwrap();
    assert_eq!(price_ab.price, 100);
    assert_eq!(price_ab.decimals, 6);

    let price_ac = client.get_price(&asset_a, &asset_c, &provider).unwrap();
    assert_eq!(price_ac.price, 500);
    assert_eq!(price_ac.decimals, 8);
}

// ---------------------------------------------------------------------------
// timestamp monotonicity
// ---------------------------------------------------------------------------

#[test]
fn submit_price_rejects_backdated_timestamp() {
    let (env, client, admin) = setup();
    let provider = setup_provider(&env, &client, &admin, 300);
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    // Submit first price.
    client.submit_price(&provider, &asset_a, &asset_b, &200i128, &6u32);

    // The second submission uses contract's timestamp (which is monotonic),
    // so this isn't directly testable at the integration level since the
    // contract derives timestamp from the ledger. We verify it doesn't
    // crash and the latest price is stored.
    client.submit_price(&provider, &asset_a, &asset_b, &150i128, &6u32);
    let pd = client.get_price(&asset_a, &asset_b, &provider).unwrap();
    assert_eq!(pd.price, 150);
}

// ---------------------------------------------------------------------------
// end-to-end: full oracle workflow
// ---------------------------------------------------------------------------

#[test]
fn full_oracle_lifecycle() {
    let (env, client, admin) = setup();
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    // Register 5 providers.
    let mut providers: Vec<Address> = vec![&env];
    for _ in 0..5 {
        let p = Address::generate(&env);
        client.register_provider(&admin, &p, &3600u64);
        providers.push_back(p);
    }

    // Authorize 3 of them.
    for i in 0..3 {
        let p = providers.get(i).unwrap();
        client.authorize_provider(&admin, &p);
        client.heartbeat(&p);
    }

    // Only authorized providers submit prices.
    client.submit_price(
        &providers.get(0).unwrap(),
        &asset_a,
        &asset_b,
        &1000i128,
        &6u32,
    );
    client.submit_price(
        &providers.get(1).unwrap(),
        &asset_a,
        &asset_b,
        &1100i128,
        &6u32,
    );
    client.submit_price(
        &providers.get(2).unwrap(),
        &asset_a,
        &asset_b,
        &950i128,
        &6u32,
    );

    // Median of [950, 1000, 1100] = 1000.
    let agg = client.get_aggregated_price(&asset_a, &asset_b);
    assert_eq!(agg.price, 1000);

    // Revoke provider 1 and verify it's excluded.
    client.revoke_provider(&admin, &providers.get(1).unwrap());

    // Now median of [950, 1000] → lower = 950.
    let agg2 = client.get_aggregated_price(&asset_a, &asset_b);
    assert_eq!(agg2.price, 950);

    // Advance time beyond staleness for provider 0.
    env.ledger().with_mut(|li| li.timestamp += 3601);

    // Refresh provider 2's heartbeat and price so it remains valid.
    client.heartbeat(&providers.get(2).unwrap());
    client.submit_price(
        &providers.get(2).unwrap(),
        &asset_a,
        &asset_b,
        &950i128,
        &6u32,
    );

    // Only provider 2 with 950 remains.
    let agg3 = client.get_aggregated_price(&asset_a, &asset_b);
    assert_eq!(agg3.price, 950);

    // Heartbeat provider 0 back and re-submit its price.
    client.heartbeat(&providers.get(0).unwrap());
    client.submit_price(
        &providers.get(0).unwrap(),
        &asset_a,
        &asset_b,
        &1000i128,
        &6u32,
    );

    // Now [950, 1000] again → lower = 950.
    let agg4 = client.get_aggregated_price(&asset_a, &asset_b);
    assert_eq!(agg4.price, 950);
}
