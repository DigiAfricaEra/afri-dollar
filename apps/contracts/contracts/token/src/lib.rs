#![no_std]
//! Tokenized Asset — custom token contract for AfriDollar.
//!
//! Implements a standard token interface with mint (issuer-only), burn
//! (holder), transfer, approve/delegate spending, balance queries, and
//! immutable metadata after initialization.

use afri_contract_shared::{
    extend_instance_ttl, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, String,
};

/// Immutable token metadata set once during initialization.
#[contracttype]
#[derive(Clone)]
pub struct TokenMetadata {
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
    pub issuer: Address,
}

/// Allowance entry recorded when an owner approves a spender.
#[contracttype]
#[derive(Clone)]
pub struct AllowanceValue {
    pub amount: i128,
    /// Ledger number at which this allowance expires.
    /// `0` means never expires.
    pub expiration_ledger: u32,
}

/// Errors returned by the token contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InsufficientBalance = 4,
    InsufficientAllowance = 5,
    AllowanceExpired = 6,
    InvalidAmount = 7,
    Overflow = 8,
}

/// Instance and persistent storage keys.
#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Metadata,
    TotalSupply,
    Balance(Address),
    Allowance(Address, Address),
}

/// Emitted on every transfer, mint, and burn.
#[contractevent(topics = ["transfer"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferEvent {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

/// Emitted whenever an allowance is set.
#[contractevent(topics = ["approve"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApproveEvent {
    #[topic]
    pub owner: Address,
    #[topic]
    pub spender: Address,
    pub amount: i128,
    pub expiration_ledger: u32,
}

/// Extend TTL for a persistent storage entry using the same thresholds as
/// instance storage.
pub(crate) fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

#[contract]
pub struct TokenContract;

#[contractimpl]
impl TokenContract {
    /// Initialize the token with metadata and mint `total_supply` to
    /// `issuer`. The `issuer` is recorded as the admin and is the only
    /// address that may call `mint`. Fails with
    /// [`Error::AlreadyInitialized`] if called twice.
    pub fn initialize(
        env: Env,
        issuer: Address,
        name: String,
        symbol: String,
        decimals: u32,
        total_supply: i128,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        if total_supply < 0 {
            return Err(Error::InvalidAmount);
        }

        issuer.require_auth();

        let metadata = TokenMetadata {
            name,
            symbol,
            decimals,
            issuer: issuer.clone(),
        };

        env.storage().instance().set(&DataKey::Admin, &issuer);
        env.storage().instance().set(&DataKey::Metadata, &metadata);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &total_supply);

        if total_supply > 0 {
            let key = DataKey::Balance(issuer.clone());
            env.storage().persistent().set(&key, &total_supply);
            extend_persistent_ttl(&env, &key);
        }

        extend_instance_ttl(&env);

        TransferEvent {
            from: env.current_contract_address(),
            to: issuer,
            amount: total_supply,
        }
        .publish(&env);

