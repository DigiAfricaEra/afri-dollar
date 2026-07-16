#![no_std]
//! Staking — token staking and rewards contract for AfriDollar.
//!
//! Stakers lock a supported `asset` for at least `min_stake_duration` and
//! accrue rewards in a (possibly different) `reward_asset`, at a rate fixed
//! per second per staked token. Rewards are paid out on demand via
//! `claim_rewards`; principal is only returned via `unstake`, and only once
//! the lock has expired.
//!
//! ## Design notes: two fields beyond the original spec
//!
//! [`StakingPosition`] carries two fields beyond what was originally
//! sketched for this contract (`reward_rate`, `pending_rewards`). Both exist
//! to satisfy the acceptance criterion "reward rate changes apply to new
//! stakes only" *correctly*:
//!
//! * `reward_rate` — a snapshot of [`RewardConfig::reward_rate`] taken the
//!   moment `stake` is called (first stake, or any top-up). If rewards were
//!   instead computed from the *live* `RewardConfig` at claim time, an
//!   admin's `set_reward_rate` call would silently change the accrual rate
//!   for every already-open position — exactly what the acceptance
//!   criterion says must not happen. Snapshotting on the position makes
//!   each stake immune to later rate changes; only a fresh `stake` call
//!   picks up the new rate.
//! * `pending_rewards` — rewards accrued but not yet paid out. Whenever a
//!   position's `amount` or `reward_rate` is about to change (a top-up
//!   stake, or a partial `unstake`), the reward owed for the *elapsed time
//!   under the old amount/rate* is settled into this bucket first (see
//!   [`settle_accrual`]), so past accrual is never lost, recomputed at a
//!   new rate, or double-counted.
//!
//! Every other field matches the original `StakingPosition`/`RewardConfig`
//! shape. All contract entrypoints return `Result<_, Error>` rather than
//! bare values, matching this repo's established convention (see the
//! `counter` reference contract) rather than the bare-return signatures
//! originally sketched for this issue.

use afri_contract_shared::extend_instance_ttl;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token::TokenClient,
    Address, Env, MuxedAddress,
};

/// Errors returned by the staking contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` was called on a contract that already has an admin.
    AlreadyInitialized = 1,
    /// An operation was attempted before the contract was initialized.
    NotInitialized = 2,
    /// The caller is not authorized to perform the operation (wrong admin).
    Unauthorized = 3,
    /// An amount or rate argument was zero, negative, or otherwise invalid.
    InvalidAmount = 4,
    /// `stake` was called for an `asset` with no `RewardConfig` set.
    RewardConfigNotSet = 5,
    /// `stake` was called with `lock_duration` below `RewardConfig::min_stake_duration`.
    LockDurationTooShort = 6,
    /// `unstake` was called before the position's `lock_until` timestamp.
    StillLocked = 7,
    /// `unstake` requested more than the position's current staked `amount`.
    InsufficientStake = 8,
    /// No `StakingPosition` exists for the given `(staker, asset)` pair.
    PositionNotFound = 9,
    /// A checked arithmetic operation would have overflowed.
    Overflow = 10,
}

/// A staker's position in a given `asset`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakingPosition {
    pub staker: Address,
    pub asset: Address,
    pub amount: i128,
    pub staked_at: u64,
    pub lock_until: u64,
    pub rewards_claimed: i128,
    /// Reward rate snapshot taken at the most recent `stake` call. See the
    /// module-level docs for why this exists.
    pub reward_rate: i128,
    /// Rewards accrued but not yet paid out via `claim_rewards`. See the
    /// module-level docs for why this exists.
    pub pending_rewards: i128,
}

/// Per-asset reward configuration, set by the admin via `set_reward_config`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardConfig {
    pub asset: Address,
    pub reward_asset: Address,
    /// Reward units of `reward_asset` per second per staked unit of `asset`.
    pub reward_rate: i128,
    /// Minimum `lock_duration` (in seconds) accepted by `stake` for this asset.
    pub min_stake_duration: u64,
}

