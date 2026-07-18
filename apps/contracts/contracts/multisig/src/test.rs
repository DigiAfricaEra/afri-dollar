use crate::{Error, MultisigContract, MultisigContractClient};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    vec, Address, Bytes, Env,
};

fn create_token<'a>(
    env: &Env,
    admin: &Address,
) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let address = sac.address();
    (
        address.clone(),
        TokenClient::new(env, &address),
        StellarAssetClient::new(env, &address),
    )
}

fn setup_with_signers(
    n: u32,
    threshold: u32,
) -> (
    Env,
    MultisigContractClient<'static>,
    soroban_sdk::Vec<Address>,
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigContract, ());
    let client = MultisigContractClient::new(&env, &contract_id);
    let mut signers = soroban_sdk::Vec::new(&env);
    for _ in 0..n {
        signers.push_back(Address::generate(&env));
    }
    client.initialize(&signers, &threshold);
    (env, client, signers)
}

fn empty_data(env: &Env) -> Bytes {
    Bytes::new(env)
}

#[test]
fn initialize_stores_signers_and_threshold() {
    let (_env, client, signers) = setup_with_signers(3, 2);
    assert_eq!(client.get_signers(), signers);
    assert_eq!(client.get_threshold(), 2);
}

#[test]
fn initialize_is_one_time_only() {
    let (_env, client, signers) = setup_with_signers(2, 1);
    let result = client.try_initialize(&signers, &1u32);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn initialize_rejects_zero_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigContract, ());
    let client = MultisigContractClient::new(&env, &contract_id);
    let signers = vec![&env, Address::generate(&env)];
    let result = client.try_initialize(&signers, &0u32);
    assert_eq!(result, Err(Ok(Error::InvalidThreshold)));
}

#[test]
fn initialize_rejects_threshold_above_signer_count() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigContract, ());
    let client = MultisigContractClient::new(&env, &contract_id);
    let signers = vec![&env, Address::generate(&env)];
    let result = client.try_initialize(&signers, &2u32);
    assert_eq!(result, Err(Ok(Error::InvalidThreshold)));
}

#[test]
fn initialize_rejects_duplicate_signer() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigContract, ());
    let client = MultisigContractClient::new(&env, &contract_id);
    let a = Address::generate(&env);
    let signers = vec![&env, a.clone(), a];
    let result = client.try_initialize(&signers, &1u32);
    assert_eq!(result, Err(Ok(Error::DuplicateSigner)));
}

#[test]
fn initialize_requires_every_signer_auth() {
    let env = Env::default();
    let contract_id = env.register(MultisigContract, ());
    let client = MultisigContractClient::new(&env, &contract_id);
    let signers = vec![&env, Address::generate(&env), Address::generate(&env)];
    // No mock_all_auths(): each signer's own authorization must be enforced.
    let result = client.try_initialize(&signers, &2u32);
    assert!(result.is_err());
}

