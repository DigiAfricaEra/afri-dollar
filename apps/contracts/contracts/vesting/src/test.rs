use crate::{Error, Milestone, VestingContract, VestingContractClient, VestingType};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal,
};

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

fn setup() -> (Env, VestingContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(VestingContract, ());
    let client = VestingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

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

/// Helper to create a standard linear vesting schedule (1000 tokens,
/// 100–200 seconds, cliff at 100).
fn create_linear_vesting(
    env: &Env,
    client: &VestingContractClient,
    creator: &Address,
    beneficiary: &Address,
    asset: &Address,
) -> u64 {
    client.create_vesting(
        creator,
        beneficiary,
        asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Linear,
        &soroban_sdk::vec![env],
    )
}

// ---------------------------------------------------------------------------
// initialize
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
    let contract_id = env.register(VestingContract, ());
    let client = VestingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let result = client.try_initialize(&admin);
    assert!(result.is_err());
}

#[test]
fn create_vesting_before_initialize_fails() {
    let env = Env::default();
    let contract_id = env.register(VestingContract, ());
    let client = VestingContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let asset = Address::generate(&env);
    env.mock_all_auths();

    let result = client.try_create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Linear,
        &soroban_sdk::vec![&env],
    );
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

// ---------------------------------------------------------------------------
// pause / unpause
// ---------------------------------------------------------------------------

#[test]
fn pause_blocks_create_vesting() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    client.pause(&admin);

    let result = client.try_create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Linear,
        &soroban_sdk::vec![&env],
    );
    assert_eq!(result, Err(Ok(Error::ContractPaused)));
}

#[test]
fn pause_blocks_claim_vested() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);
    env.ledger().with_mut(|li| li.timestamp += 150);

    client.pause(&admin);

    let result = client.try_claim_vested(&id, &beneficiary);
    assert_eq!(result, Err(Ok(Error::ContractPaused)));
}

#[test]
fn pause_blocks_revoke_vesting() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    client.pause(&admin);

    let result = client.try_revoke_vesting(&id, &creator);
    assert_eq!(result, Err(Ok(Error::ContractPaused)));
}

#[test]
fn unpause_re_enables_operations() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    client.pause(&admin);
    client.unpause(&admin);

    let id = client.create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Linear,
        &soroban_sdk::vec![&env],
    );
    assert_eq!(id, 0);
}

#[test]
fn pause_requires_admin_auth() {
    let (env, client, admin) = setup();
    // Correct admin but no auth — exercises require_auth, not identity check.
    env.set_auths(&[]);
    let result = client.try_pause(&admin);
    assert!(result.is_err());
}

#[test]
fn pause_rejects_wrong_admin() {
    let (env, client, _admin) = setup();
    let intruder = Address::generate(&env);
    env.set_auths(&[]);
    let result = client.try_pause(&intruder);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn unpause_requires_admin_auth() {
    let (env, client, admin) = setup();
    client.pause(&admin);
    // Correct admin but no auth — exercises require_auth, not identity check.
    env.set_auths(&[]);
    let result = client.try_unpause(&admin);
    assert!(result.is_err());
}

#[test]
fn unpause_rejects_wrong_admin() {
    let (env, client, admin) = setup();
    client.pause(&admin);
    let intruder = Address::generate(&env);
    env.set_auths(&[]);
    let result = client.try_unpause(&intruder);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn pause_emits_event() {
    let (env, client, admin) = setup();
    client.pause(&admin);
    assert_last_event(
        &env,
        &client.address,
        (symbol_short!("vesting"), symbol_short!("paused")),
        admin.clone(),
    );
}

#[test]
fn unpause_emits_event() {
    let (env, client, admin) = setup();
    client.pause(&admin);
    client.unpause(&admin);
    assert_last_event(
        &env,
        &client.address,
        (symbol_short!("vesting"), symbol_short!("unpaused")),
        admin,
    );
}

// ---------------------------------------------------------------------------
// create_vesting
// ---------------------------------------------------------------------------

#[test]
fn create_vesting_escrows_tokens_in_contract() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    assert_eq!(token.balance(&creator), 0);
    assert_eq!(token.balance(&client.address), 1_000);
    assert_eq!(id, 0);
}

#[test]
fn create_vesting_rejects_zero_amount() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, _mint) = create_token(&env, &admin);

    let result = client.try_create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &0i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Linear,
        &soroban_sdk::vec![&env],
    );
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn create_vesting_rejects_negative_amount() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, _mint) = create_token(&env, &admin);

    let result = client.try_create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &-100i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Linear,
        &soroban_sdk::vec![&env],
    );
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn create_vesting_rejects_cliff_after_end() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, _mint) = create_token(&env, &admin);

    let result = client.try_create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &250u64, // cliff after end
        &200u64,
        &VestingType::Linear,
        &soroban_sdk::vec![&env],
    );
    assert_eq!(result, Err(Ok(Error::InvalidSchedule)));
}

