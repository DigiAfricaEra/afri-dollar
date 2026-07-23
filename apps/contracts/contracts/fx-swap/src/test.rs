use crate::{Error, FXSwapContract, FXSwapContractClient};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

const INITIAL_MINT: i128 = 100_000;

struct Fixture {
    contract_id: Address,
    admin: Address,
    lp: Address,
    user: Address,
    asset_a: Address,
    asset_b: Address,
}

fn setup() -> (Env, Fixture) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(FXSwapContract, ());

    let lp = Address::generate(&env);
    let user = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let asset_a = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let asset_b = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    StellarAssetClient::new(&env, &asset_a).mint(&lp, &INITIAL_MINT);
    StellarAssetClient::new(&env, &asset_b).mint(&lp, &INITIAL_MINT);
    StellarAssetClient::new(&env, &asset_a).mint(&user, &INITIAL_MINT);
    StellarAssetClient::new(&env, &asset_b).mint(&user, &INITIAL_MINT);

    (
        env,
        Fixture {
            contract_id,
            admin,
            lp,
            user,
            asset_a,
            asset_b,
        },
    )
}

fn client<'a>(env: &'a Env, fixture: &Fixture) -> FXSwapContractClient<'a> {
    FXSwapContractClient::new(env, &fixture.contract_id)
}

#[test]
fn test_initialize_and_double_initialize_prevention() {
    let (env, fixture) = setup();
    let client = client(&env, &fixture);

    client.initialize(&fixture.admin);

    assert_eq!(
        client.try_initialize(&fixture.admin),
        Err(Ok(Error::AlreadyInitialized))
    );
}

#[test]
fn test_set_pool_by_admin() {
    let (env, fixture) = setup();
    let client = client(&env, &fixture);
    client.initialize(&fixture.admin);

    client.set_pool(&fixture.admin, &fixture.asset_a, &fixture.asset_b);

    let pool = client.get_pool(&fixture.asset_a, &fixture.asset_b);
    assert_eq!(pool.reserve_a, 0);
    assert_eq!(pool.reserve_b, 0);
    assert_eq!(pool.total_shares, 0);

    // Duplicate pool creation should fail
    assert_eq!(
        client.try_set_pool(&fixture.admin, &fixture.asset_a, &fixture.asset_b),
        Err(Ok(Error::PoolAlreadyExists))
    );
}

