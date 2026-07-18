use crate::{DataKey, EscrowContract, EscrowContractClient, EscrowStatus};
use afri_contract_shared::Error;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

const INITIAL_BUYER_BALANCE: i128 = 1_000;

struct Fixture {
    contract_id: Address,
    buyer: Address,
    seller: Address,
    arbitrator: Address,
    asset: Address,
}

fn setup() -> (Env, Fixture) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (&admin,));
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    StellarAssetClient::new(&env, &asset).mint(&buyer, &INITIAL_BUYER_BALANCE);

    (
        env,
        Fixture {
            contract_id,
            buyer,
            seller,
            arbitrator,
            asset,
        },
    )
}

fn client<'a>(env: &'a Env, fixture: &Fixture) -> EscrowContractClient<'a> {
    EscrowContractClient::new(env, &fixture.contract_id)
}

fn token<'a>(env: &'a Env, fixture: &Fixture) -> TokenClient<'a> {
    TokenClient::new(env, &fixture.asset)
}

fn create_escrow(env: &Env, fixture: &Fixture, amount: i128, timeout: u64) -> u64 {
    client(env, fixture).create_escrow(
        &fixture.buyer,
        &fixture.seller,
        &fixture.arbitrator,
        &fixture.asset,
        &amount,
        &timeout,
    )
}

#[test]
fn funding_moves_tokens_into_contract_custody() {
    let (env, fixture) = setup();
    let escrow_id = create_escrow(&env, &fixture, 100, 10);

    client(&env, &fixture).fund_escrow(&escrow_id, &fixture.buyer);

    assert_eq!(
        client(&env, &fixture).get_escrow(&escrow_id).status,
        EscrowStatus::Funded
    );
    assert_eq!(token(&env, &fixture).balance(&fixture.buyer), 900);
    assert_eq!(token(&env, &fixture).balance(&fixture.contract_id), 100);
    assert_eq!(token(&env, &fixture).balance(&fixture.seller), 0);
    env.as_contract(&fixture.contract_id, || {
        let key = DataKey::Escrow(escrow_id);
        assert!(env.storage().persistent().has(&key));
        assert!(!env.storage().instance().has(&key));
    });
}

#[test]
fn manual_and_timeout_release_pay_the_seller() {
    let (env, fixture) = setup();
    let manual_id = create_escrow(&env, &fixture, 50, 100);
    client(&env, &fixture).fund_escrow(&manual_id, &fixture.buyer);
    client(&env, &fixture).release_funds(&manual_id, &fixture.buyer);

    assert_eq!(
        client(&env, &fixture).get_escrow(&manual_id).status,
        EscrowStatus::Completed
    );
    assert_eq!(token(&env, &fixture).balance(&fixture.contract_id), 0);
    assert_eq!(token(&env, &fixture).balance(&fixture.seller), 50);

    let timeout_id = create_escrow(&env, &fixture, 25, 1);
    client(&env, &fixture).fund_escrow(&timeout_id, &fixture.buyer);
    env.ledger().set_timestamp(env.ledger().timestamp() + 2);
    env.set_auths(&[]);

    client(&env, &fixture).release_funds(&timeout_id, &Address::generate(&env));

    assert_eq!(
        client(&env, &fixture).get_escrow(&timeout_id).status,
        EscrowStatus::Completed
    );
    assert_eq!(token(&env, &fixture).balance(&fixture.contract_id), 0);
    assert_eq!(token(&env, &fixture).balance(&fixture.seller), 75);
}

#[test]
fn refund_returns_custodied_tokens_to_buyer() {
    let (env, fixture) = setup();
    let escrow_id = create_escrow(&env, &fixture, 80, 20);
    client(&env, &fixture).fund_escrow(&escrow_id, &fixture.buyer);
    client(&env, &fixture).start_dispute(&escrow_id, &fixture.seller);

    client(&env, &fixture).refund_buyer(&escrow_id, &fixture.arbitrator);

    assert_eq!(
        client(&env, &fixture).get_escrow(&escrow_id).status,
        EscrowStatus::Refunded
    );
    assert_eq!(
        token(&env, &fixture).balance(&fixture.buyer),
        INITIAL_BUYER_BALANCE
    );
    assert_eq!(token(&env, &fixture).balance(&fixture.contract_id), 0);
}