#[test]
fn create_vesting_rejects_start_after_end() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, _mint) = create_token(&env, &admin);

    let result = client.try_create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &200u64,
        &200u64,
        &100u64,
        &VestingType::Linear,
        &soroban_sdk::vec![&env],
    );
    assert_eq!(result, Err(Ok(Error::InvalidSchedule)));
}

#[test]
fn create_vesting_linear_stores_correct_fields() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    let schedule = client.get_vesting(&id);
    assert_eq!(schedule.issuer, creator);
    assert_eq!(schedule.beneficiary, beneficiary);
    assert_eq!(schedule.asset, asset);
    assert_eq!(schedule.total_amount, 1_000);
    assert_eq!(schedule.claimed_amount, 0);
    assert_eq!(schedule.start_time, 100);
    assert_eq!(schedule.cliff_time, 100);
    assert_eq!(schedule.end_time, 200);
    assert_eq!(schedule.vesting_type, VestingType::Linear);
    assert!(!schedule.revoked);
}

#[test]
fn create_vesting_milestone_stores_milestones() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let milestones = vec![
        &env,
        Milestone {
            timestamp: 150,
            percentage: 50,
        },
        Milestone {
            timestamp: 200,
            percentage: 50,
        },
    ];

    let id = client.create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Milestone,
        &milestones,
    );

    let schedule = client.get_vesting(&id);
    assert_eq!(schedule.vesting_type, VestingType::Milestone);
}

#[test]
fn create_vesting_milestone_rejects_empty_milestones() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let result = client.try_create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Milestone,
        &soroban_sdk::vec![&env],
    );
    assert_eq!(result, Err(Ok(Error::NoMilestones)));
}

#[test]
fn create_vesting_milestone_rejects_percentage_over_100() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let milestones = vec![
        &env,
        Milestone {
            timestamp: 150,
            percentage: 60,
        },
        Milestone {
            timestamp: 200,
            percentage: 50,
        },
    ];

    let result = client.try_create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Milestone,
        &milestones,
    );
    assert_eq!(result, Err(Ok(Error::MilestonePercentageExceeded)));
}

#[test]
fn create_vesting_milestone_rejects_percentage_not_100() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let milestones = vec![
        &env,
        Milestone {
            timestamp: 150,
            percentage: 30,
        },
        Milestone {
            timestamp: 200,
            percentage: 30,
        },
    ];

    let result = client.try_create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Milestone,
        &milestones,
    );
    assert_eq!(result, Err(Ok(Error::MilestonePercentageExceeded)));
}

#[test]
fn create_vesting_milestone_rejects_timestamp_out_of_range() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    // Milestone timestamp before start_time (100)
    let milestones = vec![
        &env,
        Milestone {
            timestamp: 50,
            percentage: 50,
        },
        Milestone {
            timestamp: 200,
            percentage: 50,
        },
    ];

    let result = client.try_create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Milestone,
        &milestones,
    );
    assert_eq!(result, Err(Ok(Error::InvalidSchedule)));
}

#[test]
fn create_vesting_requires_creator_auth() {
    let env = Env::default();
    let contract_id = env.register(VestingContract, ());
    let client = VestingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, _mint) = create_token(&env, &admin);

    env.set_auths(&[]);
    let result = client.try_create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Linear,
        &soroban_sdk::vec![&env],
    );
    assert!(result.is_err());
}

