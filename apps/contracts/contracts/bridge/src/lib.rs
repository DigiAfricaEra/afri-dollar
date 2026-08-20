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
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short,
    token::TokenClient, Address, Bytes, BytesN, Env, Symbol, Vec,
};

/// Proof action byte used when signing a mint (lock leg) proof.
const ACTION_MINT: u8 = 1;
/// Proof action byte used when signing an unlock (burn leg) proof.
const ACTION_UNLOCK: u8 = 2;
/// Size of a single ECDSA signature block inside a proof: one recovery id byte
/// followed by the 64-byte `r || s` signature.
const SIGNATURE_BLOCK_SIZE: u32 = 65;
/// Maximum accepted ECDSA recovery id (`0..=3`).
const MAX_RECOVERY_ID: u32 = 3;
/// Bridge fee upper bound, expressed in basis points (10000 = 100%).
const MAX_BRIDGE_FEE_BPS: u32 = 10_000;
/// Current on-disk storage schema version. Bumped on every breaking layout
/// change so the contract can refuse to operate on a state written by an
/// older, incompatible deployment.
const STORAGE_VERSION: u32 = 2;

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
    /// Gross amount locked by the sender before the bridge fee is deducted.
    pub gross_amount: i128,
    /// Net amount released at the mint/unlock hop (`gross_amount` minus fee).
    pub amount: i128,
    /// Bridge fee deducted from `gross_amount` (`gross_amount - amount`).
    pub bridge_fee_applied: i128,
    /// Sender address on source chain.
    pub sender: Address,
    /// Recipient address on destination chain (stored as Bytes for cross-chain compatibility).
    pub recipient: Bytes,
    /// Stellar address that receives the unlocked original asset on the
    /// burn/unlock leg. `None` for outbound (lock) requests.
    pub unlock_recipient: Option<Address>,
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
    /// Accumulated bridge fees per asset, withdrawable by the admin.
    FeesCollected(Address),
    /// ECDSA public keys of the proof-signing oracle set (SEC-1 encoded).
    Signers,
    /// Minimum number of distinct signer signatures required to accept a proof.
    SignerThreshold,
    /// On-disk schema version; refuses operations when the stored value differs
    /// from the current `STORAGE_VERSION`.
    StorageVersion,
}

/// Event published when a bridge request is initiated.
#[contractevent(topics = ["bridge"])]
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
    /// Net amount credited to the request after the bridge fee.
    pub amount: i128,
    /// Gross amount locked by the sender.
    pub gross_amount: i128,
    /// Bridge fee collected by the treasury.
    pub fee_amount: i128,
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

/// Event published when accumulated bridge fees are withdrawn.
#[contractevent(topics = ["bridge", "fees"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeesWithdrawn {
    /// Asset whose fees were withdrawn.
    #[topic]
    pub asset: Address,
    /// Amount withdrawn.
    pub amount: i128,
    /// Treasury address that received the fees.
    #[topic]
    pub to: Address,
}

/// Bridge-specific error variants.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum BridgeError {
    /// The requested fee withdrawal exceeds the collected fees for the asset.
    InsufficientFees = 1,
    /// A fee withdrawal was attempted by a non-admin caller.
    FeeWithdrawalUnauthorized = 2,
    /// On-disk storage schema is from an older, incompatible deployment.
    InvalidStorageVersion = 3,
    /// The unlock would draw down the contract's collected-fee reserve.
    InsufficientLiquidity = 4,
    /// The bridge fee was set above `MAX_BRIDGE_FEE_BPS` or the resulting net
    /// amount would be non-positive.
    InvalidFee = 5,
    /// The signer set contains duplicate or invalid entries.
    DuplicateSigner = 6,
}

/// Encode an `Address` into a stable byte form for use inside a proof digest.
/// Strkey encoding (G... for accounts, C... for contracts) is canonical and
/// unambiguous per network, so two equal addresses always produce equal bytes
/// and two different addresses always produce different bytes.
fn address_bytes(addr: &Address) -> Bytes {
    addr.to_string().to_bytes()
}