#[test]
fn dispute_resolution_pays_the_selected_winner() {
    let (env, fixture) = setup();
    let seller_id = create_escrow(&env, &fixture, 70, 20);
    client(&env, &fixture).fund_escrow(&seller_id, &fixture.buyer);
    client(&env, &fixture).start_dispute(&seller_id, &fixture.buyer);
    client(&env, &fixture).resolve_dispute(&seller_id, &fixture.arbitrator, &fixture.seller);

    assert_eq!(token(&env, &fixture).balance(&fixture.seller), 70);
    assert_eq!(token(&env, &fixture).balance(&fixture.contract_id), 0);

    let buyer_id = create_escrow(&env, &fixture, 30, 20);
    client(&env, &fixture).fund_escrow(&buyer_id, &fixture.buyer);
    client(&env, &fixture).start_dispute(&buyer_id, &fixture.seller);
    client(&env, &fixture).resolve_dispute(&buyer_id, &fixture.arbitrator, &fixture.buyer);

    assert_eq!(token(&env, &fixture).balance(&fixture.buyer), 930);
    assert_eq!(token(&env, &fixture).balance(&fixture.contract_id), 0);
    assert_eq!(
        client(&env, &fixture).get_escrow(&buyer_id).status,
        EscrowStatus::Refunded
    );
}

#[test]
fn funding_after_deadline_is_rejected_without_moving_tokens() {
    let (env, fixture) = setup();
    let escrow_id = create_escrow(&env, &fixture, 100, 1);
    env.ledger().set_timestamp(env.ledger().timestamp() + 1);

    let result = client(&env, &fixture).try_fund_escrow(&escrow_id, &fixture.buyer);

    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(token(&env, &fixture).balance(&fixture.buyer), 1_000);
    assert_eq!(token(&env, &fixture).balance(&fixture.contract_id), 0);
    assert_eq!(
        client(&env, &fixture).get_escrow(&escrow_id).status,
        EscrowStatus::Created
    );
}

#[test]
fn create_requires_buyer_authorization() {
    let (env, fixture) = setup();
    env.set_auths(&[]);
    assert!(client(&env, &fixture)
        .try_create_escrow(
            &fixture.buyer,
            &fixture.seller,
            &fixture.arbitrator,
            &fixture.asset,
            &10,
            &10,
        )
        .is_err());
}

