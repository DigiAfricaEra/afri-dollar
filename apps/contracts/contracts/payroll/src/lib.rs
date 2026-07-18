#![no_std]
//! Payroll batch distribution contract for AfriDollar.
//!
//! Allows an admin to initialize the contract, after which any address can:
//!
//! * Create a payroll batch tied to an asset.
//! * Add recipients with individual amounts.
//! * Fund the batch by depositing the exact total into the contract.
//! * Distribute all payments in a single call.
//! * Cancel a batch before it is funded.
//!
//! Funds are held in the contract's token balance and transferred to
//! recipients atomically on distribution.

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
    /// No payroll batch exists for the given ID.
    BatchNotFound = 4,
    /// An amount argument was zero or negative.
    InvalidAmount = 5,
    /// The batch has already been funded or distributed.
    BatchAlreadyFunded = 6,
    /// The batch has not been funded yet.
    BatchNotFunded = 7,
    /// The batch has already been distributed.
    AlreadyDistributed = 8,
    /// A checked arithmetic operation would have overflowed.
    Overflow = 9,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Recipient {
    pub address: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayrollBatch {
    pub id: u64,
    pub creator: Address,
    pub asset: Address,
    pub recipients: Vec<Recipient>,
    pub total_amount: i128,
    pub funded: bool,
    pub distributed: bool,
    pub created_at: u64,
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    NextBatchId,
    PayrollBatch(u64),
    Recipients(u64),
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent(topics = ["payroll", "batch_created"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchCreated {
    #[topic]
    pub batch_id: u64,
    #[topic]
    pub creator: Address,
    pub asset: Address,
}

#[contractevent(topics = ["payroll", "recipient_added"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecipientAdded {
    #[topic]
    pub batch_id: u64,
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent(topics = ["payroll", "batch_funded"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchFunded {
    #[topic]
    pub batch_id: u64,
    #[topic]
    pub funder: Address,
    pub total_amount: i128,
}

#[contractevent(topics = ["payroll", "distribution_completed"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DistributionCompleted {
    #[topic]
    pub batch_id: u64,
    pub total_amount: i128,
}

#[contractevent(topics = ["payroll", "batch_cancelled"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchCancelled {
    #[topic]
    pub batch_id: u64,
    #[topic]
    pub creator: Address,
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

fn read_batch(env: &Env, batch_id: u64) -> Option<PayrollBatch> {
    env.storage()
        .persistent()
        .get(&DataKey::PayrollBatch(batch_id))
}

fn put_batch(env: &Env, batch: &PayrollBatch) {
    env.storage()
        .persistent()
        .set(&DataKey::PayrollBatch(batch.id), batch);
}

fn read_recipients(env: &Env, batch_id: u64) -> Vec<Recipient> {
    env.storage()
        .persistent()
        .get(&DataKey::Recipients(batch_id))
        .unwrap_or_else(|| soroban_sdk::vec![env])
}

fn put_recipients(env: &Env, batch_id: u64, recipients: &Vec<Recipient>) {
    env.storage()
        .persistent()
        .set(&DataKey::Recipients(batch_id), recipients);
}

fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct PayrollContract;

#[contractimpl]
impl PayrollContract {
    /// Initialize the contract with an `admin` address.
    /// Fails with `Error::AlreadyInitialized` if called twice.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextBatchId, &1u64);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Create a new empty payroll batch for `asset`.
    /// Returns the new batch ID.
    pub fn create_batch(env: Env, creator: Address, asset: Address) -> u64 {
        creator.require_auth();

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextBatchId)
            .unwrap_or(1);
        let next_id = id.checked_add(1).ok_or(Error::Overflow).unwrap();

        let batch = PayrollBatch {
            id,
            creator: creator.clone(),
            asset: asset.clone(),
            recipients: soroban_sdk::vec![&env],
            total_amount: 0,
            funded: false,
            distributed: false,
            created_at: env.ledger().timestamp(),
        };

        put_batch(&env, &batch);
        put_recipients(&env, id, &soroban_sdk::vec![&env]);
        extend_persistent_ttl(&env, &DataKey::PayrollBatch(id));
        extend_persistent_ttl(&env, &DataKey::Recipients(id));

        env.storage()
            .instance()
            .set(&DataKey::NextBatchId, &next_id);
        extend_instance_ttl(&env);

        BatchCreated {
            batch_id: id,
            creator,
            asset,
        }
        .publish(&env);

        id
    }

    /// Add a `recipient` with `amount` to `batch_id`.
    /// Only the batch creator may call this.
    pub fn add_recipient(
        env: Env,
        caller: Address,
        batch_id: u64,
        recipient: Address,
        amount: i128,
    ) -> Result<(), Error> {
        let mut batch = read_batch(&env, batch_id).ok_or(Error::BatchNotFound)?;
        if caller != batch.creator {
            return Err(Error::Unauthorized);
        }
        if batch.funded || batch.distributed {
            return Err(Error::BatchAlreadyFunded);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        caller.require_auth();

        batch.total_amount = batch
            .total_amount
            .checked_add(amount)
            .ok_or(Error::Overflow)?;

        let mut recipients = read_recipients(&env, batch_id);
        recipients.push_back(Recipient {
            address: recipient.clone(),
            amount,
        });

        put_batch(&env, &batch);
        put_recipients(&env, batch_id, &recipients);
        extend_persistent_ttl(&env, &DataKey::PayrollBatch(batch_id));
        extend_persistent_ttl(&env, &DataKey::Recipients(batch_id));
        extend_instance_ttl(&env);

        RecipientAdded {
            batch_id,
            recipient,
            amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Fund `batch_id` by transferring `total_amount` of `asset` from `funder`
    /// into the contract.
    pub fn fund_batch(env: Env, batch_id: u64, funder: Address) -> Result<(), Error> {
        let mut batch = read_batch(&env, batch_id).ok_or(Error::BatchNotFound)?;
        if batch.funded || batch.distributed {
            return Err(Error::BatchAlreadyFunded);
        }
        if batch.total_amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        funder.require_auth();

        TokenClient::new(&env, &batch.asset).transfer(
            &funder,
            MuxedAddress::from(env.current_contract_address()),
            &batch.total_amount,
        );

        batch.funded = true;
        put_batch(&env, &batch);
        extend_persistent_ttl(&env, &DataKey::PayrollBatch(batch_id));
        extend_instance_ttl(&env);

        BatchFunded {
            batch_id,
            funder,
            total_amount: batch.total_amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Distribute all payments for `batch_id` to its recipients.
    pub fn distribute(env: Env, batch_id: u64) -> Result<(), Error> {
        let mut batch = read_batch(&env, batch_id).ok_or(Error::BatchNotFound)?;
        if batch.distributed {
            return Err(Error::AlreadyDistributed);
        }
        if !batch.funded {
            return Err(Error::BatchNotFunded);
        }

        let token = TokenClient::new(&env, &batch.asset);
        let recipients = read_recipients(&env, batch_id);

        for recipient in recipients.iter() {
            token.transfer(
                &env.current_contract_address(),
                MuxedAddress::from(recipient.address),
                &recipient.amount,
            );
        }

        batch.distributed = true;
        put_batch(&env, &batch);
        extend_persistent_ttl(&env, &DataKey::PayrollBatch(batch_id));
        extend_instance_ttl(&env);

        DistributionCompleted {
            batch_id,
            total_amount: batch.total_amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Cancel `batch_id`. Only the batch creator may call this, and only
    /// before funding.
    pub fn cancel_batch(env: Env, caller: Address, batch_id: u64) -> Result<(), Error> {
        let mut batch = read_batch(&env, batch_id).ok_or(Error::BatchNotFound)?;
        if caller != batch.creator {
            return Err(Error::Unauthorized);
        }
        if batch.funded || batch.distributed {
            return Err(Error::BatchAlreadyFunded);
        }

        caller.require_auth();

        batch.distributed = true;
        put_batch(&env, &batch);
        extend_persistent_ttl(&env, &DataKey::PayrollBatch(batch_id));
        extend_instance_ttl(&env);

        BatchCancelled {
            batch_id,
            creator: batch.creator,
        }
        .publish(&env);

        Ok(())
    }

    /// Read the full `PayrollBatch` for `batch_id`.
    pub fn get_batch(env: Env, batch_id: u64) -> Result<PayrollBatch, Error> {
        read_batch(&env, batch_id).ok_or(Error::BatchNotFound)
    }
}