/// Instance storage keys.
#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// The address allowed to perform privileged operations.
    Admin,
    /// `RewardConfig`, keyed by `asset`.
    RewardConfig(Address),
    /// `StakingPosition`, keyed by `(staker, asset)`.
    Position(Address, Address),
}

/// Emitted when `stake` is called (initial stake or top-up).
#[contractevent(topics = ["staking", "stake"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Staked {
    #[topic]
    pub staker: Address,
    #[topic]
    pub asset: Address,
    pub amount: i128,
    pub lock_until: u64,
}

/// Emitted when `unstake` returns principal to the staker.
#[contractevent(topics = ["staking", "unstake"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Unstaked {
    #[topic]
    pub staker: Address,
    #[topic]
    pub asset: Address,
    pub amount: i128,
}

/// Emitted when `claim_rewards` pays out accrued rewards.
#[contractevent(topics = ["staking", "claim"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardsClaimed {
    #[topic]
    pub staker: Address,
    #[topic]
    pub asset: Address,
    pub amount: i128,
}

/// Emitted when the admin sets or updates a `RewardConfig`'s rate — either
/// via `set_reward_config` (new config) or `set_reward_rate` (rate-only
/// update on an existing config).
#[contractevent(topics = ["staking", "rate_set"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardRateSet {
    #[topic]
    pub asset: Address,
    pub rate: i128,
}

/// Read a stored `StakingPosition`, or `None` if the staker has never
/// staked this asset.
fn read_position(env: &Env, staker: &Address, asset: &Address) -> Option<StakingPosition> {
    env.storage()
        .persistent()
        .get(&DataKey::Position(staker.clone(), asset.clone()))
}

/// Write a `StakingPosition` under its `(staker, asset)` key.
fn put_position(env: &Env, pos: &StakingPosition) {
    env.storage().persistent().set(
        &DataKey::Position(pos.staker.clone(), pos.asset.clone()),
        pos,
    );
}

/// Read the `RewardConfig` for `asset`, or `Error::RewardConfigNotSet` if
/// the admin has not configured this asset yet.
fn read_reward_config(env: &Env, asset: &Address) -> Result<RewardConfig, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::RewardConfig(asset.clone()))
        .ok_or(Error::RewardConfigNotSet)
}

/// `rate * amount * elapsed_secs`, using checked arithmetic throughout so a
/// pathological rate/amount/duration combination fails loudly with
/// `Error::Overflow` instead of silently wrapping.
fn compute_accrual(rate: i128, amount: i128, elapsed_secs: u64) -> Result<i128, Error> {
    let per_second = rate.checked_mul(amount).ok_or(Error::Overflow)?;
    per_second
        .checked_mul(elapsed_secs as i128)
        .ok_or(Error::Overflow)
}

/// Settle rewards accrued since `pos.staked_at` (at the position's current
/// `amount`/`reward_rate`) into `pos.pending_rewards`, then reset
/// `pos.staked_at` to now. Must be called before `amount` or `reward_rate`
/// changes, so no accrual window is computed at the wrong rate.
fn settle_accrual(env: &Env, pos: &mut StakingPosition) -> Result<(), Error> {
    let now = env.ledger().timestamp();
    let elapsed = now.saturating_sub(pos.staked_at);
    if elapsed > 0 && pos.amount > 0 {
        let accrued = compute_accrual(pos.reward_rate, pos.amount, elapsed)?;
        pos.pending_rewards = pos
            .pending_rewards
            .checked_add(accrued)
            .ok_or(Error::Overflow)?;
    }
    pos.staked_at = now;
    Ok(())
}

/// Read the stored admin, requiring it to match `caller` and requiring
/// `caller`'s authorization. Shared by every admin-gated entrypoint.
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

#[contract]
pub struct StakingContract;

