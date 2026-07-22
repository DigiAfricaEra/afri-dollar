#![no_std]
//! Shared building blocks for AfriDollar Soroban contracts.

use soroban_sdk::{contracterror, contracttype, Address, BytesN, Env};

pub const DAY_IN_LEDGERS: u32 = 17_280;
pub const INSTANCE_BUMP_AMOUNT: u32 = 7 * DAY_IN_LEDGERS;
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    UpgradeAlreadyPending = 4,
    NoPendingUpgrade = 5,
    UpgradeTimelockNotElapsed = 6,
    InvalidVersion = 7,
}

pub fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

// --- Upgradeable Contract Types ----------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    pub wasm_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeProposal {
    pub id: u64,
    pub new_wasm_hash: BytesN<32>,
    pub proposed_by: Address,
    pub proposed_at: u64,
    pub scheduled_at: u64,
    pub status: UpgradeStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpgradeStatus {
    Pending,
    Scheduled,
    Executed,
    Cancelled,
    RolledBack,
}

#[contracttype]
#[derive(Clone)]
pub enum UpgradeDataKey {
    Version,
    ProposalCount,
    Proposal(u64),
    PreviousWasmHash,
    Admin,
}

// --- Upgrade Helper Functions ------------------------------------------

pub fn get_version(env: &Env) -> ContractVersion {
    env.storage()
        .instance()
        .get(&UpgradeDataKey::Version)
        .unwrap_or(ContractVersion {
            major: 1,
            minor: 0,
            patch: 0,
            wasm_hash: BytesN::from_array(env, &[0u8; 32]),
        })
}

pub fn set_version(env: &Env, version: &ContractVersion) {
    env.storage()
        .instance()
        .set(&UpgradeDataKey::Version, version);
}

pub fn propose_upgrade(
    env: &Env,
    proposer: &Address,
    new_wasm_hash: BytesN<32>,
    delay_ledgers: u64,
) -> Result<u64, Error> {
    proposer.require_auth();
    let admin: Address = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    if *proposer != admin {
        return Err(Error::Unauthorized);
    }

    let count: u64 = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::ProposalCount)
        .unwrap_or(0);
    let new_id = count + 1;

    let current_ledger = env.ledger().sequence() as u64;
    let proposal = UpgradeProposal {
        id: new_id,
        new_wasm_hash: new_wasm_hash.clone(),
        proposed_by: proposer.clone(),
        proposed_at: current_ledger,
        scheduled_at: current_ledger + delay_ledgers,
        status: UpgradeStatus::Pending,
    };

    env.storage()
        .instance()
        .set(&UpgradeDataKey::Proposal(new_id), &proposal);
    env.storage()
        .instance()
        .set(&UpgradeDataKey::ProposalCount, &new_id);
    extend_instance_ttl(env);

    Ok(new_id)
}

pub fn schedule_upgrade(env: &Env, proposal_id: u64) -> Result<(), Error> {
    let mut proposal: UpgradeProposal = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::Proposal(proposal_id))
        .ok_or(Error::NoPendingUpgrade)?;

    if proposal.status != UpgradeStatus::Pending {
        return Err(Error::NoPendingUpgrade);
    }

    proposal.status = UpgradeStatus::Scheduled;
    env.storage()
        .instance()
        .set(&UpgradeDataKey::Proposal(proposal_id), &proposal);
    extend_instance_ttl(env);
    Ok(())
}

pub fn execute_upgrade(env: &Env, proposal_id: u64) -> Result<(), Error> {
    let proposal: UpgradeProposal = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::Proposal(proposal_id))
        .ok_or(Error::NoPendingUpgrade)?;

    if proposal.status != UpgradeStatus::Scheduled {
        return Err(Error::NoPendingUpgrade);
    }

    let current_ledger = env.ledger().sequence() as u64;
    if current_ledger < proposal.scheduled_at {
        return Err(Error::UpgradeTimelockNotElapsed);
    }

    let current_version = get_version(env);
    let previous_hash = current_version.wasm_hash;
    env.storage()
        .instance()
        .set(&UpgradeDataKey::PreviousWasmHash, &previous_hash);

    env.deployer()
        .update_current_contract_wasm(proposal.new_wasm_hash.clone());

    let new_version = ContractVersion {
        major: current_version.major + 1,
        minor: 0,
        patch: 0,
        wasm_hash: proposal.new_wasm_hash.clone(),
    };
    set_version(env, &new_version);

    let mut executed = proposal;
    executed.status = UpgradeStatus::Executed;
    env.storage()
        .instance()
        .set(&UpgradeDataKey::Proposal(proposal_id), &executed);
    extend_instance_ttl(env);
    Ok(())
}

pub fn cancel_upgrade(env: &Env, proposal_id: u64) -> Result<(), Error> {
    let mut proposal: UpgradeProposal = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::Proposal(proposal_id))
        .ok_or(Error::NoPendingUpgrade)?;

    if proposal.status == UpgradeStatus::Executed || proposal.status == UpgradeStatus::RolledBack {
        return Err(Error::NoPendingUpgrade);
    }

    proposal.status = UpgradeStatus::Cancelled;
    env.storage()
        .instance()
        .set(&UpgradeDataKey::Proposal(proposal_id), &proposal);
    extend_instance_ttl(env);
    Ok(())
}

pub fn rollback_upgrade(env: &Env, admin: &Address) -> Result<(), Error> {
    admin.require_auth();
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    let previous_hash: Option<BytesN<32>> = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::PreviousWasmHash);

    if let Some(hash) = previous_hash {
        env.deployer().update_current_contract_wasm(hash.clone());
        let current = get_version(env);
        let rolled_back = ContractVersion {
            major: current.major,
            minor: current.minor,
            patch: current.patch + 1,
            wasm_hash: hash.clone(),
        };
        set_version(env, &rolled_back);
    }

    extend_instance_ttl(env);
    Ok(())
}

pub fn migrate_storage(_env: &Env, _old_version: ContractVersion, _new_version: ContractVersion) {
    // Storage migration hook - extend for version-specific migrations
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn extend_instance_ttl_runs_inside_contract_context() {
        let env = Env::default();
        let contract_id = env.register(TestContract, ());
        env.as_contract(&contract_id, || {
            env.storage().instance().set(&(), &0u32);
            extend_instance_ttl(&env);
        });
    }

    use soroban_sdk::contract;
    #[contract]
    struct TestContract;
}
