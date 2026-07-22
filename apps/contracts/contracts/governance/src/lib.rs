#![no_std]
//! Governance — on-chain, token-weighted voting for AfriDollar.
//!
//! The contract lets any token holder submit a [`Proposal`], lets holders
//! [`vote`](GovernanceContract::vote) on it with weight proportional to their
//! governance-token holdings, and lets anyone
//! [`execute`](GovernanceContract::execute_proposal) a proposal once voting
//! has closed *and* it has met both its quorum and its approval threshold.
//! Holders may [`delegate`](GovernanceContract::delegate) their voting weight
//! to another address without transferring any tokens.
//!
//! ## Where voting power comes from — and two deviations from the sketch
//!
//! This contract is wired to a single SEP-41 governance token, fixed at
//! [`initialize`](GovernanceContract::initialize). A voter's weight is read
//! from that token rather than trusted from a caller-supplied argument, for
//! two reasons that together make "voting is token-weighted" an *enforced*
//! property instead of a claim:
//!
//! * **`vote` does not take a `voting_power` argument.** The original issue
//!   sketch passed `voting_power: i128` into `vote`. Trusting that value would
//!   let any caller vote with an arbitrary weight, so the acceptance criterion
//!   "voting is token-weighted" could not hold. Instead `vote` derives weight
//!   from the governance token via [`voting_power_of`] and records the derived
//!   value into `Vote.voting_power` — which is exactly what that field is for.
//! * **Every entrypoint returns `Result<_, Error>`** rather than the bare
//!   values in the sketch, matching this repo's established convention (see the
//!   `staking` and `counter` reference contracts).
//!
//! Every field of [`Proposal`] and [`Vote`] matches the issue sketch exactly.
//!
//! ## Delegation model
//!
//! Delegation is a non-transferable redirection of voting weight, modelled
//! after the OpenZeppelin `Votes` design but adapted to Soroban's storage:
//!
//! * When `A` delegates to `B`, `A`'s *current* token balance is snapshotted
//!   and added to `B`'s incoming delegated power. `A` keeps custody of its
//!   tokens; it simply stops counting its own balance toward its own vote (see
//!   [`voting_power_of`]).
//! * Delegation is **not transitive**: if `B` has in turn delegated its own
//!   balance to `C`, the weight `A` gave to `B` still counts for `B`, not `C`.
//! * Re-delegating moves the previously-snapshotted amount off the old
//!   delegatee before crediting the new one, so a holder's weight is never
//!   counted for two delegatees at once.
//!
//! ## Known limitation: no historical balance snapshots
//!
//! Voting weight is read from *live* token balances, because Soroban has no
//! cheap per-ledger balance checkpoint primitive. A determined holder could
//! therefore vote, transfer their tokens to a fresh address, and vote again
//! from that address on the same proposal — the classic non-snapshot
//! double-vote. Within a single address this is prevented (one [`Vote`] per
//! `(voter, proposal)`), but cross-address transfer-and-revote is not. The same
//! root cause admits a delegation variant: an address may vote its own balance
//! on a proposal and *then* delegate that balance to another address, which can
//! vote the same weight again on the same still-open proposal. All three are
//! one problem — weight is read live rather than snapshotted per proposal — and
//! cannot be closed with a local guard here: [`delegate`](GovernanceContract::delegate)
//! is account-level and proposal-agnostic, so rejecting it would require an
//! unbounded scan of every open proposal, and there is no per-proposal power to
//! subtract from. A production deployment should back governance with a
//! checkpointed token or require holders to lock tokens for the voting window;
//! both are out of scope for this contract, which focuses on the
//! proposal/vote/delegate/execute lifecycle. This is documented rather than
//! hidden so the tradeoff is explicit.

use afri_contract_shared::{
    extend_instance_ttl, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token::TokenClient,
    Address, Env, String,
};

/// Basis-points denominator for [`Proposal::threshold`]. A threshold of
/// `5_000` means "50.00% of the votes cast must be `for` votes".
const BPS_DENOMINATOR: i128 = 10_000;

