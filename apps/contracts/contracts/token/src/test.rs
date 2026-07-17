use crate::{Error, TokenContract, TokenContractClient};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    Address, Env, String,
};

fn assert_one_event(env: &Env, contract: &Address) {
    let filtered = env.events().all().filter_by_contract(contract);
    assert_eq!(filtered.events().len(), 1);
}

fn setup() -> (Env, TokenContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TokenContract, ());
    let client = TokenContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    client.initialize(
        &issuer,
        &String::from_str(&env, "AfriDollar"),
        &String::from_str(&env, "AFD"),
        &18u32,
        &1_000_000i128,
    );
    (env, client, issuer)
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

#[test]
fn initialize_sets_metadata_and_mints_to_issuer() {
    let (env, client, issuer) = setup();

    let meta = client.get_metadata();
    assert_eq!(meta.name, String::from_str(&env, "AfriDollar"));
    assert_eq!(meta.symbol, String::from_str(&env, "AFD"));
    assert_eq!(meta.decimals, 18);
    assert_eq!(meta.issuer, issuer);
    assert_eq!(client.balance(&issuer), 1_000_000);
}

#[test]
fn initialize_is_one_time_only() {
    let (_env, client, issuer) = setup();
    let result = client.try_initialize(
        &issuer,
        &String::from_str(&_env, "Again"),
        &String::from_str(&_env, "AGN"),
        &18u32,
        &0i128,
    );
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn initialize_rejects_negative_total_supply() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TokenContract, ());
    let client = TokenContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    let result = client.try_initialize(
        &issuer,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, "TST"),
        &18u32,
        &-100i128,
    );
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn initialize_emits_transfer_event() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TokenContract, ());
    let client = TokenContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);

    client.initialize(
        &issuer,
        &String::from_str(&env, "AfriDollar"),
        &String::from_str(&env, "AFD"),
        &18u32,
        &5000i128,
    );

    assert_one_event(&env, &contract_id);
}

#[test]
fn initialize_zero_supply_works() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TokenContract, ());
    let client = TokenContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);

    client.initialize(
        &issuer,
        &String::from_str(&env, "Zero"),
        &String::from_str(&env, "ZRO"),
        &6u32,
        &0i128,
    );

    assert_eq!(client.balance(&issuer), 0);
    let meta = client.get_metadata();
    assert_eq!(meta.decimals, 6);
}

#[test]
fn initialize_requires_issuer_auth() {
    let env = Env::default();
    let contract_id = env.register(TokenContract, ());
    let client = TokenContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);

    let result = client.try_initialize(
        &issuer,
        &String::from_str(&env, "T"),
        &String::from_str(&env, "T"),
        &0u32,
        &0i128,
    );
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// mint
// ---------------------------------------------------------------------------

#[test]
fn mint_increases_balance_and_supply() {
    let (env, client, issuer) = setup();
    let recipient = Address::generate(&env);

    client.mint(&recipient, &500i128);

    assert_eq!(client.balance(&recipient), 500);
    assert_eq!(client.balance(&issuer), 1_000_000);
}

#[test]
fn mint_fails_for_non_issuer() {
    let (_env, client, _issuer) = setup();
    let recipient = Address::generate(&_env);

    _env.set_auths(&[]);
    let result = client.try_mint(&recipient, &100i128);
    assert!(result.is_err());
}

#[test]
fn mint_rejects_zero_or_negative() {
    let (_env, client, _issuer) = setup();
    let recipient = Address::generate(&_env);

    let result = client.try_mint(&recipient, &0i128);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));

    let result = client.try_mint(&recipient, &-1i128);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn mint_emits_transfer_event() {
    let (env, client, _issuer) = setup();
    let contract_addr = client.address.clone();
    let recipient = Address::generate(&env);

    client.mint(&recipient, &300i128);

    assert_one_event(&env, &contract_addr);
}

#[test]
fn mint_without_initialize_errors() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TokenContract, ());
    let client = TokenContractClient::new(&env, &contract_id);
    let to = Address::generate(&env);

    let result = client.try_mint(&to, &100i128);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

// ---------------------------------------------------------------------------
// burn
// ---------------------------------------------------------------------------

#[test]
fn burn_reduces_balance_and_supply() {
    let (_env, client, issuer) = setup();

    client.burn(&issuer, &200_000i128);

    assert_eq!(client.balance(&issuer), 800_000);
}

#[test]
fn burn_rejects_insufficient_balance() {
    let (env, _client, _issuer) = setup();
    let user = Address::generate(&env);

    let result = _client.try_burn(&user, &10i128);
    assert_eq!(result, Err(Ok(Error::InsufficientBalance)));
}

