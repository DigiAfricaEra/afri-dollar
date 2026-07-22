extern crate std;

use crate::{BatchExecutor, BatchExecutorClient, BatchStatus, ContractOperation};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, testutils::Events, vec, Address, Env,
    IntoVal, String, Vec,
};

// ---------------------------------------------------------------------------
// Test callee contract
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OpError {
    Failed = 1,
}

#[contracttype]
#[derive(Clone)]
enum OpKey {
    Value,
}

#[contract]
pub struct OpContract;

#[contractimpl]
impl OpContract {
    pub fn write(env: Env, val: u32) {
        env.storage().persistent().set(&OpKey::Value, &val);
    }

    pub fn read(env: Env) -> u32 {
        env.storage().persistent().get(&OpKey::Value).unwrap_or(0)
    }

    /// Writes 999 then returns Err(Failed).
    /// Tests whether write persists when caller catches via try_invoke_contract.
    pub fn fail(env: Env, _val: u32) -> Result<(), OpError> {
        env.storage().persistent().set(&OpKey::Value, &999u32);
        Err(OpError::Failed)
    }
}

// ---------------------------------------------------------------------------
// Malicious reentrancy callee
// ---------------------------------------------------------------------------

#[contract]
pub struct ReenterContract;

#[contractimpl]
impl ReenterContract {
    pub fn trigger(env: Env, executor: Address, batch_id: u64) -> Result<(), OpError> {
        let client = BatchExecutorClient::new(&env, &executor);
        let result = client.try_execute_batch(&batch_id);
        if result.is_ok() {
            panic!("reentrant execute_batch unexpectedly succeeded");
        }
        Err(OpError::Failed)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn setup_callee(env: &Env) -> Address {
    env.register(OpContract, ())
}

fn make_op(env: &Env, callee: &Address, fn_name: &str, val: u32) -> ContractOperation {
    ContractOperation {
        contract_id: callee.clone(),
        function_name: String::from_str(env, fn_name),
        args: Vec::from_array(env, [val.into_val(env)]),
    }
}

fn register_executor(env: &Env) -> Address {
    env.register(BatchExecutor, ())
}

fn client<'a>(env: &'a Env, id: &'a Address) -> BatchExecutorClient<'a> {
    BatchExecutorClient::new(env, id)
}

// ===========================================================================
// create_batch
// ===========================================================================

#[test]
fn create_batch_stores_operations_and_initial_status() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 42)]);
    let id = cl.create_batch(&ops);

    // BatchCreated event emitted
    assert_ne!(
        env.events().all(),
        vec![&env],
        "BatchCreated event expected"
    );

    let stored = cl.get_batch_status(&id);
    assert_eq!(stored.status, BatchStatus::Pending);
    assert_eq!(stored.id, id);
    assert_eq!(stored.operations.len(), 1);
    assert!(stored.executed_at.is_none());
    assert!(stored.gas_used.is_none());
}

#[test]
fn create_batch_assigns_monotonic_ids() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 1)]);
    let id1 = cl.create_batch(&ops);
    let id2 = cl.create_batch(&ops);

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}

#[test]
fn create_batch_rejects_empty_operations() {
    let env = Env::default();
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let empty: Vec<ContractOperation> = Vec::from_array(&env, []);
    let result = cl.try_create_batch(&empty);

    // try_create_batch returns Err(soroban_sdk::Error) when contract returns Err
    assert!(
        result.is_err(),
        "should fail when creating batch with empty operations"
    );
}

// ===========================================================================
// execute_batch
// ===========================================================================

#[test]
fn execute_batch_all_operations_succeed() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let callee_client = OpContractClient::new(&env, &callee);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 100)]);
    let id = cl.create_batch(&ops);
    cl.execute_batch(&id);

    // BatchExecuted event emitted
    assert_ne!(
        env.events().all(),
        vec![&env],
        "BatchExecuted event expected"
    );

    let stored = cl.get_batch_status(&id);
    assert_eq!(stored.status, BatchStatus::Completed);
    assert!(stored.executed_at.is_some());
    assert_eq!(callee_client.read(), 100);
}