#[test]
fn test_set_pool_unauthorized() {
    let (env, fixture) = setup();
    let client = client(&env, &fixture);
    client.initialize(&fixture.admin);

    let stranger = Address::generate(&env);
    assert_eq!(
        client.try_set_pool(&stranger, &fixture.asset_a, &fixture.asset_b),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn test_add_and_remove_liquidity() {
    let (env, fixture) = setup();
    let client = client(&env, &fixture);
    client.initialize(&fixture.admin);

    let token_a = TokenClient::new(&env, &fixture.asset_a);
    let token_b = TokenClient::new(&env, &fixture.asset_b);

    // Add initial liquidity: 10,000 asset_a and 40,000 asset_b
    let shares_minted = client.add_liquidity(
        &fixture.lp,
        &fixture.asset_a,
        &10_000,
        &fixture.asset_b,
        &40_000,
    );

    // Expected initial shares = sqrt(10_000 * 40_000) = sqrt(400_000_000) = 20_000
    assert_eq!(shares_minted, 20_000);
    assert_eq!(token_a.balance(&fixture.lp), INITIAL_MINT - 10_000);
    assert_eq!(token_b.balance(&fixture.lp), INITIAL_MINT - 40_000);
    assert_eq!(token_a.balance(&fixture.contract_id), 10_000);
    assert_eq!(token_b.balance(&fixture.contract_id), 40_000);

    let pool = client.get_pool(&fixture.asset_a, &fixture.asset_b);
    assert_eq!(pool.total_shares, 20_000);
    assert_eq!(
        client.get_liquidity(&fixture.lp, &fixture.asset_a, &fixture.asset_b),
        20_000
    );

    // Remove half of liquidity (10,000 shares)
    let (returned_a, returned_b) =
        client.remove_liquidity(&fixture.lp, &fixture.asset_a, &fixture.asset_b, &10_000);

    assert_eq!(returned_a, 5_000);
    assert_eq!(returned_b, 20_000);
    assert_eq!(token_a.balance(&fixture.lp), INITIAL_MINT - 5_000);
    assert_eq!(token_b.balance(&fixture.lp), INITIAL_MINT - 20_000);
    assert_eq!(
        client.get_liquidity(&fixture.lp, &fixture.asset_a, &fixture.asset_b),
        10_000
    );
}

#[test]
fn test_quote_accuracy_and_atomic_swap() {
    let (env, fixture) = setup();
    let client = client(&env, &fixture);
    client.initialize(&fixture.admin);

    // Add liquidity: 10,000 asset_a and 10,000 asset_b
    client.add_liquidity(
        &fixture.lp,
        &fixture.asset_a,
        &10_000,
        &fixture.asset_b,
        &10_000,
    );

    // Swap 1,000 asset_a for asset_b
    // Quote calculation: (1,000 * 10,000) / (10,000 + 1,000) = 10,000,000 / 11,000 = 909
    let expected_quote = client.get_quote(&fixture.asset_a, &1_000, &fixture.asset_b);
    assert_eq!(expected_quote, 909);

    let token_a = TokenClient::new(&env, &fixture.asset_a);
    let token_b = TokenClient::new(&env, &fixture.asset_b);

    let user_a_before = token_a.balance(&fixture.user);
    let user_b_before = token_b.balance(&fixture.user);

    // Execute swap with min_amount_out = 900 (less than 909)
    let amount_out = client.swap(
        &fixture.user,
        &fixture.asset_a,
        &1_000,
        &fixture.asset_b,
        &900,
    );

    assert_eq!(amount_out, 909);
    assert_eq!(token_a.balance(&fixture.user), user_a_before - 1_000);
    assert_eq!(token_b.balance(&fixture.user), user_b_before + 909);

    let pool = client.get_pool(&fixture.asset_a, &fixture.asset_b);
    if fixture.asset_a < fixture.asset_b {
        assert_eq!(pool.reserve_a, 11_000);
        assert_eq!(pool.reserve_b, 10_000 - 909);
    } else {
        assert_eq!(pool.reserve_b, 11_000);
        assert_eq!(pool.reserve_a, 10_000 - 909);
    }
}

#[test]
fn test_slippage_protection_reverts_when_min_amount_out_exceeded() {
    let (env, fixture) = setup();
    let client = client(&env, &fixture);
    client.initialize(&fixture.admin);

    client.add_liquidity(
        &fixture.lp,
        &fixture.asset_a,
        &10_000,
        &fixture.asset_b,
        &10_000,
    );

    // Swap quote is 909. If min_amount_out is set to 950, swap MUST fail.
    let res = client.try_swap(
        &fixture.user,
        &fixture.asset_a,
        &1_000,
        &fixture.asset_b,
        &950,
    );

    assert_eq!(res, Err(Ok(Error::SlippageExceeded)));

    // User balances must be untouched
    let token_a = TokenClient::new(&env, &fixture.asset_a);
    let token_b = TokenClient::new(&env, &fixture.asset_b);
    assert_eq!(token_a.balance(&fixture.user), INITIAL_MINT);
    assert_eq!(token_b.balance(&fixture.user), INITIAL_MINT);
}

#[test]
fn test_identical_assets_rejected() {
    let (env, fixture) = setup();
    let client = client(&env, &fixture);
    client.initialize(&fixture.admin);

    assert_eq!(
        client.try_add_liquidity(&fixture.lp, &fixture.asset_a, &100, &fixture.asset_a, &100),
        Err(Ok(Error::IdenticalAssets))
    );
}
