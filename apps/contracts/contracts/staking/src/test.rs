use crate::{Error, RewardConfig, StakingContract, StakingContractClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal,
};
/// Deploy a Stellar Asset Contract token for use as either the staked
/// `asset` or the `reward_asset` in tests. Returns the token's address plus
/// ready-made clients for transfers/balances and minting.
fn create_token<'a>(
    env: &Env,
    admin: &Address,
) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let address = sac.address();
    (
        address.clone(),
        TokenClient::new(env, &address),
        StellarAssetClient::new(env, &address),
    )
}

fn setup() -> (Env, StakingContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

/// Assert that `env.events().all()` (which only surfaces events from the
/// most recently completed contract invocation) is exactly one event,
/// published by the staking contract, with the given topics and data.
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
    // Filter to just our own contract's events: a `stake`/`unstake`/
    // `claim_rewards` call internally invokes the token contract's own
    // `transfer`, which publishes its own event under the token's
    // contract id — we only want to assert our own event here.
    let ours = env.events().all().filter_by_contract(contract_id);
    assert_eq!(ours, expected);
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
    let contract_id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    // No mock_all_auths(): the admin's own authorization must be enforced.
    let result = client.try_initialize(&admin);
    assert!(result.is_err());
}

#[test]
fn set_reward_config_rejects_non_admin_caller() {
    let (env, client, _admin) = setup();
    let intruder = Address::generate(&env);
    let asset = Address::generate(&env);
    let reward_asset = Address::generate(&env);
    let result = client.try_set_reward_config(&intruder, &asset, &reward_asset, &1i128, &0u64);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn set_reward_config_requires_admin_auth_even_for_real_admin() {
    let env = Env::default();
    let contract_id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);

    let asset = Address::generate(&env);
    let reward_asset = Address::generate(&env);
    env.set_auths(&[]);
    let result = client.try_set_reward_config(&admin, &asset, &reward_asset, &1i128, &0u64);
    assert!(result.is_err());
}

#[test]
fn set_reward_config_rejects_negative_rate() {
    let (env, client, admin) = setup();
    let asset = Address::generate(&env);
    let reward_asset = Address::generate(&env);
    let result = client.try_set_reward_config(&admin, &asset, &reward_asset, &-1i128, &0u64);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn set_reward_config_emits_full_event_payload() {
    let (env, client, admin) = setup();
    let asset = Address::generate(&env);
    let reward_asset = Address::generate(&env);

    client.set_reward_config(&admin, &asset, &reward_asset, &3i128, &500u64);

    assert_last_event(
        &env,
        &client.address,
        (
            symbol_short!("staking"),
            symbol_short!("cfg_set"),
            asset.clone(),
        ),
        (reward_asset, 3i128, 500u64),
    );
}

#[test]
fn set_reward_config_rejects_changing_reward_asset() {
    let (env, client, admin) = setup();
    let asset = Address::generate(&env);
    let reward_asset_a = Address::generate(&env);
    let reward_asset_b = Address::generate(&env);
    client.set_reward_config(&admin, &asset, &reward_asset_a, &2i128, &0u64);

    let result = client.try_set_reward_config(&admin, &asset, &reward_asset_b, &2i128, &0u64);
    assert_eq!(result, Err(Ok(Error::RewardAssetImmutable)));
}

#[test]
fn set_reward_config_allows_reconfiguring_with_same_reward_asset() {
    let (env, client, admin) = setup();
    let asset = Address::generate(&env);
    let reward_asset = Address::generate(&env);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &0u64);

    client.set_reward_config(&admin, &asset, &reward_asset, &7i128, &100u64);

    let config = client.get_reward_config(&asset).unwrap();
    assert_eq!(config.reward_rate, 7);
    assert_eq!(config.min_stake_duration, 100);
}

#[test]
fn set_reward_rate_fails_without_existing_config() {
    let (env, client, admin) = setup();
    let asset = Address::generate(&env);
    let result = client.try_set_reward_rate(&admin, &asset, &5i128);
    assert_eq!(result, Err(Ok(Error::RewardConfigNotSet)));
}