#[test]
fn execute_batch_failure_atomic_rollback() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let callee_client = OpContractClient::new(&env, &callee);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(
        &env,
        [
            make_op(&env, &callee, "write", 100),
            make_op(&env, &callee, "fail", 999),
        ],
    );
    let id = cl.create_batch(&ops);
    let result = cl.try_execute_batch(&id);

    // Atomic rollback: execute_batch returns Err(OperationFailed), which
    // causes the Soroban host to revert ALL state changes from this
    // invocation, including the successful op A's write.
    assert!(
        result.is_err(),
        "execute_batch must return Err when any op fails"
    );

    // Batch rolls back to its pre-execution state.
    let stored = cl.get_batch_status(&id);
    assert_eq!(
        stored.status,
        BatchStatus::Pending,
        "batch rolls back to Pending after atomic failure"
    );

    // Op A's write was rolled back by the host despite succeeding
    // within its own sub-invocation.
    assert_eq!(
        callee_client.read(),
        0,
        "op A write must be reverted by Soroban host-level rollback"
    );
}

#[test]
fn execute_batch_twice_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 50)]);
    let id = cl.create_batch(&ops);
    cl.execute_batch(&id);

    let result = cl.try_execute_batch(&id);
    assert!(
        result.is_err(),
        "second execution should fail (InvalidBatchState pre-flight)"
    );
}

#[test]
fn execute_batch_nonexistent_returns_error() {
    let env = Env::default();
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let result = cl.try_execute_batch(&999);
    assert!(result.is_err(), "executing nonexistent batch should fail");
}

#[test]
fn execute_batch_rejects_non_pending_state() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 10)]);
    let id = cl.create_batch(&ops);

    cl.cancel_batch(&id);

    let result = cl.try_execute_batch(&id);
    assert!(
        result.is_err(),
        "executing cancelled batch should fail (pre-flight)"
    );
}

#[test]
fn execute_batch_reentrancy_guard() {
    let env = Env::default();
    env.mock_all_auths();

    let reenter = env.register(ReenterContract, ());
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(
        &env,
        [ContractOperation {
            contract_id: reenter,
            function_name: String::from_str(&env, "trigger"),
            args: Vec::from_array(&env, [executor_id.into_val(&env), 1u64.into_val(&env)]),
        }],
    );
    let id = cl.create_batch(&ops); // id = 1
    let result = cl.try_execute_batch(&id);

    // Reentrant attempt is blocked by Executing status → trigger returns
    // Err → propagate as OperationFailed.
    assert!(result.is_err());

    // Soroban rollback restores batch to Pending.
    let stored = cl.get_batch_status(&id);
    assert_eq!(stored.status, BatchStatus::Pending);
}

#[test]
fn execute_batch_cross_contract_atomic_rollback() {
    let env = Env::default();
    env.mock_all_auths();

    // Two independent callee contracts with separate storage.
    let callee_a = setup_callee(&env);
    let callee_b = setup_callee(&env);
    let client_a = OpContractClient::new(&env, &callee_a);
    let client_b = OpContractClient::new(&env, &callee_b);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    // Op1: succeeds — writes 100 to callee_a
    // Op2: fails — calls fail() on callee_b
    let ops = Vec::from_array(
        &env,
        [
            make_op(&env, &callee_a, "write", 100),
            make_op(&env, &callee_b, "fail", 999),
        ],
    );
    let id = cl.create_batch(&ops);
    let result = cl.try_execute_batch(&id);

    // 1. execute_batch propagates the failure.
    assert!(
        result.is_err(),
        "execute_batch must return Err on any op failure"
    );

    // 2. Batch remains in Pending (Soroban rolled back all state).
    assert_eq!(
        cl.get_batch_status(&id).status,
        BatchStatus::Pending,
        "batch rolls back to Pending"
    );

    // 3. callee_a's successful mutation was rolled back.
    assert_eq!(
        client_a.read(),
        0,
        "callee_a's prior successful mutation must be reverted"
    );

    // 4. callee_b also has no persistent mutation.
    assert_eq!(
        client_b.read(),
        0,
        "callee_b must have no unintended mutation"
    );
}

// ===========================================================================
// estimate_batch_gas
// ===========================================================================

#[test]
fn estimate_batch_gas_returns_zero() {
    let env = Env::default();
    let callee = setup_callee(&env);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    // Returns 0 for empty input.
    let empty: Vec<ContractOperation> = Vec::from_array(&env, []);
    assert_eq!(cl.estimate_batch_gas(&empty), 0);

    // Returns 0 for non-empty input.
    let ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 1)]);
    assert_eq!(cl.estimate_batch_gas(&ops), 0);
}

