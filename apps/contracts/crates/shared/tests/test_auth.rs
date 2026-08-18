extern crate afri_contract_shared;

use afri_contract_shared::require_auth_or_admin;
use soroban_sdk::{contract, contractimpl, testutils::Address as _, Address, Env};

#[contract]
struct AuthTestContract;

#[contractimpl]
impl AuthTestContract {
    pub fn do_nothing(_env: Env) {}
}

fn setup() -> (Env, Address) {
    let env = Env::default();
    let contract_id = env.register(AuthTestContract, ());
    (env, contract_id)
}

// ---------------------------------------------------------------------------
// Admin bypass
// ---------------------------------------------------------------------------

#[test]
fn admin_bypasses_auth() {
    let (env, contract_id) = setup();
    let admin = Address::generate(&env);
    // When caller == admin, no auth is required — should succeed
    // without mock_all_auths.
    env.as_contract(&contract_id, || {
        assert_eq!(require_auth_or_admin(&env, &admin, Some(&admin)), Ok(()));
    });
}

// ---------------------------------------------------------------------------
// Non-admin requires auth
// ---------------------------------------------------------------------------

#[test]
fn non_admin_requires_auth_succeeds_with_mock() {
    let (env, contract_id) = setup();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    env.as_contract(&contract_id, || {
        assert_eq!(require_auth_or_admin(&env, &user, Some(&admin)), Ok(()));
    });
}

#[test]
#[should_panic]
fn non_admin_requires_auth_fails_without_mock() {
    let (env, contract_id) = setup();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    // This will panic because the user hasn't authorized.
    env.as_contract(&contract_id, || {
        let _ = require_auth_or_admin(&env, &user, Some(&admin));
    });
}

// ---------------------------------------------------------------------------
// No admin provided (admin = None)
// ---------------------------------------------------------------------------

#[test]
fn no_admin_always_requires_auth() {
    let (env, contract_id) = setup();
    env.mock_all_auths();
    let user = Address::generate(&env);
    env.as_contract(&contract_id, || {
        assert_eq!(require_auth_or_admin(&env, &user, None), Ok(()));
    });
}

// ---------------------------------------------------------------------------
// Different admin than caller
// ---------------------------------------------------------------------------

#[test]
fn different_admin_from_caller() {
    let (env, contract_id) = setup();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    // user != admin, so auth is required (mocked).
    env.as_contract(&contract_id, || {
        assert_eq!(require_auth_or_admin(&env, &user, Some(&admin)), Ok(()));
    });
}
