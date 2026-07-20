#![no_std]
//! FX Swap — Soroban contract for atomic asset swaps and liquidity pools.
//!
//! Provides automated market maker (AMM) functionality using the constant product
//! formula (x * y = k) for FX currency pairs and digital assets on Stellar/Soroban.

use afri_contract_shared::{
    extend_instance_ttl, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token::TokenClient,
    Address, Env, MuxedAddress,
};

/// Errors returned by the FX Swap contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract is already initialized.
    AlreadyInitialized = 1,
    /// Contract is not yet initialized.
    NotInitialized = 2,
    /// Caller is not authorized.
    Unauthorized = 3,
    /// Amount passed is non-positive or invalid.
    InvalidAmount = 4,
    /// Assets in pair must be distinct.
    IdenticalAssets = 5,
    /// Specified liquidity pool does not exist.
    PoolNotFound = 6,
    /// Pool has zero liquidity.
    InsufficientLiquidity = 7,
    /// LP has insufficient LP token shares to burn.
    InsufficientShares = 8,
    /// Swap output is less than specified `min_amount_out`.
    SlippageExceeded = 9,
    /// Arithmetic operation overflowed.
    Overflow = 10,
    /// Pool for the given asset pair already exists.
    PoolAlreadyExists = 11,
}

/// Liquidity pool state for an asset pair (asset_a < asset_b).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pool {
    pub asset_a: Address,
    pub asset_b: Address,
    pub reserve_a: i128,
    pub reserve_b: i128,
    pub total_shares: i128,
}

/// Storage keys used by the FX Swap contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The admin address of the contract.
    Admin,
    /// Pool state for `(asset_a, asset_b)` pair.
    Pool(Address, Address),
    /// LP share balance for `(lp, asset_a, asset_b)`.
    LpShares(Address, Address, Address),
}

/// Emitted when a pool is created or configured.
#[contractevent(topics = ["fx_swap", "set_pool"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolSet {
    #[topic]
    pub asset_a: Address,
    #[topic]
    pub asset_b: Address,
}

/// Emitted when liquidity is added to a pool.
#[contractevent(topics = ["fx_swap", "add_liq"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityAdded {
    #[topic]
    pub lp: Address,
    #[topic]
    pub asset_a: Address,
    #[topic]
    pub asset_b: Address,
    pub amount_a: i128,
    pub amount_b: i128,
    pub shares: i128,
}

/// Emitted when liquidity is removed from a pool.
#[contractevent(topics = ["fx_swap", "rem_liq"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityRemoved {
    #[topic]
    pub lp: Address,
    #[topic]
    pub asset_a: Address,
    #[topic]
    pub asset_b: Address,
    pub amount_a: i128,
    pub amount_b: i128,
    pub shares: i128,
}

/// Emitted when an atomic asset swap occurs.
#[contractevent(topics = ["fx_swap", "swap"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Swapped {
    #[topic]
    pub user: Address,
    #[topic]
    pub asset_in: Address,
    #[topic]
    pub asset_out: Address,
    pub amount_in: i128,
    pub amount_out: i128,
}

/// Extends TTL for persistent storage keys.
fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Deterministically sort asset pair so `asset_0 < asset_1`.
/// Returns `(asset_0, asset_1, is_reversed)`.
pub fn sort_assets(
    asset_a: &Address,
    asset_b: &Address,
) -> Result<(Address, Address, bool), Error> {
    if asset_a == asset_b {
        return Err(Error::IdenticalAssets);
    }
    if asset_a < asset_b {
        Ok((asset_a.clone(), asset_b.clone(), false))
    } else {
        Ok((asset_b.clone(), asset_a.clone(), true))
    }
}

/// Integer square root calculation via Newton's method.
fn integer_sqrt(y: i128) -> i128 {
    if y <= 0 {
        return 0;
    }
    let mut z = y;
    let mut x = y / 2 + 1;
    while x < z {
        z = x;
        x = (y / x + x) / 2;
    }
    z
}

