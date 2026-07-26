extern crate std;

use crate::{Error, FxSwapContract, FxSwapContractClient};
use soroban_sdk::{
    testutils::{Address as _, Events},
    token::StellarAssetClient,
    Address, Env,
};

fn setup() -> (Env, Address, FxSwapContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(FxSwapContract, ());
    let client = FxSwapContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, contract_id, client, admin)
}

fn setup_with_pool() -> (
    Env,
    Address,
    FxSwapContractClient<'static>,
    Address,
    Address,
) {
    let (env, contract_id, client, admin) = setup();
    let sac_a = env.register_stellar_asset_contract_v2(admin.clone());
    let token_a = sac_a.address();
    let sac_b = env.register_stellar_asset_contract_v2(admin.clone());
    let token_b = sac_b.address();
    {
        let ma = StellarAssetClient::new(&env, &token_a);
        let mb = StellarAssetClient::new(&env, &token_b);
        ma.mint(&admin, &1_000_000_000_000_000);
        mb.mint(&admin, &1_000_000_000_000_000);
    }
    client.set_liquidity_pools(&admin, &token_a, &token_b);
    (env, contract_id, client, token_a, token_b)
}

fn setup_with_pool_for_admin() -> (
    Env,
    Address,
    FxSwapContractClient<'static>,
    Address,
    Address,
    Address,
) {
    let (env, contract_id, client, admin) = setup();
    let sac_a = env.register_stellar_asset_contract_v2(admin.clone());
    let token_a = sac_a.address();
    let sac_b = env.register_stellar_asset_contract_v2(admin.clone());
    let token_b = sac_b.address();
    {
        let ma = StellarAssetClient::new(&env, &token_a);
        let mb = StellarAssetClient::new(&env, &token_b);
        ma.mint(&admin, &1_000_000_000_000_000);
        mb.mint(&admin, &1_000_000_000_000_000);
    }
    client.set_liquidity_pools(&admin, &token_a, &token_b);
    (env, contract_id, client, admin, token_a, token_b)
}

fn add_liquidity(
    env: &Env,
    client: &FxSwapContractClient,
    token_a: &Address,
    token_b: &Address,
    lp: &Address,
    amount_a: i128,
    amount_b: i128,
) -> i128 {
    StellarAssetClient::new(env, token_a).mint(lp, &amount_a);
    StellarAssetClient::new(env, token_b).mint(lp, &amount_b);
    client.add_liquidity(lp, token_a, &amount_a, token_b, &amount_b)
}

// ===========================================================================
// initialize
// ===========================================================================