        Ok(())
    }

    /// Mint `amount` tokens `to` the given address. Only the issuer
    /// (initializing admin) may call this. Fails with
    /// [`Error::NotInitialized`] if the contract has not been initialized.
    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let mut balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(to.clone()))
            .unwrap_or(0);
        balance = balance.checked_add(amount).ok_or(Error::Overflow)?;
        let key = DataKey::Balance(to.clone());
        env.storage().persistent().set(&key, &balance);
        extend_persistent_ttl(&env, &key);

        let mut supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        supply = supply.checked_add(amount).ok_or(Error::Overflow)?;
        env.storage().instance().set(&DataKey::TotalSupply, &supply);

        extend_instance_ttl(&env);

        TransferEvent {
            from: env.current_contract_address(),
            to,
            amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Burn `amount` tokens from `from`. The holder must authorize the
    /// call. Fails with [`Error::InsufficientBalance`] if the holder's
    /// balance is too low.
    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        from.require_auth();

        let mut balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(from.clone()))
            .unwrap_or(0);
        if balance < amount {
            return Err(Error::InsufficientBalance);
        }
        balance = balance.checked_sub(amount).ok_or(Error::Overflow)?;
        let key = DataKey::Balance(from.clone());
        env.storage().persistent().set(&key, &balance);
        extend_persistent_ttl(&env, &key);

        let mut supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        supply = supply.checked_sub(amount).ok_or(Error::Overflow)?;
        env.storage().instance().set(&DataKey::TotalSupply, &supply);

        extend_instance_ttl(&env);

        TransferEvent {
            from,
            to: env.current_contract_address(),
            amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Burn `amount` tokens from `from` on behalf of the issuer (clawback).
    /// Only the contract admin (issuer) may call this. Fails with
    /// [`Error::NotInitialized`] if the contract has not been initialized,
    /// [`Error::Unauthorized`] if the caller is not the admin, or
    /// [`Error::InsufficientBalance`] if the holder's balance is too low.
    pub fn burn_from(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let mut balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(from.clone()))
            .unwrap_or(0);
        if balance < amount {
            return Err(Error::InsufficientBalance);
        }
        balance = balance.checked_sub(amount).ok_or(Error::Overflow)?;
        let key = DataKey::Balance(from.clone());
        env.storage().persistent().set(&key, &balance);
        extend_persistent_ttl(&env, &key);

        let mut supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        supply = supply.checked_sub(amount).ok_or(Error::Overflow)?;
        env.storage().instance().set(&DataKey::TotalSupply, &supply);

        extend_instance_ttl(&env);

        TransferEvent {
            from,
            to: env.current_contract_address(),
            amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Transfer `amount` tokens from `from` to `to`. Requires
    /// authorization from `from`. Fails with
    /// [`Error::InsufficientBalance`] if the sender's balance is too low.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        from.require_auth();

        let mut from_balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(from.clone()))
            .unwrap_or(0);
        if from_balance < amount {
            return Err(Error::InsufficientBalance);
        }
        from_balance = from_balance.checked_sub(amount).ok_or(Error::Overflow)?;
        let from_key = DataKey::Balance(from.clone());
        env.storage().persistent().set(&from_key, &from_balance);
        extend_persistent_ttl(&env, &from_key);

        let mut to_balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(to.clone()))
            .unwrap_or(0);
        to_balance = to_balance.checked_add(amount).ok_or(Error::Overflow)?;
        let to_key = DataKey::Balance(to.clone());
        env.storage().persistent().set(&to_key, &to_balance);
        extend_persistent_ttl(&env, &to_key);

        extend_instance_ttl(&env);

        TransferEvent { from, to, amount }.publish(&env);

        Ok(())
    }

    /// Set `spender`'s allowance to spend `amount` of the `owner`'s
    /// tokens, optionally expiring at ledger number `expiration_ledger`.
    /// Requires authorization from `owner`. Passing `0` for `expiration_ledger`
    /// means the allowance never expires.
    pub fn approve(
        env: Env,
        owner: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) -> Result<(), Error> {
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }

        owner.require_auth();

        let allowance = AllowanceValue {
            amount,
            expiration_ledger,
        };

        if amount == 0 {
            env.storage()
                .persistent()
                .remove(&DataKey::Allowance(owner.clone(), spender.clone()));
        } else {
            let allowance_key = DataKey::Allowance(owner.clone(), spender.clone());
            env.storage().persistent().set(&allowance_key, &allowance);
            extend_persistent_ttl(&env, &allowance_key);
        }

        extend_instance_ttl(&env);

        ApproveEvent {
            owner,
            spender,
            amount,
            expiration_ledger,
        }
        .publish(&env);

        Ok(())
    }

    /// Transfer `amount` tokens from `from` to `to` using `spender`'s
    /// allowance. Requires authorization from `spender`. Fails with
    /// [`Error::InsufficientAllowance`] if the allowance is too low, or
    /// [`Error::AllowanceExpired`] if the allowance has expired.
    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        spender.require_auth();

        // Read and validate allowance.
        let mut allowance: AllowanceValue = env
            .storage()
            .persistent()
            .get(&DataKey::Allowance(from.clone(), spender.clone()))
            .ok_or(Error::InsufficientAllowance)?;

        if allowance.expiration_ledger > 0 && env.ledger().sequence() >= allowance.expiration_ledger
        {
            return Err(Error::AllowanceExpired);
        }
        if allowance.amount < amount {
            return Err(Error::InsufficientAllowance);
        }

        // Deduct from allowance.
        allowance.amount = allowance
            .amount
            .checked_sub(amount)
            .ok_or(Error::Overflow)?;
        if allowance.amount == 0 {
            env.storage()
                .persistent()
                .remove(&DataKey::Allowance(from.clone(), spender.clone()));
        } else {
            let allowance_key = DataKey::Allowance(from.clone(), spender.clone());
            env.storage().persistent().set(&allowance_key, &allowance);
            extend_persistent_ttl(&env, &allowance_key);
        }

        // Transfer tokens.
        let mut from_balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(from.clone()))
            .unwrap_or(0);
        if from_balance < amount {
            return Err(Error::InsufficientBalance);
        }
        from_balance = from_balance.checked_sub(amount).ok_or(Error::Overflow)?;
        let from_key = DataKey::Balance(from.clone());
        env.storage().persistent().set(&from_key, &from_balance);
        extend_persistent_ttl(&env, &from_key);

        let mut to_balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(to.clone()))
            .unwrap_or(0);
        to_balance = to_balance.checked_add(amount).ok_or(Error::Overflow)?;
        let to_key = DataKey::Balance(to.clone());
        env.storage().persistent().set(&to_key, &to_balance);
        extend_persistent_ttl(&env, &to_key);

        extend_instance_ttl(&env);

        TransferEvent { from, to, amount }.publish(&env);

        Ok(())
    }

    /// Return the token balance of `address`. Returns `0` if the address
    /// has no balance or the contract is uninitialized.
    pub fn balance(env: Env, address: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(address))
            .unwrap_or(0)
    }

    /// Return the current allowance `spender` has from `owner`. Returns
    /// `0` if no allowance exists or it has expired.
    pub fn allowance(env: Env, owner: Address, spender: Address) -> i128 {
        match env
            .storage()
            .persistent()
            .get::<DataKey, AllowanceValue>(&DataKey::Allowance(owner, spender))
        {
            Some(a) => {
                if a.expiration_ledger > 0 && env.ledger().sequence() >= a.expiration_ledger {
                    0
                } else {
                    a.amount
                }
            }
            None => 0,
        }
    }

    /// Return the immutable token metadata. Panics if the contract has not
    /// been initialized.
    pub fn get_metadata(env: Env) -> TokenMetadata {
        env.storage()
            .instance()
            .get(&DataKey::Metadata)
            .unwrap_or_else(|| panic!("contract not initialized"))
    }

    /// Return the token name. Panics if not initialized.
    pub fn name(env: Env) -> String {
        env.storage()
            .instance()
            .get::<DataKey, TokenMetadata>(&DataKey::Metadata)
            .unwrap_or_else(|| panic!("contract not initialized"))
            .name
    }

    /// Return the token symbol. Panics if not initialized.
    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get::<DataKey, TokenMetadata>(&DataKey::Metadata)
            .unwrap_or_else(|| panic!("contract not initialized"))
            .symbol
    }

    /// Return the token decimals. Panics if not initialized.
    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get::<DataKey, TokenMetadata>(&DataKey::Metadata)
            .unwrap_or_else(|| panic!("contract not initialized"))
            .decimals
    }
}

#[cfg(test)]
mod test;
