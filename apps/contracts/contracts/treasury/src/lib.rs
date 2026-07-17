#![no_std]
//! Treasury — clawback contract for AfriDollar.
//!
//! Provides regulatory-compliant clawback of compliant assets. The contract
//! admin configures clawback per asset — enabling it, setting an authority
//! address (typically a regulatory or platform admin), and optionally
//! requiring a reason string. The authority can then execute clawbacks that
//! return tokens from a specified address to the token issuer.
//!
//! Every clawback is recorded with a unique ID, the reason, and a timestamp
//! so the full history is available for audit. All state changes emit events.

use afri_contract_shared::{
    extend_instance_ttl, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype,
    token::StellarAssetClient,
    Address, Env, String, Vec,
};

/// Errors returned by the treasury clawback contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` was called on a contract that already has an admin.
    AlreadyInitialized = 1,
    /// An operation was attempted before the contract was initialized.
    NotInitialized = 2,
    /// The caller is not authorized to perform the operation.
    Unauthorized = 3,
    /// No `ClawbackConfig` exists for the given asset.
    ConfigNotFound = 4,
    /// Clawback is not enabled for the given asset.
    ClawbackDisabled = 5,
    /// The amount provided is zero or negative.
    InvalidAmount = 6,
    /// A reason is required for this asset but none was provided.
    InvalidReason = 7,
    /// A checked arithmetic operation would have overflowed.
    Overflow = 8,
}

/// Configuration for clawback on a specific asset.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClawbackConfig {
    pub asset: Address,
    pub enabled: bool,
    pub authority: Address,
    pub reason_required: bool,
}

/// A recorded clawback execution, stored for audit trail.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClawbackRecord {
    pub id: u64,
    pub from_address: Address,
    pub asset: Address,
    pub amount: i128,
    pub authority: Address,
    pub reason: String,
    pub timestamp: u64,
}

/// Instance and persistent storage keys.
#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// The address allowed to perform privileged operations.
    Admin,
    /// `ClawbackConfig`, keyed by `asset`.
    ClawbackConfig(Address),
    /// Monotonic counter for the next clawback record ID.
    NextRecordId,
    /// `ClawbackRecord`, keyed by `id`.
    ClawbackRecord(u64),
}

/// Emitted when clawback is enabled for an asset.
#[contractevent(topics = ["treasury", "enable"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClawbackEnabled {
    #[topic]
    pub asset: Address,
    pub authority: Address,
    pub reason_required: bool,
}

/// Emitted when clawback is disabled for an asset.
#[contractevent(topics = ["treasury", "disable"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClawbackDisabled {
    #[topic]
    pub asset: Address,
    pub disabled_at: u64,
}

/// Emitted when a clawback is executed.
#[contractevent(topics = ["treasury", "clawback"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClawbackExecuted {
    #[topic]
    pub from: Address,
    #[topic]
    pub asset: Address,
    pub amount: i128,
    pub authority: Address,
    pub reason: String,
    pub record_id: u64,
}

/// Extend the TTL of a persistent storage entry, using the same bump amounts
/// as `extend_instance_ttl`. Without this, a long-idle config or record could
/// expire while the contract's instance data stays alive.
fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Read the stored admin and require its authorization. Shared by every
/// admin-gated entrypoint.
fn require_admin(env: &Env) -> Result<(), Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    admin.require_auth();
    Ok(())
}

#[contract]
pub struct TreasuryContract;

#[contractimpl]
impl TreasuryContract {
    /// Initialize the contract, recording `admin`. Requires `admin`'s
    /// authorization, so an attacker cannot front-run initialization and
    /// claim the admin role. Fails with `Error::AlreadyInitialized` if called
    /// twice.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextRecordId, &1u64);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Admin-only. Enable clawback for `asset`, setting `authority` as the
    /// address authorized to execute clawbacks, and optionally requiring a
    /// reason string via `reason_required`. If a config already exists for
    /// this asset, it is overwritten.
    pub fn enable_clawback(
        env: Env,
        asset: Address,
        authority: Address,
        reason_required: bool,
    ) -> Result<(), Error> {
        require_admin(&env)?;

        let config = ClawbackConfig {
            asset: asset.clone(),
            enabled: true,
            authority: authority.clone(),
            reason_required,
        };
        env.storage()
            .persistent()
            .set(&DataKey::ClawbackConfig(asset.clone()), &config);
        extend_persistent_ttl(&env, &DataKey::ClawbackConfig(asset.clone()));
        extend_instance_ttl(&env);

        ClawbackEnabled {
            asset,
            authority,
            reason_required,
        }
        .publish(&env);
        Ok(())
    }

