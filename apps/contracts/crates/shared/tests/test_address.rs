extern crate afri_contract_shared;

use afri_contract_shared::address_valid;
use soroban_sdk::{testutils::Address as _, Address, Env};

/// address_valid always returns Ok for Soroban Address values because
/// the host guarantees their validity. This test documents that contract.
#[test]
fn address_valid_returns_ok_for_generated_address() {
    let env = Env::default();
    let addr = Address::generate(&env);
    assert_eq!(address_valid(&env, &addr), Ok(()));
}

/// A different generated address should also be valid.
#[test]
fn address_valid_returns_ok_for_different_address() {
    let env = Env::default();
    let addr1 = Address::generate(&env);
    let addr2 = Address::generate(&env);
    assert_eq!(address_valid(&env, &addr1), Ok(()));
    assert_eq!(address_valid(&env, &addr2), Ok(()));
    // They are different addresses but both valid.
    assert_ne!(addr1, addr2);
}
