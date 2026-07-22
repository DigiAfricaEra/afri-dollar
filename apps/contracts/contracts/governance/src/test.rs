use crate::{Error, GovernanceContract, GovernanceContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env, String,
};

/// Deploy a Stellar Asset Contract to stand in for the governance token, and
/// return its address plus a minting client.
fn create_token<'a>(env: &Env, admin: &Address) -> (Address, StellarAssetClient<'a>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let address = sac.address();
    (address.clone(), StellarAssetClient::new(env, &address))
}

/// Register the governance contract wired to a freshly-minted token. Returns
/// the env, the client, the token admin, and the token mint client.
fn setup() -> (
    Env,
    GovernanceContractClient<'static>,
    Address,
    StellarAssetClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();
    let token_admin = Address::generate(&env);
    let (token, mint) = create_token(&env, &token_admin);

    let contract_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &contract_id);
    client.initialize(&token);
    (env, client, token_admin, mint)
}

fn set_time(env: &Env, t: u64) {
    env.ledger().set_timestamp(t);
}

fn text(env: &Env, s: &str) -> String {
    String::from_str(env, s)
}

/// Create a standard proposal open for voting in `[100, 1000)` with the given
/// quorum/threshold, proposed by a freshly-funded holder.
fn make_proposal(
    env: &Env,
    client: &GovernanceContractClient,
    mint: &StellarAssetClient,
    quorum: i128,
    threshold: u32,
) -> (u64, Address) {
    let proposer = Address::generate(env);
    mint.mint(&proposer, &1_000);
    set_time(env, 100);
    let id = client.create_proposal(
        &proposer,
        &text(env, "Upgrade protocol"),
        &text(env, "Bump the fee parameter"),
        &100u64,
        &1_000u64,
        &quorum,
        &threshold,
    );
    (id, proposer)
}

#[test]
fn initialize_is_one_time_only() {
    let (_env, client, _admin, _mint) = setup();
    let other = Address::generate(&client.env);
    let result = client.try_initialize(&other);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn get_token_returns_configured_token() {
    let env = Env::default();
    env.mock_all_auths();
    let token_admin = Address::generate(&env);
    let (token, _mint) = create_token(&env, &token_admin);
    let contract_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &contract_id);
    client.initialize(&token);
    assert_eq!(client.get_token(), Some(token));
}

#[test]
fn create_proposal_returns_incrementing_ids() {
    let (env, client, _admin, mint) = setup();
    let (first, _) = make_proposal(&env, &client, &mint, 100, 5_000);
    let (second, _) = make_proposal(&env, &client, &mint, 100, 5_000);
    assert_eq!(first, 0);
    assert_eq!(second, 1);
}

#[test]
fn create_proposal_rejects_bad_time_range() {
    let (env, client, _admin, mint) = setup();
    let proposer = Address::generate(&env);
    mint.mint(&proposer, &1_000);
    set_time(&env, 100);
    // start >= end
    let r = client.try_create_proposal(
        &proposer,
        &text(&env, "t"),
        &text(&env, "d"),
        &1_000u64,
        &1_000u64,
        &10i128,
        &5_000u32,
    );
    assert_eq!(r, Err(Ok(Error::InvalidTimeRange)));
    // end in the past
    let r = client.try_create_proposal(
        &proposer,
        &text(&env, "t"),
        &text(&env, "d"),
        &10u64,
        &50u64,
        &10i128,
        &5_000u32,
    );
    assert_eq!(r, Err(Ok(Error::InvalidTimeRange)));
}

#[test]
fn create_proposal_rejects_threshold_above_denominator() {
    let (env, client, _admin, mint) = setup();
    let proposer = Address::generate(&env);
    mint.mint(&proposer, &1_000);
    set_time(&env, 100);
    let r = client.try_create_proposal(
        &proposer,
        &text(&env, "t"),
        &text(&env, "d"),
        &100u64,
        &1_000u64,
        &10i128,
        &10_001u32,
    );
    assert_eq!(r, Err(Ok(Error::InvalidThreshold)));
}

