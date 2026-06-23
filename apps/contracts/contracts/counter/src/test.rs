use crate::{CounterContract, CounterContractClient};
use afri_contract_shared::Error;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events},
    vec, Address, Env, IntoVal,
};

fn setup() -> (Env, Address, CounterContractClient<'static>, Address) {
    let env = Env::default();
    let contract_id = env.register(CounterContract, ());
    let client = CounterContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    (env, contract_id, client, admin)
}

#[test]
fn initialize_seeds_counter_at_zero() {
    let (_env, _id, client, admin) = setup();
    client.initialize(&admin);
    assert_eq!(client.get_count(), 0);
}

#[test]
fn initialize_is_one_time_only() {
    let (_env, _id, client, admin) = setup();
    client.initialize(&admin);

    // The non-`try` client panics on a contract error; `try_` returns it.
    let result = client.try_initialize(&admin);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn increment_updates_storage_and_returns_new_value() {
    let (_env, _id, client, admin) = setup();
    client.initialize(&admin);

    assert_eq!(client.increment(), 1);
    assert_eq!(client.increment(), 2);
    assert_eq!(client.get_count(), 2);
}

#[test]
fn increment_before_initialize_errors() {
    let (_env, _id, client, _admin) = setup();
    let result = client.try_increment();
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn increment_emits_event() {
    let (env, contract_id, client, admin) = setup();
    client.initialize(&admin);
    client.increment();

    // Exactly one event, carrying topics ("counter", "increment") and data 1.
    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (
                contract_id,
                (symbol_short!("counter"), symbol_short!("increment")).into_val(&env),
                1u32.into_val(&env),
            ),
        ]
    );
}

#[test]
fn reset_requires_admin_auth_and_zeroes_counter() {
    let (env, _id, client, admin) = setup();
    client.initialize(&admin);
    client.increment();
    client.increment();
    assert_eq!(client.get_count(), 2);

    // Authorize any required signatures, then reset.
    env.mock_all_auths();
    client.reset();
    assert_eq!(client.get_count(), 0);
}
