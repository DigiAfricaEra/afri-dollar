#![no_std]
//! Oracle contract for AfriDollar external price feed integration.

use afri_contract_shared::{
    extend_instance_ttl, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, Address, Env,
    Symbol, Vec,
};

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PriceData {
    pub asset_a: Address,
    pub asset_b: Address,
    pub price: i128,
    pub decimals: u32,
    pub timestamp: u64,
    pub provider: Address,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct OracleConfig {
    pub provider: Address,
    pub authorized: bool,
    pub last_heartbeat: u64,
    pub max_staleness_seconds: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    ProviderNotRegistered = 4,
    ProviderAlreadyRegistered = 5,
    ProviderInactive = 6,
    InvalidPrice = 7,
    PriceNotFound = 8,
    PriceStale = 9,
    DecimalMismatch = 10,
    Overflow = 11,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Provider(Address),
    Providers,
    Price(Address, Address, Address),
}

#[contractevent(topics = ["oracle", "provider"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderEvent {
    #[topic]
    pub action: Symbol,
    #[topic]
    pub provider: Address,
    pub authorized: bool,
    pub max_staleness_seconds: u64,
}

#[contractevent(topics = ["oracle", "price"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceSubmitted {
    #[topic]
    pub provider: Address,
    #[topic]
    pub asset_a: Address,
    #[topic]
    pub asset_b: Address,
    pub price: i128,
    pub decimals: u32,
    pub timestamp: u64,
}

fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn require_admin(env: &Env, admin: &Address) -> Result<(), OracleError> {
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(OracleError::NotInitialized)?;
    if *admin != stored_admin {
        return Err(OracleError::Unauthorized);
    }
    admin.require_auth();
    Ok(())
}

fn read_provider(env: &Env, provider: &Address) -> Result<OracleConfig, OracleError> {
    env.storage()
        .persistent()
        .get(&DataKey::Provider(provider.clone()))
        .ok_or(OracleError::ProviderNotRegistered)
}

fn write_provider(env: &Env, config: &OracleConfig) {
    let key = DataKey::Provider(config.provider.clone());
    env.storage().persistent().set(&key, config);
    extend_persistent_ttl(env, &key);
}

fn is_active(now: u64, config: &OracleConfig) -> bool {
    now.saturating_sub(config.last_heartbeat) <= config.max_staleness_seconds
}

fn validate_provider(env: &Env, provider: &Address) -> Result<OracleConfig, OracleError> {
    let config = read_provider(env, provider)?;
    if !config.authorized {
        return Err(OracleError::Unauthorized);
    }
    if !is_active(env.ledger().timestamp(), &config) {
        return Err(OracleError::ProviderInactive);
    }
    Ok(config)
}

fn ensure_fresh(env: &Env, price: &PriceData, config: &OracleConfig) -> Result<(), OracleError> {
    if env.ledger().timestamp().saturating_sub(price.timestamp) > config.max_staleness_seconds {
        return Err(OracleError::PriceStale);
    }
    Ok(())
}

fn providers(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::Providers)
        .unwrap_or(Vec::new(env))
}

fn put_providers(env: &Env, providers: &Vec<Address>) {
    env.storage().instance().set(&DataKey::Providers, providers);
}

fn canonical_pair(asset_a: Address, asset_b: Address) -> (Address, Address) {
    if asset_a <= asset_b {
        (asset_a, asset_b)
    } else {
        (asset_b, asset_a)
    }
}

fn price_key(asset_a: Address, asset_b: Address, provider: Address) -> DataKey {
    let (asset_a, asset_b) = canonical_pair(asset_a, asset_b);
    DataKey::Price(asset_a, asset_b, provider)
}

#[contract]
pub struct OracleContract;