#[test]
fn create_proposal_rejects_negative_quorum() {
    let (env, client, _admin, mint) = setup();
    let proposer = Address::generate(&env);
    mint.mint(&proposer, &1_000);
    set_time(&env, 100);
    let r = client.try_create_proposal(
        &proposer,
        &text(&env, "t"),
        &text(&env, "d"),
        &100u64,
        &1_000u64,
        &-1i128,
        &5_000u32,
    );
    assert_eq!(r, Err(Ok(Error::InvalidQuorum)));
}

#[test]
fn create_proposal_requires_voting_power() {
    let (env, client, _admin, _mint) = setup();
    let broke = Address::generate(&env);
    set_time(&env, 100);
    let r = client.try_create_proposal(
        &broke,
        &text(&env, "t"),
        &text(&env, "d"),
        &100u64,
        &1_000u64,
        &10i128,
        &5_000u32,
    );
    assert_eq!(r, Err(Ok(Error::NoVotingPower)));
}

#[test]
fn vote_is_token_weighted() {
    let (env, client, _admin, mint) = setup();
    let (id, _proposer) = make_proposal(&env, &client, &mint, 100, 5_000);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint.mint(&alice, &700);
    mint.mint(&bob, &300);

    set_time(&env, 200);
    client.vote(&alice, &id, &true);
    client.vote(&bob, &id, &false);

    let proposal = client.get_proposal(&id);
    assert_eq!(proposal.for_votes, 700);
    assert_eq!(proposal.against_votes, 300);

    let ballot = client.get_vote(&alice, &id);
    assert_eq!(ballot.voting_power, 700);
    assert!(ballot.support);
    assert_eq!(ballot.timestamp, 200);
}

#[test]
fn vote_rejects_before_start_and_after_end() {
    let (env, client, _admin, mint) = setup();
    let (id, _proposer) = make_proposal(&env, &client, &mint, 100, 5_000);
    let alice = Address::generate(&env);
    mint.mint(&alice, &500);

    set_time(&env, 50);
    assert_eq!(
        client.try_vote(&alice, &id, &true),
        Err(Ok(Error::VotingNotStarted))
    );

    set_time(&env, 1_000);
    assert_eq!(
        client.try_vote(&alice, &id, &true),
        Err(Ok(Error::VotingClosed))
    );
}

#[test]
fn vote_rejects_double_voting() {
    let (env, client, _admin, mint) = setup();
    let (id, _proposer) = make_proposal(&env, &client, &mint, 100, 5_000);
    let alice = Address::generate(&env);
    mint.mint(&alice, &500);
    set_time(&env, 200);
    client.vote(&alice, &id, &true);
    assert_eq!(
        client.try_vote(&alice, &id, &false),
        Err(Ok(Error::AlreadyVoted))
    );
}

#[test]
fn vote_requires_voting_power() {
    let (env, client, _admin, mint) = setup();
    let (id, _proposer) = make_proposal(&env, &client, &mint, 100, 5_000);
    let broke = Address::generate(&env);
    set_time(&env, 200);
    assert_eq!(
        client.try_vote(&broke, &id, &true),
        Err(Ok(Error::NoVotingPower))
    );
}

#[test]
fn delegation_moves_voting_power() {
    let (env, client, _admin, mint) = setup();
    let (id, _proposer) = make_proposal(&env, &client, &mint, 100, 5_000);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint.mint(&alice, &400);
    mint.mint(&bob, &100);

    // Alice delegates her 400 to Bob.
    client.delegate(&alice, &bob);

    set_time(&env, 200);
    // Bob now votes with his own 100 + Alice's delegated 400 = 500.
    client.vote(&bob, &id, &true);
    let proposal = client.get_proposal(&id);
    assert_eq!(proposal.for_votes, 500);

    // Alice has delegated her weight away and can no longer vote.
    assert_eq!(
        client.try_vote(&alice, &id, &true),
        Err(Ok(Error::NoVotingPower))
    );
}

