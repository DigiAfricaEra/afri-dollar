#![no_std]
//! Multisig — an N-of-M multi-signature wallet contract for AfriDollar.
//!
//! Signers propose transactions (asset transfers out of the contract's own
//! token balance), other signers approve them, and once approvals reach the
//! configured `threshold`, the transaction can be executed.
//!
//! ## Design notes: choices beyond the issue's literal sketch
//!
//! * **`initialize` requires every listed signer's authorization.** Without
//!   this, anyone could initialize a multisig naming other people's
//!   addresses as signers who never consented — the same class of bug as
//!   an unauthenticated `initialize` on any admin-gated contract.
//! * **`create_transaction` does not auto-approve.** The creator must call
//!   `approve` separately, keeping proposal and approval as two explicit,
//!   independently-tested steps.
//! * **`execute` is permissionless once `threshold` is met**, matching the
//!   issue's exact signature (`execute(env, tx_id)`, no caller parameter).
//!   The security gate is the approval count itself, not who calls
//!   execute — this is a common, deliberate design in multisig contracts
//!   (anyone can relay an already-sufficiently-approved transaction).
//! * **`add_signer`/`remove_signer`/`change_threshold`** are not specified
//!   with exact signatures in the issue beyond "if threshold met". Rather
//!   than building a second proposal/approval storage system just for
//!   governance actions, each takes a `callers: Vec<Address>` of current
//!   signers who each individually call `require_auth()` in the same
//!   invocation — Soroban natively supports multiple signatures in one
//!   call, and this is the same pattern used for admin multisig actions
//!   in this workspace's sibling escrow contracts.
//!
//! All contract entrypoints return `Result<_, Error>` rather than bare
//! values, matching this repo's established convention (see the `counter`
//! reference contract) rather than the bare-return signatures originally
//! sketched for this issue.

use afri_contract_shared::{
    extend_instance_ttl, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token::TokenClient,
    Address, Bytes, Env, MuxedAddress, Vec,
};

/// Errors returned by the multisig contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` was called on a contract that already has signers.
    AlreadyInitialized = 1,
    /// An operation was attempted before the contract was initialized.
    NotInitialized = 2,
    /// The caller is not a signer, or too few current signers co-signed.
    Unauthorized = 3,
    /// An amount argument was zero, negative, or otherwise invalid.
    InvalidAmount = 4,
    /// `initialize` or `add_signer` listed/named a duplicate signer.
    DuplicateSigner = 5,
    /// `threshold` is zero or exceeds the number of signers.
    InvalidThreshold = 6,
    /// No `Transaction` exists for the given `tx_id`.
    TransactionNotFound = 7,
    /// The transaction has already been executed.
    AlreadyExecuted = 8,
    /// This signer has already approved this transaction.
    AlreadyApproved = 9,
    /// `execute` was called before enough signers approved.
    ThresholdNotMet = 10,
    /// `remove_signer` named an address that is not a current signer.
    SignerNotFound = 11,
    /// Removing this signer would drop the signer count below `threshold`.
    WouldBreakThreshold = 12,
    /// A checked arithmetic operation would have overflowed.
    Overflow = 13,
}

/// A proposed (and possibly executed) asset transfer out of the contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Transaction {
    pub id: u64,
    pub destination: Address,
    pub asset: Address,
    pub amount: i128,
    pub data: Bytes,
    pub approvals: Vec<Address>,
    pub executed: bool,
}

/// Instance/persistent storage keys.
#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// The current list of signer addresses.
    Signers,
    /// The current approval threshold.
    Threshold,
    /// Monotonic counter used to assign new transaction ids.
    TxCount,
    /// `Transaction`, keyed by its own id.
    Tx(u64),
}

/// Emitted when a new transaction is proposed.
#[contractevent(topics = ["multisig", "tx_created"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionCreated {
    #[topic]
    pub tx_id: u64,
    pub creator: Address,
    pub destination: Address,
    pub asset: Address,
    pub amount: i128,
}

/// Emitted when a signer approves a transaction.
#[contractevent(topics = ["multisig", "approved"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Approved {
    #[topic]
    pub tx_id: u64,
    pub signer: Address,
}

/// Emitted when a transaction is executed.
#[contractevent(topics = ["multisig", "executed"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Executed {
    #[topic]
    pub tx_id: u64,
    pub approval_count: u32,
}

/// Emitted when a signer is added via `add_signer`.
#[contractevent(topics = ["multisig", "signer_add"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerAdded {
    #[topic]
    pub signer: Address,
}

/// Emitted when a signer is removed via `remove_signer`.
#[contractevent(topics = ["multisig", "signer_rm"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerRemoved {
    #[topic]
    pub signer: Address,
}

/// Emitted when the approval threshold changes via `change_threshold`.
#[contractevent(topics = ["multisig", "threshold"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThresholdChanged {
    #[topic]
    pub new_threshold: u32,
}

/// Extend the TTL of a persistent storage entry (a `Transaction`), using
/// the same bump amounts as `extend_instance_ttl`.
fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn read_signers(env: &Env) -> Result<Vec<Address>, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Signers)
        .ok_or(Error::NotInitialized)
}