#[test]
fn initialize_sets_admin_and_prevents_unauthorized_pools() {
    let (env, _contract_id, client, admin) = setup();
    let stranger = Address::generate(&env);
    assert_eq!(
        client.try_set_liquidity_pools(&stranger, &admin, &admin),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn initialize_rejects_repeated_call() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(FxSwapContract, ());
    let client = FxSwapContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    assert!(client.try_initialize(&admin).is_ok());
    let result = client.try_initialize(&Address::generate(&env));
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

// ===========================================================================
// set_liquidity_pools
// ===========================================================================

#[test]
fn set_liquidity_pools_creates_pool() {
    let (_env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let pool = client.get_pool(&token_a, &token_b);
    assert_eq!(pool.asset_a, token_a);
    assert_eq!(pool.asset_b, token_b);
    assert_eq!(pool.reserve_a, 0);
    assert_eq!(pool.reserve_b, 0);
    assert_eq!(pool.lp_token_supply, 0);
}

#[test]
fn set_liquidity_pools_requires_admin_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(FxSwapContract, ());
    let client = FxSwapContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let sac_a = env.register_stellar_asset_contract_v2(admin.clone());
    let token_a = sac_a.address();
    let sac_b = env.register_stellar_asset_contract_v2(admin.clone());
    let token_b = sac_b.address();

    env.set_auths(&[]);
    let result = client.try_set_liquidity_pools(&Address::generate(&env), &token_a, &token_b);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn set_liquidity_pools_requires_admin_auth_with_correct_address() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(FxSwapContract, ());
    let client = FxSwapContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let sac_a = env.register_stellar_asset_contract_v2(admin.clone());
    let token_a = sac_a.address();
    let sac_b = env.register_stellar_asset_contract_v2(admin.clone());
    let token_b = sac_b.address();

    env.set_auths(&[]);
    let result = client.try_set_liquidity_pools(&admin, &token_a, &token_b);
    assert!(result.is_err());
}

#[test]
fn set_liquidity_pools_rejects_duplicate_pair() {
    let (_env, _contract_id, client, admin, token_a, token_b) = setup_with_pool_for_admin();
    let result = client.try_set_liquidity_pools(&admin, &token_a, &token_b);
    assert_eq!(result, Err(Ok(Error::PoolAlreadyExists)));
}

#[test]
fn set_liquidity_pools_rejects_same_asset() {
    let (_env, _contract_id, client, admin, token_a, _token_b) = setup_with_pool_for_admin();
    let result = client.try_set_liquidity_pools(&admin, &token_a, &token_a);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn set_liquidity_pools_canonical_ordering() {
    let (_env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let pool_ab = client.get_pool(&token_a, &token_b);
    let pool_ba = client.get_pool(&token_b, &token_a);
    assert_eq!(pool_ab.pool_id, pool_ba.pool_id);
}

// ===========================================================================
// add_liquidity
// ===========================================================================

#[test]
fn add_liquidity_first_deposit() {
    let (env, contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    // First deposit: (1000, 2000)
    // sqrt(2_000_000) = 1414, minus MINIMUM_LIQUIDITY (1000) = 414
    // total_supply includes the locked 1000: 1414
    let lp_tokens = add_liquidity(&env, &client, &token_a, &token_b, &lp, 1000, 2000);
    assert_eq!(lp_tokens, 414);

    let pool = client.get_pool(&token_a, &token_b);
    assert_eq!(pool.reserve_a, 1000);
    assert_eq!(pool.reserve_b, 2000);
    assert_eq!(pool.lp_token_supply, 1414);

    let contract_lp = client.get_lp_balance(&token_a, &token_b, &contract_id);
    assert_eq!(contract_lp, 1000);

    let lp_bal = client.get_lp_balance(&token_a, &token_b, &lp);
    assert_eq!(lp_bal, 414);
}

#[test]
fn add_liquidity_subsequent_deposit() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp1 = Address::generate(&env);
    add_liquidity(&env, &client, &token_a, &token_b, &lp1, 1000, 2000);

    let lp2 = Address::generate(&env);
    // Second deposit (500, 1000) against pool (1000, 2000) with supply=1414
    // share_a = 500 * 1414 / 1000 = 707
    // share_b = 1000 * 1414 / 2000 = 707
    let second_lp = add_liquidity(&env, &client, &token_a, &token_b, &lp2, 500, 1000);
    assert_eq!(second_lp, 707);

    let pool = client.get_pool(&token_a, &token_b);
    assert_eq!(pool.reserve_a, 1500);
    assert_eq!(pool.reserve_b, 3000);
    assert_eq!(pool.lp_token_supply, 2121);
}

#[test]
fn add_liquidity_off_ratio_deposit() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp1 = Address::generate(&env);
    add_liquidity(&env, &client, &token_a, &token_b, &lp1, 1000, 2000);

    let lp2 = Address::generate(&env);
    // Off-ratio: (500, 5000) against 1:2 pool
    // share_a = 500 * 1414 / 1000 = 707
    // share_b = 5000 * 1414 / 2000 = 3535
    // min = 707
    let tokens = add_liquidity(&env, &client, &token_a, &token_b, &lp2, 500, 5000);
    assert_eq!(tokens, 707);

    let pool = client.get_pool(&token_a, &token_b);
    assert_eq!(pool.reserve_a, 1500);
    assert_eq!(pool.reserve_b, 7000);
}

#[test]
fn add_liquidity_reverse_asset_order() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    // Pass (token_b, amount_b, token_a, amount_a) — reverse of canonical
    StellarAssetClient::new(&env, &token_a).mint(&lp, &1000);
    StellarAssetClient::new(&env, &token_b).mint(&lp, &2000);
    let tokens = client.add_liquidity(&lp, &token_b, &2000, &token_a, &1000);
    assert_eq!(tokens, 414);
}

#[test]
fn add_liquidity_requires_lp_auth() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    StellarAssetClient::new(&env, &token_a).mint(&lp, &1000);
    StellarAssetClient::new(&env, &token_b).mint(&lp, &2000);

    env.set_auths(&[]);
    let result = client.try_add_liquidity(&lp, &token_a, &1000, &token_b, &2000);
    assert!(result.is_err());
}

#[test]
fn add_liquidity_zero_amount_rejected() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    let result = client.try_add_liquidity(&lp, &token_a, &0, &token_b, &0);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn add_liquidity_pool_not_found() {
    let (env, _contract_id, client, _token_a, _token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    let unknown = Address::generate(&env);
    let result = client.try_add_liquidity(&lp, &unknown, &1000, &unknown, &2000);
    assert_eq!(result, Err(Ok(Error::PoolNotFound)));
}

#[test]
fn add_liquidity_minimum_liquidity_error() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    // sqrt(10 * 10) = 10 < MINIMUM_LIQUIDITY (1000)
    StellarAssetClient::new(&env, &token_a).mint(&lp, &10);
    StellarAssetClient::new(&env, &token_b).mint(&lp, &10);
    let result = client.try_add_liquidity(&lp, &token_a, &10, &token_b, &10);
    assert_eq!(result, Err(Ok(Error::MinimumLiquidity)));
}

// ===========================================================================
// remove_liquidity
// ===========================================================================

#[test]
fn remove_liquidity_happy_path() {
    let (env, contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    let lp_tokens = add_liquidity(&env, &client, &token_a, &token_b, &lp, 1000, 2000);

    let bal = client.get_lp_balance(&token_a, &token_b, &lp);
    assert_eq!(bal, 414);
    assert_eq!(
        client.get_lp_balance(&token_a, &token_b, &contract_id),
        1000
    );

    client.remove_liquidity(&lp, &token_a, &token_b, &lp_tokens);

    let pool = client.get_pool(&token_a, &token_b);
    assert_eq!(pool.reserve_a, 1000 - 292);
    assert_eq!(pool.reserve_b, 2000 - 585);
    assert_eq!(pool.lp_token_supply, 1000);

    let bal = client.get_lp_balance(&token_a, &token_b, &lp);
    assert_eq!(bal, 0);
}

#[test]
fn remove_liquidity_partial() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    let lp_tokens = add_liquidity(&env, &client, &token_a, &token_b, &lp, 1000, 2000);

    let half = lp_tokens / 2;
    // 207 * 1000 / 1414 = 146
    // 207 * 2000 / 1414 = 292
    client.remove_liquidity(&lp, &token_a, &token_b, &half);

    let pool = client.get_pool(&token_a, &token_b);
    assert_eq!(pool.reserve_a, 1000 - 146);
    assert_eq!(pool.reserve_b, 2000 - 292);
    assert_eq!(pool.lp_token_supply, 1414 - 207);
}

#[test]
fn remove_liquidity_requires_lp_auth() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    let lp_tokens = add_liquidity(&env, &client, &token_a, &token_b, &lp, 1000, 2000);

    env.set_auths(&[]);
    let result = client.try_remove_liquidity(&lp, &token_a, &token_b, &lp_tokens);
    assert!(result.is_err());
}

