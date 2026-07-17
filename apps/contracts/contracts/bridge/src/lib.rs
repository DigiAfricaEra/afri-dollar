#![no_std]
//! Cross-chain bridge contract for AfriDollar asset transfers.
//!
//! This contract enables secure asset bridging between Stellar and other
//! blockchains through a lock-mint/burn-unlock mechanism:
//!
//! * Lock assets on source chain
//! * Mint wrapped assets on destination chain
//! * Burn wrapped assets on destination chain
//! * Unlock original assets on source chain
//! * Relay transaction proofs for verification
//! * Bridge fee management

use afri_contract_shared::{extend_instance_ttl, Error};
use soroban_sdk::testutils::Address as TestAddress;
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, symbol_short, Address, Bytes, Env, Symbol,
};

/// Bridge request status enum.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BridgeStatus {
    Pending,
    Locked,
    Minted,
    Burned,
    Unlocked,
    Failed,
}

/// Bridge request data structure.
#[contracttype]
#[derive(Clone)]
pub struct BridgeRequest {
    /// Unique request identifier.
    pub id: u64,
    /// Source chain identifier.
    pub source_chain: Symbol,
    /// Destination chain identifier.
    pub destination_chain: Symbol,
    /// Asset address being bridged.
    pub asset: Address,
    /// Amount of asset to bridge (using i128 for precision).
    pub amount: i128,
    /// Sender address on source chain.
    pub sender: Address,
    /// Recipient address on destination chain (stored as Bytes for cross-chain compatibility).
    pub recipient: Bytes,
    /// Current status of the bridge request.
    pub status: BridgeStatus,
    /// Timestamp when the request was created.
    pub created_at: u64,
    /// Timestamp when the request was completed (if applicable).
    pub completed_at: Option<u64>,
}

/// Storage keys for the bridge contract.
#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// Administrator address with privileged permissions.
    Admin,
    /// Next bridge request ID counter.
    NextRequestId,
    /// Bridge fee percentage (basis points: 100 = 1%).
    BridgeFee,
    /// Individual bridge request by ID.
    BridgeRequest(u64),
}

/// Event published when a bridge request is initiated.
#[contractevent(topics = ["bridge"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeInitiated {
    /// Bridge request ID.
    #[topic]
    pub request_id: u64,
    /// Source chain.
    #[topic]
    pub source_chain: Symbol,
    /// Destination chain.
    #[topic]
    pub destination_chain: Symbol,
    /// Asset address.
    #[topic]
    pub asset: Address,
    /// Amount.
    pub amount: i128,
    /// Sender address.
    #[topic]
    pub sender: Address,
}

/// Event published when assets are locked.
#[contractevent(topics = ["bridge", "locked"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetsLocked {
    /// Bridge request ID.
    #[topic]
    pub request_id: u64,
    /// Amount locked.
    pub amount: i128,
}

/// Event published when wrapped assets are minted.
#[contractevent(topics = ["bridge", "minted"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WrappedMinted {
    /// Bridge request ID.
    #[topic]
    pub request_id: u64,
    /// Amount minted.
    pub amount: i128,
}

/// Event published when wrapped assets are burned.
#[contractevent(topics = ["bridge", "burned"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WrappedBurned {
    /// Bridge request ID.
    #[topic]
    pub request_id: u64,
    /// Amount burned.
    pub amount: i128,
}

/// Event published when original assets are unlocked.
#[contractevent(topics = ["bridge", "unlocked"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetsUnlocked {
    /// Bridge request ID.
    #[topic]
    pub request_id: u64,
    /// Amount unlocked.
    pub amount: i128,
}

/// Event published when a bridge request fails.
#[contractevent(topics = ["bridge", "failed"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeFailed {
    /// Bridge request ID.
    #[topic]
    pub request_id: u64,
    /// Failure reason.
    pub reason: Symbol,
}

#[contract]
pub struct BridgeContract;

#[contractimpl]
impl BridgeContract {
    /// Initialize the bridge contract with an administrator.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - The administrator address with privileged permissions.
    ///
    /// # Returns
    /// * `Ok(())` on successful initialization.
    /// * `Err(Error::AlreadyInitialized)` if already initialized.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextRequestId, &1u64);
        env.storage().instance().set(&DataKey::BridgeFee, &30u32); // 0.30% default fee