#[test]
fn set_reward_rate_rejects_non_admin_caller() {
    let (env, client, admin) = setup();
    let asset = Address::generate(&env);
    let reward_asset = Address::generate(&env);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &0u64);

    let intruder = Address::generate(&env);
    let result = client.try_set_reward_rate(&intruder, &asset, &9i128);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn set_reward_rate_updates_stored_config() {
    let (env, client, admin) = setup();
    let asset = Address::generate(&env);
    let reward_asset = Address::generate(&env);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &0u64);

    client.set_reward_rate(&admin, &asset, &9i128);

    let config = client.get_reward_config(&asset).unwrap();
    assert_eq!(
        config,
        RewardConfig {
            asset,
            reward_asset,
            reward_rate: 9,
            min_stake_duration: 0,
        }
    );
}

#[test]
fn set_reward_rate_emits_event_payload() {
    let (env, client, admin) = setup();
    let asset = Address::generate(&env);
    let reward_asset = Address::generate(&env);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &0u64);

    client.set_reward_rate(&admin, &asset, &9i128);

    assert_last_event(
        &env,
        &client.address,
        (symbol_short!("staking"), symbol_short!("rate_set"), asset),
        9i128,
    );
}

#[test]
fn stake_fails_without_reward_config() {
    let (env, client, _admin) = setup();
    let staker = Address::generate(&env);
    let asset = Address::generate(&env);
    let result = client.try_stake(&staker, &asset, &100i128, &0u64);
    assert_eq!(result, Err(Ok(Error::RewardConfigNotSet)));
}

#[test]
fn stake_rejects_lock_duration_below_minimum() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _asset_token, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &1i128, &1_000u64);
    asset_mint.mint(&staker, &500i128);

    let result = client.try_stake(&staker, &asset, &100i128, &500u64);
    assert_eq!(result, Err(Ok(Error::LockDurationTooShort)));
}

#[test]
fn stake_transfers_principal_and_creates_position() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, asset_token, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &100u64);
    asset_mint.mint(&staker, &1_000i128);

    client.stake(&staker, &asset, &400i128, &200u64);

    assert_eq!(asset_token.balance(&staker), 600);
    assert_eq!(asset_token.balance(&client.address), 400);

    let pos = client.get_position(&staker, &asset);
    assert_eq!(pos.amount, 400);
    assert_eq!(pos.reward_rate, 2);
    assert_eq!(pos.rewards_claimed, 0);
    assert_eq!(pos.pending_rewards, 0);
    assert_eq!(pos.lock_until, pos.staked_at + 200);
}

#[test]
fn stake_emits_event_payload() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);

    client.stake(&staker, &asset, &400i128, &50u64);

    // Capture the expected lock_until independently, without an extra
    // contract call between stake() and the event assertion (any further
    // call would clear the "most recent invocation" event buffer).
    let expected_lock_until = env.ledger().timestamp() + 50;
    assert_last_event(
        &env,
        &client.address,
        (
            symbol_short!("staking"),
            symbol_short!("stake"),
            staker,
            asset,
        ),
        (400i128, expected_lock_until),
    );
}

#[test]
fn stake_requires_staker_auth() {
    let env = Env::default();
    let contract_id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &1i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);

    env.set_auths(&[]);
    let result = client.try_stake(&staker, &asset, &100i128, &0u64);
    assert!(result.is_err());
}

#[test]
fn get_position_errors_when_never_staked() {
    let (env, client, _admin) = setup();
    let staker = Address::generate(&env);
    let asset = Address::generate(&env);
    let result = client.try_get_position(&staker, &asset);
    assert_eq!(result, Err(Ok(Error::PositionNotFound)));
}

#[test]
fn calculate_rewards_is_zero_when_never_staked() {
    let (env, client, _admin) = setup();
    let staker = Address::generate(&env);
    let asset = Address::generate(&env);
    assert_eq!(client.calculate_rewards(&staker, &asset), 0);
}

