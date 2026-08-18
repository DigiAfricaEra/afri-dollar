extern crate afri_contract_shared;

use afri_contract_shared::{
    bump_instance_and_persistent, extend_instance_ttl, INSTANCE_BUMP_AMOUNT,
    INSTANCE_LIFETIME_THRESHOLD,
};
use soroban_sdk::{contract, contractimpl, symbol_short, Env, IntoVal};

#[contract]
struct TestContract;

#[contractimpl]
impl TestContract {
    pub fn do_nothing(_env: Env) {}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

#[test]
fn constants_are_correct() {
    assert_eq!(DAY_IN_LEDGERS, 17_280);
    assert_eq!(INSTANCE_BUMP_AMOUNT, 7 * 17_280);
    assert_eq!(INSTANCE_LIFETIME_THRESHOLD, 6 * 17_280);
}

use afri_contract_shared::DAY_IN_LEDGERS;

// ---------------------------------------------------------------------------
// extend_instance_ttl
// ---------------------------------------------------------------------------

#[test]
fn extend_instance_ttl_runs_inside_contract_context() {
    let env = Env::default();
    let contract_id = env.register(TestContract, ());
    env.as_contract(&contract_id, || {
        // Write something to instance storage so there's something to bump.
        env.storage().instance().set(&symbol_short!("key"), &42u32);
        // Should not panic.
        extend_instance_ttl(&env);
    });
}

#[test]
fn extend_instance_ttl_can_be_called_repeatedly() {
    let env = Env::default();
    let contract_id = env.register(TestContract, ());
    env.as_contract(&contract_id, || {
        env.storage().instance().set(&(), &0u32);
        for _ in 0..5 {
            extend_instance_ttl(&env);
        }
    });
}

// ---------------------------------------------------------------------------
// bump_instance_and_persistent
// ---------------------------------------------------------------------------

#[test]
fn bump_instance_and_persistent_bumps_instance() {
    let env = Env::default();
    let contract_id = env.register(TestContract, ());
    env.as_contract(&contract_id, || {
        env.storage().instance().set(&(), &0u32);
        let keys = soroban_sdk::vec![&env];
        // Empty keys list — only instance TTL is bumped.
        bump_instance_and_persistent(&env, &keys);
    });
}

#[test]
fn bump_instance_and_persistent_bumps_persistent_keys() {
    let env = Env::default();
    let contract_id = env.register(TestContract, ());
    env.as_contract(&contract_id, || {
        let key1 = symbol_short!("config");
        let key2 = symbol_short!("admin");
        env.storage().persistent().set(&key1, &100u32);
        env.storage().persistent().set(&key2, &200u32);

        let keys = soroban_sdk::vec![
            &env,
            key1.clone().into_val(&env),
            key2.clone().into_val(&env)
        ];
        bump_instance_and_persistent(&env, &keys);

        // Verify storage values are unchanged after bump.
        let v1: u32 = env.storage().persistent().get(&key1).unwrap();
        let v2: u32 = env.storage().persistent().get(&key2).unwrap();
        assert_eq!(v1, 100);
        assert_eq!(v2, 200);
    });
}
