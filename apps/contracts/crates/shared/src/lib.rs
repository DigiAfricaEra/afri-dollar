#![no_std]
//! Shared building blocks for AfriDollar Soroban contracts.
//!
//! This crate is intentionally small: it holds the cross-contract error type
//! and storage-TTL helpers so individual contracts stay consistent and avoid
//! duplicating boilerplate. Add new shared types here as the contract suite
//! grows.

use soroban_sdk::{contracterror, Env};

/// Number of ledgers produced in roughly one day on Stellar (~5s per ledger).
pub const DAY_IN_LEDGERS: u32 = 17_280;

/// How far to extend instance storage each time it is touched (~7 days).
pub const INSTANCE_BUMP_AMOUNT: u32 = 7 * DAY_IN_LEDGERS;

/// Re-extend instance storage once its remaining TTL drops below this (~6 days).
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

/// Errors shared across AfriDollar contracts.
///
/// Each contract is free to extend this set with its own domain errors; the
/// common lifecycle errors live here so they carry consistent codes.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` was called on a contract that already has state.
    AlreadyInitialized = 1,
    /// An operation was attempted before the contract was initialized.
    NotInitialized = 2,
    /// The caller is not authorized to perform the operation.
    Unauthorized = 3,
}

/// Extend the TTL of the contract's instance storage.
///
/// Soroban storage entries expire unless their TTL is periodically bumped.
/// Call this after any successful state mutation so an actively-used contract
/// keeps its instance state alive.
pub fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn extend_instance_ttl_runs_inside_contract_context() {
        let env = Env::default();
        let contract_id = env.register(TestContract, ());
        env.as_contract(&contract_id, || {
            // Seed an entry so there is instance state to extend.
            env.storage().instance().set(&(), &0u32);
            extend_instance_ttl(&env);
        });
    }

    use soroban_sdk::contract;
    #[contract]
    struct TestContract;
}
