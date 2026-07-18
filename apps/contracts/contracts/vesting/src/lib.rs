#![no_std]
//! Token vesting schedule contract for AfriDollar.
//!
//! Any address can create a vesting schedule by escrowing tokens into the
//! contract at creation time. Schedules support three vesting types:
//!
//! * **Linear** — tokens vest continuously between `start_time` and
//!   `end_time`, with nothing available before `cliff_time`.
//! * **Milestone** — tokens vest in discrete chunks at specific timestamps,
//!   defined at schedule creation. Milestone percentages must sum to exactly
//!   100 %.
//! * **Immediate** — all tokens are available after `start_time` (cliff is
//!   ignored).
//!
//! A contract-level admin exists solely as an emergency circuit breaker:
//! `pause` blocks `create_vesting`, `claim_vested`, and `revoke_vesting`;
//! `unpause` re-enables them. The admin cannot touch individual schedules.
//!
//! Revocation is scoped to each schedule's creator (the `issuer`): only the
//! issuer can revoke their own schedule. On revocation the unvested portion
//! is returned to the issuer, and `total_amount` is frozen at the vested
//! amount so the beneficiary can still claim any vested-but-unclaimed tokens.
//!
//! After freezing, `unvested + (frozen_total - claimed) + claimed` always
//! equals the original `total_amount`, so no tokens can be stranded.

use afri_contract_shared::{
    extend_instance_ttl, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token::TokenClient,
    Address, Env, MuxedAddress, Vec,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors returned by the vesting contract.
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
    /// An amount argument was zero or negative.
    InvalidAmount = 4,
    /// No vesting schedule exists for the given ID.
    VestingNotFound = 5,
    /// Timeline constraints were violated (e.g. cliff after end).
    InvalidSchedule = 6,
    /// Nothing is currently claimable for this schedule.
    NothingClaimable = 7,
    /// A checked arithmetic operation would have overflowed.
    Overflow = 8,
    /// Milestone percentages do not sum to exactly 100 %.
    MilestonePercentageExceeded = 9,
    /// The caller is not the schedule's beneficiary.
    UnauthorizedBeneficiary = 10,
    /// The caller is not the schedule's issuer.
    UnauthorizedIssuer = 11,
    /// This schedule has already been revoked.
    AlreadyRevoked = 12,
    /// A milestone vesting type was specified with no milestones.
    NoMilestones = 13,
    /// The operation is blocked by the emergency pause.
    ContractPaused = 14,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Determines how tokens vest over time.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VestingType {
    /// Continuous vesting between `start_time` and `end_time`.
    Linear,
    /// Discrete vesting at specific milestone timestamps.
    Milestone,
    /// All tokens available after `start_time`.
    Immediate,
}

/// A vesting schedule escrowed in the contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    /// Unique identifier assigned at creation.
    pub id: u64,
    /// Address that created and escrowed tokens for this schedule.
    pub issuer: Address,
    /// Address that receives vested tokens.
    pub beneficiary: Address,
    /// Token contract address.
    pub asset: Address,
    /// Original total amount escrowed. After revocation this is frozen at
    /// the vested amount so the beneficiary can claim vested-but-unclaimed
    /// tokens.
    pub total_amount: i128,
    /// Cumulative amount already claimed by the beneficiary.
    pub claimed_amount: i128,
    /// Timestamp when vesting begins.
    pub start_time: u64,
    /// Timestamp when the first tokens become claimable (Linear and
    /// Milestone types).
    pub cliff_time: u64,
    /// Timestamp when the full amount has vested.
    pub end_time: u64,
    /// How tokens vest.
    pub vesting_type: VestingType,
    /// Whether the issuer has revoked this schedule.
    pub revoked: bool,
}

/// A single milestone entry for milestone-type vesting.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Milestone {
    /// Timestamp at which this milestone's percentage vests.
    pub timestamp: u64,
    /// Percentage of `total_amount` that vests at this milestone (0–100).
    /// All milestones must sum to exactly 100.
    pub percentage: u32,
}