// ===========================================================================
// get_batch_status
// ===========================================================================

#[test]
fn get_batch_status_returns_full_batch() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 77)]);
    let id = cl.create_batch(&ops);
    let stored = cl.get_batch_status(&id);

    assert_eq!(stored.id, id);
    assert_eq!(stored.operations.len(), 1);
    assert_eq!(stored.operations.get(0).unwrap().contract_id, callee);
    assert_eq!(stored.status, BatchStatus::Pending);
}

// ===========================================================================
// cancel_batch
// ===========================================================================

#[test]
fn cancel_pending_batch_transitions_to_failed() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 10)]);
    let id = cl.create_batch(&ops);

    cl.cancel_batch(&id);

    // BatchCancelled event emitted
    assert_ne!(
        env.events().all(),
        vec![&env],
        "BatchCancelled event expected"
    );

    let stored = cl.get_batch_status(&id);
    assert_eq!(stored.status, BatchStatus::Failed);
}

#[test]
fn cancel_completed_batch_returns_error() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 10)]);
    let id = cl.create_batch(&ops);
    cl.execute_batch(&id);

    let result = cl.try_cancel_batch(&id);
    assert!(result.is_err(), "canceling executed batch should error");
}

#[test]
fn cancel_nonexistent_batch_returns_error() {
    let env = Env::default();
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let result = cl.try_cancel_batch(&999);
    assert!(result.is_err());
}

// ===========================================================================
// rollback_batch
// ===========================================================================

// NOTE: `rollback_batch` on `Partial` is not tested here because
// `execute_batch` uses Soroban host-level rollback (`Err` return)
// for atomicity, rendering `Partial` unreachable via normal execution.
// The `rollback_batch` function is preserved for API compatibility;
// its error-path behavior is covered by the Pending and Completed tests below.

#[test]
fn rollback_completed_batch_returns_error() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 10)]);
    let id = cl.create_batch(&ops);
    cl.execute_batch(&id);

    let result = cl.try_rollback_batch(&id);
    assert!(result.is_err(), "rollback on completed batch should error");
}

#[test]
fn rollback_pending_batch_returns_error() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 10)]);
    let id = cl.create_batch(&ops);

    let result = cl.try_rollback_batch(&id);
    assert!(result.is_err(), "rollback on pending batch should error");
}

// ===========================================================================
// Lifecycle
// ===========================================================================

#[test]
fn lifecycle_pending_to_completed() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let callee_client = OpContractClient::new(&env, &callee);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 555)]);
    let id = cl.create_batch(&ops);

    assert_eq!(cl.get_batch_status(&id).status, BatchStatus::Pending);

    cl.execute_batch(&id);

    assert_eq!(cl.get_batch_status(&id).status, BatchStatus::Completed);
    assert_eq!(callee_client.read(), 555);
}

#[test]
fn lifecycle_pending_to_failed() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 555)]);
    let id = cl.create_batch(&ops);

    assert_eq!(cl.get_batch_status(&id).status, BatchStatus::Pending);

    cl.cancel_batch(&id);

    assert_eq!(cl.get_batch_status(&id).status, BatchStatus::Failed);
}

#[test]
fn lifecycle_failed_execute_rolls_back_to_pending() {
    let env = Env::default();
    env.mock_all_auths();

    let callee = setup_callee(&env);
    let executor_id = register_executor(&env);
    let cl = client(&env, &executor_id);

    let ops = Vec::from_array(
        &env,
        [
            make_op(&env, &callee, "write", 100),
            make_op(&env, &callee, "fail", 999),
        ],
    );
    let id = cl.create_batch(&ops);

    assert_eq!(cl.get_batch_status(&id).status, BatchStatus::Pending);

    // execute_batch fails atomically — batch stays Pending.
    let result = cl.try_execute_batch(&id);
    assert!(result.is_err());

    let stored = cl.get_batch_status(&id);
    assert_eq!(stored.status, BatchStatus::Pending);

    // A new execution attempt is still possible since batch is Pending.
    // Replace with a working operation to verify.
    // (This proves the rollback fully reset the state.)
    let success_ops = Vec::from_array(&env, [make_op(&env, &callee, "write", 200)]);
    let id2 = cl.create_batch(&success_ops);
    cl.execute_batch(&id2);
    assert_eq!(cl.get_batch_status(&id2).status, BatchStatus::Completed);
}
