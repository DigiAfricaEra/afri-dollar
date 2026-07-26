#![no_std]

use afri_contract_shared::{
    extend_instance_ttl, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token::TokenClient,
    Address, Env, MuxedAddress,
};

const MINIMUM_LIQUIDITY: i128 = 1000;
const FEE_BPS: i128 = 30; // 0.3%
const FEE_DENOMINATOR: i128 = 10_000;

// ===========================================================================
// Errors
// ===========================================================================

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    PoolNotFound = 4,
    PoolAlreadyExists = 5,
    InvalidAmount = 6,
    InsufficientLiquidity = 7,
    SlippageExceeded = 8,
    MinimumLiquidity = 9,
    Overflow = 10,
}

// ===========================================================================
// Types
// ===========================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolInfo {
    pub pool_id: u64,
    pub asset_a: Address,
    pub asset_b: Address,
    pub reserve_a: i128,
    pub reserve_b: i128,
    pub lp_token_supply: i128,
}

// ===========================================================================
// Storage
// ===========================================================================

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    PoolCount,
    PoolId(Address, Address),
    Pool(u64),
    LpBalance(u64, Address),
}

// ===========================================================================
// Events
// ===========================================================================

#[contractevent(topics = ["fxswap", "pool_created"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolCreated {
    #[topic]
    pub pool_id: u64,
    #[topic]
    pub asset_a: Address,
    #[topic]
    pub asset_b: Address,
}

#[contractevent(topics = ["fxswap", "liquidity_added"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityAdded {
    #[topic]
    pub pool_id: u64,
    #[topic]
    pub provider: Address,
    pub amount_a: i128,
    pub amount_b: i128,
    pub lp_tokens: i128,
}

#[contractevent(topics = ["fxswap", "liquidity_removed"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityRemoved {
    #[topic]
    pub pool_id: u64,
    #[topic]
    pub provider: Address,
    pub amount_a: i128,
    pub amount_b: i128,
    pub lp_tokens: i128,
}

#[contractevent(topics = ["fxswap", "swap"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapExecuted {
    #[topic]
    pub pool_id: u64,
    #[topic]
    pub user: Address,
    pub asset_in: Address,
    pub amount_in: i128,
    pub asset_out: Address,
    pub amount_out: i128,
}

// ===========================================================================
// Storage helpers
// ===========================================================================

fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn require_admin(env: &Env, admin: &Address) -> Result<(), Error> {
    let stored: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    if *admin != stored {
        return Err(Error::Unauthorized);
    }
    admin.require_auth();
    Ok(())
}

fn canonical_pair(a: &Address, b: &Address) -> (Address, Address) {
    if a <= b {
        (a.clone(), b.clone())
    } else {
        (b.clone(), a.clone())
    }
}

fn pool_id_key(a: &Address, b: &Address) -> DataKey {
    let (ca, cb) = canonical_pair(a, b);
    DataKey::PoolId(ca, cb)
}

fn get_pool_id(env: &Env, a: &Address, b: &Address) -> Result<u64, Error> {
    env.storage()
        .persistent()
        .get(&pool_id_key(a, b))
        .ok_or(Error::PoolNotFound)
}

fn read_pool(env: &Env, pool_id: u64) -> Option<PoolInfo> {
    env.storage().persistent().get(&DataKey::Pool(pool_id))
}

fn write_pool(env: &Env, pool: &PoolInfo) {
    let key = DataKey::Pool(pool.pool_id);
    env.storage().persistent().set(&key, pool);
    extend_persistent_ttl(env, &key);
}

fn read_lp_balance(env: &Env, pool_id: u64, provider: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::LpBalance(pool_id, provider.clone()))
        .unwrap_or(0)
}

fn write_lp_balance(env: &Env, pool_id: u64, provider: &Address, amount: i128) {
    let key = DataKey::LpBalance(pool_id, provider.clone());
    if amount == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &amount);
        extend_persistent_ttl(env, &key);
    }
}

// ===========================================================================
// Math helpers
// ===========================================================================

fn sqrt(val: i128) -> i128 {
    if val <= 0 {
        return 0;
    }
    let uval = val as u128;
    let mut x = uval;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + uval / x) / 2;
    }
    x as i128
}

fn compute_amount_out(amount_in: i128, reserve_in: i128, reserve_out: i128) -> Result<i128, Error> {
    let amount_in_with_fee = amount_in
        .checked_mul(FEE_DENOMINATOR - FEE_BPS)
        .ok_or(Error::Overflow)?;
    let numerator = reserve_out
        .checked_mul(amount_in_with_fee)
        .ok_or(Error::Overflow)?;
    let denominator = reserve_in
        .checked_mul(FEE_DENOMINATOR)
        .ok_or(Error::Overflow)?
        .checked_add(amount_in_with_fee)
        .ok_or(Error::Overflow)?;
    numerator.checked_div(denominator).ok_or(Error::Overflow)
}