#[test]
fn create_vesting_emits_event() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    client.create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Linear,
        &soroban_sdk::vec![&env],
    );

    assert_last_event(
        &env,
        &client.address,
        (
            symbol_short!("vesting"),
            symbol_short!("created"),
            0u64,
            beneficiary.clone(),
        ),
        (creator, asset, 1_000i128),
    );
}

#[test]
fn create_vesting_increments_ids() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &3_000i128);

    let id1 = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);
    let id2 = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);
    assert_eq!(id1, 0);
    assert_eq!(id2, 1);
}

// ---------------------------------------------------------------------------
// claim_vested — Linear
// ---------------------------------------------------------------------------

#[test]
fn claim_before_cliff_returns_zero() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    // At timestamp 50 (before cliff of 100)
    env.ledger().with_mut(|li| li.timestamp += 50);

    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 0);
}

#[test]
fn claim_at_cliff_proportional() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    // At timestamp 150 (midpoint of 100–200, so 50% vested)
    env.ledger().with_mut(|li| li.timestamp += 150);

    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 500);
}

#[test]
fn claim_after_end_full_amount() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    // At timestamp 250 (after end of 200)
    env.ledger().with_mut(|li| li.timestamp += 250);

    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 1_000);
    assert_eq!(token.balance(&beneficiary), 1_000);
    assert_eq!(token.balance(&client.address), 0);
}

#[test]
fn claim_already_fully_claimed_returns_zero() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    env.ledger().with_mut(|li| li.timestamp += 250);

    client.claim_vested(&id, &beneficiary);
    let second_claim = client.claim_vested(&id, &beneficiary);
    assert_eq!(second_claim, 0);
}

#[test]
fn claim_updates_claimed_amount() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    env.ledger().with_mut(|li| li.timestamp += 150);
    client.claim_vested(&id, &beneficiary);

    let schedule = client.get_vesting(&id);
    assert_eq!(schedule.claimed_amount, 500);

    // Advance to end, claim remainder
    env.ledger().with_mut(|li| li.timestamp += 100);
    let second_claim = client.claim_vested(&id, &beneficiary);
    assert_eq!(second_claim, 500);

    let schedule = client.get_vesting(&id);
    assert_eq!(schedule.claimed_amount, 1_000);
}

#[test]
fn claim_requires_beneficiary_auth() {
    let env = Env::default();
    let contract_id = env.register(VestingContract, ());
    let client = VestingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);
    env.ledger().with_mut(|li| li.timestamp += 150);

    env.set_auths(&[]);
    let result = client.try_claim_vested(&id, &beneficiary);
    assert!(result.is_err());
}

#[test]
fn claim_wrong_beneficiary_rejected() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let wrong = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);
    env.ledger().with_mut(|li| li.timestamp += 150);

    let result = client.try_claim_vested(&id, &wrong);
    assert_eq!(result, Err(Ok(Error::UnauthorizedBeneficiary)));
}

#[test]
fn claim_emits_event() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);
    env.ledger().with_mut(|li| li.timestamp += 150);

    client.claim_vested(&id, &beneficiary);

    assert_last_event(
        &env,
        &client.address,
        (
            symbol_short!("vesting"),
            symbol_short!("claimed"),
            id,
            beneficiary,
        ),
        500i128,
    );
}

#[test]
fn claim_at_start_before_cliff_returns_zero() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    // No time advance — at timestamp 0, before start_time 100
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 0);
}

// ---------------------------------------------------------------------------
// claim_vested — Immediate
// ---------------------------------------------------------------------------

#[test]
fn claim_immediate_after_start_full_amount() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = client.create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Immediate,
        &soroban_sdk::vec![&env],
    );

    // At timestamp 100 (at start_time)
    env.ledger().with_mut(|li| li.timestamp += 100);

    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 1_000);
    assert_eq!(token.balance(&beneficiary), 1_000);
}

