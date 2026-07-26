extern crate std;

use crate::{Error, FxSwapContract, FxSwapContractClient};
use soroban_sdk::{
    testutils::{Address as _, Events},
    token::StellarAssetClient,
    vec, Address, Env,
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
fn initialize_sets_admin() {
    let (_env, _contract_id, client, admin) = setup();
    let result = client.try_initialize(&admin);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
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
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    let lp_tokens = add_liquidity(&env, &client, &token_a, &token_b, &lp, 1000, 2000);
    assert!(lp_tokens > 0);

    let pool = client.get_pool(&token_a, &token_b);
    assert_eq!(pool.reserve_a, 1000);
    assert_eq!(pool.reserve_b, 2000);
    assert_eq!(pool.lp_token_supply, lp_tokens);
}

#[test]
fn add_liquidity_subsequent_deposit() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp1 = Address::generate(&env);
    let _first_lp = add_liquidity(&env, &client, &token_a, &token_b, &lp1, 1000, 2000);

    let lp2 = Address::generate(&env);
    let second_lp = add_liquidity(&env, &client, &token_a, &token_b, &lp2, 500, 1000);
    assert!(second_lp > 0);
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

// ===========================================================================
// remove_liquidity
// ===========================================================================

#[test]
fn remove_liquidity_happy_path() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    let lp_tokens = add_liquidity(&env, &client, &token_a, &token_b, &lp, 1000, 2000);

    let bal = client.get_lp_balance(&token_a, &token_b, &lp);
    assert_eq!(bal, lp_tokens);

    client.remove_liquidity(&lp, &token_a, &token_b, &lp_tokens);

    let pool = client.get_pool(&token_a, &token_b);
    assert_eq!(pool.reserve_a, 0);
    assert_eq!(pool.reserve_b, 0);
    assert_eq!(pool.lp_token_supply, 0);

    let bal = client.get_lp_balance(&token_a, &token_b, &lp);
    assert_eq!(bal, 0);
}

#[test]
fn remove_liquidity_partial() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    let lp_tokens = add_liquidity(&env, &client, &token_a, &token_b, &lp, 1000, 2000);

    let half = lp_tokens / 2;
    client.remove_liquidity(&lp, &token_a, &token_b, &half);

    let pool = client.get_pool(&token_a, &token_b);
    assert!(pool.reserve_a > 0);
    assert!(pool.reserve_b > 0);
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
    assert!(amount_out > 0);

    let pool = client.get_pool(&token_a, &token_b);
    assert_eq!(pool.reserve_a, 110_000);
    assert!(pool.reserve_b < 200_000);
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

// ===========================================================================
// get_quote
// ===========================================================================

#[test]
fn get_quote_returns_accurate_quote() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    add_liquidity(&env, &client, &token_a, &token_b, &lp, 100_000, 200_000);

    let quoted = client.get_quote(&token_a, &10_000, &token_b);
    assert!(quoted > 0);

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
    assert!(lp_tokens > 0);

    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token_a).mint(&user, &10_000);
    let out = client.swap(&user, &token_a, &10_000, &token_b, &1);
    assert!(out > 0);

    let bal_before = client.get_lp_balance(&token_a, &token_b, &lp);
    assert_eq!(bal_before, lp_tokens);
    client.remove_liquidity(&lp, &token_a, &token_b, &lp_tokens);
    let bal_after = client.get_lp_balance(&token_a, &token_b, &lp);
    assert_eq!(bal_after, 0);

    let pool = client.get_pool(&token_a, &token_b);
    assert_eq!(pool.reserve_a, 0);
    assert_eq!(pool.reserve_b, 0);
}

#[test]
fn events_emitted_on_lifecycle() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);

    let lp_tokens = add_liquidity(&env, &client, &token_a, &token_b, &lp, 1000, 2000);
    assert_ne!(
        env.events().all(),
        vec![&env],
        "LiquidityAdded event expected"
    );
    assert!(lp_tokens > 0);

    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token_a).mint(&user, &500);
    let _out = client.swap(&user, &token_a, &500, &token_b, &1);
    assert_ne!(
        env.events().all(),
        vec![&env],
        "SwapExecuted event expected"
    );

    client.remove_liquidity(&lp, &token_a, &token_b, &lp_tokens);
    assert_ne!(
        env.events().all(),
        vec![&env],
        "LiquidityRemoved event expected"
    );
}

#[test]
fn swap_reverse_direction() {
    let (env, _contract_id, client, token_a, token_b) = setup_with_pool();
    let lp = Address::generate(&env);
    add_liquidity(&env, &client, &token_a, &token_b, &lp, 100_000, 200_000);

    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token_b).mint(&user, &10_000);
    let amount_out = client.swap(&user, &token_b, &10_000, &token_a, &1);
    assert!(amount_out > 0);

    let pool = client.get_pool(&token_a, &token_b);
    assert_eq!(pool.reserve_b, 210_000);
    assert!(pool.reserve_a < 100_000);
}