#[contractimpl]
impl StakingContract {
    /// Initialize the contract, recording `admin`. Fails with
    /// `Error::AlreadyInitialized` if called twice.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Admin-only. Create or fully replace the `RewardConfig` for `asset`.
    /// Required before `stake` will accept that asset. Rejects a negative
    /// `reward_rate` with `Error::InvalidAmount`.
    pub fn set_reward_config(
        env: Env,
        admin: Address,
        asset: Address,
        reward_asset: Address,
        reward_rate: i128,
        min_stake_duration: u64,
    ) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        if reward_rate < 0 {
            return Err(Error::InvalidAmount);
        }
        let config = RewardConfig {
            asset: asset.clone(),
            reward_asset,
            reward_rate,
            min_stake_duration,
        };
        env.storage()
            .persistent()
            .set(&DataKey::RewardConfig(asset.clone()), &config);
        extend_instance_ttl(&env);

        RewardRateSet {
            asset,
            rate: reward_rate,
        }
        .publish(&env);
        Ok(())
    }

    /// Admin-only. Update just the `reward_rate` of an existing
    /// `RewardConfig`. Per the acceptance criteria, this affects only
    /// *future* `stake` calls — every currently-open `StakingPosition`
    /// keeps accruing at the rate it snapshotted when it was last staked
    /// into. Fails with `Error::RewardConfigNotSet` if `asset` has no
    /// config yet (use `set_reward_config` first).
    pub fn set_reward_rate(
        env: Env,
        admin: Address,
        asset: Address,
        rate: i128,
    ) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        if rate < 0 {
            return Err(Error::InvalidAmount);
        }
        let mut config = read_reward_config(&env, &asset)?;
        config.reward_rate = rate;
        env.storage()
            .persistent()
            .set(&DataKey::RewardConfig(asset.clone()), &config);
        extend_instance_ttl(&env);

        RewardRateSet { asset, rate }.publish(&env);
        Ok(())
    }

    /// Read the `RewardConfig` for `asset`, if one has been set.
    pub fn get_reward_config(env: Env, asset: Address) -> Option<RewardConfig> {
        env.storage()
            .persistent()
            .get(&DataKey::RewardConfig(asset))
    }

    /// Stake `amount` of `asset`, locked for `lock_duration` seconds.
    ///
    /// Requires `staker.require_auth()` and a `RewardConfig` already set
    /// for `asset` (`Error::RewardConfigNotSet` otherwise). `lock_duration`
    /// must be at least `RewardConfig::min_stake_duration`
    /// (`Error::LockDurationTooShort` otherwise).
    ///
    /// If the staker already has an open position in this asset, this is a
    /// top-up: prior accrual is settled at the *old* amount/rate first (see
    /// [`settle_accrual`]), the new amount is added, the position's
    /// `reward_rate` is re-snapshotted to the current config rate, and
    /// `lock_until` is extended to `max(existing lock_until, now +
    /// lock_duration)` — a top-up can extend the lock but never shorten it.
    ///
    /// Transfers `amount` of `asset` from `staker` to the contract.
    pub fn stake(
        env: Env,
        staker: Address,
        asset: Address,
        amount: i128,
        lock_duration: u64,
    ) -> Result<(), Error> {
        staker.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let config = read_reward_config(&env, &asset)?;
        if lock_duration < config.min_stake_duration {
            return Err(Error::LockDurationTooShort);
        }
        let now = env.ledger().timestamp();
        let new_lock_until = now.checked_add(lock_duration).ok_or(Error::Overflow)?;

        let pos = match read_position(&env, &staker, &asset) {
            Some(mut existing) => {
                settle_accrual(&env, &mut existing)?;
                existing.amount = existing.amount.checked_add(amount).ok_or(Error::Overflow)?;
                existing.reward_rate = config.reward_rate;
                existing.lock_until = if existing.lock_until > new_lock_until {
                    existing.lock_until
                } else {
                    new_lock_until
                };
                existing
            }
            None => StakingPosition {
                staker: staker.clone(),
                asset: asset.clone(),
                amount,
                staked_at: now,
                lock_until: new_lock_until,
                rewards_claimed: 0,
                reward_rate: config.reward_rate,
                pending_rewards: 0,
            },
        };

        TokenClient::new(&env, &asset).transfer(
            &staker,
            MuxedAddress::from(env.current_contract_address()),
            &amount,
        );

        let lock_until = pos.lock_until;
        put_position(&env, &pos);
        extend_instance_ttl(&env);

        Staked {
            staker,
            asset,
            amount,
            lock_until,
        }
        .publish(&env);
        Ok(())
    }

    /// Withdraw `amount` of staked principal back to `staker`.
    ///
    /// Requires `staker.require_auth()`, an existing position
    /// (`Error::PositionNotFound`), the lock to have expired
    /// (`Error::StillLocked` if `now < lock_until`), and `amount` to not
    /// exceed the position's current staked amount
    /// (`Error::InsufficientStake`). Settles any pending reward accrual
    /// before reducing `amount`, so the withdrawn principal never causes
    /// past rewards to be under-counted.
    pub fn unstake(env: Env, staker: Address, asset: Address, amount: i128) -> Result<(), Error> {
        staker.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let mut pos = read_position(&env, &staker, &asset).ok_or(Error::PositionNotFound)?;
        let now = env.ledger().timestamp();
        if now < pos.lock_until {
            return Err(Error::StillLocked);
        }
        if amount > pos.amount {
            return Err(Error::InsufficientStake);
        }
        settle_accrual(&env, &mut pos)?;
        pos.amount = pos.amount.checked_sub(amount).ok_or(Error::Overflow)?;
        put_position(&env, &pos);
        extend_instance_ttl(&env);

        TokenClient::new(&env, &asset).transfer(
            &env.current_contract_address(),
            MuxedAddress::from(staker.clone()),
            &amount,
        );

        Unstaked {
            staker,
            asset,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Pay out all rewards accrued so far for `(staker, asset)`, in
    /// `RewardConfig::reward_asset`. Returns the amount paid (`0` if
    /// nothing was owed — this is not an error, since calling `claim` on a
    /// freshly-opened position is a valid no-op).
    ///
    /// Requires `staker.require_auth()` and an existing position
    /// (`Error::PositionNotFound`).
    pub fn claim_rewards(env: Env, staker: Address, asset: Address) -> Result<i128, Error> {
        staker.require_auth();
        let mut pos = read_position(&env, &staker, &asset).ok_or(Error::PositionNotFound)?;
        settle_accrual(&env, &mut pos)?;
        let amount = pos.pending_rewards;
        if amount > 0 {
            let config = read_reward_config(&env, &asset)?;
            TokenClient::new(&env, &config.reward_asset).transfer(
                &env.current_contract_address(),
                MuxedAddress::from(staker.clone()),
                &amount,
            );
            pos.rewards_claimed = pos
                .rewards_claimed
                .checked_add(amount)
                .ok_or(Error::Overflow)?;
            pos.pending_rewards = 0;
            put_position(&env, &pos);
            extend_instance_ttl(&env);

            RewardsClaimed {
                staker,
                asset,
                amount,
            }
            .publish(&env);
        }
        Ok(amount)
    }

    /// Read the full `StakingPosition` for `(staker, asset)`.
    /// `Error::PositionNotFound` if the staker has never staked this asset.
    pub fn get_position(
        env: Env,
        staker: Address,
        asset: Address,
    ) -> Result<StakingPosition, Error> {
        read_position(&env, &staker, &asset).ok_or(Error::PositionNotFound)
    }

    /// Pure read of rewards owed for `(staker, asset)` right now: settled
    /// `pending_rewards` plus accrual for the time elapsed since
    /// `staked_at`, at the position's current `reward_rate`/`amount`.
    /// Returns `0` (not an error) if the staker has never staked this
    /// asset. Does not mutate storage.
    pub fn calculate_rewards(env: Env, staker: Address, asset: Address) -> Result<i128, Error> {
        match read_position(&env, &staker, &asset) {
            None => Ok(0),
            Some(pos) => {
                let now = env.ledger().timestamp();
                let elapsed = now.saturating_sub(pos.staked_at);
                let accrued = compute_accrual(pos.reward_rate, pos.amount, elapsed)?;
                pos.pending_rewards
                    .checked_add(accrued)
                    .ok_or(Error::Overflow)
            }
        }
    }
}

#[cfg(test)]
mod test;
