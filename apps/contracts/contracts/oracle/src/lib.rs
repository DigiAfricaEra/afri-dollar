#![no_std]
//! Oracle — price feed integration contract for AfriDollar.
//!
//! Provides reliable price data for FX swaps, valuations, and collateral
//! calculations by aggregating prices from multiple authorized oracle
//! providers on-chain.
//!
//! ## Core features
//!
//! * **Provider management** — register, authorize, and revoke oracle
//!   providers with per-provider staleness thresholds.
//! * **Price submission** — authorized providers submit price updates for
//!   any asset pair.
//! * **Price queries** — read the latest price for an asset pair from a
//!   specific provider, or fetch a median-aggregated price across all
//!   authorized providers.
//! * **Staleness enforcement** — prices older than a provider's configured
//!   `max_staleness_seconds` are automatically rejected on submission and
//!   filtered out of aggregation.
//! * **Heartbeat monitoring** — providers call `heartbeat` to signal they
//!   are live; a stale heartbeat (no call within `max_staleness_seconds`)
//!   flags the provider as inactive so its prices are excluded from
//!   aggregation until it heartbeats again.
//!
//! ## Data types
//!
//! * [`PriceData`] — a single price observation: asset pair, price,
//!   decimals, timestamp, and the provider that submitted it.
//! * [`OracleConfig`] — per-provider configuration: authorization status,
//!   last heartbeat, and max staleness window.
//!
//! ## Acceptance criteria (see issue #118)
//!
//! 1. Only authorized providers can submit prices.
//! 2. Stale prices are rejected.
//! 3. Aggregation works with multiple providers.
//! 4. Heartbeat monitoring detects inactive providers.

use afri_contract_shared::{
    extend_instance_ttl, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, vec, Address, Env, Vec,
};

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/// Errors returned by the oracle contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` was called on a contract that already has an admin.
    AlreadyInitialized = 1,
    /// An operation was attempted before the contract was initialized.
    NotInitialized = 2,
    /// The caller is not authorized (wrong admin, or unauthorized provider).
    Unauthorized = 3,
    /// The provider is already registered.
    ProviderAlreadyRegistered = 4,
    /// The provider is not registered.
    ProviderNotRegistered = 5,
    /// The price is stale (timestamp too old relative to provider's
    /// `max_staleness_seconds`).
    PriceStale = 6,
    /// Invalid amount or parameter (e.g. negative price, zero address).
    InvalidAmount = 7,
    /// Arithmetic overflow during price aggregation.
    Overflow = 8,
    /// No valid price available for the requested asset pair (no authorized
    /// provider has submitted a recent enough price).
    NoValidPrice = 9,
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// A single price observation submitted by a provider.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    /// Base asset of the pair (the asset being priced).
    pub asset_a: Address,
    /// Quote asset of the pair (the denominating asset).
    pub asset_b: Address,
    /// Price: how many units of `asset_b` one unit of `asset_a` is worth.
    pub price: i128,
    /// Number of decimals the `price` field carries.
    pub decimals: u32,
    /// UNIX timestamp (seconds) when this price was submitted.
    pub timestamp: u64,
    /// The provider that submitted this price.
    pub provider: Address,
}

/// Per-provider oracle configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleConfig {
    /// The provider address this config governs.
    pub provider: Address,
    /// Whether the provider is authorized to submit prices.
    pub authorized: bool,
    /// UNIX timestamp (seconds) of the provider's last heartbeat.
    pub last_heartbeat: u64,
    /// Maximum age (in seconds) a price from this provider may have before
    /// it is considered stale and rejected.
    pub max_staleness_seconds: u64,
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// The address allowed to perform privileged operations.
    Admin,
    /// `OracleConfig` for a given provider.
    Config(Address),
    /// `PriceData` for a given (asset_a, asset_b, provider) tuple.
    Price(Address, Address, Address),
    /// List of providers that have submitted a price for a given
    /// (asset_a, asset_b) pair. Stored as a `Vec<Address>`.
    Providers(Address, Address),
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Emitted when the admin registers a new provider.
#[contractevent(topics = ["oracle", "prov_reg"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRegistered {
    #[topic]
    pub provider: Address,
    pub max_staleness_seconds: u64,
}

/// Emitted when an admin authorizes a previously registered provider.
#[contractevent(topics = ["oracle", "prov_auth"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderAuthorized {
    #[topic]
    pub provider: Address,
    pub timestamp: u64,
}