/// Errors returned by the governance contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` was called on a contract that already has a token set.
    AlreadyInitialized = 1,
    /// An operation was attempted before the contract was initialized.
    NotInitialized = 2,
    /// `create_proposal` was given `start_time >= end_time`, or an `end_time`
    /// that is not in the future.
    InvalidTimeRange = 3,
    /// `create_proposal` was given a `threshold` above `BPS_DENOMINATOR`.
    InvalidThreshold = 4,
    /// `create_proposal` was given a negative `quorum`.
    InvalidQuorum = 5,
    /// The proposer (or a would-be voter) has zero voting power.
    NoVotingPower = 6,
    /// No proposal exists for the given id.
    ProposalNotFound = 7,
    /// `vote` was called before the proposal's `start_time`.
    VotingNotStarted = 8,
    /// `vote` was called at or after the proposal's `end_time`.
    VotingClosed = 9,
    /// This voter has already cast a vote on this proposal.
    AlreadyVoted = 10,
    /// No vote exists for the given `(voter, proposal_id)`.
    VoteNotFound = 11,
    /// `execute_proposal` was called before the proposal's `end_time`.
    VotingNotEnded = 12,
    /// `execute_proposal` was called on a proposal that did not meet its
    /// quorum and/or approval threshold.
    ProposalNotPassed = 13,
    /// `execute_proposal` was called on an already-executed proposal.
    AlreadyExecuted = 14,
    /// A checked arithmetic operation would have overflowed.
    Overflow = 15,
}

/// A governance proposal. Field shape matches the issue sketch exactly;
/// `for_votes`/`against_votes` accumulate the token-weighted tallies.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub title: String,
    pub description: String,
    pub start_time: u64,
    pub end_time: u64,
    pub for_votes: i128,
    pub against_votes: i128,
    /// Minimum total weight (`for + against`) that must participate for the
    /// proposal to be executable.
    pub quorum: i128,
    /// Minimum share of *cast* votes, in basis points (see [`BPS_DENOMINATOR`]),
    /// that must be `for` votes for the proposal to pass.
    pub threshold: u32,
    pub executed: bool,
}

/// A single voter's ballot on a proposal. `voting_power` is the weight derived
/// from the governance token at the moment the vote was cast.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Vote {
    pub voter: Address,
    pub proposal_id: u64,
    pub support: bool,
    pub voting_power: i128,
    pub timestamp: u64,
}

/// A holder's outstanding delegation: whom they delegated to and the weight
/// snapshotted at delegation time (used to unwind on re-delegation).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Delegation {
    pub delegatee: Address,
    pub amount: i128,
}

/// Storage keys. `Token`/`ProposalCount` live in instance storage; the rest in
/// persistent storage keyed by their subject.
#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// The governance token whose balances define voting weight.
    Token,
    /// Monotonic counter; the next proposal id to hand out.
    ProposalCount,
    /// `Proposal`, keyed by id.
    Proposal(u64),
    /// `Vote`, keyed by `(voter, proposal_id)`.
    Vote(Address, u64),
    /// A holder's outstanding `Delegation`, if they have delegated.
    Delegate(Address),
    /// Weight delegated *to* an address by others (an i128 accumulator).
    DelegatedPower(Address),
}

/// Emitted when a new proposal is created.
#[contractevent(topics = ["governance", "proposal"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreated {
    #[topic]
    pub id: u64,
    #[topic]
    pub proposer: Address,
    pub start_time: u64,
    pub end_time: u64,
}

/// Emitted when a vote is cast.
#[contractevent(topics = ["governance", "vote"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteCast {
    #[topic]
    pub proposal_id: u64,
    #[topic]
    pub voter: Address,
    pub support: bool,
    pub voting_power: i128,
}

/// Emitted when a proposal is executed.
#[contractevent(topics = ["governance", "execute"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExecuted {
    #[topic]
    pub id: u64,
    pub for_votes: i128,
    pub against_votes: i128,
}

/// Emitted when an address (re-)delegates its voting weight.
#[contractevent(topics = ["governance", "delegate"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Delegated {
    #[topic]
    pub delegator: Address,
    #[topic]
    pub delegatee: Address,
    pub amount: i128,
}

/// Read the configured governance token, or `Error::NotInitialized`.
fn read_token(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Token)
        .ok_or(Error::NotInitialized)
}

/// Read a stored proposal, or `Error::ProposalNotFound`.
fn read_proposal(env: &Env, id: u64) -> Result<Proposal, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Proposal(id))
        .ok_or(Error::ProposalNotFound)
}

/// Persist a proposal and extend its TTL.
fn put_proposal(env: &Env, proposal: &Proposal) {
    let key = DataKey::Proposal(proposal.id);
    env.storage().persistent().set(&key, proposal);
    extend_persistent_ttl(env, &key);
}

/// Extend the TTL of a persistent entry, mirroring `extend_instance_ttl`.
/// Persistent entries carry their own TTL, so a long-lived proposal or
/// delegation must be bumped independently of instance storage or it could
/// expire mid-vote.
fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Weight delegated *to* `addr` by others (0 if none).
fn delegated_power(env: &Env, addr: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::DelegatedPower(addr.clone()))
        .unwrap_or(0)
}

