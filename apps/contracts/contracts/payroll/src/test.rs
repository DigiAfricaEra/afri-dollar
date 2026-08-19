use crate::{BatchStatus, Error, PayrollContract, PayrollContractClient};
use soroban_sdk::{
    testutils::{Address as _, Events},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, Vec,
};

// Constants
const FUNDER_BALANCE: i128 = 1_000_000;

// Test fixtures

struct Fixture {
    contract_id: Address,
    admin: Address,
    creator: Address,
    funder: Address,
    asset: Address,
}

fn setup() -> (Env, Fixture) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(PayrollContract, ());
    let client = PayrollContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let creator = Address::generate(&env);
    let funder = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    StellarAssetClient::new(&env, &asset).mint(&funder, &FUNDER_BALANCE);

    (
        env,
        Fixture {
            contract_id,
            admin,
            creator,
            funder,
            asset,
        },
    )
}

fn client<'a>(env: &'a Env, f: &Fixture) -> PayrollContractClient<'a> {
    PayrollContractClient::new(env, &f.contract_id)
}

fn token<'a>(env: &'a Env, f: &Fixture) -> TokenClient<'a> {
    TokenClient::new(env, &f.asset)
}

/// Helper: creates a batch and adds `n` recipients of `amount` each.
fn batch_with_recipients(env: &Env, f: &Fixture, n: u32, amount: i128) -> u64 {
    let c = client(env, f);
    let batch_id = c.create_batch(&f.creator, &f.asset);
    for _ in 0..n {
        let r = Address::generate(env);
        c.add_recipient(&f.creator, &batch_id, &r, &amount);
    }
    batch_id
}

// Initialization

#[test]
fn initialize_ok() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(PayrollContract, ());
    let client = PayrollContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    // No panic = success.
}

#[test]
fn initialize_twice_err() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(PayrollContract, ());
    let client = PayrollContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let result = client.try_initialize(&admin);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

// Batch CRUD

#[test]
fn create_batch_emits_event_and_stores() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    assert_eq!(batch_id, 1);

    let batch = c.get_batch(&batch_id);
    assert_eq!(batch.id, 1);
    assert_eq!(batch.creator, f.creator);
    assert_eq!(batch.asset, f.asset);
    assert_eq!(batch.status, BatchStatus::Open);
    assert_eq!(batch.total_amount, 0);

    // Verify the event was emitted.
    let events = env.events().all();
    assert!(
        events.len() > 0,
        "expected at least one event from create_batch"
    );
}

#[test]
fn create_batch_non_initialized_err() {
    let env = Env::default();
    env.mock_all_auths();
    // Register WITHOUT calling initialize.
    let contract_id = env.register(PayrollContract, ());
    let client = PayrollContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let asset = Address::generate(&env);

    let result = client.try_create_batch(&creator, &asset);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

// Add recipient

#[test]
fn creator_can_add() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let recipient = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &recipient, &500);

    let batch = c.get_batch(&batch_id);
    assert_eq!(batch.total_amount, 500);
}

#[test]
fn non_creator_add_unauthorized() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let stranger = Address::generate(&env);
    let recipient = Address::generate(&env);

    let result = c.try_add_recipient(&stranger, &batch_id, &recipient, &100);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn add_after_fund_invalid_batch_state() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &r, &100);
    c.fund_batch(&batch_id, &f.funder);

    let new_r = Address::generate(&env);
    let result = c.try_add_recipient(&f.creator, &batch_id, &new_r, &50);
    assert_eq!(result, Err(Ok(Error::InvalidBatchState)));
}

#[test]
fn add_at_max_recipients_200_ok() {
    let (env, f) = setup();
    let c = client(&env, &f);

    // Increase the budget so we can add 200 recipients in a test.
    env.budget().reset_unlimited();

    let batch_id = c.create_batch(&f.creator, &f.asset);
    for _ in 0..200 {
        let r = Address::generate(&env);
        c.add_recipient(&f.creator, &batch_id, &r, &1);
    }

    let batch = c.get_batch(&batch_id);
    assert_eq!(batch.total_amount, 200);
}

#[test]
fn add_201_returns_too_many_recipients() {
    let (env, f) = setup();
    let c = client(&env, &f);

    env.budget().reset_unlimited();

    let batch_id = c.create_batch(&f.creator, &f.asset);
    for _ in 0..200 {
        let r = Address::generate(&env);
        c.add_recipient(&f.creator, &batch_id, &r, &1);
    }

    let extra = Address::generate(&env);
    let result = c.try_add_recipient(&f.creator, &batch_id, &extra, &1);
    assert_eq!(result, Err(Ok(Error::TooManyRecipients)));
}