/// Read-only status view of a vesting schedule.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingStatus {
    /// Total amount that has vested so far (frozen at revocation).
    pub total_vested: i128,
    /// Total amount claimed by the beneficiary.
    pub total_claimed: i128,
    /// Amount currently claimable (vested but not yet claimed).
    pub claimable: i128,
    /// Amount that has not yet vested.
    pub remaining: i128,
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// Contract admin address (emergency pause only).
    Admin,
    /// Whether the contract is paused.
    Paused,
    /// Auto-incrementing vesting ID counter.
    NextVestingId,
    /// Vesting schedule by ID.
    Vesting(u64),
    /// Milestones for a vesting schedule by ID.
    Milestones(u64),
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Emitted when a new vesting schedule is created and tokens escrowed.
#[contractevent(topics = ["vesting", "created"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingCreated {
    #[topic]
    pub vesting_id: u64,
    #[topic]
    pub beneficiary: Address,
    pub issuer: Address,
    pub asset: Address,
    pub total_amount: i128,
}

/// Emitted when the beneficiary claims vested tokens.
#[contractevent(topics = ["vesting", "claimed"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingClaimed {
    #[topic]
    pub vesting_id: u64,
    #[topic]
    pub beneficiary: Address,
    pub amount: i128,
}

/// Emitted when an issuer revokes a schedule, returning unvested tokens.
#[contractevent(topics = ["vesting", "revoked"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingRevoked {
    #[topic]
    pub vesting_id: u64,
    pub returned_amount: i128,
}

/// Emitted when a beneficiary transfers their rights to another address.
#[contractevent(topics = ["vesting", "transfer"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnershipTransferred {
    #[topic]
    pub vesting_id: u64,
    pub from: Address,
    pub to: Address,
}

/// Emitted when the emergency pause is activated.
#[contractevent(topics = ["vesting", "paused"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Paused {
    pub admin: Address,
}

/// Emitted when the emergency pause is deactivated.
#[contractevent(topics = ["vesting", "unpaused"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Unpaused {
    pub admin: Address,
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/// Read a stored `VestingSchedule`, or `None` if it doesn't exist.
fn read_vesting(env: &Env, vesting_id: u64) -> Option<VestingSchedule> {
    env.storage()
        .persistent()
        .get(&DataKey::Vesting(vesting_id))
}

/// Write a `VestingSchedule` to persistent storage.
fn put_vesting(env: &Env, schedule: &VestingSchedule) {
    env.storage()
        .persistent()
        .set(&DataKey::Vesting(schedule.id), schedule);
}

/// Read stored milestones for a vesting schedule.
fn read_milestones(env: &Env, vesting_id: u64) -> Vec<Milestone> {
    env.storage()
        .persistent()
        .get(&DataKey::Milestones(vesting_id))
        .unwrap_or_else(|| soroban_sdk::vec![env])
}

/// Write milestones to persistent storage.
fn put_milestones(env: &Env, vesting_id: u64, milestones: &Vec<Milestone>) {
    env.storage()
        .persistent()
        .set(&DataKey::Milestones(vesting_id), milestones);
}

/// Extend the TTL of a persistent storage entry.
fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Read the stored admin address, requiring it to match `caller`.
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

