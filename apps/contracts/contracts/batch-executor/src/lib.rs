#![no_std]

use afri_contract_shared::{
    extend_instance_ttl, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, String,
    Symbol, Val, Vec,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    BatchNotFound = 1,
    InvalidBatchState = 2,
    OperationFailed = 3,
    EmptyBatch = 4,
    BatchAlreadyExecuted = 5,
    NotRolledBack = 6,
}

// ---------------------------------------------------------------------------
// Types — exact match with issue #145 spec
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractOperation {
    pub contract_id: Address,
    pub function_name: String,
    pub args: Vec<Val>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BatchStatus {
    Pending,
    Executing,
    Completed,
    Failed,
    Partial,
    RolledBack,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchOperation {
    pub id: u64,
    pub operations: Vec<ContractOperation>,
    pub status: BatchStatus,
    pub created_at: u64,
    pub executed_at: Option<u64>,
    pub gas_used: Option<u64>,
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum DataKey {
    NextBatchId,
    Batch(u64),
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent(topics = ["batch", "created"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchCreated {
    #[topic]
    pub batch_id: u64,
    pub operation_count: u32,
}

#[contractevent(topics = ["batch", "executed"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchExecuted {
    #[topic]
    pub batch_id: u64,
    pub status: BatchStatus,
}

#[contractevent(topics = ["batch", "cancelled"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchCancelled {
    #[topic]
    pub batch_id: u64,
}

#[contractevent(topics = ["batch", "rolled_back"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchRolledBack {
    #[topic]
    pub batch_id: u64,
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

fn read_batch(env: &Env, batch_id: u64) -> Option<BatchOperation> {
    env.storage().persistent().get(&DataKey::Batch(batch_id))
}

fn put_batch(env: &Env, batch: &BatchOperation) {
    env.storage()
        .persistent()
        .set(&DataKey::Batch(batch.id), batch);
}

fn string_to_symbol(env: &Env, s: &soroban_sdk::String) -> Symbol {
    let bytes = s.to_bytes();
    let len = bytes.len() as usize;
    let mut buf = [0u8; 32];
    for (i, b) in bytes.iter().enumerate() {
        if i < 32 {
            buf[i] = b;
        }
    }
    let s = core::str::from_utf8(&buf[..len.min(32)]).unwrap_or("");
    Symbol::new(env, s)
}

fn extend_batch_ttl(env: &Env, batch_id: u64) {
    env.storage().persistent().extend_ttl(
        &DataKey::Batch(batch_id),
        INSTANCE_LIFETIME_THRESHOLD,
        INSTANCE_BUMP_AMOUNT,
    );
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct BatchExecutor;

#[contractimpl]
impl BatchExecutor {
    /// Create a new batch with the given operations.
    /// Returns a unique batch ID.
    /// Fails with `Error::EmptyBatch` if operations is empty.
    pub fn create_batch(env: Env, operations: Vec<ContractOperation>) -> Result<u64, Error> {
        if operations.is_empty() {
            return Err(Error::EmptyBatch);
        }

        let next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextBatchId)
            .unwrap_or(1);

        let batch = BatchOperation {
            id: next_id,
            operations: operations.clone(),
            status: BatchStatus::Pending,
            created_at: env.ledger().timestamp(),
            executed_at: None,
            gas_used: None,
        };

        put_batch(&env, &batch);
        extend_batch_ttl(&env, next_id);
        env.storage()
            .instance()
            .set(&DataKey::NextBatchId, &(next_id + 1));
        extend_instance_ttl(&env);

        BatchCreated {
            batch_id: next_id,
            operation_count: operations.len(),
        }
        .publish(&env);

        Ok(next_id)
    }

    /// Execute all operations in a batch atomically.
    ///
    /// Uses Soroban's host-level rollback: if any nested operation fails, the
    /// entire invocation is aborted and ALL state changes (including mutations
    /// made by previously successful operations in this batch) are reverted.
    /// Only when every operation succeeds is `Completed` status written and
    /// the event published.
    ///
    /// Pre-flight validation (nonexistent batch, wrong state) returns `Err`
    /// without performing any work.
    pub fn execute_batch(env: Env, batch_id: u64) -> Result<(), Error> {
        let mut batch = read_batch(&env, batch_id).ok_or(Error::BatchNotFound)?;

        if batch.status != BatchStatus::Pending {
            return Err(Error::InvalidBatchState);
        }

        // Execute every operation. Do NOT write status before the loop:
        // if any operation fails, returning Err will roll back all writes
        // including both contract mutations and our own storage changes.
        for op in batch.operations.iter() {
            let fn_name = string_to_symbol(&env, &op.function_name);
            let result = env.try_invoke_contract::<Val, soroban_sdk::Error>(
                &op.contract_id,
                &fn_name,
                op.args.clone(),
            );

            match result {
                Ok(Ok(_)) => {}
                // Any failure — host-level or contract-level — triggers a
                // full rollback of the entire invocation.
                _ => return Err(Error::OperationFailed),
            }
        }

        // All operations succeeded — persist Completed state.
        let executed_at = env.ledger().timestamp();
        batch.executed_at = Some(executed_at);
        batch.status = BatchStatus::Completed;
        put_batch(&env, &batch);
        extend_batch_ttl(&env, batch_id);
        extend_instance_ttl(&env);

        BatchExecuted {
            batch_id,
            status: BatchStatus::Completed,
        }
        .publish(&env);

        Ok(())
    }

    /// Returns 0.
    ///
    /// This function exists for API compatibility with Issue #145. Accurate
    /// resource/fee estimation for batch operations is NOT possible from
    /// inside a Soroban contract because:
    ///
    /// - The SDK provides no on-chain fee estimation API (`cost_estimate()`
    ///   is testutils-only and retrospective, not predictive).
    /// - The execution cost of each `ContractOperation` depends on its target
    ///   contract's logic, storage access, events, and rent — all unknowable
    ///   without actually executing the operation.
    /// - RPC `simulateTransaction` is the canonical estimation mechanism and
    ///   is strictly off-chain (client/RPC layer, not available to deployed
    ///   WASM).
    ///
    /// Callers MUST use off-chain RPC `simulateTransaction` against the
    /// deployed target contracts with the current ledger state to obtain
    /// accurate resource fee estimates before submitting a transaction that
    /// calls `execute_batch`.
    pub fn estimate_batch_gas(_env: Env, _operations: Vec<ContractOperation>) -> u64 {
        0
    }

    /// Read the full `BatchOperation` for `batch_id`.
    /// Panics if the batch does not exist.
    pub fn get_batch_status(env: Env, batch_id: u64) -> BatchOperation {
        read_batch(&env, batch_id).expect("batch not found")
    }

    /// Cancel a pending batch.
    /// Transitions `Pending` → `Failed`.
    /// Does nothing if the batch is already in a terminal state.
    pub fn cancel_batch(env: Env, batch_id: u64) {
        let mut batch = read_batch(&env, batch_id).expect("batch not found");

        if batch.status != BatchStatus::Pending {
            panic!("batch not in pending state");
        }

        batch.status = BatchStatus::Failed;
        put_batch(&env, &batch);
        extend_batch_ttl(&env, batch_id);
        extend_instance_ttl(&env);

        BatchCancelled { batch_id }.publish(&env);
    }

    /// Roll back a partially-executed batch.
    ///
    /// Transitions `Partial` → `RolledBack` (status bookkeeping only).
    ///
    /// Real state compensation is not supported because `ContractOperation`
    /// carries no inverse-operation metadata. True compensating rollback
    /// would require each operation to specify its inverse, which the
    /// current data model does not provide.
    ///
    /// NOTE: Under the current implementation, `execute_batch` uses
    /// Soroban host-level rollback (`Err` return) to achieve atomicity,
    /// so `Partial` status is unreachable via normal execution. This
    /// function is preserved for API compatibility and future use where
    /// application-level partial states may be introduced.
    pub fn rollback_batch(env: Env, batch_id: u64) {
        let mut batch = read_batch(&env, batch_id).expect("batch not found");

        if batch.status != BatchStatus::Partial {
            panic!("batch not in partial state");
        }

        batch.status = BatchStatus::RolledBack;
        put_batch(&env, &batch);
        extend_batch_ttl(&env, batch_id);
        extend_instance_ttl(&env);

        BatchRolledBack { batch_id }.publish(&env);
    }
}

#[cfg(test)]
mod test;