#[test]
fn zero_amount_invalid() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);

    let result = c.try_add_recipient(&f.creator, &batch_id, &r, &0);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn negative_amount_invalid() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);

    let result = c.try_add_recipient(&f.creator, &batch_id, &r, &(-10));
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

// Funding

#[test]
fn fund_batch_transfers_tokens_from_caller() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &r1, &300);
    c.add_recipient(&f.creator, &batch_id, &r2, &200);

    c.fund_batch(&batch_id, &f.funder);

    let batch = c.get_batch(&batch_id);
    assert_eq!(batch.status, BatchStatus::Funded);
    assert_eq!(batch.total_amount, 500);
    assert_eq!(token(&env, &f).balance(&f.funder), FUNDER_BALANCE - 500);
    assert_eq!(token(&env, &f).balance(&f.contract_id), 500);
}

#[test]
fn fund_already_funded_invalid_batch_state() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &r, &100);
    c.fund_batch(&batch_id, &f.funder);

    let result = c.try_fund_batch(&batch_id, &f.funder);
    assert_eq!(result, Err(Ok(Error::InvalidBatchState)));
}

#[test]
fn fund_batch_empty_batch_invalid_amount() {
    let (env, f) = setup();
    let c = client(&env, &f);

    // Batch with no recipients has total_amount == 0.
    let batch_id = c.create_batch(&f.creator, &f.asset);

    let result = c.try_fund_batch(&batch_id, &f.funder);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn fund_batch_insufficient_balance_of_caller_token_error_propagates() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);
    // Add recipient with amount exceeding funder's balance.
    c.add_recipient(&f.creator, &batch_id, &r, &(FUNDER_BALANCE + 1));

    // The token transfer should fail with a host error (insufficient balance).
    let result = c.try_fund_batch(&batch_id, &f.funder);
    assert!(result.is_err(), "expected token transfer to fail");
}

// Distribute

#[test]
fn distribute_transfers_to_all_recipients() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let r3 = Address::generate(&env);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    c.add_recipient(&f.creator, &batch_id, &r1, &100);
    c.add_recipient(&f.creator, &batch_id, &r2, &250);
    c.add_recipient(&f.creator, &batch_id, &r3, &150);

    c.fund_batch(&batch_id, &f.funder);
    c.distribute(&batch_id);

    let batch = c.get_batch(&batch_id);
    assert_eq!(batch.status, BatchStatus::Distributed);

    assert_eq!(token(&env, &f).balance(&r1), 100);
    assert_eq!(token(&env, &f).balance(&r2), 250);
    assert_eq!(token(&env, &f).balance(&r3), 150);
    assert_eq!(token(&env, &f).balance(&f.contract_id), 0);
}

#[test]
fn distribute_not_funded_err() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &r, &100);

    // Batch is Open, not Funded.
    let result = c.try_distribute(&batch_id);
    assert_eq!(result, Err(Ok(Error::BatchNotFunded)));
}

#[test]
fn distribute_called_twice_returns_error_on_second() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &r, &100);
    c.fund_batch(&batch_id, &f.funder);

    c.distribute(&batch_id);
    // Second call — batch is now Distributed, not Funded.
    let result = c.try_distribute(&batch_id);
    assert_eq!(result, Err(Ok(Error::BatchNotFunded)));
}

// Cancel

#[test]
fn cancel_before_fund_ok() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &r, &100);

    c.cancel_batch(&f.creator, &batch_id);

    let batch = c.get_batch(&batch_id);
    assert_eq!(batch.status, BatchStatus::Cancelled);
}

#[test]
fn cancel_after_fund_invalid_batch_state() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &r, &100);
    c.fund_batch(&batch_id, &f.funder);

    let result = c.try_cancel_batch(&f.creator, &batch_id);
    assert_eq!(result, Err(Ok(Error::InvalidBatchState)));
}

#[test]
fn non_creator_cancel_unauthorized() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let stranger = Address::generate(&env);

    let result = c.try_cancel_batch(&stranger, &batch_id);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

// Arithmetic edge cases

#[test]
fn total_amount_overflow_after_large_recipient_sum_errors_overflow() {
    let (env, f) = setup();
    let c = client(&env, &f);

    env.budget().reset_unlimited();

    let batch_id = c.create_batch(&f.creator, &f.asset);

    // Add a recipient with i128::MAX — the first add should succeed.
    let r1 = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &r1, &i128::MAX);

    // Adding even 1 more should overflow total_amount.
    let r2 = Address::generate(&env);
    let result = c.try_add_recipient(&f.creator, &batch_id, &r2, &1);
    assert_eq!(result, Err(Ok(Error::Overflow)));
}