#[test]
fn claim_immediate_before_start_returns_zero() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = client.create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Immediate,
        &soroban_sdk::vec![&env],
    );

    // At timestamp 50 (before start_time of 100)
    env.ledger().with_mut(|li| li.timestamp += 50);

    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 0);
}

#[test]
fn immediate_vesting_ignores_cliff_time() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    // cliff_time (150) > start_time (100) — Immediate should ignore cliff.
    let id = client.create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &150u64,
        &200u64,
        &VestingType::Immediate,
        &soroban_sdk::vec![&env],
    );

    // At timestamp 100 (start_time) — before cliff (150), but Immediate
    // should vest fully.
    env.ledger().with_mut(|li| li.timestamp += 100);

    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 1_000);
    assert_eq!(token.balance(&beneficiary), 1_000);
}

// ---------------------------------------------------------------------------
// claim_vested — Milestone
// ---------------------------------------------------------------------------

#[test]
fn claim_milestone_before_first_returns_zero() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let milestones = vec![
        &env,
        Milestone {
            timestamp: 150,
            percentage: 50,
        },
        Milestone {
            timestamp: 200,
            percentage: 50,
        },
    ];

    let id = client.create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Milestone,
        &milestones,
    );

    // At timestamp 125 (after cliff but before first milestone)
    env.ledger().with_mut(|li| li.timestamp += 125);

    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 0);
}

#[test]
fn claim_milestone_after_single() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let milestones = vec![
        &env,
        Milestone {
            timestamp: 150,
            percentage: 50,
        },
        Milestone {
            timestamp: 200,
            percentage: 50,
        },
    ];

    let id = client.create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Milestone,
        &milestones,
    );

    // At timestamp 150 (first milestone hits)
    env.ledger().with_mut(|li| li.timestamp += 150);

    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 500);
    assert_eq!(token.balance(&beneficiary), 500);
}

#[test]
fn claim_milestone_after_multiple_cumulative() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let milestones = vec![
        &env,
        Milestone {
            timestamp: 150,
            percentage: 30,
        },
        Milestone {
            timestamp: 175,
            percentage: 30,
        },
        Milestone {
            timestamp: 200,
            percentage: 40,
        },
    ];

    let id = client.create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Milestone,
        &milestones,
    );

    // After first milestone (30%)
    env.ledger().with_mut(|li| li.timestamp += 150);
    let claimed1 = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed1, 300);

    // After second milestone (30% more = 60% cumulative)
    env.ledger().with_mut(|li| li.timestamp += 25);
    let claimed2 = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed2, 300);

    // After third milestone (40% more = 100% cumulative)
    env.ledger().with_mut(|li| li.timestamp += 25);
    let claimed3 = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed3, 400);

    assert_eq!(token.balance(&beneficiary), 1_000);
}

// ---------------------------------------------------------------------------
// revoke_vesting
// ---------------------------------------------------------------------------

#[test]
fn revoke_returns_unvested_to_issuer() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    // At midpoint: 50% vested, 50% unvested
    env.ledger().with_mut(|li| li.timestamp += 150);

    client.revoke_vesting(&id, &creator);

    // Issuer gets 500 (unvested)
    assert_eq!(token.balance(&creator), 500);
    // Contract still holds 500 (vested, for beneficiary to claim)
    assert_eq!(token.balance(&client.address), 500);
}

#[test]
fn revoke_after_full_vest_returns_zero_to_issuer() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    // After end: 100% vested, 0% unvested
    env.ledger().with_mut(|li| li.timestamp += 250);

    client.revoke_vesting(&id, &creator);

    assert_eq!(token.balance(&creator), 0);
    assert_eq!(token.balance(&client.address), 1_000);
}

#[test]
fn revoke_requires_issuer_auth() {
    let env = Env::default();
    let contract_id = env.register(VestingContract, ());
    let client = VestingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    env.set_auths(&[]);
    let result = client.try_revoke_vesting(&id, &creator);
    assert!(result.is_err());
}

#[test]
fn revoke_wrong_issuer_rejected() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let wrong = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);
    env.ledger().with_mut(|li| li.timestamp += 150);

    let result = client.try_revoke_vesting(&id, &wrong);
    assert_eq!(result, Err(Ok(Error::UnauthorizedIssuer)));
}