#[contract]
pub struct FXSwapContract;

#[contractimpl]
impl FXSwapContract {
    /// Initialize contract with `admin` address.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Admin-initialized setting of liquidity pool for an asset pair.
    pub fn set_pool(
        env: Env,
        admin: Address,
        asset_a: Address,
        asset_b: Address,
    ) -> Result<(), Error> {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }
        admin.require_auth();

        let (asset_0, asset_1, _) = sort_assets(&asset_a, &asset_b)?;
        let pool_key = DataKey::Pool(asset_0.clone(), asset_1.clone());
        if env.storage().persistent().has(&pool_key) {
            return Err(Error::PoolAlreadyExists);
        }

        let pool = Pool {
            asset_a: asset_0.clone(),
            asset_b: asset_1.clone(),
            reserve_a: 0,
            reserve_b: 0,
            total_shares: 0,
        };
        env.storage().persistent().set(&pool_key, &pool);
        extend_persistent_ttl(&env, &pool_key);
        extend_instance_ttl(&env);

        PoolSet {
            asset_a: asset_0,
            asset_b: asset_1,
        }
        .publish(&env);

        Ok(())
    }

    /// Add liquidity to a pool, minting LP tokens to `lp`.
    pub fn add_liquidity(
        env: Env,
        lp: Address,
        asset_a: Address,
        amount_a: i128,
        asset_b: Address,
        amount_b: i128,
    ) -> Result<i128, Error> {
        if amount_a <= 0 || amount_b <= 0 {
            return Err(Error::InvalidAmount);
        }
        lp.require_auth();

        let (asset_0, asset_1, is_reversed) = sort_assets(&asset_a, &asset_b)?;
        let (amt_0, amt_1) = if !is_reversed {
            (amount_a, amount_b)
        } else {
            (amount_b, amount_a)
        };

        let pool_key = DataKey::Pool(asset_0.clone(), asset_1.clone());
        let mut pool: Pool = env.storage().persistent().get(&pool_key).unwrap_or(Pool {
            asset_a: asset_0.clone(),
            asset_b: asset_1.clone(),
            reserve_a: 0,
            reserve_b: 0,
            total_shares: 0,
        });

        let shares_minted = if pool.total_shares == 0 {
            let product = amt_0.checked_mul(amt_1).ok_or(Error::Overflow)?;
            integer_sqrt(product)
        } else {
            let share_0 = amt_0
                .checked_mul(pool.total_shares)
                .ok_or(Error::Overflow)?
                .checked_div(pool.reserve_a)
                .ok_or(Error::Overflow)?;
            let share_1 = amt_1
                .checked_mul(pool.total_shares)
                .ok_or(Error::Overflow)?
                .checked_div(pool.reserve_b)
                .ok_or(Error::Overflow)?;
            if share_0 < share_1 {
                share_0
            } else {
                share_1
            }
        };

        if shares_minted <= 0 {
            return Err(Error::InvalidAmount);
        }

        // Transfer tokens from LP to contract
        TokenClient::new(&env, &asset_a).transfer(
            &lp,
            MuxedAddress::from(env.current_contract_address()),
            &amount_a,
        );
        TokenClient::new(&env, &asset_b).transfer(
            &lp,
            MuxedAddress::from(env.current_contract_address()),
            &amount_b,
        );

        pool.reserve_a = pool.reserve_a.checked_add(amt_0).ok_or(Error::Overflow)?;
        pool.reserve_b = pool.reserve_b.checked_add(amt_1).ok_or(Error::Overflow)?;
        pool.total_shares = pool
            .total_shares
            .checked_add(shares_minted)
            .ok_or(Error::Overflow)?;

        env.storage().persistent().set(&pool_key, &pool);
        extend_persistent_ttl(&env, &pool_key);

        let lp_key = DataKey::LpShares(lp.clone(), asset_0.clone(), asset_1.clone());
        let current_lp_shares: i128 = env.storage().persistent().get(&lp_key).unwrap_or(0);
        let new_lp_shares = current_lp_shares
            .checked_add(shares_minted)
            .ok_or(Error::Overflow)?;
        env.storage().persistent().set(&lp_key, &new_lp_shares);
        extend_persistent_ttl(&env, &lp_key);

        extend_instance_ttl(&env);

        LiquidityAdded {
            lp,
            asset_a: asset_0,
            asset_b: asset_1,
            amount_a: amt_0,
            amount_b: amt_1,
            shares: shares_minted,
        }
        .publish(&env);

        Ok(shares_minted)
    }

    /// Remove liquidity from a pool by burning `liquidity_tokens` LP shares.
    pub fn remove_liquidity(
        env: Env,
        lp: Address,
        asset_a: Address,
        asset_b: Address,
        liquidity_tokens: i128,
    ) -> Result<(i128, i128), Error> {
        if liquidity_tokens <= 0 {
            return Err(Error::InvalidAmount);
        }
        lp.require_auth();

        let (asset_0, asset_1, is_reversed) = sort_assets(&asset_a, &asset_b)?;
        let pool_key = DataKey::Pool(asset_0.clone(), asset_1.clone());
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .ok_or(Error::PoolNotFound)?;

        let lp_key = DataKey::LpShares(lp.clone(), asset_0.clone(), asset_1.clone());
        let current_lp_shares: i128 = env
            .storage()
            .persistent()
            .get(&lp_key)
            .ok_or(Error::InsufficientShares)?;

        if current_lp_shares < liquidity_tokens {
            return Err(Error::InsufficientShares);
        }

        if pool.total_shares == 0 {
            return Err(Error::InsufficientLiquidity);
        }

        let amt_0 = liquidity_tokens
            .checked_mul(pool.reserve_a)
            .ok_or(Error::Overflow)?
            .checked_div(pool.total_shares)
            .ok_or(Error::Overflow)?;
        let amt_1 = liquidity_tokens
            .checked_mul(pool.reserve_b)
            .ok_or(Error::Overflow)?
            .checked_div(pool.total_shares)
            .ok_or(Error::Overflow)?;

        if amt_0 <= 0 || amt_1 <= 0 {
            return Err(Error::InvalidAmount);
        }

        pool.reserve_a = pool.reserve_a.checked_sub(amt_0).ok_or(Error::Overflow)?;
        pool.reserve_b = pool.reserve_b.checked_sub(amt_1).ok_or(Error::Overflow)?;
        pool.total_shares = pool
            .total_shares
            .checked_sub(liquidity_tokens)
            .ok_or(Error::Overflow)?;

        env.storage().persistent().set(&pool_key, &pool);
        extend_persistent_ttl(&env, &pool_key);

        let new_lp_shares = current_lp_shares
            .checked_sub(liquidity_tokens)
            .ok_or(Error::Overflow)?;
        env.storage().persistent().set(&lp_key, &new_lp_shares);
        extend_persistent_ttl(&env, &lp_key);

        extend_instance_ttl(&env);

        let (amount_a_out, amount_b_out) = if !is_reversed {
            (amt_0, amt_1)
        } else {
            (amt_1, amt_0)
        };

        TokenClient::new(&env, &asset_a).transfer(
            &env.current_contract_address(),
            MuxedAddress::from(lp.clone()),
            &amount_a_out,
        );
        TokenClient::new(&env, &asset_b).transfer(
            &env.current_contract_address(),
            MuxedAddress::from(lp.clone()),
            &amount_b_out,
        );

        LiquidityRemoved {
            lp,
            asset_a: asset_0,
            asset_b: asset_1,
            amount_a: amt_0,
            amount_b: amt_1,
            shares: liquidity_tokens,
        }
        .publish(&env);

        Ok((amount_a_out, amount_b_out))
    }

    /// Calculate expected `amount_out` for `amount_in` without executing swap.
    pub fn get_quote(
        env: Env,
        asset_in: Address,
        amount_in: i128,
        asset_out: Address,
    ) -> Result<i128, Error> {
        if amount_in <= 0 {
            return Err(Error::InvalidAmount);
        }

        let (asset_0, asset_1, is_reversed) = sort_assets(&asset_in, &asset_out)?;
        let pool_key = DataKey::Pool(asset_0, asset_1);
        let pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .ok_or(Error::PoolNotFound)?;

        let (reserve_in, reserve_out) = if !is_reversed {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };

        if reserve_in <= 0 || reserve_out <= 0 {
            return Err(Error::InsufficientLiquidity);
        }

        let numerator = amount_in.checked_mul(reserve_out).ok_or(Error::Overflow)?;
        let denominator = reserve_in.checked_add(amount_in).ok_or(Error::Overflow)?;
        let amount_out = numerator.checked_div(denominator).ok_or(Error::Overflow)?;

        Ok(amount_out)
    }

    /// Perform atomic swap from `asset_in` to `asset_out` with slippage protection.
    pub fn swap(
        env: Env,
        user: Address,
        asset_in: Address,
        amount_in: i128,
        asset_out: Address,
        min_amount_out: i128,
    ) -> Result<i128, Error> {
        if amount_in <= 0 {
            return Err(Error::InvalidAmount);
        }
        user.require_auth();

        let amount_out =
            Self::get_quote(env.clone(), asset_in.clone(), amount_in, asset_out.clone())?;

        if amount_out < min_amount_out {
            return Err(Error::SlippageExceeded);
        }

        if amount_out <= 0 {
            return Err(Error::InvalidAmount);
        }

        let (asset_0, asset_1, is_reversed) = sort_assets(&asset_in, &asset_out)?;
        let pool_key = DataKey::Pool(asset_0, asset_1);
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .ok_or(Error::PoolNotFound)?;

        if !is_reversed {
            pool.reserve_a = pool
                .reserve_a
                .checked_add(amount_in)
                .ok_or(Error::Overflow)?;
            pool.reserve_b = pool
                .reserve_b
                .checked_sub(amount_out)
                .ok_or(Error::Overflow)?;
        } else {
            pool.reserve_b = pool
                .reserve_b
                .checked_add(amount_in)
                .ok_or(Error::Overflow)?;
            pool.reserve_a = pool
                .reserve_a
                .checked_sub(amount_out)
                .ok_or(Error::Overflow)?;
        }

        env.storage().persistent().set(&pool_key, &pool);
        extend_persistent_ttl(&env, &pool_key);
        extend_instance_ttl(&env);

        TokenClient::new(&env, &asset_in).transfer(
            &user,
            MuxedAddress::from(env.current_contract_address()),
            &amount_in,
        );
        TokenClient::new(&env, &asset_out).transfer(
            &env.current_contract_address(),
            MuxedAddress::from(user.clone()),
            &amount_out,
        );

        Swapped {
            user,
            asset_in,
            amount_in,
            asset_out,
            amount_out,
        }
        .publish(&env);

        Ok(amount_out)
    }

    /// Read pool details for `(asset_a, asset_b)`.
    pub fn get_pool(env: Env, asset_a: Address, asset_b: Address) -> Result<Pool, Error> {
        let (asset_0, asset_1, _) = sort_assets(&asset_a, &asset_b)?;
        let pool_key = DataKey::Pool(asset_0, asset_1);
        env.storage()
            .persistent()
            .get(&pool_key)
            .ok_or(Error::PoolNotFound)
    }

    /// Read LP share balance for `(lp, asset_a, asset_b)`.
    pub fn get_liquidity(env: Env, lp: Address, asset_a: Address, asset_b: Address) -> i128 {
        if let Ok((asset_0, asset_1, _)) = sort_assets(&asset_a, &asset_b) {
            let lp_key = DataKey::LpShares(lp, asset_0, asset_1);
            env.storage().persistent().get(&lp_key).unwrap_or(0)
        } else {
            0
        }
    }
}

#[cfg(test)]
mod test;