#[test]
fn redelegation_unwinds_previous_delegatee() {
    let (env, client, _admin, mint) = setup();
    let (id, _proposer) = make_proposal(&env, &client, &mint, 100, 5_000);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);
    mint.mint(&alice, &400);

    client.delegate(&alice, &bob);
    // Re-point to Carol; Bob should lose the credit.
    client.delegate(&alice, &carol);

    set_time(&env, 200);
    client.vote(&carol, &id, &true);
    assert_eq!(client.get_proposal(&id).for_votes, 400);

    // Bob has no power of his own and no longer holds Alice's delegation.
    assert_eq!(
        client.try_vote(&bob, &id, &true),
        Err(Ok(Error::NoVotingPower))
    );
}

#[test]
fn execute_succeeds_when_quorum_and_threshold_met() {
    let (env, client, _admin, mint) = setup();
    let (id, _proposer) = make_proposal(&env, &client, &mint, 500, 5_000);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint.mint(&alice, &700);
    mint.mint(&bob, &300);

    set_time(&env, 200);
    client.vote(&alice, &id, &true);
    client.vote(&bob, &id, &false);

    set_time(&env, 1_000);
    client.execute_proposal(&id);
    assert!(client.get_proposal(&id).executed);
}

#[test]
fn execute_fails_when_quorum_not_met() {
    let (env, client, _admin, mint) = setup();
    // Quorum of 1_000 but only 300 will vote.
    let (id, _proposer) = make_proposal(&env, &client, &mint, 1_000, 5_000);
    let alice = Address::generate(&env);
    mint.mint(&alice, &300);

    set_time(&env, 200);
    client.vote(&alice, &id, &true);

    set_time(&env, 1_000);
    assert_eq!(
        client.try_execute_proposal(&id),
        Err(Ok(Error::ProposalNotPassed))
    );
}

#[test]
fn execute_fails_when_threshold_not_met() {
    let (env, client, _admin, mint) = setup();
    // Require 60% approval.
    let (id, _proposer) = make_proposal(&env, &client, &mint, 100, 6_000);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint.mint(&alice, &500);
    mint.mint(&bob, &500);

    set_time(&env, 200);
    client.vote(&alice, &id, &true);
    client.vote(&bob, &id, &false);

    set_time(&env, 1_000);
    // 50% for < 60% threshold.
    assert_eq!(
        client.try_execute_proposal(&id),
        Err(Ok(Error::ProposalNotPassed))
    );
}

#[test]
fn execute_fails_before_voting_ends() {
    let (env, client, _admin, mint) = setup();
    let (id, _proposer) = make_proposal(&env, &client, &mint, 100, 5_000);
    let alice = Address::generate(&env);
    mint.mint(&alice, &500);
    set_time(&env, 200);
    client.vote(&alice, &id, &true);
    // Still within the voting window.
    assert_eq!(
        client.try_execute_proposal(&id),
        Err(Ok(Error::VotingNotEnded))
    );
}

#[test]
fn execute_is_idempotent_guarded() {
    let (env, client, _admin, mint) = setup();
    let (id, _proposer) = make_proposal(&env, &client, &mint, 100, 5_000);
    let alice = Address::generate(&env);
    mint.mint(&alice, &600);
    set_time(&env, 200);
    client.vote(&alice, &id, &true);
    set_time(&env, 1_000);
    client.execute_proposal(&id);
    assert_eq!(
        client.try_execute_proposal(&id),
        Err(Ok(Error::AlreadyExecuted))
    );
}

#[test]
fn get_proposal_and_vote_report_not_found() {
    let (env, client, _admin, _mint) = setup();
    assert_eq!(
        client.try_get_proposal(&42),
        Err(Ok(Error::ProposalNotFound))
    );
    let ghost = Address::generate(&env);
    assert_eq!(
        client.try_get_vote(&ghost, &42),
        Err(Ok(Error::VoteNotFound))
    );
}