#[test]
fn revoke_already_revoked_rejected() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);
    env.ledger().with_mut(|li| li.timestamp += 150);

    client.revoke_vesting(&id, &creator);
    let result = client.try_revoke_vesting(&id, &creator);
    assert_eq!(result, Err(Ok(Error::AlreadyRevoked)));
}

#[test]
fn revoke_emits_event() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);
    env.ledger().with_mut(|li| li.timestamp += 150);

    client.revoke_vesting(&id, &creator);

    assert_last_event(
        &env,
        &client.address,
        (symbol_short!("vesting"), symbol_short!("revoked"), id),
        500i128,
    );
}

#[test]
fn beneficiary_cannot_claim_after_revoke() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);
    env.ledger().with_mut(|li| li.timestamp += 150);

    client.revoke_vesting(&id, &creator);

    // Beneficiary tries to claim — nothing was claimed before, and
    // after revocation claimable = frozen_total - claimed = 500 - 0 = 500
    // This is the vested-but-unclaimed amount — beneficiary CAN still claim.
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 500);
}

// ---------------------------------------------------------------------------
// claim after revoke (vested-but-unclaimed remains claimable)
// ---------------------------------------------------------------------------

#[test]
fn claim_after_revoke_returns_vested_unclaimed() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    // Partial vest: 70% vested
    env.ledger().with_mut(|li| li.timestamp += 170);

    // Revoke: unvested (300) goes to issuer, frozen_total = 700
    client.revoke_vesting(&id, &creator);
    assert_eq!(token.balance(&creator), 300);

    // Beneficiary claims the 700 vested-but-unclaimed
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 700);
    assert_eq!(token.balance(&beneficiary), 700);
    assert_eq!(token.balance(&client.address), 0);
}

#[test]
fn revoke_then_claim_then_status_shows_zero() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    env.ledger().with_mut(|li| li.timestamp += 150);

    client.revoke_vesting(&id, &creator);
    client.claim_vested(&id, &beneficiary);

    let status = client.get_vesting_status(&id);
    assert_eq!(status.total_vested, 500);
    assert_eq!(status.total_claimed, 500);
    assert_eq!(status.claimable, 0);
    assert_eq!(status.remaining, 0);
}

#[test]
fn revoke_at_full_vest_leaves_zero_for_beneficiary() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    // Full vest
    env.ledger().with_mut(|li| li.timestamp += 250);

    client.revoke_vesting(&id, &creator);

    // frozen_total = 1000, claimed = 0, so beneficiary can still claim 1000
    // Wait — unvested = total - vested = 1000 - 1000 = 0. Issuer gets 0.
    // frozen_total = 1000. Beneficiary claimable = 1000 - 0 = 1000.
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 1_000);
}

#[test]
fn revoke_before_cliff_returns_full_amount_to_issuer() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    // Before cliff: vested = 0, unvested = 1000
    env.ledger().with_mut(|li| li.timestamp += 50);

    client.revoke_vesting(&id, &creator);

    // Issuer gets all 1000
    assert_eq!(token.balance(&creator), 1_000);
    assert_eq!(token.balance(&client.address), 0);

    // frozen_total = 0, beneficiary claimable = 0
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 0);
}

#[test]
fn revoke_milestone_type_between_milestones_freezes_correctly() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let milestones = vec![
        &env,
        Milestone {
            timestamp: 130,
            percentage: 40,
        },
        Milestone {
            timestamp: 170,
            percentage: 30,
        },
        Milestone {
            timestamp: 200,
            percentage: 30,
        },
    ];

    let id = client.create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Milestone,
        &milestones,
    );

    // Between milestone 1 (130) and milestone 2 (170): 40% vested
    env.ledger().with_mut(|li| li.timestamp += 150);

    client.revoke_vesting(&id, &creator);

    // unvested = 1000 - 400 = 600 → issuer
    assert_eq!(token.balance(&creator), 600);
    // frozen_total = 400 → beneficiary can claim this
    assert_eq!(token.balance(&client.address), 400);

    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 400);
    assert_eq!(token.balance(&beneficiary), 400);
}

