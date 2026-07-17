#![no_std]

use afri_contract_shared::extend_instance_ttl;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short,
    Address, Env, Symbol, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimeLockConfig {
    pub asset: Address,
    pub lock_period_seconds: u64,
    pub enabled: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawalRequest {
    pub id: u64,
    pub requester: Address,
    pub to: Address,
    pub asset: Address,
    pub amount: i128,
    pub created_at: u64,
    pub unlock_at: u64,
    pub executed: bool,
    pub cancelled: bool,
}

#[contracttype]
enum DataKey {
    Admin,
    TimeLockConfig(Address),
    WithdrawalRequest(u64),
    NextRequestId,
    EmergencyApprovers,
    EmergencyThreshold,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TreasuryError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    LockPeriodTooLarge = 4,
    AmountZero = 5,
    RequestNotFound = 6,
    RequestAlreadyExecuted = 7,
    RequestAlreadyCancelled = 8,
    TimeLockNotElapsed = 9,
    NotRequesterOrAdmin = 10,
    InvalidApprover = 11,
    InsufficientApprovals = 12,
    AssetNotConfigured = 13,
    NoEmergencyApprovers = 14,
}

#[contractevent(topics = ["timelock_config"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelockConfigEvent {
    #[topic]
    pub action: Symbol,
    pub asset: Address,
    pub lock_period_seconds: u64,
    pub enabled: bool,
}

#[contractevent(topics = ["withdrawal"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawalEvent {
    #[topic]
    pub action: Symbol,
    pub request_id: u64,
    pub asset: Address,
    pub amount: i128,
    pub to: Address,
}

#[contract]
pub struct TreasuryContract;