#[test]
fn create_transaction_requires_signer() {
    let (env, client, _signers) = setup_with_signers(2, 1);
    let intruder = Address::generate(&env);
    let dest = Address::generate(&env);
    let asset = Address::generate(&env);
    let result =
        client.try_create_transaction(&intruder, &dest, &asset, &100i128, &empty_data(&env));
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn create_transaction_rejects_non_positive_amount() {
    let (env, client, signers) = setup_with_signers(2, 1);
    let creator = signers.get(0).unwrap();
    let dest = Address::generate(&env);
    let asset = Address::generate(&env);
    let result = client.try_create_transaction(&creator, &dest, &asset, &0i128, &empty_data(&env));
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn create_transaction_does_not_auto_approve() {
    let (env, client, signers) = setup_with_signers(2, 1);
    let creator = signers.get(0).unwrap();
    let dest = Address::generate(&env);
    let asset = Address::generate(&env);
    let tx_id = client.create_transaction(&creator, &dest, &asset, &100i128, &empty_data(&env));
    let tx = client.get_transaction(&tx_id);
    assert_eq!(tx.approvals.len(), 0);
    assert!(!tx.executed);
}

#[test]
fn approve_requires_signer() {
    let (env, client, signers) = setup_with_signers(2, 2);
    let creator = signers.get(0).unwrap();
    let dest = Address::generate(&env);
    let asset = Address::generate(&env);
    let tx_id = client.create_transaction(&creator, &dest, &asset, &100i128, &empty_data(&env));

    let intruder = Address::generate(&env);
    let result = client.try_approve(&intruder, &tx_id);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn approve_rejects_double_approval() {
    let (env, client, signers) = setup_with_signers(2, 2);
    let creator = signers.get(0).unwrap();
    let dest = Address::generate(&env);
    let asset = Address::generate(&env);
    let tx_id = client.create_transaction(&creator, &dest, &asset, &100i128, &empty_data(&env));

    client.approve(&creator, &tx_id);
    let result = client.try_approve(&creator, &tx_id);
    assert_eq!(result, Err(Ok(Error::AlreadyApproved)));
}

#[test]
fn execute_fails_before_threshold_met() {
    let (env, client, signers) = setup_with_signers(3, 2);
    let creator = signers.get(0).unwrap();
    let dest = Address::generate(&env);
    let asset = Address::generate(&env);
    let tx_id = client.create_transaction(&creator, &dest, &asset, &100i128, &empty_data(&env));
    client.approve(&creator, &tx_id);

    let result = client.try_execute(&tx_id);
    assert_eq!(result, Err(Ok(Error::ThresholdNotMet)));
}

#[test]
fn execute_transfers_funds_once_threshold_met() {
    let (env, client, signers) = setup_with_signers(3, 2);
    let admin = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&client.address, &1_000i128);

    let creator = signers.get(0).unwrap();
    let second = signers.get(1).unwrap();
    let dest = Address::generate(&env);
    let tx_id = client.create_transaction(&creator, &dest, &asset, &400i128, &empty_data(&env));
    client.approve(&creator, &tx_id);
    client.approve(&second, &tx_id);

    client.execute(&tx_id);

    assert_eq!(token.balance(&dest), 400);
    assert_eq!(token.balance(&client.address), 600);
    let tx = client.get_transaction(&tx_id);
    assert!(tx.executed);
}

#[test]
fn execute_is_permissionless_once_threshold_met() {
    let (env, client, signers) = setup_with_signers(2, 2);
    let admin = Address::generate(&env);
    let (asset, token, mint) = create_token(&env, &admin);
    mint.mint(&client.address, &500i128);

    let a = signers.get(0).unwrap();
    let b = signers.get(1).unwrap();
    let dest = Address::generate(&env);
    let tx_id = client.create_transaction(&a, &dest, &asset, &200i128, &empty_data(&env));
    client.approve(&a, &tx_id);
    client.approve(&b, &tx_id);

    // A completely unrelated caller can execute — the approvals already
    // gate authorization; execute() itself takes no caller parameter.
    let stranger = Address::generate(&env);
    let _ = &stranger; // execute() has no caller param; this documents the intent
    client.execute(&tx_id);

    assert_eq!(token.balance(&dest), 200);
}

#[test]
fn execute_rejects_double_execution() {
    let (env, client, signers) = setup_with_signers(2, 2);
    let admin = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&client.address, &500i128);

    let a = signers.get(0).unwrap();
    let b = signers.get(1).unwrap();
    let dest = Address::generate(&env);
    let tx_id = client.create_transaction(&a, &dest, &asset, &200i128, &empty_data(&env));
    client.approve(&a, &tx_id);
    client.approve(&b, &tx_id);
    client.execute(&tx_id);

    let result = client.try_execute(&tx_id);
    assert_eq!(result, Err(Ok(Error::AlreadyExecuted)));
}

#[test]
fn approve_rejects_already_executed_transaction() {
    let (env, client, signers) = setup_with_signers(2, 2);
    let admin = Address::generate(&env);
    let (asset, _token, mint) = create_token(&env, &admin);
    mint.mint(&client.address, &500i128);

    let a = signers.get(0).unwrap();
    let b = signers.get(1).unwrap();
    let dest = Address::generate(&env);
    let tx_id = client.create_transaction(&a, &dest, &asset, &200i128, &empty_data(&env));
    client.approve(&a, &tx_id);
    client.approve(&b, &tx_id);
    client.execute(&tx_id);

    let c = Address::generate(&env);
    let _ = c;
    let result = client.try_approve(&a, &tx_id);
    assert_eq!(result, Err(Ok(Error::AlreadyExecuted)));
}

#[test]
fn add_signer_requires_threshold_cosigners() {
    let (env, client, signers) = setup_with_signers(3, 2);
    let new_signer = Address::generate(&env);

    let one_signer = vec![&env, signers.get(0).unwrap()];
    let result = client.try_add_signer(&one_signer, &new_signer);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));

    let two_signers = vec![&env, signers.get(0).unwrap(), signers.get(1).unwrap()];
    client.add_signer(&two_signers, &new_signer);
    assert!(client.is_signer(&new_signer));
}