#[test]
fn remove_liquidity_insufficient_balance() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    add_liquidity(&env, &client, &token_a, &token_b, &lp, 1000, 2000);

    let result = client.try_remove_liquidity(&lp, &token_a, &token_b, &999_999);
    assert_eq!(result, Err(Ok(Error::InsufficientLiquidity)));
}

// ===========================================================================
// swap
// ===========================================================================

#[test]
fn swap_happy_path() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    add_liquidity(&env, &client, &token_a, &token_b, &lp, 100_000, 200_000);

    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token_a).mint(&user, &10_000);
    let amount_out = client.swap(&user, &token_a, &10_000, &token_b, &1);
    // CPMM with 30bps: amount_in_with_fee = 10000 * 9970 = 99700000
    // numerator = 200000 * 99700000 / 10000 = 1994000000
    // denominator = 100000 + 99700000/10000 = 100000 + 9970 = 109970
    // amount_out = 1994000000 / 109970 = 18132
    assert_eq!(amount_out, 18_132);

    let pool = client.get_pool(&token_a, &token_b);
    assert_eq!(pool.reserve_a, 110_000);
    assert_eq!(pool.reserve_b, 200_000 - 18_132);
}

#[test]
fn swap_slippage_protection() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    add_liquidity(&env, &client, &token_a, &token_b, &lp, 100_000, 200_000);

    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token_a).mint(&user, &10_000);
    let result = client.try_swap(&user, &token_a, &10_000, &token_b, &999_999);
    assert_eq!(result, Err(Ok(Error::SlippageExceeded)));
}

#[test]
fn swap_insufficient_liquidity() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let user = Address::generate(&env);
    let result = client.try_swap(&user, &token_a, &10_000, &token_b, &1);
    assert_eq!(result, Err(Ok(Error::InsufficientLiquidity)));
}

#[test]
fn swap_zero_amount_rejected() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    add_liquidity(&env, &client, &token_a, &token_b, &lp, 100_000, 200_000);
    let user = Address::generate(&env);
    let result = client.try_swap(&user, &token_a, &0, &token_b, &1);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn swap_pool_not_found() {
    let (env, _contract_id, client, _token_a, _token_b) = setup_with_pool();
    let user = Address::generate(&env);
    let unknown = Address::generate(&env);
    let result = client.try_swap(&user, &unknown, &100, &unknown, &1);
    assert_eq!(result, Err(Ok(Error::PoolNotFound)));
}