#[contractimpl]
impl TreasuryContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), TreasuryError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(TreasuryError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        extend_instance_ttl(&env);
        Ok(())
    }

    pub fn set_timelock(
        env: Env,
        asset: Address,
        lock_period_seconds: u64,
    ) -> Result<(), TreasuryError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(TreasuryError::NotInitialized)?;
        admin.require_auth();

        let config = TimeLockConfig {
            asset: asset.clone(),
            lock_period_seconds,
            enabled: true,
        };
        env.storage()
            .instance()
            .set(&DataKey::TimeLockConfig(asset.clone()), &config);
        extend_instance_ttl(&env);

        TimelockConfigEvent {
            action: symbol_short!("set"),
            asset,
            lock_period_seconds,
            enabled: true,
        }
        .publish(&env);

        Ok(())
    }

    pub fn disable_timelock(env: Env, asset: Address) -> Result<(), TreasuryError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(TreasuryError::NotInitialized)?;
        admin.require_auth();

        let mut config: TimeLockConfig = env
            .storage()
            .instance()
            .get(&DataKey::TimeLockConfig(asset.clone()))
            .ok_or(TreasuryError::AssetNotConfigured)?;
        config.enabled = false;

        env.storage()
            .instance()
            .set(&DataKey::TimeLockConfig(asset.clone()), &config);
        extend_instance_ttl(&env);

        TimelockConfigEvent {
            action: symbol_short!("disable"),
            asset,
            lock_period_seconds: config.lock_period_seconds,
            enabled: false,
        }
        .publish(&env);

        Ok(())
    }

    pub fn get_timelock(env: Env, asset: Address) -> TimeLockConfig {
        env.storage()
            .instance()
            .get(&DataKey::TimeLockConfig(asset.clone()))
            .unwrap_or(TimeLockConfig {
                asset,
                lock_period_seconds: 0,
                enabled: false,
            })
    }

    pub fn set_emergency_approvers(
        env: Env,
        approvers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), TreasuryError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(TreasuryError::NotInitialized)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::EmergencyApprovers, &approvers);
        env.storage()
            .instance()
            .set(&DataKey::EmergencyThreshold, &threshold);
        extend_instance_ttl(&env);

        Ok(())
    }

    pub fn get_emergency_approvers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::EmergencyApprovers)
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_emergency_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::EmergencyThreshold)
            .unwrap_or(0)
    }

    pub fn request_withdrawal(
        env: Env,
        requester: Address,
        to: Address,
        asset: Address,
        amount: i128,
    ) -> Result<u64, TreasuryError> {
        env.storage()
            .instance()
            .get::<_, Address>(&DataKey::Admin)
            .ok_or(TreasuryError::NotInitialized)?;

        requester.require_auth();

        if amount <= 0 {
            return Err(TreasuryError::AmountZero);
        }

        let config: TimeLockConfig = env
            .storage()
            .instance()
            .get(&DataKey::TimeLockConfig(asset.clone()))
            .ok_or(TreasuryError::AssetNotConfigured)?;
        if !config.enabled {
            return Err(TreasuryError::AssetNotConfigured);
        }

        let now = env.ledger().timestamp();
        let unlock_at = now + config.lock_period_seconds;

        let mut next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextRequestId)
            .unwrap_or(1);
        let request_id = next_id;
        next_id += 1;
        env.storage()
            .instance()
            .set(&DataKey::NextRequestId, &next_id);

        let request = WithdrawalRequest {
            id: request_id,
            requester: requester.clone(),
            to: to.clone(),
            asset: asset.clone(),
            amount,
            created_at: now,
            unlock_at,
            executed: false,
            cancelled: false,
        };
        env.storage()
            .instance()
            .set(&DataKey::WithdrawalRequest(request_id), &request);
        extend_instance_ttl(&env);

        WithdrawalEvent {
            action: symbol_short!("request"),
            request_id,
            asset,
            amount,
            to,
        }
        .publish(&env);

        Ok(request_id)
    }

    pub fn execute_withdrawal(env: Env, request_id: u64) -> Result<(), TreasuryError> {
        env.storage()
            .instance()
            .get::<_, Address>(&DataKey::Admin)
            .ok_or(TreasuryError::NotInitialized)?;

        let mut request: WithdrawalRequest = env
            .storage()
            .instance()
            .get(&DataKey::WithdrawalRequest(request_id))
            .ok_or(TreasuryError::RequestNotFound)?;

        if request.executed {
            return Err(TreasuryError::RequestAlreadyExecuted);
        }
        if request.cancelled {
            return Err(TreasuryError::RequestAlreadyCancelled);
        }

        let now = env.ledger().timestamp();
        if now < request.unlock_at {
            return Err(TreasuryError::TimeLockNotElapsed);
        }

        request.executed = true;
        env.storage()
            .instance()
            .set(&DataKey::WithdrawalRequest(request_id), &request);
        extend_instance_ttl(&env);

        WithdrawalEvent {
            action: symbol_short!("execute"),
            request_id,
            asset: request.asset.clone(),
            amount: request.amount,
            to: request.to.clone(),
        }
        .publish(&env);

        Ok(())
    }

    pub fn cancel_withdrawal(env: Env, request_id: u64) -> Result<(), TreasuryError> {
        env.storage()
            .instance()
            .get::<_, Address>(&DataKey::Admin)
            .ok_or(TreasuryError::NotInitialized)?;

        let mut request: WithdrawalRequest = env
            .storage()
            .instance()
            .get(&DataKey::WithdrawalRequest(request_id))
            .ok_or(TreasuryError::RequestNotFound)?;

        if request.executed {
            return Err(TreasuryError::RequestAlreadyExecuted);
        }
        if request.cancelled {
            return Err(TreasuryError::RequestAlreadyCancelled);
        }

        request.requester.require_auth();

        request.cancelled = true;
        env.storage()
            .instance()
            .set(&DataKey::WithdrawalRequest(request_id), &request);
        extend_instance_ttl(&env);

        WithdrawalEvent {
            action: symbol_short!("cancel"),
            request_id,
            asset: request.asset,
            amount: request.amount,
            to: request.to,
        }
        .publish(&env);

        Ok(())
    }

    pub fn emergency_override(
        env: Env,
        request_id: u64,
        approvers: Vec<Address>,
    ) -> Result<(), TreasuryError> {
        env.storage()
            .instance()
            .get::<_, Address>(&DataKey::Admin)
            .ok_or(TreasuryError::NotInitialized)?;

        let stored_approvers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::EmergencyApprovers)
            .ok_or(TreasuryError::NoEmergencyApprovers)?;
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::EmergencyThreshold)
            .ok_or(TreasuryError::NoEmergencyApprovers)?;

        if approvers.len() < threshold {
            return Err(TreasuryError::InsufficientApprovals);
        }

        for approver in approvers.iter() {
            let mut is_valid = false;
            for stored in stored_approvers.iter() {
                if stored == approver {
                    is_valid = true;
                    break;
                }
            }
            if !is_valid {
                return Err(TreasuryError::InvalidApprover);
            }
            approver.require_auth();
        }

        let mut request: WithdrawalRequest = env
            .storage()
            .instance()
            .get(&DataKey::WithdrawalRequest(request_id))
            .ok_or(TreasuryError::RequestNotFound)?;

        if request.executed {
            return Err(TreasuryError::RequestAlreadyExecuted);
        }
        if request.cancelled {
            return Err(TreasuryError::RequestAlreadyCancelled);
        }

        request.executed = true;
        env.storage()
            .instance()
            .set(&DataKey::WithdrawalRequest(request_id), &request);
        extend_instance_ttl(&env);

        WithdrawalEvent {
            action: symbol_short!("emrgncy"), // "emergency" is 9 chars, this fits
            request_id,
            asset: request.asset,
            amount: request.amount,
            to: request.to,
        }
        .publish(&env);

        Ok(())
    }

    pub fn get_withdrawal_request(
        env: Env,
        request_id: u64,
    ) -> Result<WithdrawalRequest, TreasuryError> {
        env.storage()
            .instance()
            .get(&DataKey::WithdrawalRequest(request_id))
            .ok_or(TreasuryError::RequestNotFound)
    }
}

#[cfg(test)]
mod test;
