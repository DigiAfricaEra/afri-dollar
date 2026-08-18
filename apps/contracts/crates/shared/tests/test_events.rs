extern crate afri_contract_shared;

use afri_contract_shared::{publish_admin_action, publish_transfer};
use soroban_sdk::{
    contract, contractimpl, symbol_short, testutils::Address as _, testutils::Events, vec, Address,
    Env, IntoVal, Symbol,
};

// ---------------------------------------------------------------------------
// Test contract that wraps the event helpers so they run in contract context.
// ---------------------------------------------------------------------------

#[contract]
pub struct EventTestContract;

#[contractimpl]
impl EventTestContract {
    pub fn emit_transfer(env: Env, from: Address, to: Address, amount: i128) {
        publish_transfer(&env, &from, &to, amount, None);
    }

    pub fn emit_transfer_with_asset(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
        asset: Address,
    ) {
        publish_transfer(&env, &from, &to, amount, Some(&asset));
    }

    pub fn emit_admin_action(env: Env, action: Symbol) {
        publish_admin_action(&env, action, ().into());
    }
}

fn setup() -> (Env, Address) {
    let env = Env::default();
    let contract_id = env.register(EventTestContract, ());
    (env, contract_id)
}

// ---------------------------------------------------------------------------
// publish_transfer
// ---------------------------------------------------------------------------

#[test]
fn publish_transfer_emits_correct_topics_and_data() {
    let (env, contract_id) = setup();
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    env.as_contract(&contract_id, || {
        publish_transfer(&env, &from, &to, 1_000, None);
    });

    // 3 topics: "transfer", from, to. Data: 1_000.
    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (
                contract_id,
                soroban_sdk::vec![
                    &env,
                    symbol_short!("transfer").into_val(&env),
                    from.into_val(&env),
                    to.into_val(&env),
                ],
                1_000i128.into_val(&env),
            ),
        ]
    );
}

#[test]
fn publish_transfer_with_asset_has_four_topics() {
    let (env, contract_id) = setup();
    let from = Address::generate(&env);
    let to = Address::generate(&env);
    let asset = Address::generate(&env);

    env.as_contract(&contract_id, || {
        publish_transfer(&env, &from, &to, 2_000, Some(&asset));
    });

    // 4 topics: "transfer", from, to, asset. Data: 2_000.
    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (
                contract_id,
                soroban_sdk::vec![
                    &env,
                    symbol_short!("transfer").into_val(&env),
                    from.into_val(&env),
                    to.into_val(&env),
                    asset.into_val(&env),
                ],
                2_000i128.into_val(&env),
            ),
        ]
    );
}

#[test]
fn publish_transfer_without_asset_has_three_topics() {
    let (env, contract_id) = setup();
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    env.as_contract(&contract_id, || {
        publish_transfer(&env, &from, &to, 500, None);
    });

    // 3 topics: "transfer", from, to. Data: 500.
    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (
                contract_id,
                soroban_sdk::vec![
                    &env,
                    symbol_short!("transfer").into_val(&env),
                    from.into_val(&env),
                    to.into_val(&env),
                ],
                500i128.into_val(&env),
            ),
        ]
    );
}

// ---------------------------------------------------------------------------
// publish_admin_action
// ---------------------------------------------------------------------------

#[test]
fn publish_admin_action_emits_correct_topics() {
    let (env, contract_id) = setup();

    env.as_contract(&contract_id, || {
        publish_admin_action(&env, symbol_short!("pause"), ().into());
    });

    // 2 topics: "admin", "pause". Data: ().
    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (
                contract_id,
                soroban_sdk::vec![
                    &env,
                    symbol_short!("admin").into_val(&env),
                    symbol_short!("pause").into_val(&env),
                ],
                ().into_val(&env),
            ),
        ]
    );
}

#[test]
fn publish_admin_action_with_data() {
    let (env, contract_id) = setup();

    env.as_contract(&contract_id, || {
        publish_admin_action(&env, symbol_short!("upgrade"), 42u32.into());
    });

    // 2 topics: "admin", "upgrade". Data: 42u32.
    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (
                contract_id,
                soroban_sdk::vec![
                    &env,
                    symbol_short!("admin").into_val(&env),
                    symbol_short!("upgrade").into_val(&env),
                ],
                42u32.into_val(&env),
            ),
        ]
    );
}

// ---------------------------------------------------------------------------
// Topic ordering
// ---------------------------------------------------------------------------

#[test]
fn transfer_topic_ordering_is_deterministic() {
    let (env, contract_id) = setup();
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    // Emit two transfers and verify they have the same structure.
    env.as_contract(&contract_id, || {
        publish_transfer(&env, &from, &to, 100, None);
        publish_transfer(&env, &from, &to, 200, None);
    });

    let expected = soroban_sdk::vec![
        &env,
        (
            contract_id.clone(),
            soroban_sdk::vec![
                &env,
                symbol_short!("transfer").into_val(&env),
                from.clone().into_val(&env),
                to.clone().into_val(&env),
            ],
            100i128.into_val(&env),
        ),
        (
            contract_id,
            soroban_sdk::vec![
                &env,
                symbol_short!("transfer").into_val(&env),
                from.into_val(&env),
                to.into_val(&env),
            ],
            200i128.into_val(&env),
        ),
    ];
    assert_eq!(env.events().all(), expected);
}
