use crate::{EscrowContract, EscrowContractClient, EscrowStatus};
use afri_contract_shared::Error;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

fn setup() -> (Env, Address, EscrowContractClient<'static>) {
    let env = Env::default();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    (env, contract_id, client)
}

#[test]
fn create_and_fund_escrow_lifecycle() {
    let (env, _contract_id, client) = setup();
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let asset = Address::generate(&env);

    client.initialize(&Address::generate(&env));
    let escrow_id = client.create_escrow(&buyer, &seller, &arbitrator, &asset, &100, &10);

    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Created);

    env.mock_all_auths();
    client.fund_escrow(&escrow_id, &buyer);
    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Funded);
}

#[test]
fn release_funds_by_buyer_and_timeout_auto_release() {
    let (env, _contract_id, client) = setup();
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let asset = Address::generate(&env);

    client.initialize(&Address::generate(&env));
    let escrow_id = client.create_escrow(&buyer, &seller, &arbitrator, &asset, &50, &1);

    env.mock_all_auths();
    client.fund_escrow(&escrow_id, &buyer);
    client.release_funds(&escrow_id, &buyer);
    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Completed);

    let later_id = client.create_escrow(&buyer, &seller, &arbitrator, &asset, &25, &1);
    env.mock_all_auths();
    client.fund_escrow(&later_id, &buyer);
    env.ledger().set_timestamp(env.ledger().timestamp() + 2);
    client.release_funds(&later_id, &buyer);
    let escrow = client.get_escrow(&later_id);
    assert_eq!(escrow.status, EscrowStatus::Completed);
}

#[test]
fn refund_and_dispute_flow_works() {
    let (env, _contract_id, client) = setup();
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let asset = Address::generate(&env);

    client.initialize(&Address::generate(&env));
    let escrow_id = client.create_escrow(&buyer, &seller, &arbitrator, &asset, &80, &20);

    env.mock_all_auths();
    client.fund_escrow(&escrow_id, &buyer);
    client.start_dispute(&escrow_id, &seller);
    client.refund_buyer(&escrow_id, &arbitrator);
    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Refunded);
}

#[test]
fn cancel_escrow_requires_buyer_or_seller() {
    let (env, _contract_id, client) = setup();
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let asset = Address::generate(&env);

    client.initialize(&Address::generate(&env));
    let escrow_id = client.create_escrow(&buyer, &seller, &arbitrator, &asset, &40, &10);

    env.mock_all_auths();
    client.cancel_escrow(&escrow_id, &buyer);
    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Cancelled);
}

#[test]
fn initialize_is_one_time_only() {
    let (_env, _contract_id, client) = setup();
    client.initialize(&Address::generate(&_env));
    let result = client.try_initialize(&Address::generate(&_env));
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}