    /// Admin-only. Disable clawback for `asset`. The stored config is kept
    /// but marked disabled, so re-enabling is possible without re-setting
    /// the authority.
    pub fn disable_clawback(env: Env, asset: Address) -> Result<(), Error> {
        require_admin(&env)?;

        let mut config: ClawbackConfig = env
            .storage()
            .persistent()
            .get(&DataKey::ClawbackConfig(asset.clone()))
            .ok_or(Error::ConfigNotFound)?;
        config.enabled = false;
        env.storage()
            .persistent()
            .set(&DataKey::ClawbackConfig(asset.clone()), &config);
        extend_persistent_ttl(&env, &DataKey::ClawbackConfig(asset.clone()));
        extend_instance_ttl(&env);

        ClawbackDisabled {
            asset,
            disabled_at: env.ledger().timestamp(),
        }
        .publish(&env);
        Ok(())
    }

    /// Execute a clawback: transfer `amount` of `asset` from `from` back to
    /// the token issuer. Only the configured `authority` for this asset may
    /// call this. Fails with:
    ///
    /// * `Error::ConfigNotFound` — the asset has no clawback config.
    /// * `Error::ClawbackDisabled` — clawback is not enabled for this asset.
    /// * `Error::Unauthorized` — `authority` does not match the stored authority.
    /// * `Error::InvalidAmount` — `amount` is zero or negative.
    /// * `Error::InvalidReason` — `reason_required` is true but `reason` is empty.
    ///
    /// Creates a `ClawbackRecord` and emits a `ClawbackExecuted` event.
    pub fn execute_clawback(
        env: Env,
        authority: Address,
        from: Address,
        asset: Address,
        amount: i128,
        reason: String,
    ) -> Result<ClawbackRecord, Error> {
        let config: ClawbackConfig = env
            .storage()
            .persistent()
            .get(&DataKey::ClawbackConfig(asset.clone()))
            .ok_or(Error::ConfigNotFound)?;

        if !config.enabled {
            return Err(Error::ClawbackDisabled);
        }
        if authority != config.authority {
            return Err(Error::Unauthorized);
        }
        authority.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if config.reason_required && reason.len() == 0 {
            return Err(Error::InvalidReason);
        }

        let record_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextRecordId)
            .ok_or(Error::NotInitialized)?;

        let now = env.ledger().timestamp();

        // Execute the token clawback — this transfers `amount` of `asset`
        // from `from` to the token admin (issuer). The contract must be the
        // clawback authority on the Stellar Asset Contract token.
        StellarAssetClient::new(&env, &asset).clawback(&from, &amount);

        let record = ClawbackRecord {
            id: record_id,
            from_address: from.clone(),
            asset: asset.clone(),
            amount,
            authority: authority.clone(),
            reason: reason.clone(),
            timestamp: now,
        };

        env.storage()
            .persistent()
            .set(&DataKey::ClawbackRecord(record_id), &record);
        extend_persistent_ttl(&env, &DataKey::ClawbackRecord(record_id));

        let next_id = record_id.checked_add(1).ok_or(Error::Overflow)?;
        env.storage().instance().set(&DataKey::NextRecordId, &next_id);
        extend_instance_ttl(&env);

        ClawbackExecuted {
            from,
            asset,
            amount,
            authority,
            reason,
            record_id,
        }
        .publish(&env);
        Ok(record)
    }

    /// Read the `ClawbackConfig` for `asset`, or `None` if no config has
    /// been set.
    pub fn get_clawback_config(env: Env, asset: Address) -> Option<ClawbackConfig> {
        env.storage()
            .persistent()
            .get(&DataKey::ClawbackConfig(asset))
    }

    /// Return the most recent `limit` clawback records, ordered newest-first.
    /// Returns fewer records than `limit` if fewer exist.
    pub fn get_clawback_history(env: Env, limit: u32) -> Vec<ClawbackRecord> {
        let next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextRecordId)
            .unwrap_or(1);

        let max_records = if limit <= 0 { 0 } else { limit };
        let count = (next_id - 1).min(max_records as u64);
        let mut records: Vec<ClawbackRecord> = Vec::new(&env);

        for i in 0..count {
            let id = next_id - 1 - i;
            if let Some(record) = env
                .storage()
                .persistent()
                .get::<DataKey, ClawbackRecord>(&DataKey::ClawbackRecord(id))
            {
                records.push_back(record);
            }
        }

        records
    }
}

#[cfg(test)]
mod test;