/// Check that the contract is not paused. Returns `Error::ContractPaused`
/// if it is.
fn require_not_paused(env: &Env) -> Result<(), Error> {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        return Err(Error::ContractPaused);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Vesting calculation
// ---------------------------------------------------------------------------

/// Compute the total amount that has vested as of `now`.
///
/// For `Linear`, the formula is:
///   `total_amount * (now - start_time) / (end_time - start_time)`
/// clamped to 0 before cliff and to `total_amount` after end.
///
/// For `Milestone`, it sums each milestone's share whose timestamp has
/// passed, clamped to 0 before cliff.
///
/// For `Immediate`, it is `total_amount` once `now >= start_time`.
fn compute_vested_amount(
    schedule: &VestingSchedule,
    milestones: &Vec<Milestone>,
    now: u64,
) -> i128 {
    if now < schedule.cliff_time {
        return 0;
    }
    match schedule.vesting_type {
        VestingType::Immediate => {
            if now < schedule.start_time {
                0
            } else {
                schedule.total_amount
            }
        }
        VestingType::Linear => {
            if now >= schedule.end_time {
                return schedule.total_amount;
            }
            let elapsed = now.saturating_sub(schedule.start_time);
            let duration = schedule.end_time.saturating_sub(schedule.start_time);
            if duration == 0 {
                return schedule.total_amount;
            }
            schedule.total_amount * elapsed as i128 / duration as i128
        }
        VestingType::Milestone => {
            let mut vested: i128 = 0;
            for m in milestones.iter() {
                if m.timestamp <= now {
                    vested += schedule.total_amount * m.percentage as i128 / 100;
                }
            }
            vested
        }
    }
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct VestingContract;

#[contractimpl]
impl VestingContract {
    /// Initialize the contract with an `admin` who controls the emergency
    /// pause. Requires `admin`'s authorization. Fails with
    /// `Error::AlreadyInitialized` if called twice.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextVestingId, &0u64);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Admin-only. Activate the emergency pause, blocking `create_vesting`,
    /// `claim_vested`, and `revoke_vesting`.
    pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        extend_instance_ttl(&env);
        Paused { admin }.publish(&env);
        Ok(())
    }

    /// Admin-only. Deactivate the emergency pause.
    pub fn unpause(env: Env, admin: Address) -> Result<(), Error> {
        require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        extend_instance_ttl(&env);
        Unpaused { admin }.publish(&env);
        Ok(())
    }

    /// Create a new vesting schedule, escrowing `total_amount` of `asset`
    /// from `creator` into the contract.
    ///
    /// For `VestingType::Milestone`, `milestones` must be non-empty, every
    /// timestamp must fall within `(start_time, end_time]`, and percentages
    /// must sum to exactly 100.
    ///
    /// Returns the new vesting schedule ID.
    #[allow(clippy::too_many_arguments)]
    pub fn create_vesting(
        env: Env,
        creator: Address,
        beneficiary: Address,
        asset: Address,
        total_amount: i128,
        start_time: u64,
        cliff_time: u64,
        end_time: u64,
        vesting_type: VestingType,
        milestones: Vec<Milestone>,
    ) -> Result<u64, Error> {
        require_not_paused(&env)?;
        creator.require_auth();

        if total_amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if cliff_time < start_time || end_time <= start_time || end_time <= cliff_time {
            return Err(Error::InvalidSchedule);
        }

        if vesting_type == VestingType::Milestone {
            if milestones.is_empty() {
                return Err(Error::NoMilestones);
            }
            let mut cumulative: u32 = 0;
            for m in milestones.iter() {
                if m.timestamp <= start_time || m.timestamp > end_time {
                    return Err(Error::InvalidSchedule);
                }
                cumulative = cumulative
                    .checked_add(m.percentage)
                    .ok_or(Error::Overflow)?;
            }
            if cumulative != 100 {
                return Err(Error::MilestonePercentageExceeded);
            }
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextVestingId)
            .unwrap_or(0);
        let next_id = id.checked_add(1).ok_or(Error::Overflow)?;

        let schedule = VestingSchedule {
            id,
            issuer: creator.clone(),
            beneficiary: beneficiary.clone(),
            asset: asset.clone(),
            total_amount,
            claimed_amount: 0,
            start_time,
            cliff_time,
            end_time,
            vesting_type: vesting_type.clone(),
            revoked: false,
        };

        put_vesting(&env, &schedule);
        if vesting_type == VestingType::Milestone {
            put_milestones(&env, id, &milestones);
        }

        env.storage()
            .instance()
            .set(&DataKey::NextVestingId, &next_id);
        extend_persistent_ttl(&env, &DataKey::Vesting(id));
        extend_instance_ttl(&env);

        // Escrow: pull tokens from creator into the contract.
        TokenClient::new(&env, &asset).transfer(
            &creator,
            MuxedAddress::from(env.current_contract_address()),
            &total_amount,
        );

        VestingCreated {
            vesting_id: id,
            beneficiary,
            issuer: schedule.issuer,
            asset,
            total_amount,
        }
        .publish(&env);

        Ok(id)
    }

    /// Claim vested tokens for `vesting_id`. Only the schedule's
    /// beneficiary may call this.
    ///
    /// After revocation, the beneficiary can still claim any tokens that
    /// had already vested before revocation (i.e. `frozen_total -
    /// claimed_amount`). Returns the amount claimed (may be 0 if nothing
    /// is claimable yet).
    pub fn claim_vested(env: Env, vesting_id: u64, beneficiary: Address) -> Result<i128, Error> {
        require_not_paused(&env)?;
        beneficiary.require_auth();

        let mut schedule = read_vesting(&env, vesting_id).ok_or(Error::VestingNotFound)?;
        if beneficiary != schedule.beneficiary {
            return Err(Error::UnauthorizedBeneficiary);
        }

        let claimable = if schedule.revoked {
            // total_amount is frozen at vested_amount on revocation.
            schedule
                .total_amount
                .checked_sub(schedule.claimed_amount)
                .ok_or(Error::Overflow)?
        } else {
            let now = env.ledger().timestamp();
            let milestones = read_milestones(&env, vesting_id);
            let vested = compute_vested_amount(&schedule, &milestones, now);
            vested
                .checked_sub(schedule.claimed_amount)
                .ok_or(Error::Overflow)?
        };

        if claimable <= 0 {
            return Ok(0);
        }

        TokenClient::new(&env, &schedule.asset).transfer(
            &env.current_contract_address(),
            MuxedAddress::from(beneficiary.clone()),
            &claimable,
        );

        schedule.claimed_amount = schedule
            .claimed_amount
            .checked_add(claimable)
            .ok_or(Error::Overflow)?;
        put_vesting(&env, &schedule);
        extend_persistent_ttl(&env, &DataKey::Vesting(vesting_id));
        extend_instance_ttl(&env);

        VestingClaimed {
            vesting_id,
            beneficiary,
            amount: claimable,
        }
        .publish(&env);

        Ok(claimable)
    }

    /// Revoke a vesting schedule. Only the schedule's issuer may call
    /// this.
    ///
    /// The unvested portion is returned to the issuer, and
    /// `total_amount` is frozen at the vested amount so the beneficiary
    /// can still claim any vested-but-unclaimed tokens.
    pub fn revoke_vesting(env: Env, vesting_id: u64, issuer: Address) -> Result<(), Error> {
        require_not_paused(&env)?;
        issuer.require_auth();

        let mut schedule = read_vesting(&env, vesting_id).ok_or(Error::VestingNotFound)?;
        if issuer != schedule.issuer {
            return Err(Error::UnauthorizedIssuer);
        }
        if schedule.revoked {
            return Err(Error::AlreadyRevoked);
        }

        let now = env.ledger().timestamp();
        let milestones = read_milestones(&env, vesting_id);
        let vested_amount = compute_vested_amount(&schedule, &milestones, now);

        let unvested = schedule
            .total_amount
            .checked_sub(vested_amount)
            .ok_or(Error::Overflow)?;

        if unvested > 0 {
            TokenClient::new(&env, &schedule.asset).transfer(
                &env.current_contract_address(),
                MuxedAddress::from(issuer.clone()),
                &unvested,
            );
        }

        // Freeze total_amount at what has vested so the beneficiary can
        // still claim the vested-but-unclaimed portion.
        schedule.total_amount = vested_amount;
        schedule.revoked = true;
        put_vesting(&env, &schedule);
        extend_persistent_ttl(&env, &DataKey::Vesting(vesting_id));
        extend_instance_ttl(&env);

        VestingRevoked {
            vesting_id,
            returned_amount: unvested,
        }
        .publish(&env);

        Ok(())
    }

    /// Transfer beneficiary rights for `vesting_id` from `from` to `to`.
    /// Only the current beneficiary may initiate this.
    pub fn transfer_ownership(
        env: Env,
        vesting_id: u64,
        from: Address,
        to: Address,
    ) -> Result<(), Error> {
        from.require_auth();

        let mut schedule = read_vesting(&env, vesting_id).ok_or(Error::VestingNotFound)?;
        if from != schedule.beneficiary {
            return Err(Error::UnauthorizedBeneficiary);
        }

        schedule.beneficiary = to.clone();
        put_vesting(&env, &schedule);
        extend_persistent_ttl(&env, &DataKey::Vesting(vesting_id));
        extend_instance_ttl(&env);

        OwnershipTransferred {
            vesting_id,
            from,
            to,
        }
        .publish(&env);

        Ok(())
    }

    /// Read-only status of a vesting schedule at the current ledger time.
    pub fn get_vesting_status(env: Env, vesting_id: u64) -> Result<VestingStatus, Error> {
        let schedule = read_vesting(&env, vesting_id).ok_or(Error::VestingNotFound)?;

        let total_vested = if schedule.revoked {
            // total_amount is frozen at vested_amount on revocation.
            schedule.total_amount
        } else {
            let now = env.ledger().timestamp();
            let milestones = read_milestones(&env, vesting_id);
            compute_vested_amount(&schedule, &milestones, now)
        };

        let claimable = total_vested
            .checked_sub(schedule.claimed_amount)
            .unwrap_or(0);
        let remaining = schedule.total_amount.checked_sub(total_vested).unwrap_or(0);

        Ok(VestingStatus {
            total_vested,
            total_claimed: schedule.claimed_amount,
            claimable,
            remaining,
        })
    }

    /// Read the full `VestingSchedule` for `vesting_id`.
    pub fn get_vesting(env: Env, vesting_id: u64) -> Result<VestingSchedule, Error> {
        read_vesting(&env, vesting_id).ok_or(Error::VestingNotFound)
    }
}

#[cfg(test)]
mod test;