// ---------------------------------------------------------------------------
// transfer_ownership
// ---------------------------------------------------------------------------

#[test]
fn transfer_changes_beneficiary() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let new_beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    client.transfer_ownership(&id, &beneficiary, &new_beneficiary);

    let schedule = client.get_vesting(&id);
    assert_eq!(schedule.beneficiary, new_beneficiary);
}

#[test]
fn transfer_requires_beneficiary_auth() {
    let env = Env::default();
    let contract_id = env.register(VestingContract, ());
    let client = VestingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let new_beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    env.set_auths(&[]);
    let result = client.try_transfer_ownership(&id, &beneficiary, &new_beneficiary);
    assert!(result.is_err());
}

#[test]
fn transfer_wrong_address_rejected() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let wrong = Address::generate(&env);
    let new_beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    let result = client.try_transfer_ownership(&id, &wrong, &new_beneficiary);
    assert_eq!(result, Err(Ok(Error::UnauthorizedBeneficiary)));
}

#[test]
fn transferred_beneficiary_can_claim() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let new_beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);
    client.transfer_ownership(&id, &beneficiary, &new_beneficiary);

    env.ledger().with_mut(|li| li.timestamp += 250);

    let claimed = client.claim_vested(&id, &new_beneficiary);
    assert_eq!(claimed, 1_000);
    assert_eq!(token.balance(&new_beneficiary), 1_000);
}

#[test]
fn transfer_emits_event() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let new_beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    client.transfer_ownership(&id, &beneficiary, &new_beneficiary);

    assert_last_event(
        &env,
        &client.address,
        (symbol_short!("vesting"), symbol_short!("transfer"), id),
        (beneficiary, new_beneficiary),
    );
}

#[test]
fn transfer_then_revoke_still_works() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let new_beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    // Transfer ownership
    client.transfer_ownership(&id, &beneficiary, &new_beneficiary);

    // Advance past cliff
    env.ledger().with_mut(|li| li.timestamp += 150);

    // Issuer revokes — unvested goes to issuer, not to new_beneficiary
    client.revoke_vesting(&id, &creator);
    assert_eq!(token.balance(&creator), 500);

    // New beneficiary can claim the vested-but-unclaimed amount
    let claimed = client.claim_vested(&id, &new_beneficiary);
    assert_eq!(claimed, 500);
    assert_eq!(token.balance(&new_beneficiary), 500);
}

// ---------------------------------------------------------------------------
// get_vesting_status
// ---------------------------------------------------------------------------

#[test]
fn status_at_various_times_linear() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    // Before cliff
    env.ledger().with_mut(|li| li.timestamp += 50);
    let status = client.get_vesting_status(&id);
    assert_eq!(status.total_vested, 0);
    assert_eq!(status.claimable, 0);
    assert_eq!(status.remaining, 1_000);

    // At midpoint
    env.ledger().with_mut(|li| li.timestamp += 100);
    let status = client.get_vesting_status(&id);
    assert_eq!(status.total_vested, 500);
    assert_eq!(status.claimable, 500);
    assert_eq!(status.remaining, 500);

    // After end
    env.ledger().with_mut(|li| li.timestamp += 100);
    let status = client.get_vesting_status(&id);
    assert_eq!(status.total_vested, 1_000);
    assert_eq!(status.claimable, 1_000);
    assert_eq!(status.remaining, 0);
}

#[test]
fn status_reflects_claims() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    env.ledger().with_mut(|li| li.timestamp += 250);

    client.claim_vested(&id, &beneficiary);

    let status = client.get_vesting_status(&id);
    assert_eq!(status.total_vested, 1_000);
    assert_eq!(status.total_claimed, 1_000);
    assert_eq!(status.claimable, 0);
    assert_eq!(status.remaining, 0);
}

#[test]
fn status_after_revoke_shows_frozen_state() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    env.ledger().with_mut(|li| li.timestamp += 150);

    client.revoke_vesting(&id, &creator);

    let status = client.get_vesting_status(&id);
    assert_eq!(status.total_vested, 500);
    assert_eq!(status.total_claimed, 0);
    assert_eq!(status.claimable, 500);
    assert_eq!(status.remaining, 0);
}