// ===========================================================================
// Contract
// ===========================================================================

#[contract]
pub struct FxSwapContract;

#[contractimpl]
impl FxSwapContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::PoolCount, &0u64);
        extend_instance_ttl(&env);
        Ok(())
    }

    pub fn set_liquidity_pools(
        env: Env,
        admin: Address,
        asset_a: Address,
        asset_b: Address,
    ) -> Result<(), Error> {
        require_admin(&env, &admin)?;

        if asset_a == asset_b {
            return Err(Error::InvalidAmount);
        }

        let (ca, cb) = canonical_pair(&asset_a, &asset_b);
        if env.storage().persistent().has(&pool_id_key(&ca, &cb)) {
            return Err(Error::PoolAlreadyExists);
        }

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PoolCount)
            .unwrap_or(0);
        let pool_id = count.checked_add(1).ok_or(Error::Overflow)?;
        env.storage().instance().set(&DataKey::PoolCount, &pool_id);

        let pool = PoolInfo {
            pool_id,
            asset_a: ca.clone(),
            asset_b: cb.clone(),
            reserve_a: 0,
            reserve_b: 0,
            lp_token_supply: 0,
        };
        env.storage()
            .persistent()
            .set(&pool_id_key(&ca, &cb), &pool_id);
        write_pool(&env, &pool);
        extend_instance_ttl(&env);

        PoolCreated {
            pool_id,
            asset_a: ca,
            asset_b: cb,
        }
        .publish(&env);

        Ok(())
    }

    pub fn add_liquidity(
        env: Env,
        lp: Address,
        asset_a: Address,
        amount_a: i128,
        asset_b: Address,
        amount_b: i128,
    ) -> Result<i128, Error> {
        lp.require_auth();
        if amount_a <= 0 || amount_b <= 0 {
            return Err(Error::InvalidAmount);
        }

        let pool_id = get_pool_id(&env, &asset_a, &asset_b)?;
        let mut pool = read_pool(&env, pool_id).ok_or(Error::PoolNotFound)?;

        if asset_a != pool.asset_a || asset_b != pool.asset_b {
            return Err(Error::PoolNotFound);
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

        let lp_tokens;
        if pool.lp_token_supply == 0 {
            let product = (amount_a as u128)
                .checked_mul(amount_b as u128)
                .ok_or(Error::Overflow)?;
            let sqrt_product = sqrt(product as i128);
            lp_tokens = sqrt_product
                .checked_sub(MINIMUM_LIQUIDITY)
                .ok_or(Error::MinimumLiquidity)?;
            if lp_tokens <= 0 {
                return Err(Error::MinimumLiquidity);
            }
            pool.lp_token_supply = lp_tokens;
            pool.reserve_a = amount_a;
            pool.reserve_b = amount_b;
        } else {
            let share_a = amount_a
                .checked_mul(pool.lp_token_supply)
                .ok_or(Error::Overflow)?
                .checked_div(pool.reserve_a)
                .ok_or(Error::Overflow)?;
            let share_b = amount_b
                .checked_mul(pool.lp_token_supply)
                .ok_or(Error::Overflow)?
                .checked_div(pool.reserve_b)
                .ok_or(Error::Overflow)?;
            lp_tokens = share_a.min(share_b);
            if lp_tokens <= 0 {
                return Err(Error::MinimumLiquidity);
            }
            pool.reserve_a = pool
                .reserve_a
                .checked_add(amount_a)
                .ok_or(Error::Overflow)?;
            pool.reserve_b = pool
                .reserve_b
                .checked_add(amount_b)
                .ok_or(Error::Overflow)?;
            pool.lp_token_supply = pool
                .lp_token_supply
                .checked_add(lp_tokens)
                .ok_or(Error::Overflow)?;
        }

        write_pool(&env, &pool);
        let existing_lp = read_lp_balance(&env, pool_id, &lp);
        write_lp_balance(&env, pool_id, &lp, existing_lp + lp_tokens);
        extend_instance_ttl(&env);

        LiquidityAdded {
            pool_id,
            provider: lp,
            amount_a,
            amount_b,
            lp_tokens,
        }
        .publish(&env);

        Ok(lp_tokens)
    }

    pub fn remove_liquidity(
        env: Env,
        lp: Address,
        asset_a: Address,
        asset_b: Address,
        liquidity_tokens: i128,
    ) -> Result<(), Error> {
        lp.require_auth();
        if liquidity_tokens <= 0 {
            return Err(Error::InvalidAmount);
        }

        let pool_id = get_pool_id(&env, &asset_a, &asset_b)?;
        let mut pool = read_pool(&env, pool_id).ok_or(Error::PoolNotFound)?;

        if asset_a != pool.asset_a || asset_b != pool.asset_b {
            return Err(Error::PoolNotFound);
        }

        let lp_balance = read_lp_balance(&env, pool_id, &lp);
        if lp_balance < liquidity_tokens {
            return Err(Error::InsufficientLiquidity);
        }

        let share_numer = liquidity_tokens;
        let share_denom = pool.lp_token_supply;

        let amount_a = pool
            .reserve_a
            .checked_mul(share_numer)
            .ok_or(Error::Overflow)?
            .checked_div(share_denom)
            .ok_or(Error::Overflow)?;
        let amount_b = pool
            .reserve_b
            .checked_mul(share_numer)
            .ok_or(Error::Overflow)?
            .checked_div(share_denom)
            .ok_or(Error::Overflow)?;

        // Transfer tokens from contract to LP
        TokenClient::new(&env, &asset_a).transfer(
            &env.current_contract_address(),
            MuxedAddress::from(lp.clone()),
            &amount_a,
        );
        TokenClient::new(&env, &asset_b).transfer(
            &env.current_contract_address(),
            MuxedAddress::from(lp.clone()),
            &amount_b,
        );

        pool.reserve_a = pool
            .reserve_a
            .checked_sub(amount_a)
            .ok_or(Error::Overflow)?;
        pool.reserve_b = pool
            .reserve_b
            .checked_sub(amount_b)
            .ok_or(Error::Overflow)?;
        pool.lp_token_supply = pool
            .lp_token_supply
            .checked_sub(share_numer)
            .ok_or(Error::Overflow)?;

        write_pool(&env, &pool);
        let remaining = lp_balance - liquidity_tokens;
        write_lp_balance(&env, pool_id, &lp, remaining);
        extend_instance_ttl(&env);

        LiquidityRemoved {
            pool_id,
            provider: lp,
            amount_a,
            amount_b,
            lp_tokens: liquidity_tokens,
        }
        .publish(&env);

        Ok(())
    }

    pub fn swap(
        env: Env,
        user: Address,
        asset_in: Address,
        amount_in: i128,
        asset_out: Address,
        min_amount_out: i128,
    ) -> Result<i128, Error> {
        user.require_auth();
        if amount_in <= 0 || min_amount_out < 0 {
            return Err(Error::InvalidAmount);
        }

        let pool_id = get_pool_id(&env, &asset_in, &asset_out)?;
        let mut pool = read_pool(&env, pool_id).ok_or(Error::PoolNotFound)?;

        let (reserve_in, reserve_out) = if asset_in == pool.asset_a {
            (pool.reserve_a, pool.reserve_b)
        } else if asset_in == pool.asset_b {
            (pool.reserve_b, pool.reserve_a)
        } else {
            return Err(Error::PoolNotFound);
        };

        if reserve_in <= 0 || reserve_out <= 0 {
            return Err(Error::InsufficientLiquidity);
        }

        let amount_out = compute_amount_out(amount_in, reserve_in, reserve_out)?;

        if amount_out < min_amount_out {
            return Err(Error::SlippageExceeded);
        }

        // Pull tokens in
        TokenClient::new(&env, &asset_in).transfer(
            &user,
            MuxedAddress::from(env.current_contract_address()),
            &amount_in,
        );

        // Push tokens out
        TokenClient::new(&env, &asset_out).transfer(
            &env.current_contract_address(),
            MuxedAddress::from(user.clone()),
            &amount_out,
        );

        // Update reserves
        if asset_in == pool.asset_a {
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

        write_pool(&env, &pool);
        extend_instance_ttl(&env);

        SwapExecuted {
            pool_id,
            user,
            asset_in,
            amount_in,
            asset_out,
            amount_out,
        }
        .publish(&env);

        Ok(amount_out)
    }

    pub fn get_quote(
        env: Env,
        asset_in: Address,
        amount_in: i128,
        asset_out: Address,
    ) -> Result<i128, Error> {
        if amount_in <= 0 {
            return Err(Error::InvalidAmount);
        }

        let pool_id = get_pool_id(&env, &asset_in, &asset_out)?;
        let pool = read_pool(&env, pool_id).ok_or(Error::PoolNotFound)?;

        let (reserve_in, reserve_out) = if asset_in == pool.asset_a {
            (pool.reserve_a, pool.reserve_b)
        } else if asset_in == pool.asset_b {
            (pool.reserve_b, pool.reserve_a)
        } else {
            return Err(Error::PoolNotFound);
        };

        if reserve_in <= 0 || reserve_out <= 0 {
            return Err(Error::InsufficientLiquidity);
        }

        compute_amount_out(amount_in, reserve_in, reserve_out)
    }

    pub fn get_pool(env: Env, asset_a: Address, asset_b: Address) -> PoolInfo {
        let pool_id = get_pool_id(&env, &asset_a, &asset_b).expect("pool not found");
        read_pool(&env, pool_id).expect("pool not found")
    }

    pub fn get_lp_balance(env: Env, asset_a: Address, asset_b: Address, provider: Address) -> i128 {
        let pool_id = get_pool_id(&env, &asset_a, &asset_b).unwrap_or(0);
        read_lp_balance(&env, pool_id, &provider)
    }
}

#[cfg(test)]
mod test;