#[test]
fn burn_rejects_zero_or_negative() {
    let (_env, client, issuer) = setup();

    let result = client.try_burn(&issuer, &0i128);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));

    let result = client.try_burn(&issuer, &-5i128);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn burn_requires_holder_auth() {
    let (env, client, _issuer) = setup();
    let holder = Address::generate(&env);
    client.mint(&holder, &500i128);

    env.set_auths(&[]);
    let result = client.try_burn(&holder, &100i128);
    assert!(result.is_err());
}

#[test]
fn burn_emits_transfer_event() {
    let (env, client, issuer) = setup();
    let contract_addr = client.address.clone();

    client.burn(&issuer, &500i128);

    assert_one_event(&env, &contract_addr);
}

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

#[test]
fn transfer_moves_tokens() {
    let (env, client, issuer) = setup();
    let recipient = Address::generate(&env);

    client.transfer(&issuer, &recipient, &300_000i128);

    assert_eq!(client.balance(&issuer), 700_000);
    assert_eq!(client.balance(&recipient), 300_000);
}

#[test]
fn transfer_rejects_insufficient_balance() {
    let (env, _client, _issuer) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let result = _client.try_transfer(&sender, &recipient, &10i128);
    assert_eq!(result, Err(Ok(Error::InsufficientBalance)));
}