fn read_threshold(env: &Env) -> Result<u32, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Threshold)
        .ok_or(Error::NotInitialized)
}

fn is_signer(signers: &Vec<Address>, addr: &Address) -> bool {
    signers.iter().any(|s| s == *addr)
}

/// Require that at least `threshold` *distinct*, *current* signers among
/// `callers` have each authorized this invocation. Used to gate
/// `add_signer`/`remove_signer`/`change_threshold`.
fn require_signer_threshold(env: &Env, callers: &Vec<Address>) -> Result<(), Error> {
    let signers = read_signers(env)?;
    let threshold = read_threshold(env)?;

    let mut valid_count: u32 = 0;
    let mut seen: Vec<Address> = Vec::new(env);
    for caller in callers.iter() {
        if !is_signer(&signers, &caller) {
            continue;
        }
        if is_signer(&seen, &caller) {
            continue; // ignore duplicate entries in `callers`
        }
        caller.require_auth();
        seen.push_back(caller.clone());
        valid_count = valid_count.saturating_add(1);
    }

    if valid_count < threshold {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

fn read_tx(env: &Env, tx_id: u64) -> Result<Transaction, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Tx(tx_id))
        .ok_or(Error::TransactionNotFound)
}

fn put_tx(env: &Env, tx: &Transaction) {
    env.storage().persistent().set(&DataKey::Tx(tx.id), tx);
    extend_persistent_ttl(env, &DataKey::Tx(tx.id));
    extend_instance_ttl(env);
}

#[contract]
pub struct MultisigContract;