/// Emitted when an admin revokes a provider's authorization.
#[contractevent(topics = ["oracle", "prov_rev"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRevoked {
    #[topic]
    pub provider: Address,
    pub timestamp: u64,
}

/// Emitted when an authorized provider submits a price.
#[contractevent(topics = ["oracle", "price_set"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceSubmitted {
    #[topic]
    pub asset_a: Address,
    pub asset_b: Address,
    pub price: i128,
    pub decimals: u32,
    #[topic]
    pub provider: Address,
}

/// Emitted when a provider sends a heartbeat.
#[contractevent(topics = ["oracle", "heartbeat"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HeartbeatUpdated {
    #[topic]
    pub provider: Address,
    pub timestamp: u64,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extend the TTL of a persistent storage entry.
fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Verify `caller` is the stored admin and that they have authorized the
/// invocation. Returns `Error::NotInitialized` if the contract has no
/// admin, or `Error::Unauthorized` if `caller` is not the admin.
fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    if *caller != admin {
        return Err(Error::Unauthorized);
    }
    caller.require_auth();
    Ok(())
}

/// Return `true` if `provider` is registered and authorized, and its most
/// recent heartbeat is within `max_staleness_seconds` of `now`.
fn is_provider_active(config: &OracleConfig, now: u64) -> bool {
    if !config.authorized {
        return false;
    }
    now.saturating_sub(config.last_heartbeat) <= config.max_staleness_seconds
}

/// Read a provider's config. Returns `Error::ProviderNotRegistered` if no
/// config exists.
fn read_config(env: &Env, provider: &Address) -> Result<OracleConfig, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Config(provider.clone()))
        .ok_or(Error::ProviderNotRegistered)
}

/// Collect all authorized, non-stale prices for an asset pair. Returns a
/// sorted (ascending) `Vec<i128>` suitable for median computation.
fn collect_prices(env: &Env, asset_a: &Address, asset_b: &Address) -> Vec<i128> {
    let now = env.ledger().timestamp();
    let providers: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::Providers(asset_a.clone(), asset_b.clone()))
        .unwrap_or_else(|| vec![env]);

    let mut prices: Vec<i128> = vec![env];
    for provider in providers.iter() {
        let config: OracleConfig = match env
            .storage()
            .persistent()
            .get(&DataKey::Config(provider.clone()))
        {
            Some(c) => c,
            None => continue,
        };
        if !is_provider_active(&config, now) {
            continue;
        }
        if let Some(price_data) = env.storage().persistent().get(&DataKey::Price(
            asset_a.clone(),
            asset_b.clone(),
            provider.clone(),
        )) {
            let price_data: PriceData = price_data;
            let age = now.saturating_sub(price_data.timestamp);
            if age <= config.max_staleness_seconds {
                prices.push_back(price_data.price);
            }
        }
    }

    // Sort ascending for median computation.
    // Simple bubble sort for `Vec<i128>`.
    let len = prices.len();
    for i in 0..len {
        for j in 0..len.saturating_sub(1).saturating_sub(i) {
            let a = prices.get(j).unwrap();
            let b = prices.get(j + 1).unwrap();
            if a > b {
                prices.set(j, b);
                prices.set(j + 1, a);
            }
        }
    }

    prices
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct OracleContract;

#[contractimpl]
impl OracleContract {
    /// Initialize the contract, recording `admin` as the only address
    /// permitted to manage providers. Requires `admin`'s authorization.
    /// Fails with [`Error::AlreadyInitialized`] if called twice.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Admin-only. Register a new oracle provider with the given
    /// `max_staleness_seconds`. The provider starts **unauthorized** — the
    /// admin must call [`authorize_provider`] before the provider can
    /// submit prices. Fails with [`Error::ProviderAlreadyRegistered`] if
    /// the provider already has a config.
    pub fn register_provider(
        env: Env,
        admin: Address,
        provider: Address,
        max_staleness_seconds: u64,
    ) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        if env
            .storage()
            .persistent()
            .has(&DataKey::Config(provider.clone()))
        {
            return Err(Error::ProviderAlreadyRegistered);
        }

        let config = OracleConfig {
            provider: provider.clone(),
            authorized: false,
            last_heartbeat: 0,
            max_staleness_seconds,
        };
        let key = DataKey::Config(provider.clone());
        env.storage().persistent().set(&key, &config);
        extend_persistent_ttl(&env, &key);
        extend_instance_ttl(&env);