/// Add `delta` (which may be negative) to the power delegated to `addr`,
/// saturating at zero so accounting can never go negative even if a snapshot
/// and a live balance disagree.
fn adjust_delegated_power(env: &Env, addr: &Address, delta: i128) {
    let updated = delegated_power(env, addr).saturating_add(delta).max(0);
    let key = DataKey::DelegatedPower(addr.clone());
    env.storage().persistent().set(&key, &updated);
    extend_persistent_ttl(env, &key);
}

/// A voter's effective voting weight: the power others delegated to them, plus
/// their own live token balance *unless* they have delegated it away.
///
/// See the module docs for why this reads live balances and the double-vote
/// tradeoff that implies.
fn voting_power_of(env: &Env, voter: &Address) -> Result<i128, Error> {
    let incoming = delegated_power(env, voter);
    let has_delegated = env
        .storage()
        .persistent()
        .has(&DataKey::Delegate(voter.clone()));
    let base = if has_delegated {
        0
    } else {
        let token = read_token(env)?;
        TokenClient::new(env, &token).balance(voter)
    };
    base.checked_add(incoming).ok_or(Error::Overflow)
}

/// Whether a proposal has passed: quorum met *and* the `for` share is at least
/// `threshold` basis points of the votes cast. Called only after voting ends.
fn has_passed(proposal: &Proposal) -> Result<bool, Error> {
    let total = proposal
        .for_votes
        .checked_add(proposal.against_votes)
        .ok_or(Error::Overflow)?;
    // A proposal that drew no participation never passes, even if it was
    // created with a zero `quorum` (which would otherwise satisfy the checks
    // below with an all-zero tally).
    if total == 0 {
        return Ok(false);
    }
    if total < proposal.quorum {
        return Ok(false);
    }
    // for/total >= threshold/BPS  <=>  for*BPS >= total*threshold
    let lhs = proposal
        .for_votes
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(Error::Overflow)?;
    let rhs = total
        .checked_mul(proposal.threshold as i128)
        .ok_or(Error::Overflow)?;
    Ok(lhs >= rhs)
}

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    /// Initialize the contract, fixing the governance `token` whose balances
    /// define voting weight. Fails with `Error::AlreadyInitialized` if called
    /// twice.
    pub fn initialize(env: Env, token: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Token) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// The governance token address, if the contract has been initialized.
    pub fn get_token(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Token)
    }

    /// Create a proposal and return its id.
    ///
    /// Requires `proposer.require_auth()` and that the proposer holds nonzero
    /// voting power (`Error::NoVotingPower` otherwise), so proposals cannot be
    /// spammed by addresses with no stake in the token. Validates that
    /// `start_time < end_time`, that `end_time` is in the future
    /// (`Error::InvalidTimeRange`), that `threshold <= BPS_DENOMINATOR`
    /// (`Error::InvalidThreshold`), and that `quorum >= 0`
    /// (`Error::InvalidQuorum`).
    #[allow(clippy::too_many_arguments)]
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        title: String,
        description: String,
        start_time: u64,
        end_time: u64,
        quorum: i128,
        threshold: u32,
    ) -> Result<u64, Error> {
        proposer.require_auth();

        let now = env.ledger().timestamp();
        if start_time >= end_time || end_time <= now {
            return Err(Error::InvalidTimeRange);
        }
        if threshold as i128 > BPS_DENOMINATOR {
            return Err(Error::InvalidThreshold);
        }
        if quorum < 0 {
            return Err(Error::InvalidQuorum);
        }
        if voting_power_of(&env, &proposer)? <= 0 {
            return Err(Error::NoVotingPower);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let next = id.checked_add(1).ok_or(Error::Overflow)?;

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            title,
            description,
            start_time,
            end_time,
            for_votes: 0,
            against_votes: 0,
            quorum,
            threshold,
            executed: false,
        };
        put_proposal(&env, &proposal);
        env.storage().instance().set(&DataKey::ProposalCount, &next);
        extend_instance_ttl(&env);

        ProposalCreated {
            id,
            proposer,
            start_time,
            end_time,
        }
        .publish(&env);
        Ok(id)
    }

    /// Cast a token-weighted vote on `proposal_id`.
    ///
    /// The voter's weight is derived from the governance token (plus any power
    /// delegated to them) — it is *not* supplied by the caller; see the module
    /// docs. Requires `voter.require_auth()`. Fails with `VotingNotStarted`
    /// before `start_time`, `VotingClosed` at/after `end_time`, `AlreadyVoted`
    /// if this voter already voted on this proposal, and `NoVotingPower` if the
    /// derived weight is zero.
    pub fn vote(env: Env, voter: Address, proposal_id: u64, support: bool) -> Result<(), Error> {
        voter.require_auth();

        let mut proposal = read_proposal(&env, proposal_id)?;
        let now = env.ledger().timestamp();
        if now < proposal.start_time {
            return Err(Error::VotingNotStarted);
        }
        if now >= proposal.end_time {
            return Err(Error::VotingClosed);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::Vote(voter.clone(), proposal_id))
        {
            return Err(Error::AlreadyVoted);
        }

        let power = voting_power_of(&env, &voter)?;
        if power <= 0 {
            return Err(Error::NoVotingPower);
        }

        if support {
            proposal.for_votes = proposal
                .for_votes
                .checked_add(power)
                .ok_or(Error::Overflow)?;
        } else {
            proposal.against_votes = proposal
                .against_votes
                .checked_add(power)
                .ok_or(Error::Overflow)?;
        }
        put_proposal(&env, &proposal);

        let ballot = Vote {
            voter: voter.clone(),
            proposal_id,
            support,
            voting_power: power,
            timestamp: now,
        };
        let vote_key = DataKey::Vote(voter.clone(), proposal_id);
        env.storage().persistent().set(&vote_key, &ballot);
        extend_persistent_ttl(&env, &vote_key);
        extend_instance_ttl(&env);

        VoteCast {
            proposal_id,
            voter,
            support,
            voting_power: power,
        }
        .publish(&env);
        Ok(())
    }

    /// Execute a proposal that has passed.
    ///
    /// The `Proposal` struct carries no on-chain call payload, so execution is
    /// a state transition — it marks the proposal `executed` and emits
    /// [`ProposalExecuted`] for downstream systems to act on. Requires that
    /// voting has ended (`Error::VotingNotEnded` before `end_time`), that the
    /// proposal met its quorum and threshold (`Error::ProposalNotPassed`
    /// otherwise), and that it has not already been executed
    /// (`Error::AlreadyExecuted`). Permissionless: anyone may trigger execution
    /// of a passed proposal.
    pub fn execute_proposal(env: Env, proposal_id: u64) -> Result<(), Error> {
        let mut proposal = read_proposal(&env, proposal_id)?;
        if proposal.executed {
            return Err(Error::AlreadyExecuted);
        }
        let now = env.ledger().timestamp();
        if now < proposal.end_time {
            return Err(Error::VotingNotEnded);
        }
        if !has_passed(&proposal)? {
            return Err(Error::ProposalNotPassed);
        }

        proposal.executed = true;
        put_proposal(&env, &proposal);
        extend_instance_ttl(&env);

        ProposalExecuted {
            id: proposal_id,
            for_votes: proposal.for_votes,
            against_votes: proposal.against_votes,
        }
        .publish(&env);
        Ok(())
    }

    /// Delegate `delegator`'s voting weight to `delegatee`.
    ///
    /// Snapshots `delegator`'s current token balance and credits it to
    /// `delegatee`'s incoming delegated power; `delegator` keeps custody of its
    /// tokens but stops counting its own balance toward its own vote. Calling
    /// again re-points the delegation, first unwinding the previously-credited
    /// amount from the old delegatee. Requires `delegator.require_auth()`. See
    /// the module docs for the (non-transitive, live-balance) delegation model.
    pub fn delegate(env: Env, delegator: Address, delegatee: Address) -> Result<(), Error> {
        delegator.require_auth();

        let token = read_token(&env)?;
        let amount = TokenClient::new(&env, &token).balance(&delegator);

        // Unwind any prior delegation before crediting the new delegatee, so a
        // holder's weight is never counted for two delegatees at once.
        if let Some(prev) = env
            .storage()
            .persistent()
            .get::<DataKey, Delegation>(&DataKey::Delegate(delegator.clone()))
        {
            adjust_delegated_power(&env, &prev.delegatee, -prev.amount);
        }

        adjust_delegated_power(&env, &delegatee, amount);
        let key = DataKey::Delegate(delegator.clone());
        env.storage().persistent().set(
            &key,
            &Delegation {
                delegatee: delegatee.clone(),
                amount,
            },
        );
        extend_persistent_ttl(&env, &key);
        extend_instance_ttl(&env);

        Delegated {
            delegator,
            delegatee,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Read a proposal by id.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, Error> {
        read_proposal(&env, proposal_id)
    }

    /// Read a voter's ballot on a proposal.
    pub fn get_vote(env: Env, voter: Address, proposal_id: u64) -> Result<Vote, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Vote(voter, proposal_id))
            .ok_or(Error::VoteNotFound)
    }
}

#[cfg(test)]
mod test;