#[contractimpl]
impl MultisigContract {
    /// Initialize the wallet with an initial signer set and approval
    /// threshold. Requires **every** listed signer's authorization, so a
    /// multisig can never be initialized naming addresses that never
    /// consented to being signers.
    ///
    /// Fails with `Error::AlreadyInitialized` if called twice,
    /// `Error::DuplicateSigner` if `signers` contains a repeated address,
    /// and `Error::InvalidThreshold` if `threshold` is `0` or exceeds
    /// `signers.len()`.
    pub fn initialize(env: Env, signers: Vec<Address>, threshold: u32) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Signers) {
            return Err(Error::AlreadyInitialized);
        }
        if threshold == 0 || threshold > signers.len() {
            return Err(Error::InvalidThreshold);
        }
        let mut seen: Vec<Address> = Vec::new(&env);
        for signer in signers.iter() {
            if is_signer(&seen, &signer) {
                return Err(Error::DuplicateSigner);
            }
            signer.require_auth();
            seen.push_back(signer.clone());
        }

        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::TxCount, &0u64);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Propose a new transaction moving `amount` of `asset` to
    /// `destination` out of this contract's own token balance. `creator`
    /// must be a current signer. Does **not** auto-approve — the creator
    /// must call `approve` separately, same as any other signer.
    ///
    /// `data` is opaque caller-supplied context (e.g. a memo/reference);
    /// the contract does not interpret it.
    pub fn create_transaction(
        env: Env,
        creator: Address,
        destination: Address,
        asset: Address,
        amount: i128,
        data: Bytes,
    ) -> Result<u64, Error> {
        creator.require_auth();
        let signers = read_signers(&env)?;
        if !is_signer(&signers, &creator) {
            return Err(Error::Unauthorized);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let count: u64 = env.storage().instance().get(&DataKey::TxCount).unwrap_or(0);
        let tx_id = count.checked_add(1).ok_or(Error::Overflow)?;

        let tx = Transaction {
            id: tx_id,
            destination: destination.clone(),
            asset,
            amount,
            data,
            approvals: Vec::new(&env),
            executed: false,
        };
        put_tx(&env, &tx);
        env.storage().instance().set(&DataKey::TxCount, &tx_id);
        extend_instance_ttl(&env);

        TransactionCreated {
            tx_id,
            creator,
            destination,
            asset: tx.asset.clone(),
            amount,
        }
        .publish(&env);
        Ok(tx_id)
    }

    /// Approve a pending transaction. `signer` must be a current signer
    /// and must not have already approved this transaction
    /// (`Error::AlreadyApproved`). Fails with `Error::AlreadyExecuted` if
    /// the transaction has already been executed.
    pub fn approve(env: Env, signer: Address, tx_id: u64) -> Result<(), Error> {
        signer.require_auth();
        let signers = read_signers(&env)?;
        if !is_signer(&signers, &signer) {
            return Err(Error::Unauthorized);
        }
        let mut tx = read_tx(&env, tx_id)?;
        if tx.executed {
            return Err(Error::AlreadyExecuted);
        }
        if is_signer(&tx.approvals, &signer) {
            return Err(Error::AlreadyApproved);
        }
        tx.approvals.push_back(signer.clone());
        put_tx(&env, &tx);

        Approved { tx_id, signer }.publish(&env);
        Ok(())
    }

    /// Execute a transaction once its approvals reach `threshold`.
    /// Permissionless: any caller may invoke this once the threshold is
    /// met, since the approvals already gate the actual authorization —
    /// see the module-level docs for why. Fails with
    /// `Error::ThresholdNotMet` if not enough approvals yet, or
    /// `Error::AlreadyExecuted` if already run.
    ///
    /// Transfers `tx.amount` of `tx.asset` from this contract's own
    /// balance to `tx.destination` — the contract must already hold at
    /// least that much (callers fund the wallet via ordinary token
    /// transfers to the contract's address before proposing a spend).
    pub fn execute(env: Env, tx_id: u64) -> Result<(), Error> {
        let mut tx = read_tx(&env, tx_id)?;
        if tx.executed {
            return Err(Error::AlreadyExecuted);
        }
        let threshold = read_threshold(&env)?;
        // Only count approvals from addresses that are still current
        // signers. A signer who approved and was later removed via
        // `remove_signer` must not have their stale approval still count
        // toward the threshold.
        let signers = read_signers(&env)?;
        let approval_count = tx
            .approvals
            .iter()
            .filter(|a| is_signer(&signers, a))
            .count() as u32;
        if approval_count < threshold {
            return Err(Error::ThresholdNotMet);
        }

        tx.executed = true;
        put_tx(&env, &tx);

        TokenClient::new(&env, &tx.asset).transfer(
            &env.current_contract_address(),
            MuxedAddress::from(tx.destination.clone()),
            &tx.amount,
        );

        Executed {
            tx_id,
            approval_count,
        }
        .publish(&env);
        Ok(())
    }

    /// Add a new signer. Requires at least `threshold`-many *current*
    /// signers among `callers` to each individually authorize this call
    /// (Soroban supports multiple signatures per invocation natively).
    /// Fails with `Error::DuplicateSigner` if `new_signer` is already a
    /// signer.
    pub fn add_signer(env: Env, callers: Vec<Address>, new_signer: Address) -> Result<(), Error> {
        require_signer_threshold(&env, &callers)?;
        let mut signers = read_signers(&env)?;
        if is_signer(&signers, &new_signer) {
            return Err(Error::DuplicateSigner);
        }
        signers.push_back(new_signer.clone());
        env.storage().instance().set(&DataKey::Signers, &signers);
        extend_instance_ttl(&env);
        SignerAdded { signer: new_signer }.publish(&env);
        Ok(())
    }
    /// Remove a signer. Requires at least `threshold`-many current
    /// signers among `callers` to each authorize. Fails with
    /// `Error::SignerNotFound` if `signer_to_remove` is not currently a
    /// signer, or `Error::WouldBreakThreshold` if removing them would
    /// drop the remaining signer count below the current `threshold`.
    pub fn remove_signer(
        env: Env,
        callers: Vec<Address>,
        signer_to_remove: Address,
    ) -> Result<(), Error> {
        require_signer_threshold(&env, &callers)?;
        let signers = read_signers(&env)?;
        if !is_signer(&signers, &signer_to_remove) {
            return Err(Error::SignerNotFound);
        }
        let threshold = read_threshold(&env)?;
        let remaining = signers.len().checked_sub(1).ok_or(Error::Overflow)?;
        if remaining < threshold {
            return Err(Error::WouldBreakThreshold);
        }

        let mut updated: Vec<Address> = Vec::new(&env);
        for s in signers.iter() {
            if s != signer_to_remove {
                updated.push_back(s);
            }
        }
        env.storage().instance().set(&DataKey::Signers, &updated);
        extend_instance_ttl(&env);

        SignerRemoved {
            signer: signer_to_remove,
        }
        .publish(&env);
        Ok(())
    }

    /// Change the approval threshold. Requires at least `threshold`-many
    /// (the *current* threshold, before the change) current signers
    /// among `callers` to each authorize. Fails with
    /// `Error::InvalidThreshold` if `new_threshold` is `0` or exceeds the
    /// current signer count.
    pub fn change_threshold(
        env: Env,
        callers: Vec<Address>,
        new_threshold: u32,
    ) -> Result<(), Error> {
        require_signer_threshold(&env, &callers)?;
        let signers = read_signers(&env)?;
        if new_threshold == 0 || new_threshold > signers.len() {
            return Err(Error::InvalidThreshold);
        }
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &new_threshold);
        extend_instance_ttl(&env);

        ThresholdChanged { new_threshold }.publish(&env);
        Ok(())
    }

    /// Read the full `Transaction` for `tx_id`.
    /// `Error::TransactionNotFound` if it doesn't exist.
    pub fn get_transaction(env: Env, tx_id: u64) -> Result<Transaction, Error> {
        read_tx(&env, tx_id)
    }

    /// Returns `true` iff `address` is a current signer.
    pub fn is_signer(env: Env, address: Address) -> Result<bool, Error> {
        let signers = read_signers(&env)?;
        Ok(is_signer(&signers, &address))
    }

    /// Read the current signer list.
    pub fn get_signers(env: Env) -> Result<Vec<Address>, Error> {
        read_signers(&env)
    }

    /// Read the current approval threshold.
    pub fn get_threshold(env: Env) -> Result<u32, Error> {
        read_threshold(&env)
    }
}

#[cfg(test)]
mod test;