#[test]
fn add_signer_rejects_duplicate() {
    let (env, client, signers) = setup_with_signers(3, 2);
    let existing = signers.get(0).unwrap();
    let cosigners = vec![&env, signers.get(0).unwrap(), signers.get(1).unwrap()];
    let result = client.try_add_signer(&cosigners, &existing);
    assert_eq!(result, Err(Ok(Error::DuplicateSigner)));
}

#[test]
fn remove_signer_requires_threshold_cosigners() {
    let (env, client, signers) = setup_with_signers(3, 2);
    let target = signers.get(2).unwrap();
    let cosigners = vec![&env, signers.get(0).unwrap(), signers.get(1).unwrap()];
    client.remove_signer(&cosigners, &target);
    assert!(!client.is_signer(&target));
}

#[test]
fn remove_signer_rejects_when_it_would_break_threshold() {
    let (env, client, signers) = setup_with_signers(2, 2);
    let target = signers.get(0).unwrap();
    let cosigners = vec![&env, signers.get(0).unwrap(), signers.get(1).unwrap()];
    let result = client.try_remove_signer(&cosigners, &target);
    assert_eq!(result, Err(Ok(Error::WouldBreakThreshold)));
}

#[test]
fn remove_signer_rejects_unknown_signer() {
    let (env, client, signers) = setup_with_signers(3, 2);
    let stranger = Address::generate(&env);
    let cosigners = vec![&env, signers.get(0).unwrap(), signers.get(1).unwrap()];
    let result = client.try_remove_signer(&cosigners, &stranger);
    assert_eq!(result, Err(Ok(Error::SignerNotFound)));
}

#[test]
fn change_threshold_requires_current_threshold_cosigners() {
    let (env, client, signers) = setup_with_signers(3, 2);
    let cosigners = vec![&env, signers.get(0).unwrap(), signers.get(1).unwrap()];
    client.change_threshold(&cosigners, &3u32);
    assert_eq!(client.get_threshold(), 3);
}

#[test]
fn change_threshold_rejects_invalid_values() {
    let (env, client, signers) = setup_with_signers(3, 2);
    let cosigners = vec![&env, signers.get(0).unwrap(), signers.get(1).unwrap()];
    let result = client.try_change_threshold(&cosigners, &0u32);
    assert_eq!(result, Err(Ok(Error::InvalidThreshold)));

    let result2 = client.try_change_threshold(&cosigners, &10u32);
    assert_eq!(result2, Err(Ok(Error::InvalidThreshold)));
}

#[test]
fn get_transaction_errors_when_not_found() {
    let (env, client, _signers) = setup_with_signers(2, 1);
    let _ = &env;
    let result = client.try_get_transaction(&999u64);
    assert_eq!(result, Err(Ok(Error::TransactionNotFound)));
}