/// Reject a caller when the on-disk storage schema is from a previous release.
/// Deployments with a stale `StorageVersion` (or none) must be migrated
/// explicitly before this contract will operate on them.
fn require_storage_version(env: &Env) -> Result<(), Error> {
    let stored: u32 = env
        .storage()
        .instance()
        .get(&DataKey::StorageVersion)
        .unwrap_or(0);
    if stored != STORAGE_VERSION {
        return Err(Error::InvalidVersion);
    }
    Ok(())
}

/// Verify an ECDSA multi-signature proof against the configured oracle signer
/// set with a minimum threshold of distinct signers.
///
/// The proof is a sequence of 65-byte blocks, each containing a one-byte
/// recovery id followed by a 64-byte `r || s` signature. Every signature is
/// recovered against `sha256(contract || action || request_id || asset ||
/// amount || destination)` and must belong to a configured signer. At least
/// `threshold` distinct signers must be present. Domain-separating the
/// digest across these fields prevents replay across deployments and stops a
/// single proof from authorizing an arbitrary asset / amount / recipient.
fn verify_proof(
    env: &Env,
    proof: &Bytes,
    action: u8,
    request_id: u64,
    asset: &Address,
    amount: i128,
    destination: &Address,
) -> Result<(), Error> {
    let signers: Vec<BytesN<65>> = env
        .storage()
        .instance()
        .get(&DataKey::Signers)
        .ok_or(Error::NotInitialized)?;

    let threshold: u32 = env
        .storage()
        .instance()
        .get(&DataKey::SignerThreshold)
        .unwrap_or(2);

    if !proof.len().is_multiple_of(SIGNATURE_BLOCK_SIZE) {
        return Err(Error::Unauthorized);
    }
    let num_sigs = proof.len() / SIGNATURE_BLOCK_SIZE;
    if num_sigs < threshold {
        return Err(Error::Unauthorized);
    }

    let mut msg = Bytes::new(env);
    msg.append(&address_bytes(&env.current_contract_address()));
    msg.push_back(action);
    msg.extend_from_array(&request_id.to_be_bytes());
    msg.append(&address_bytes(asset));
    msg.extend_from_array(&amount.to_be_bytes());
    msg.append(&address_bytes(destination));
    let digest = env.crypto().sha256(&msg);

    // Track which signer slots matched so duplicate signatures count once.
    let mut matched: Vec<bool> = Vec::new(env);
    for _ in 0..signers.len() {
        matched.push_back(false);
    }

    for i in 0..num_sigs {
        let offset = i * SIGNATURE_BLOCK_SIZE;
        let recovery_id = proof.get(offset).unwrap() as u32;
        if recovery_id > MAX_RECOVERY_ID {
            return Err(Error::Unauthorized);
        }
        let signature =
            BytesN::<64>::try_from(proof.slice(offset + 1..offset + SIGNATURE_BLOCK_SIZE))
                .map_err(|_| Error::Unauthorized)?;
        let recovered = env
            .crypto()
            .secp256k1_recover(&digest, &signature, recovery_id);
        for j in 0..signers.len() {
            if signers.get(j).unwrap() == recovered && !matched.get(j).unwrap() {
                matched.set(j, true);
                // A recovered key only maps to one signer slot; skip the rest.
                break;
            }
        }
    }

    let mut count: u32 = 0;
    for i in 0..matched.len() {
        if matched.get(i).unwrap() {
            count += 1;
        }
    }
    if count < threshold {
        return Err(Error::Unauthorized);
    }

    Ok(())
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

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextRequestId, &1u64);
        env.storage().instance().set(&DataKey::BridgeFee, &30u32); // 0.30% default fee
        env.storage()
            .instance()
            .set(&DataKey::StorageVersion, &STORAGE_VERSION);

        extend_instance_ttl(&env);
        Ok(())
    }

    /// Lock assets on the source chain for cross-chain transfer.
    ///
    /// The full `amount` is transferred from `caller` into the contract. The
    /// bridge fee is deducted and tracked in `FeesCollected`, while the net
    /// amount is recorded on the request and released to the wrapped-asset
    /// minter at the mint hop.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `caller` - The account locking the assets (authorized via `require_auth`).
    /// * `asset` - The asset address to lock.
    /// * `amount` - The gross amount to lock.
    /// * `destination_chain` - The destination chain identifier.
    /// * `recipient` - The recipient address on the destination chain (hex encoded).
    ///
    /// # Returns
    /// * `u64` - The bridge request ID.
    pub fn lock_asset(
        env: Env,
        caller: Address,
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

        caller.require_auth();

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

        // Guard against a fee setting that would consume the entire deposit
        // (or, in the limit, refund the sender). The net amount must remain
        // strictly positive for the bridge request to be meaningful.
        if bridge_fee > MAX_BRIDGE_FEE_BPS {
            return Err(Error::InvalidAmount);
        }
        let fee_amount = (amount * bridge_fee as i128) / 10000;
        let net_amount = amount - fee_amount;
        if net_amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        // Pull the full gross amount into the contract; the fee stays with the
        // contract as treasury, the net is owed to the wrapped-asset minter.
        TokenClient::new(&env, &asset).transfer(&caller, env.current_contract_address(), &amount);

        let collected: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeesCollected(asset.clone()))
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::FeesCollected(asset.clone()),
            &(collected + fee_amount),
        );

        let request = BridgeRequest {
            id: next_id,
            source_chain: symbol_short!("stellar"),
            destination_chain,
            asset: asset.clone(),
            gross_amount: amount,
            amount: net_amount,
            bridge_fee_applied: fee_amount,
            sender: caller.clone(),
            recipient,
            unlock_recipient: None,
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

        // Emit event with both gross and net amounts.
        BridgeInitiated {
            request_id: next_id,
            source_chain: symbol_short!("stellar"),
            destination_chain: request.destination_chain.clone(),
            asset,
            amount: net_amount,
            gross_amount: amount,
            fee_amount,
            sender: caller,
        }
        .publish(&env);

        Ok(next_id)
    }

    /// Release the locked (net) amount to the wrapped-asset minter on the
    /// destination chain after a valid multi-signature proof is supplied.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `bridge_request_id` - The bridge request ID.
    /// * `proof` - ECDSA multi-signature proof for verification.
    /// * `wrapped_asset_issuer` - Address that mints the wrapped asset on the
    ///   destination chain and holds the released collateral.
    ///
    /// # Returns
    /// * `Ok(())` on successful minting.
    pub fn mint_wrapped(
        env: Env,
        bridge_request_id: u64,
        proof: Bytes,
        wrapped_asset_issuer: Address,
    ) -> Result<(), Error> {
        require_storage_version(&env)?;

        let mut request: BridgeRequest = env
            .storage()
            .instance()
            .get(&DataKey::BridgeRequest(bridge_request_id))
            .ok_or(Error::NotInitialized)?;

        if request.status != BridgeStatus::Locked {
            return Err(Error::Unauthorized);
        }

        // Verify the proof against the destination: the same proof bytes cannot
        // authorize a payout to any other address. Combined with the
        // status-mutation order below, this prevents replay-by-resubmission
        // from stealing the locked funds.
        verify_proof(
            &env,
            &proof,
            ACTION_MINT,
            bridge_request_id,
            &request.asset,
            request.amount,
            &wrapped_asset_issuer,
        )?;

        // Persist the terminal status before performing any external token
        // transfer. If the transfer were to fail the request would still be
        // marked Minted; doing this first keeps the state machine honest.
        request.status = BridgeStatus::Minted;
        request.completed_at = Some(env.ledger().timestamp());
        env.storage()
            .instance()
            .set(&DataKey::BridgeRequest(bridge_request_id), &request);

        // Release the net amount to the wrapped-asset minter, which holds it
        // as collateral for the wrapped tokens minted on the destination chain.
        TokenClient::new(&env, &request.asset).transfer(
            &env.current_contract_address(),
            &wrapped_asset_issuer,
            &request.amount,
        );

        extend_instance_ttl(&env);

        WrappedMinted {
            request_id: bridge_request_id,
            amount: request.amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Initiate the return leg: deposit wrapped tokens into the contract and
    /// record a burn request whose original asset can later be unlocked.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `caller` - The account burning the wrapped tokens (authorized via `require_auth`).
    /// * `asset` - The original asset to unlock on the source chain.
    /// * `wrapped_token` - The wrapped asset being deposited/burned.
    /// * `amount` - The amount to burn.
    /// * `source_chain` - The destination chain identifier the burn originated from.
    /// * `recipient` - The Stellar address that will receive the unlocked original asset.
    ///
    /// # Returns
    /// * `u64` - The new bridge request ID for unlocking.
    pub fn burn_wrapped(
        env: Env,
        caller: Address,
        asset: Address,
        wrapped_token: Address,
        amount: i128,
        source_chain: Symbol,
        recipient: Address,
    ) -> Result<u64, Error> {
        require_storage_version(&env)?;

        if amount <= 0 {
            return Err(Error::Unauthorized);
        }

        let _admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        caller.require_auth();

        let next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextRequestId)
            .unwrap_or(1);

        // Deposit the wrapped tokens into the contract, retiring them from
        // circulation until the original asset is unlocked.
        TokenClient::new(&env, &wrapped_token).transfer(
            &caller,
            env.current_contract_address(),
            &amount,
        );

        let request = BridgeRequest {
            id: next_id,
            source_chain,
            destination_chain: symbol_short!("stellar"),
            asset: asset.clone(),
            gross_amount: amount,
            amount,
            bridge_fee_applied: 0,
            sender: caller.clone(),
            recipient: Bytes::new(&env),
            unlock_recipient: Some(recipient.clone()),
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

    /// Unlock original assets to the burn request's recipient after a valid
    /// multi-signature proof is supplied.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `bridge_request_id` - The bridge request ID.
    /// * `proof` - ECDSA multi-signature proof for verification.
    ///
    /// # Returns
    /// * `Ok(())` on successful unlocking.
    pub fn unlock_asset(env: Env, bridge_request_id: u64, proof: Bytes) -> Result<(), Error> {
        require_storage_version(&env)?;

        let mut request: BridgeRequest = env
            .storage()
            .instance()
            .get(&DataKey::BridgeRequest(bridge_request_id))
            .ok_or(Error::NotInitialized)?;

        if request.status != BridgeStatus::Burned {
            return Err(Error::Unauthorized);
        }

        let unlock_recipient: Address = request
            .unlock_recipient
            .clone()
            .ok_or(Error::Unauthorized)?;

        // Verify the proof against the recorded recipient: same proof bytes
        // cannot authorize a payout to any other Stellar address.
        verify_proof(
            &env,
            &proof,
            ACTION_UNLOCK,
            bridge_request_id,
            &request.asset,
            request.amount,
            &unlock_recipient,
        )?;

        // Reserve the contract's collected-fee balance. The unlock draws from
        // the same pooled balance that holds the fees; without this check the
        // admin could find their `withdraw_fees` call trap once the pool has
        // been drained by legitimate unlocks.
        let collected: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeesCollected(request.asset.clone()))
            .unwrap_or(0);
        let pool: i128 =
            TokenClient::new(&env, &request.asset).balance(&env.current_contract_address());
        if pool - collected < request.amount {
            return Err(Error::InsufficientBalance);
        }

        // Persist the terminal status before the external transfer so the
        // state machine always reflects the intended outcome, even if the
        // transfer were to fail at the host boundary.
        request.status = BridgeStatus::Unlocked;
        request.completed_at = Some(env.ledger().timestamp());
        env.storage()
            .instance()
            .set(&DataKey::BridgeRequest(bridge_request_id), &request);

        // Release the stored net amount to the recipient from the contract's
        // pooled balance of the original asset.
        TokenClient::new(&env, &request.asset).transfer(
            &env.current_contract_address(),
            &unlock_recipient,
            &request.amount,
        );

        extend_instance_ttl(&env);

        AssetsUnlocked {
            request_id: bridge_request_id,
            amount: request.amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Withdraw accumulated bridge fees for an asset to a treasury address.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - The administrator address (authorized via `require_auth`).
    /// * `asset` - The asset whose collected fees are withdrawn.
    /// * `to` - The treasury address that receives the fees.
    /// * `amount` - The fee amount to withdraw.
    ///
    /// # Returns
    /// * `Ok(())` on successful withdrawal.
    pub fn withdraw_fees(
        env: Env,
        admin: Address,
        asset: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), BridgeError> {
        if env
            .storage()
            .instance()
            .get::<_, u32>(&DataKey::StorageVersion)
            .unwrap_or(0)
            != STORAGE_VERSION
        {
            return Err(BridgeError::InvalidStorageVersion);
        }

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(BridgeError::FeeWithdrawalUnauthorized)?;
        if admin != stored_admin {
            return Err(BridgeError::FeeWithdrawalUnauthorized);
        }
        admin.require_auth();

        if amount <= 0 {
            return Err(BridgeError::InsufficientFees);
        }

        let collected: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeesCollected(asset.clone()))
            .unwrap_or(0);
        if collected < amount {
            return Err(BridgeError::InsufficientFees);
        }

        env.storage().instance().set(
            &DataKey::FeesCollected(asset.clone()),
            &(collected - amount),
        );

        TokenClient::new(&env, &asset).transfer(&env.current_contract_address(), &to, &amount);

        extend_instance_ttl(&env);

        FeesWithdrawn { asset, amount, to }.publish(&env);

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
    /// * `Err(Error::Unauthorized)` if caller is not admin.
    pub fn set_bridge_fee(env: Env, fee_percentage: u32) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        admin.require_auth();

        if fee_percentage > MAX_BRIDGE_FEE_BPS {
            return Err(Error::InvalidAmount);
        }

        env.storage()
            .instance()
            .set(&DataKey::BridgeFee, &fee_percentage);

        extend_instance_ttl(&env);

        Ok(())
    }

    /// Configure the ECDSA public keys of the proof-signing oracle set and the
    /// minimum distinct-signer threshold.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - The administrator address (authorized via `require_auth`).
    /// * `signers` - SEC-1 encoded (uncompressed, 65-byte) signer public keys.
    /// * `threshold` - Minimum distinct signers required to accept a proof.
    ///
    /// # Returns
    /// * `Ok(())` on successful update.
    /// * `Err(Error::InvalidAmount)` if the signer set or threshold is invalid.
    /// * `Err(Error::Unauthorized)` if caller is not admin.
    pub fn set_signers(
        env: Env,
        admin: Address,
        signers: Vec<BytesN<65>>,
        threshold: u32,
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

        if signers.is_empty() || threshold == 0 || threshold > signers.len() {
            return Err(Error::InvalidAmount);
        }

        // Reject duplicate entries so an attacker cannot satisfy the threshold
        // by replaying signatures from the same key across multiple slots.
        for i in 0..signers.len() {
            for j in (i + 1)..signers.len() {
                if signers.get(i).unwrap() == signers.get(j).unwrap() {
                    return Err(Error::InvalidAmount);
                }
            }
        }

        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage()
            .instance()
            .set(&DataKey::SignerThreshold, &threshold);

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

    /// Get the collected fees for an asset.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `asset` - The asset address.
    ///
    /// # Returns
    /// * `i128` - Accumulated bridge fees for the asset.
    pub fn get_collected_fees(env: Env, asset: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::FeesCollected(asset))
            .unwrap_or(0)
    }

    /// Get the configured proof-signing oracle set.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Returns
    /// * `Vec<BytesN<65>>` - The configured signer public keys.
    pub fn get_signers(env: Env) -> Vec<BytesN<65>> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Get the configured proof-signer threshold.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Returns
    /// * `u32` - Minimum distinct signers required to accept a proof.
    pub fn get_signer_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::SignerThreshold)
            .unwrap_or(2)
    }
}

#[cfg(test)]
mod test;