#[test]
fn calculate_rewards_accrues_over_time() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);

    client.stake(&staker, &asset, &100i128, &0u64);

    env.ledger().with_mut(|li| li.timestamp += 10);
    assert_eq!(client.calculate_rewards(&staker, &asset), 2 * 100 * 10);
}

#[test]
fn claim_rewards_pays_out_and_resets_pending() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, reward_token, reward_mint) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);
    reward_mint.mint(&client.address, &10_000i128);
    client.stake(&staker, &asset, &100i128, &0u64);
    env.ledger().with_mut(|li| li.timestamp += 10);
    let claimed = client.claim_rewards(&staker, &asset);
    assert_eq!(claimed, 2000);
    assert_last_event(
        &env,
        &client.address,
        (
            symbol_short!("staking"),
            symbol_short!("claim"),
            staker.clone(),
            asset.clone(),
        ),
        2000i128,
    );
    assert_eq!(reward_token.balance(&staker), 2000);
    let pos = client.get_position(&staker, &asset);
    assert_eq!(pos.pending_rewards, 0);
    assert_eq!(pos.rewards_claimed, 2000);
    assert_eq!(client.calculate_rewards(&staker, &asset), 0);
}

#[test]
fn claim_rewards_is_zero_immediately_after_staking() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, reward_mint) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);
    reward_mint.mint(&client.address, &10_000i128);

    client.stake(&staker, &asset, &100i128, &0u64);
    let claimed = client.claim_rewards(&staker, &asset);
    assert_eq!(claimed, 0);
}

#[test]
fn claim_rewards_requires_staker_auth() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, reward_mint) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);
    reward_mint.mint(&client.address, &10_000i128);
    client.stake(&staker, &asset, &100i128, &0u64);

    env.set_auths(&[]);
    let result = client.try_claim_rewards(&staker, &asset);
    assert!(result.is_err());
}

#[test]
fn unstake_rejects_before_lock_expires() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &1i128, &500u64);
    asset_mint.mint(&staker, &1_000i128);

    client.stake(&staker, &asset, &100i128, &500u64);

    let result = client.try_unstake(&staker, &asset, &50i128);
    assert_eq!(result, Err(Ok(Error::StillLocked)));
}

#[test]
fn unstake_after_lock_returns_principal() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, asset_token, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &1i128, &100u64);
    asset_mint.mint(&staker, &1_000i128);

    client.stake(&staker, &asset, &400i128, &100u64);
    env.ledger().with_mut(|li| li.timestamp += 100);

    client.unstake(&staker, &asset, &400i128);

    // Assert the event immediately after unstake(), before any other
    // contract call clears the "most recent invocation" event buffer.
    assert_last_event(
        &env,
        &client.address,
        (
            symbol_short!("staking"),
            symbol_short!("unstake"),
            staker.clone(),
            asset.clone(),
        ),
        400i128,
    );

    assert_eq!(asset_token.balance(&staker), 1_000);
    assert_eq!(asset_token.balance(&client.address), 0);

    let pos = client.get_position(&staker, &asset);
    assert_eq!(pos.amount, 0);
}

#[test]
fn unstake_rejects_amount_exceeding_stake() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &1i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);

    client.stake(&staker, &asset, &100i128, &0u64);

    let result = client.try_unstake(&staker, &asset, &200i128);
    assert_eq!(result, Err(Ok(Error::InsufficientStake)));
}

#[test]
fn unstake_requires_staker_auth() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &1i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);
    client.stake(&staker, &asset, &100i128, &0u64);

    env.set_auths(&[]);
    let result = client.try_unstake(&staker, &asset, &50i128);
    assert!(result.is_err());
}

#[test]
fn unstake_settles_pending_rewards_before_reducing_amount() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, reward_token, reward_mint) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);
    reward_mint.mint(&client.address, &10_000i128);

    client.stake(&staker, &asset, &100i128, &0u64);
    env.ledger().with_mut(|li| li.timestamp += 10);
    client.unstake(&staker, &asset, &50i128);

    let claimed = client.claim_rewards(&staker, &asset);
    assert_eq!(claimed, 2000);

    // Assert the event immediately after claim_rewards(), before any other
    // contract call clears the "most recent invocation" event buffer.
    assert_last_event(
        &env,
        &client.address,
        (
            symbol_short!("staking"),
            symbol_short!("claim"),
            staker.clone(),
            asset.clone(),
        ),
        2000i128,
    );

    assert_eq!(reward_token.balance(&staker), 2000);

    let _pos = client.get_position(&staker, &asset);
}