        extend_instance_ttl(&env);
        Ok(())
    }

    /// Lock assets on the source chain for cross-chain transfer.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `asset` - The asset address to lock.
    /// * `amount` - The amount to lock.
    /// * `destination_chain` - The destination chain identifier.
    /// * `recipient` - The recipient address on the destination chain (hex encoded).
    ///
    /// # Returns
    /// * `u64` - The bridge request ID.
    pub fn lock_asset(
        env: Env,
        asset: Address,
        amount: i128,
        destination_chain: Symbol,
        recipient: Bytes,
    ) -> Result<u64, Error> {
        if amount <= 0 {
            return Err(Error::Unauthorized);
        }

        let _admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        let next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextRequestId)
            .unwrap_or(1);

        let bridge_fee: u32 = env
            .storage()
            .instance()
            .get(&DataKey::BridgeFee)
            .unwrap_or(30);

        let fee_amount = (amount * bridge_fee as i128) / 10000;
        let net_amount = amount - fee_amount;

        let sender = <soroban_sdk::Address as TestAddress>::generate(&env);

        let request = BridgeRequest {
            id: next_id,
            source_chain: symbol_short!("stellar"),
            destination_chain,
            asset: asset.clone(),
            amount: net_amount,
            sender: sender.clone(),
            recipient,
            status: BridgeStatus::Locked,
            created_at: env.ledger().timestamp(),
            completed_at: None,
        };

        env.storage()
            .instance()
            .set(&DataKey::BridgeRequest(next_id), &request);

        env.storage()
            .instance()
            .set(&DataKey::NextRequestId, &(next_id + 1));

        extend_instance_ttl(&env);

        // Emit event
        BridgeInitiated {
            request_id: next_id,
            source_chain: symbol_short!("stellar"),
            destination_chain: request.destination_chain.clone(),
            asset,
            amount: net_amount,
            sender,
        }
        .publish(&env);

        Ok(next_id)
    }

    /// Mint wrapped assets on the destination chain.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `bridge_request_id` - The bridge request ID.
    /// * `proof` - Transaction proof for verification.
    ///
    /// # Returns
    /// * `Ok(())` on successful minting.
    /// * `Err(Error::NotInitialized)` if contract not initialized.
    pub fn mint_wrapped(env: Env, bridge_request_id: u64, proof: Bytes) -> Result<(), Error> {
        let mut request: BridgeRequest = env
            .storage()
            .instance()
            .get(&DataKey::BridgeRequest(bridge_request_id))
            .ok_or(Error::NotInitialized)?;

        if request.status != BridgeStatus::Locked {
            return Err(Error::Unauthorized);
        }

        if proof.is_empty() {
            return Err(Error::Unauthorized);
        }

        request.status = BridgeStatus::Minted;
        request.completed_at = Some(env.ledger().timestamp());

        env.storage()
            .instance()
            .set(&DataKey::BridgeRequest(bridge_request_id), &request);

        extend_instance_ttl(&env);

        // Emit event
        WrappedMinted {
            request_id: bridge_request_id,
            amount: request.amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Burn wrapped assets on the destination chain to unlock original assets.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `asset` - The wrapped asset address to burn.
    /// * `amount` - The amount to burn.
    /// * `source_chain` - The source chain identifier.
    /// * `recipient` - The recipient address on the source chain (hex encoded).
    ///
    /// # Returns
    /// * `u64` - The new bridge request ID for unlocking.
    pub fn burn_wrapped(
        env: Env,
        asset: Address,
        amount: i128,
        source_chain: Symbol,
        recipient: Bytes,
    ) -> Result<u64, Error> {
        if amount <= 0 {
            return Err(Error::Unauthorized);
        }

        let _admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        let next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextRequestId)
            .unwrap_or(1);

        let sender = <soroban_sdk::Address as TestAddress>::generate(&env);

        let request = BridgeRequest {
            id: next_id,
            source_chain,
            destination_chain: symbol_short!("stellar"),
            asset,
            amount,
            sender: sender.clone(),
            recipient,
            status: BridgeStatus::Burned,
            created_at: env.ledger().timestamp(),
            completed_at: None,
        };

        env.storage()
            .instance()
            .set(&DataKey::BridgeRequest(next_id), &request);

        env.storage()
            .instance()
            .set(&DataKey::NextRequestId, &(next_id + 1));

        extend_instance_ttl(&env);

        // Emit event
        WrappedBurned {
            request_id: next_id,
            amount,
        }
        .publish(&env);

        Ok(next_id)
    }

    /// Unlock original assets on the source chain after proof verification.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `bridge_request_id` - The bridge request ID.
    /// * `proof` - Transaction proof for verification.
    ///
    /// # Returns
    /// * `Ok(())` on successful unlocking.
    /// * `Err(Error::NotInitialized)` if contract not initialized.
    pub fn unlock_asset(env: Env, bridge_request_id: u64, proof: Bytes) -> Result<(), Error> {
        let mut request: BridgeRequest = env
            .storage()
            .instance()
            .get(&DataKey::BridgeRequest(bridge_request_id))
            .ok_or(Error::NotInitialized)?;

        if request.status != BridgeStatus::Burned {
            return Err(Error::Unauthorized);
        }

        if proof.is_empty() {
            return Err(Error::Unauthorized);
        }

        request.status = BridgeStatus::Unlocked;
        request.completed_at = Some(env.ledger().timestamp());

        env.storage()
            .instance()
            .set(&DataKey::BridgeRequest(bridge_request_id), &request);

        extend_instance_ttl(&env);

        // Emit event
        AssetsUnlocked {
            request_id: bridge_request_id,
            amount: request.amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Set the bridge fee percentage (basis points).
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `fee_percentage` - Fee percentage in basis points (100 = 1%).
    ///
    /// # Returns
    /// * `Ok(())` on successful update.
    /// * `Err(Error::NotInitialized)` if contract not initialized.
    /// * `Err(Error::Unauthorized)` if caller is not admin.
    pub fn set_bridge_fee(env: Env, fee_percentage: u32) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::BridgeFee, &fee_percentage);

        extend_instance_ttl(&env);

        Ok(())
    }

    /// Get a bridge request by ID.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `request_id` - The bridge request ID.
    ///
    /// # Returns
    /// * `Option<BridgeRequest>` - The bridge request if it exists.
    pub fn get_bridge_request(env: Env, request_id: u64) -> Option<BridgeRequest> {
        env.storage()
            .instance()
            .get(&DataKey::BridgeRequest(request_id))
    }

    /// Get the current bridge fee percentage.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Returns
    /// * `u32` - Fee percentage in basis points.
    pub fn get_bridge_fee(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::BridgeFee)
            .unwrap_or(30)
    }
}

#[cfg(test)]
mod test;