#[test]
fn transfer_rejects_zero_amount() {
    let (_env, client, issuer) = setup();
    let recipient = Address::generate(&_env);

    let result = client.try_transfer(&issuer, &recipient, &0i128);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn transfer_requires_sender_auth() {
    let (env, client, issuer) = setup();
    let recipient = Address::generate(&env);

    env.set_auths(&[]);
    let result = client.try_transfer(&issuer, &recipient, &100i128);
    assert!(result.is_err());
}

#[test]
fn transfer_emits_event() {
    let (env, client, issuer) = setup();
    let recipient = Address::generate(&env);

    client.transfer(&issuer, &recipient, &100i128);

    assert_one_event(&env, &client.address);
}

#[test]
fn transfer_allows_self_transfer() {
    let (_env, client, issuer) = setup();

    client.transfer(&issuer, &issuer, &100_000i128);

    assert_eq!(client.balance(&issuer), 1_000_000);
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

#[test]
fn approve_sets_allowance() {
    let (_env, client, issuer) = setup();
    let spender = Address::generate(&_env);

    client.approve(&issuer, &spender, &500i128, &0u64);

    assert_eq!(client.allowance(&issuer, &spender), 500);
}

#[test]
fn approve_with_expiry() {
    let (env, client, issuer) = setup();
    let spender = Address::generate(&env);
    let future = env.ledger().timestamp() + 100;

    client.approve(&issuer, &spender, &500i128, &future);

    assert_eq!(client.allowance(&issuer, &spender), 500);

    // Advance past expiry.
    env.ledger().with_mut(|li| li.timestamp += 101);
    assert_eq!(client.allowance(&issuer, &spender), 0);
}

#[test]
fn approve_zero_removes_allowance() {
    let (_env, client, issuer) = setup();
    let spender = Address::generate(&_env);

    client.approve(&issuer, &spender, &500i128, &0u64);
    assert_eq!(client.allowance(&issuer, &spender), 500);

    client.approve(&issuer, &spender, &0i128, &0u64);
    assert_eq!(client.allowance(&issuer, &spender), 0);
}

#[test]
fn approve_rejects_negative_amount() {
    let (_env, client, issuer) = setup();
    let spender = Address::generate(&_env);

    let result = client.try_approve(&issuer, &spender, &-1i128, &0u64);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn approve_requires_owner_auth() {
    let (env, client, issuer) = setup();
    let spender = Address::generate(&env);

    env.set_auths(&[]);
    let result = client.try_approve(&issuer, &spender, &100i128, &0u64);
    assert!(result.is_err());
}

#[test]
fn approve_emits_event() {
    let (env, client, issuer) = setup();
    let spender = Address::generate(&env);

    client.approve(&issuer, &spender, &1000i128, &0u64);

    assert_one_event(&env, &client.address);
}

// ---------------------------------------------------------------------------
// transfer_from
// ---------------------------------------------------------------------------

#[test]
fn transfer_from_uses_allowance() {
    let (env, client, issuer) = setup();
    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.approve(&issuer, &spender, &500i128, &0u64);
    client.transfer_from(&spender, &issuer, &recipient, &300i128);

    assert_eq!(client.balance(&issuer), 999_700);
    assert_eq!(client.balance(&recipient), 300);
    assert_eq!(client.allowance(&issuer, &spender), 200);
}

#[test]
fn transfer_from_exact_allowance_removes_entry() {
    let (env, client, issuer) = setup();
    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.approve(&issuer, &spender, &300i128, &0u64);
    client.transfer_from(&spender, &issuer, &recipient, &300i128);

    assert_eq!(client.allowance(&issuer, &spender), 0);
}

#[test]
fn transfer_from_rejects_insufficient_allowance() {
    let (env, client, issuer) = setup();
    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.approve(&issuer, &spender, &100i128, &0u64);
    let result = client.try_transfer_from(&spender, &issuer, &recipient, &200i128);
    assert_eq!(result, Err(Ok(Error::InsufficientAllowance)));
}

#[test]
fn transfer_from_rejects_expired_allowance() {
    let (env, client, issuer) = setup();
    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let now = env.ledger().timestamp();

    client.approve(&issuer, &spender, &500i128, &(now + 50));

    env.ledger().with_mut(|li| li.timestamp += 51);
    let result = client.try_transfer_from(&spender, &issuer, &recipient, &100i128);
    assert_eq!(result, Err(Ok(Error::AllowanceExpired)));
}

#[test]
fn transfer_from_rejects_no_allowance() {
    let (env, _client, _issuer) = setup();
    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let other = Address::generate(&env);

    let result = _client.try_transfer_from(&spender, &other, &recipient, &100i128);
    assert_eq!(result, Err(Ok(Error::InsufficientAllowance)));
}

#[test]
fn transfer_from_requires_spender_auth() {
    let (env, client, issuer) = setup();
    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.approve(&issuer, &spender, &500i128, &0u64);

    env.set_auths(&[]);
    let result = client.try_transfer_from(&spender, &issuer, &recipient, &100i128);
    assert!(result.is_err());
}

#[test]
fn transfer_from_emits_transfer_event() {
    let (env, client, issuer) = setup();
    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.approve(&issuer, &spender, &500i128, &0u64);

    client.transfer_from(&spender, &issuer, &recipient, &200i128);

    assert_one_event(&env, &client.address);
}

#[test]
fn transfer_from_rejects_zero_amount() {
    let (env, client, issuer) = setup();
    let spender = Address::generate(&env);

    client.approve(&issuer, &spender, &100i128, &0u64);
    let result = client.try_transfer_from(&spender, &issuer, &spender, &0i128);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

// ---------------------------------------------------------------------------
// balance / allowance / get_metadata (view functions)
// ---------------------------------------------------------------------------

#[test]
fn balance_returns_zero_for_unknown() {
    let (_env, client, _issuer) = setup();
    let unknown = Address::generate(&_env);
    assert_eq!(client.balance(&unknown), 0);
}

#[test]
fn allowance_returns_zero_for_unknown() {
    let (_env, client, _issuer) = setup();
    let owner = Address::generate(&_env);
    let spender = Address::generate(&_env);
    assert_eq!(client.allowance(&owner, &spender), 0);
}

#[test]
fn allowance_returns_zero_after_expiry() {
    let (env, client, issuer) = setup();
    let spender = Address::generate(&env);
    let future = env.ledger().timestamp() + 100;

    client.approve(&issuer, &spender, &500i128, &future);

    env.ledger().with_mut(|li| li.timestamp += 101);
    assert_eq!(client.allowance(&issuer, &spender), 0);
}

#[test]
fn get_metadata_returns_stored_values() {
    let (env, client, issuer) = setup();
    let meta = client.get_metadata();
    assert_eq!(meta.name, String::from_str(&env, "AfriDollar"));
    assert_eq!(meta.symbol, String::from_str(&env, "AFD"));
    assert_eq!(meta.decimals, 18);
    assert_eq!(meta.issuer, issuer);
}

#[test]
#[should_panic(expected = "contract not initialized")]
fn get_metadata_panics_if_not_initialized() {
    let env = Env::default();
    let contract_id = env.register(TokenContract, ());
    let client = TokenContractClient::new(&env, &contract_id);
    client.get_metadata();
}

// ---------------------------------------------------------------------------
// end-to-end scenarios
// ---------------------------------------------------------------------------

#[test]
fn full_token_lifecycle() {
    let (env, client, issuer) = setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    // Mint to Alice.
    client.mint(&alice, &10_000i128);
    assert_eq!(client.balance(&alice), 10_000);

    // Alice transfers to Bob.
    client.transfer(&alice, &bob, &3_000i128);
    assert_eq!(client.balance(&alice), 7_000);
    assert_eq!(client.balance(&bob), 3_000);

    // Bob approves Charlie (Charlie not yet created; use Alice as spender).
    let charlie = Address::generate(&env);
    client.approve(&bob, &charlie, &1_000i128, &0u64);
    assert_eq!(client.allowance(&bob, &charlie), 1_000);

    // Charlie transfers from Bob to Alice.
    client.transfer_from(&charlie, &bob, &alice, &500i128);
    assert_eq!(client.balance(&alice), 7_500);
    assert_eq!(client.balance(&bob), 2_500);
    assert_eq!(client.allowance(&bob, &charlie), 500);

    // Bob burns some tokens.
    client.burn(&bob, &500i128);
    assert_eq!(client.balance(&bob), 2_000);

    // Issuer mints more.
    client.mint(&issuer, &50_000i128);
    assert_eq!(client.balance(&issuer), 1_050_000);
}