#[test]
fn create_rejects_non_distinct_roles() {
    let (env, fixture) = setup();
    let client = client(&env, &fixture);

    assert_eq!(
        client.try_create_escrow(
            &fixture.buyer,
            &fixture.buyer,
            &fixture.arbitrator,
            &fixture.asset,
            &10,
            &10,
        ),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_create_escrow(
            &fixture.buyer,
            &fixture.seller,
            &fixture.buyer,
            &fixture.asset,
            &10,
            &10,
        ),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_create_escrow(
            &fixture.buyer,
            &fixture.seller,
            &fixture.seller,
            &fixture.asset,
            &10,
            &10,
        ),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn funding_requires_buyer_auth_and_rejects_other_funders() {
    let (env, fixture) = setup();
    let escrow_id = create_escrow(&env, &fixture, 100, 10);
    env.set_auths(&[]);

    assert!(client(&env, &fixture)
        .try_fund_escrow(&escrow_id, &fixture.buyer)
        .is_err());
    assert_eq!(
        client(&env, &fixture).try_fund_escrow(&escrow_id, &Address::generate(&env)),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn release_requires_authorized_role_and_auth_before_timeout() {
    let (env, fixture) = setup();
    let escrow_id = create_escrow(&env, &fixture, 100, 10);
    client(&env, &fixture).fund_escrow(&escrow_id, &fixture.buyer);
    env.set_auths(&[]);

    assert!(client(&env, &fixture)
        .try_release_funds(&escrow_id, &fixture.buyer)
        .is_err());
    assert_eq!(
        client(&env, &fixture).try_release_funds(&escrow_id, &Address::generate(&env)),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(token(&env, &fixture).balance(&fixture.contract_id), 100);
}

#[test]
fn arbitration_requires_arbitrator_auth_and_role() {
    let (env, fixture) = setup();
    let refund_id = create_escrow(&env, &fixture, 50, 10);
    client(&env, &fixture).fund_escrow(&refund_id, &fixture.buyer);

    let resolve_id = create_escrow(&env, &fixture, 40, 10);
    client(&env, &fixture).fund_escrow(&resolve_id, &fixture.buyer);
    client(&env, &fixture).start_dispute(&resolve_id, &fixture.seller);
    env.set_auths(&[]);

    assert!(client(&env, &fixture)
        .try_refund_buyer(&refund_id, &fixture.arbitrator)
        .is_err());
    assert_eq!(
        client(&env, &fixture).try_refund_buyer(&refund_id, &Address::generate(&env)),
        Err(Ok(Error::Unauthorized))
    );
    assert!(client(&env, &fixture)
        .try_resolve_dispute(&resolve_id, &fixture.arbitrator, &fixture.seller)
        .is_err());
    assert_eq!(
        client(&env, &fixture).try_resolve_dispute(
            &resolve_id,
            &Address::generate(&env),
            &fixture.seller,
        ),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn dispute_requires_party_auth_and_role() {
    let (env, fixture) = setup();
    let escrow_id = create_escrow(&env, &fixture, 100, 10);
    client(&env, &fixture).fund_escrow(&escrow_id, &fixture.buyer);
    env.set_auths(&[]);

    assert!(client(&env, &fixture)
        .try_start_dispute(&escrow_id, &fixture.seller)
        .is_err());
    assert_eq!(
        client(&env, &fixture).try_start_dispute(&escrow_id, &Address::generate(&env)),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn dispute_at_or_after_deadline_is_rejected_and_release_remains_available() {
    let (env, fixture) = setup();
    let escrow_id = create_escrow(&env, &fixture, 100, 5);
    client(&env, &fixture).fund_escrow(&escrow_id, &fixture.buyer);
    let deadline = client(&env, &fixture).get_escrow(&escrow_id).timeout_at;

    env.ledger().set_timestamp(deadline);
    assert_eq!(
        client(&env, &fixture).try_start_dispute(&escrow_id, &fixture.seller),
        Err(Ok(Error::Unauthorized))
    );

    env.ledger().set_timestamp(deadline + 1);
    assert_eq!(
        client(&env, &fixture).try_start_dispute(&escrow_id, &fixture.buyer),
        Err(Ok(Error::Unauthorized))
    );

    env.set_auths(&[]);
    client(&env, &fixture).release_funds(&escrow_id, &Address::generate(&env));
    assert_eq!(
        client(&env, &fixture).get_escrow(&escrow_id).status,
        EscrowStatus::Completed
    );
    assert_eq!(token(&env, &fixture).balance(&fixture.seller), 100);
}

#[test]
fn cancellation_requires_party_auth_and_rejects_outsiders() {
    let (env, fixture) = setup();
    let escrow_id = create_escrow(&env, &fixture, 100, 10);
    env.set_auths(&[]);

    assert!(client(&env, &fixture)
        .try_cancel_escrow(&escrow_id, &fixture.buyer)
        .is_err());
    assert_eq!(
        client(&env, &fixture).try_cancel_escrow(&escrow_id, &Address::generate(&env)),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client(&env, &fixture).get_escrow(&escrow_id).status,
        EscrowStatus::Created
    );
}

#[test]
fn constructor_initializes_escrow_ids() {
    let (env, fixture) = setup();
    assert_eq!(create_escrow(&env, &fixture, 100, 10), 1);
    assert_eq!(create_escrow(&env, &fixture, 100, 10), 2);
}