#[contractimpl]
impl OracleContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), OracleError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(OracleError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Providers, &Vec::<Address>::new(&env));
        extend_instance_ttl(&env);
        Ok(())
    }

    pub fn register_provider(
        env: Env,
        admin: Address,
        provider: Address,
        max_staleness_seconds: u64,
    ) -> Result<(), OracleError> {
        require_admin(&env, &admin)?;

        if env
            .storage()
            .persistent()
            .has(&DataKey::Provider(provider.clone()))
        {
            return Err(OracleError::ProviderAlreadyRegistered);
        }

        let config = OracleConfig {
            provider: provider.clone(),
            authorized: false,
            last_heartbeat: env.ledger().timestamp(),
            max_staleness_seconds,
        };
        write_provider(&env, &config);

        let mut all_providers = providers(&env);
        all_providers.push_back(provider.clone());
        put_providers(&env, &all_providers);
        extend_instance_ttl(&env);

        ProviderEvent {
            action: symbol_short!("reg"),
            provider,
            authorized: false,
            max_staleness_seconds,
        }
        .publish(&env);
        Ok(())
    }

    pub fn authorize_provider(
        env: Env,
        admin: Address,
        provider: Address,
    ) -> Result<(), OracleError> {
        require_admin(&env, &admin)?;
        let mut config = read_provider(&env, &provider)?;
        config.authorized = true;
        write_provider(&env, &config);
        extend_instance_ttl(&env);

        ProviderEvent {
            action: symbol_short!("auth"),
            provider,
            authorized: true,
            max_staleness_seconds: config.max_staleness_seconds,
        }
        .publish(&env);
        Ok(())
    }

    pub fn revoke_provider(env: Env, admin: Address, provider: Address) -> Result<(), OracleError> {
        require_admin(&env, &admin)?;
        let mut config = read_provider(&env, &provider)?;
        config.authorized = false;
        write_provider(&env, &config);
        extend_instance_ttl(&env);

        ProviderEvent {
            action: symbol_short!("revoke"),
            provider,
            authorized: false,
            max_staleness_seconds: config.max_staleness_seconds,
        }
        .publish(&env);
        Ok(())
    }

    pub fn submit_price(
        env: Env,
        provider: Address,
        asset_a: Address,
        asset_b: Address,
        price: i128,
        decimals: u32,
    ) -> Result<(), OracleError> {
        provider.require_auth();
        validate_provider(&env, &provider)?;
        if price <= 0 {
            return Err(OracleError::InvalidPrice);
        }

        let (asset_a, asset_b) = canonical_pair(asset_a, asset_b);
        let timestamp = env.ledger().timestamp();
        let data = PriceData {
            asset_a: asset_a.clone(),
            asset_b: asset_b.clone(),
            price,
            decimals,
            timestamp,
            provider: provider.clone(),
        };
        let key = price_key(asset_a.clone(), asset_b.clone(), provider.clone());
        env.storage().persistent().set(&key, &data);
        extend_persistent_ttl(&env, &key);
        extend_instance_ttl(&env);

        PriceSubmitted {
            provider,
            asset_a,
            asset_b,
            price,
            decimals,
            timestamp,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_price(
        env: Env,
        asset_a: Address,
        asset_b: Address,
    ) -> Result<PriceData, OracleError> {
        let (asset_a, asset_b) = canonical_pair(asset_a, asset_b);
        let mut newest: Option<PriceData> = None;
        for provider in providers(&env).iter() {
            let Ok(config) = validate_provider(&env, &provider) else {
                continue;
            };
            let Some(price) = env.storage().persistent().get::<_, PriceData>(&price_key(
                asset_a.clone(),
                asset_b.clone(),
                provider.clone(),
            )) else {
                continue;
            };
            if ensure_fresh(&env, &price, &config).is_err() {
                continue;
            }
            if newest
                .as_ref()
                .map(|current| price.timestamp > current.timestamp)
                .unwrap_or(true)
            {
                newest = Some(price);
            }
        }
        newest.ok_or(OracleError::PriceNotFound)
    }

    pub fn heartbeat(env: Env, provider: Address) -> Result<(), OracleError> {
        provider.require_auth();
        let mut config = read_provider(&env, &provider)?;
        config.last_heartbeat = env.ledger().timestamp();
        write_provider(&env, &config);
        extend_instance_ttl(&env);

        ProviderEvent {
            action: symbol_short!("beat"),
            provider,
            authorized: config.authorized,
            max_staleness_seconds: config.max_staleness_seconds,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_aggregated_price(
        env: Env,
        asset_a: Address,
        asset_b: Address,
    ) -> Result<PriceData, OracleError> {
        let (asset_a, asset_b) = canonical_pair(asset_a, asset_b);
        let mut total: i128 = 0;
        let mut count: i128 = 0;
        let mut decimals: Option<u32> = None;
        let mut newest_timestamp = 0u64;
        let mut newest_provider: Option<Address> = None;

        for provider in providers(&env).iter() {
            let Ok(config) = validate_provider(&env, &provider) else {
                continue;
            };
            let Some(price) = env.storage().persistent().get::<_, PriceData>(&price_key(
                asset_a.clone(),
                asset_b.clone(),
                provider.clone(),
            )) else {
                continue;
            };
            if ensure_fresh(&env, &price, &config).is_err() {
                continue;
            }
            if let Some(existing_decimals) = decimals {
                if existing_decimals != price.decimals {
                    return Err(OracleError::DecimalMismatch);
                }
            } else {
                decimals = Some(price.decimals);
            }
            total = total
                .checked_add(price.price)
                .ok_or(OracleError::Overflow)?;
            count = count.checked_add(1).ok_or(OracleError::Overflow)?;
            if price.timestamp >= newest_timestamp {
                newest_timestamp = price.timestamp;
                newest_provider = Some(price.provider.clone());
            }
        }

        let decimals = decimals.ok_or(OracleError::PriceNotFound)?;
        let provider = newest_provider.ok_or(OracleError::PriceNotFound)?;
        Ok(PriceData {
            asset_a,
            asset_b,
            price: total.checked_div(count).ok_or(OracleError::Overflow)?,
            decimals,
            timestamp: newest_timestamp,
            provider,
        })
    }

    pub fn get_provider(env: Env, provider: Address) -> Result<OracleConfig, OracleError> {
        read_provider(&env, &provider)
    }

    pub fn is_provider_active(env: Env, provider: Address) -> Result<bool, OracleError> {
        let config = read_provider(&env, &provider)?;
        Ok(config.authorized && is_active(env.ledger().timestamp(), &config))
    }
}
