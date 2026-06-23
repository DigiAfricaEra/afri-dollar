#![no_std]
//! Counter — the reference AfriDollar Soroban contract.
//!
//! It is deliberately tiny but exercises the four things every new contract
//! needs to get right:
//!   * **Initialization** — one-time admin setup guarded against re-init.
//!   * **Storage operations** — reading and writing instance state.
//!   * **Events** — publishing a topic + payload on state change.
//!   * **Authorization** — gating a privileged call behind `require_auth`.
//!
//! Copy this crate as the starting point for new contracts.

use afri_contract_shared::{extend_instance_ttl, Error};
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, symbol_short, Address, Env, Symbol,
};

/// Keys for the contract's instance storage.
#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// The address allowed to perform privileged operations (e.g. `reset`).
    Admin,
    /// The current counter value.
    Counter,
}

/// Event published whenever the counter changes.
///
/// Emitted with topics `["counter", <action>]` and the new count as the data
/// payload, e.g. topics `("counter", "increment")` with data `5`.
#[contractevent(topics = ["counter"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CounterChanged {
    /// What changed the counter: `"increment"` or `"reset"`.
    #[topic]
    pub action: Symbol,
    /// The counter value after the change.
    pub count: u32,
}

#[contract]
pub struct CounterContract;

#[contractimpl]
impl CounterContract {
    /// Initialize the contract, recording the `admin` and seeding the counter
    /// at zero. Fails with [`Error::AlreadyInitialized`] if called twice.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Counter, &0u32);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Increment the counter by one, returning the new value and emitting a
    /// `("counter", "increment")` event carrying it.
    pub fn increment(env: Env) -> Result<u32, Error> {
        let mut count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Counter)
            .ok_or(Error::NotInitialized)?;

        count += 1;
        env.storage().instance().set(&DataKey::Counter, &count);
        extend_instance_ttl(&env);

        CounterChanged {
            action: symbol_short!("increment"),
            count,
        }
        .publish(&env);

        Ok(count)
    }

    /// Return the current counter value (zero if never initialized).
    pub fn get_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Counter).unwrap_or(0)
    }

    /// Reset the counter to zero. Only the admin recorded at initialization may
    /// call this; the caller must authorize the invocation.
    pub fn reset(env: Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        admin.require_auth();

        env.storage().instance().set(&DataKey::Counter, &0u32);
        extend_instance_ttl(&env);

        CounterChanged {
            action: symbol_short!("reset"),
            count: 0,
        }
        .publish(&env);

        Ok(())
    }
}

#[cfg(test)]
mod test;