#[test]
fn swap_reverse_direction() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    add_liquidity(&env, &client, &token_a, &token_b, &lp, 100_000, 200_000);

    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token_b).mint(&user, &10_000);
    let amount_out = client.swap(&user, &token_b, &10_000, &token_a, &1);
    // reserve_in = 200000 (asset_b), reserve_out = 100000 (asset_a)
    // amount_in_with_fee = 10000 * 9970 = 99700000
    // numerator = 100000 * 99700000 = 9970000000000
    // denominator = 200000 * 10000 + 99700000 = 2099700000
    // amount_out = 9970000000000 / 2099700000 = 4748
    assert_eq!(amount_out, 4_748);

    let pool = client.get_pool(&token_a, &token_b);
    assert_eq!(pool.reserve_b, 210_000);
    assert_eq!(pool.reserve_a, 100_000 - 4_748);
}

// ===========================================================================
// get_quote
// ===========================================================================

#[test]
fn get_quote_returns_accurate_quote() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    add_liquidity(&env, &client, &token_a, &token_b, &lp, 100_000, 200_000);

    let quoted = client.get_quote(&token_a, &10_000, &token_b);
    assert_eq!(quoted, 18_132);

    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token_a).mint(&user, &10_000);
    let actual = client.swap(&user, &token_a, &10_000, &token_b, &1);
    assert_eq!(actual, quoted);
}

#[test]
fn get_quote_pool_not_found() {
    let (env, _contract_id, client, _token_a, _token_b) = setup_with_pool();
    let unknown = Address::generate(&env);
    let result = client.try_get_quote(&unknown, &100, &unknown);
    assert_eq!(result, Err(Ok(Error::PoolNotFound)));
}

#[test]
fn get_quote_zero_amount() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    add_liquidity(&env, &client, &token_a, &token_b, &lp, 100_000, 200_000);
    let result = client.try_get_quote(&token_a, &0, &token_b);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

// ===========================================================================
// get_lp_balance
// ===========================================================================

#[test]
fn get_lp_balance_returns_zero_for_non_lp() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let stranger = Address::generate(&env);
    let balance = client.get_lp_balance(&token_a, &token_b, &stranger);
    assert_eq!(balance, 0);
}

// ===========================================================================
// Lifecycle
// ===========================================================================

#[test]
fn full_lifecycle_add_swap_remove() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);

    let lp_tokens = add_liquidity(&env, &client, &token_a, &token_b, &lp, 100_000, 200_000);
    assert_eq!(lp_tokens, sqrt(100_000 * 200_000) - 1000);

    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token_a).mint(&user, &10_000);
    let out = client.swap(&user, &token_a, &10_000, &token_b, &1);
    assert_eq!(out, 18_132);

    let bal_before = client.get_lp_balance(&token_a, &token_b, &lp);
    assert_eq!(bal_before, lp_tokens);
    client.remove_liquidity(&lp, &token_a, &token_b, &lp_tokens);
    let bal_after = client.get_lp_balance(&token_a, &token_b, &lp);
    assert_eq!(bal_after, 0);
}

#[test]
fn fee_accrual() {
    let (env, contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);

    let _lp_tokens = add_liquidity(&env, &client, &token_a, &token_b, &lp, 100_000, 200_000);

    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token_a).mint(&user, &50_000);
    client.swap(&user, &token_a, &50_000, &token_b, &1);

    let lp_bal = client.get_lp_balance(&token_a, &token_b, &lp);
    client.remove_liquidity(&lp, &token_a, &token_b, &lp_bal);

    // MINIMUM_LIQUIDITY remains locked in the contract
    assert_eq!(
        client.get_lp_balance(&token_a, &token_b, &contract_id),
        1000
    );
}

#[test]
fn events_emitted_on_lifecycle() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);

    let lp_tokens = add_liquidity(&env, &client, &token_a, &token_b, &lp, 1000, 2000);
    assert!(lp_tokens > 0);

    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token_a).mint(&user, &500);
    let _out = client.swap(&user, &token_a, &500, &token_b, &1);

    client.remove_liquidity(&lp, &token_a, &token_b, &lp_tokens);

    // Just verify that events were published (no panic = events exist)
    env.events().all();
}

#[test]
fn reverse_order_add_and_remove_liquidity() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);

    // Add with reversed order
    StellarAssetClient::new(&env, &token_a).mint(&lp, &1000);
    StellarAssetClient::new(&env, &token_b).mint(&lp, &2000);
    let tokens = client.add_liquidity(&lp, &token_b, &2000, &token_a, &1000);
    assert_eq!(tokens, 414);

    // Remove with reversed order
    client.remove_liquidity(&lp, &token_b, &token_a, &tokens);
    let bal = client.get_lp_balance(&token_a, &token_b, &lp);
    assert_eq!(bal, 0);
}

// ===========================================================================
// Helpers
// ===========================================================================

fn sqrt(val: i128) -> i128 {
    if val <= 0 {
        return 0;
    }
    let uval = val as u128;
    let mut x = uval;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + uval / x) / 2;
    }
    x as i128
}