        ProviderRegistered {
            provider,
            max_staleness_seconds,
        }
        .publish(&env);
        Ok(())
    }

    /// Admin-only. Authorize a previously registered provider so it can
    /// submit prices and be included in aggregation. Fails with
    /// [`Error::ProviderNotRegistered`] if the provider has no config.
    /// Does **not** require re-authorization if the provider is already
    /// authorized — the call succeeds silently in that case.
    pub fn authorize_provider(env: Env, admin: Address, provider: Address) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        let mut config = read_config(&env, &provider)?;
        config.authorized = true;
        let key = DataKey::Config(provider.clone());
        env.storage().persistent().set(&key, &config);
        extend_persistent_ttl(&env, &key);
        extend_instance_ttl(&env);

        ProviderAuthorized {
            provider,
            timestamp: env.ledger().timestamp(),
        }
        .publish(&env);
        Ok(())
    }

    /// Admin-only. Revoke a provider's authorization. The provider can no
    /// longer submit prices and its prices are excluded from aggregation.
    /// The provider's config remains so it can be re-authorized later.
    /// Fails with [`Error::ProviderNotRegistered`] if the provider has no
    /// config. Does **not** require the provider to currently be
    /// authorized — the call succeeds silently if already revoked.
    pub fn revoke_provider(env: Env, admin: Address, provider: Address) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        let mut config = read_config(&env, &provider)?;
        config.authorized = false;
        let key = DataKey::Config(provider.clone());
        env.storage().persistent().set(&key, &config);
        extend_persistent_ttl(&env, &key);
        extend_instance_ttl(&env);

        ProviderRevoked {
            provider,
            timestamp: env.ledger().timestamp(),
        }
        .publish(&env);
        Ok(())
    }

    /// Submit a price update for the given asset pair. Only an authorized,
    /// active (non-stale heartbeat) provider may call this. Requires
    /// `provider`'s authorization.
    ///
    /// The submitted price is stored and available immediately for
    /// aggregation and direct queries.
    ///
    /// Fails with [`Error::ProviderNotRegistered`] if the provider has no
    /// config, [`Error::Unauthorized`] if the provider is not authorized
    /// (or has a stale heartbeat), or [`Error::InvalidAmount`] if `price`
    /// is negative.
    pub fn submit_price(
        env: Env,
        provider: Address,
        asset_a: Address,
        asset_b: Address,
        price: i128,
        decimals: u32,
    ) -> Result<(), Error> {
        provider.require_auth();

        if price < 0 {
            return Err(Error::InvalidAmount);
        }

        let config = read_config(&env, &provider)?;
        let now = env.ledger().timestamp();

        if !is_provider_active(&config, now) {
            return Err(Error::Unauthorized);
        }

        // Reject if the provider's own last price is newer — prevents
        // accidental or malicious timestamp rewinding.
        if let Some(existing) = env.storage().persistent().get(&DataKey::Price(
            asset_a.clone(),
            asset_b.clone(),
            provider.clone(),
        )) {
            let existing: PriceData = existing;
            if now < existing.timestamp {
                return Err(Error::PriceStale);
            }
        }

        let price_data = PriceData {
            asset_a: asset_a.clone(),
            asset_b: asset_b.clone(),
            price,
            decimals,
            timestamp: now,
            provider: provider.clone(),
        };

        // Store price.
        let price_key = DataKey::Price(asset_a.clone(), asset_b.clone(), provider.clone());
        env.storage().persistent().set(&price_key, &price_data);
        extend_persistent_ttl(&env, &price_key);

        // Add provider to the provider list for this asset pair (if not already
        // present).
        let providers_key = DataKey::Providers(asset_a.clone(), asset_b.clone());
        let mut providers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&providers_key)
            .unwrap_or_else(|| vec![&env]);
        let mut found = false;
        for p in providers.iter() {
            if p == provider {
                found = true;
                break;
            }
        }
        if !found {
            providers.push_back(provider.clone());
            env.storage().persistent().set(&providers_key, &providers);
            extend_persistent_ttl(&env, &providers_key);
        }

        extend_instance_ttl(&env);

        PriceSubmitted {
            asset_a,
            asset_b,
            price,
            decimals,
            provider,
        }
        .publish(&env);
        Ok(())
    }

    /// Return the latest price for `(asset_a, asset_b)` from a specific
    /// `provider`. The price is **not** checked for staleness in this
    /// view — callers that require staleness enforcement should check
    /// `price.timestamp` against the provider's config themselves, or
    /// prefer [`get_aggregated_price`].
    ///
    /// Returns `None` if the provider has never submitted a price for this
    /// pair.
    pub fn get_price(
        env: Env,
        asset_a: Address,
        asset_b: Address,
        provider: Address,
    ) -> Option<PriceData> {
        env.storage()
            .persistent()
            .get(&DataKey::Price(asset_a, asset_b, provider))
    }

    /// Return the **median** price across all authorized, non-stale
    /// providers for `(asset_a, asset_b)`.
    ///
    /// * If an odd number of valid prices exists, the exact middle is
    ///   returned.
    /// * If an even number exists, the **lower** of the two middle values
    ///   is returned (a conservative, manipulation-resistant choice).
    ///
    /// The returned [`PriceData`] carries the median `price`, the
    /// `decimals` of one of the contributing providers (since all
    /// providers should agree on decimals for a given pair), the current
    /// ledger timestamp, and the contract address as `provider` to
    /// distinguish aggregated data from a direct provider submission.
    ///
    /// Returns [`Error::NoValidPrice`] if no authorized, non-stale
    /// provider has submitted a price for this pair.
    pub fn get_aggregated_price(
        env: Env,
        asset_a: Address,
        asset_b: Address,
    ) -> Result<PriceData, Error> {
        let prices = collect_prices(&env, &asset_a, &asset_b);
        let count = prices.len();

        if count == 0 {
            return Err(Error::NoValidPrice);
        }

        // Median: odd -> exact middle; even -> lower middle.
        let median_idx = (count.saturating_sub(1)) / 2;
        let median_price = prices.get(median_idx).unwrap_or(0);

        // For decimals, sample any stored price to retrieve the decimals
        // value. All providers for the same pair should use the same
        // decimals.
        let decimals = {
            let providers: Vec<Address> = env
                .storage()
                .persistent()
                .get(&DataKey::Providers(asset_a.clone(), asset_b.clone()))
                .unwrap_or_else(|| vec![&env]);
            let mut dec = 0u32;
            for p in providers.iter() {
                if let Some(pd) = env.storage().persistent().get(&DataKey::Price(
                    asset_a.clone(),
                    asset_b.clone(),
                    p,
                )) {
                    let pd: PriceData = pd;
                    dec = pd.decimals;
                    break;
                }
            }
            dec
        };

        Ok(PriceData {
            asset_a,
            asset_b,
            price: median_price,
            decimals,
            timestamp: env.ledger().timestamp(),
            provider: env.current_contract_address(),
        })
    }

    /// Signal that the `provider` is alive. Requires `provider`'s
    /// authorization.
    ///
    /// Updates `OracleConfig::last_heartbeat` to the current ledger
    /// timestamp. If a provider misses its heartbeat window (i.e. no call
    /// for longer than `max_staleness_seconds`), it is considered inactive
    /// and its prices are excluded from aggregation until it heartbeats
    /// again.
    ///
    /// Fails with [`Error::ProviderNotRegistered`] if the provider has no
    /// config. Does **not** require the provider to be authorized — a
    /// revoked provider can still heartbeat so the admin can see liveness
    /// before re-authorizing.
    pub fn heartbeat(env: Env, provider: Address) -> Result<(), Error> {
        provider.require_auth();

        let mut config = read_config(&env, &provider)?;
        let now = env.ledger().timestamp();
        config.last_heartbeat = now;
        let key = DataKey::Config(provider.clone());
        env.storage().persistent().set(&key, &config);
        extend_persistent_ttl(&env, &key);
        extend_instance_ttl(&env);

        HeartbeatUpdated {
            provider,
            timestamp: now,
        }
        .publish(&env);
        Ok(())
    }

    /// Return the [`OracleConfig`] for a given provider, or `None` if the
    /// provider has not been registered.
    pub fn get_config(env: Env, provider: Address) -> Option<OracleConfig> {
        env.storage().persistent().get(&DataKey::Config(provider))
    }

    /// Return `true` if the provider is currently authorized, has sent a
    /// heartbeat within `max_staleness_seconds`, and is thus eligible to
    /// submit prices and be included in aggregation.
    pub fn is_active(env: Env, provider: Address) -> bool {
        match env.storage().persistent().get(&DataKey::Config(provider)) {
            Some(config) => is_provider_active(&config, env.ledger().timestamp()),
            None => false,
        }
    }

    /// Return the number of providers currently tracked for a given asset
    /// pair (regardless of authorization or staleness status).
    pub fn provider_count(env: Env, asset_a: Address, asset_b: Address) -> u32 {
        env.storage()
            .persistent()
            .get::<DataKey, Vec<Address>>(&DataKey::Providers(asset_a, asset_b))
            .map(|v| v.len())
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