// ---------------------------------------------------------------------------
// get_vesting
// ---------------------------------------------------------------------------

#[test]
fn get_vesting_returns_schedule() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);
    let schedule = client.get_vesting(&id);
    assert_eq!(schedule.id, id);
    assert_eq!(schedule.beneficiary, beneficiary);
}

#[test]
fn get_vesting_not_found() {
    let (_env, client, _admin) = setup();
    let result = client.try_get_vesting(&999);
    assert_eq!(result, Err(Ok(Error::VestingNotFound)));
}

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

#[test]
fn full_vesting_lifecycle_linear() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    // 1. Create vesting
    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);
    assert_eq!(token.balance(&creator), 0);
    assert_eq!(token.balance(&client.address), 1_000);

    // 2. Before cliff — nothing claimable
    env.ledger().with_mut(|li| li.timestamp += 50);
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 0);

    // 3. After cliff — partial claim (25%)
    env.ledger().with_mut(|li| li.timestamp += 75);
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 250);
    assert_eq!(token.balance(&beneficiary), 250);

    // 4. After end — claim remainder
    env.ledger().with_mut(|li| li.timestamp += 75);
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 750);
    assert_eq!(token.balance(&beneficiary), 1_000);
    assert_eq!(token.balance(&client.address), 0);

    // 5. Nothing left
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 0);

    // 6. Status shows fully claimed
    let status = client.get_vesting_status(&id);
    assert_eq!(status.total_vested, 1_000);
    assert_eq!(status.total_claimed, 1_000);
    assert_eq!(status.claimable, 0);
    assert_eq!(status.remaining, 0);
}

#[test]
fn full_vesting_lifecycle_milestone() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let milestones = vec![
        &env,
        Milestone {
            timestamp: 130,
            percentage: 25,
        },
        Milestone {
            timestamp: 160,
            percentage: 25,
        },
        Milestone {
            timestamp: 200,
            percentage: 50,
        },
    ];

    let id = client.create_vesting(
        &creator,
        &beneficiary,
        &asset,
        &1_000i128,
        &100u64,
        &100u64,
        &200u64,
        &VestingType::Milestone,
        &milestones,
    );

    // Before first milestone
    env.ledger().with_mut(|li| li.timestamp += 120);
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 0);

    // After first milestone (25%)
    env.ledger().with_mut(|li| li.timestamp += 10);
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 250);

    // After second milestone (25% more)
    env.ledger().with_mut(|li| li.timestamp += 30);
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 250);

    // After third milestone (50% more)
    env.ledger().with_mut(|li| li.timestamp += 40);
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 500);

    assert_eq!(token.balance(&beneficiary), 1_000);
    assert_eq!(token.balance(&client.address), 0);
}

#[test]
fn full_vesting_lifecycle_with_revoke() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&creator, &1_000i128);

    let id = create_linear_vesting(&env, &client, &creator, &beneficiary, &asset);

    // Vest 20%
    env.ledger().with_mut(|li| li.timestamp += 120);

    // Partial claim (200)
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 200);

    // Vest up to 40%, then revoke: unvested (600) → issuer, frozen_total = 400
    env.ledger().with_mut(|li| li.timestamp += 20);
    client.revoke_vesting(&id, &creator);
    assert_eq!(token.balance(&creator), 600);

    // Beneficiary claims remaining vested-but-unclaimed (400 - 200 = 200)
    let claimed = client.claim_vested(&id, &beneficiary);
    assert_eq!(claimed, 200);

    // All accounted for: 600 (issuer) + 200 (first claim) + 200 (second claim) = 1000
    assert_eq!(token.balance(&creator), 600);
    assert_eq!(token.balance(&beneficiary), 400);
    assert_eq!(token.balance(&client.address), 0);

    // Status final
    let status = client.get_vesting_status(&id);
    assert_eq!(status.total_vested, 400);
    assert_eq!(status.total_claimed, 400);
    assert_eq!(status.claimable, 0);
    assert_eq!(status.remaining, 0);
}