#[test]
fn stake_topup_extends_lock_but_never_shortens_it() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &1i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);

    client.stake(&staker, &asset, &100i128, &1_000u64);
    let first_lock_until = client.get_position(&staker, &asset).lock_until;

    client.stake(&staker, &asset, &50i128, &10u64);
    let pos = client.get_position(&staker, &asset);
    assert_eq!(pos.lock_until, first_lock_until);
    assert_eq!(pos.amount, 150);
}

#[test]
fn stake_topup_with_longer_duration_extends_lock() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &1i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);

    client.stake(&staker, &asset, &100i128, &100u64);
    let first_lock_until = client.get_position(&staker, &asset).lock_until;

    client.stake(&staker, &asset, &50i128, &1_000u64);
    let pos = client.get_position(&staker, &asset);
    assert!(pos.lock_until > first_lock_until);
}

/// Top-up must settle prior accrual into `pending_rewards` rather than
/// discarding it when `amount` changes.
#[test]
fn stake_topup_settles_prior_accrual_into_pending_rewards() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);

    client.stake(&staker, &asset, &100i128, &0u64);
    env.ledger().with_mut(|li| li.timestamp += 10);
    client.stake(&staker, &asset, &50i128, &0u64);

    let pos = client.get_position(&staker, &asset);
    assert_eq!(pos.pending_rewards, 2000);
    assert_eq!(pos.amount, 150);
}

/// Top-up must NOT reprice already-staked principal to whatever the
/// current config rate is — the position keeps its original snapshot
/// rate even across a top-up.
#[test]
fn stake_topup_after_rate_change_keeps_original_rate() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);

    client.stake(&staker, &asset, &100i128, &0u64);
    client.set_reward_rate(&admin, &asset, &50i128);
    client.stake(&staker, &asset, &50i128, &0u64);

    let pos = client.get_position(&staker, &asset);
    assert_eq!(pos.reward_rate, 2);
    assert_eq!(pos.amount, 150);
}

/// The acceptance-criteria test: an admin's `set_reward_rate` call must
/// only affect *future* stakes, never an already-open position.
#[test]
fn reward_rate_change_does_not_affect_open_position() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &2i128, &0u64);
    asset_mint.mint(&staker, &1_000i128);

    client.stake(&staker, &asset, &100i128, &0u64);
    let pos_before = client.get_position(&staker, &asset);
    assert_eq!(pos_before.reward_rate, 2);

    client.set_reward_rate(&admin, &asset, &10i128);

    let pos_after = client.get_position(&staker, &asset);
    assert_eq!(pos_after.reward_rate, 2);

    env.ledger().with_mut(|li| li.timestamp += 10);
    assert_eq!(client.calculate_rewards(&staker, &asset), 2 * 100 * 10);

    let staker2 = Address::generate(&env);
    asset_mint.mint(&staker2, &1_000i128);
    client.stake(&staker2, &asset, &100i128, &0u64);
    let pos2 = client.get_position(&staker2, &asset);
    assert_eq!(pos2.reward_rate, 10);
}

#[test]
fn calculate_rewards_errors_on_overflow() {
    let (env, client, admin) = setup();
    let staker = Address::generate(&env);
    let (asset, _at, asset_mint) = create_token(&env, &admin);
    let (reward_asset, _rt, _ram) = create_token(&env, &admin);
    client.set_reward_config(&admin, &asset, &reward_asset, &(i128::MAX / 10), &0u64);
    asset_mint.mint(&staker, &1_000i128);

    client.stake(&staker, &asset, &100i128, &0u64);
    env.ledger().with_mut(|li| li.timestamp += 1_000);

    let result = client.try_calculate_rewards(&staker, &asset);
    assert_eq!(result, Err(Ok(Error::Overflow)));
}