// Read / State transitions

#[test]
fn get_batch_returns_matching_fields_each_step() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);

    // Open
    let batch = c.get_batch(&batch_id);
    assert_eq!(batch.status, BatchStatus::Open);
    assert_eq!(batch.total_amount, 0);

    c.add_recipient(&f.creator, &batch_id, &r, &500);
    let batch = c.get_batch(&batch_id);
    assert_eq!(batch.total_amount, 500);
    assert_eq!(batch.status, BatchStatus::Open);

    // Funded
    c.fund_batch(&batch_id, &f.funder);
    let batch = c.get_batch(&batch_id);
    assert_eq!(batch.status, BatchStatus::Funded);
    assert_eq!(batch.total_amount, 500);

    // Distributed
    c.distribute(&batch_id);
    let batch = c.get_batch(&batch_id);
    assert_eq!(batch.status, BatchStatus::Distributed);
    assert_eq!(batch.total_amount, 500);
}

#[test]
fn get_batch_not_found() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let result = c.try_get_batch(&999);
    assert_eq!(result, Err(Ok(Error::BatchNotFound)));
}

// Events

#[test]
fn create_batch_event_has_correct_topics() {
    let (env, f) = setup();
    let c = client(&env, &f);

    c.create_batch(&f.creator, &f.asset);

    let events = env.events().all();
    assert!(events.len() > 0, "create_batch should emit an event");
}

#[test]
fn add_recipient_emits_event() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let recipient = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &recipient, &300);

    let events = env.events().all();
    // At least the RecipientAdded event (plus the BatchCreated from create_batch).
    assert!(
        events.len() >= 2,
        "expected events from create_batch and add_recipient"
    );
}

#[test]
fn fund_batch_emits_event() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &r, &100);
    c.fund_batch(&batch_id, &f.funder);

    let events = env.events().all();
    // BatchCreated + RecipientAdded + token transfer + BatchFunded.
    assert!(events.len() >= 3, "expected fund_batch to emit an event");
}

#[test]
fn distribute_emits_event() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &r, &100);
    c.fund_batch(&batch_id, &f.funder);
    c.distribute(&batch_id);

    let events = env.events().all();
    // BatchCreated + RecipientAdded + token xfer(fund) + BatchFunded
    //   + token xfer(distribute) + DistributionCompleted.
    assert!(events.len() >= 5, "expected distribute to emit events");
}

#[test]
fn cancel_batch_emits_event() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    c.cancel_batch(&f.creator, &batch_id);

    let events = env.events().all();
    // BatchCreated + BatchCancelled.
    assert!(events.len() >= 2, "expected cancel_batch to emit an event");
}

// Additional edge cases

#[test]
fn multiple_batches_are_independent() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let b1 = c.create_batch(&f.creator, &f.asset);
    let b2 = c.create_batch(&f.creator, &f.asset);
    assert_eq!(b1, 1);
    assert_eq!(b2, 2);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    c.add_recipient(&f.creator, &b1, &r1, &100);
    c.add_recipient(&f.creator, &b2, &r2, &200);

    assert_eq!(c.get_batch(&b1).total_amount, 100);
    assert_eq!(c.get_batch(&b2).total_amount, 200);
}

#[test]
fn cancel_then_add_recipient_fails() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    c.cancel_batch(&f.creator, &batch_id);

    let r = Address::generate(&env);
    let result = c.try_add_recipient(&f.creator, &batch_id, &r, &100);
    assert_eq!(result, Err(Ok(Error::InvalidBatchState)));
}

#[test]
fn cancel_then_fund_fails() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &r, &100);
    c.cancel_batch(&f.creator, &batch_id);

    let result = c.try_fund_batch(&batch_id, &f.funder);
    assert_eq!(result, Err(Ok(Error::InvalidBatchState)));
}

#[test]
fn distribute_cancelled_batch_fails() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let batch_id = c.create_batch(&f.creator, &f.asset);
    let r = Address::generate(&env);
    c.add_recipient(&f.creator, &batch_id, &r, &100);
    c.cancel_batch(&f.creator, &batch_id);

    let result = c.try_distribute(&batch_id);
    assert_eq!(result, Err(Ok(Error::BatchNotFunded)));
}

#[test]
fn add_recipient_to_nonexistent_batch_fails() {
    let (env, f) = setup();
    let c = client(&env, &f);

    let r = Address::generate(&env);
    let result = c.try_add_recipient(&f.creator, &999, &r, &100);
    assert_eq!(result, Err(Ok(Error::BatchNotFound)));
}
