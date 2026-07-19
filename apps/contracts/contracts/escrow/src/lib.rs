#![no_std]

use afri_contract_shared::{
    extend_instance_ttl, Error, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
};
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, panic_with_error, token::TokenClient,
    Address, Env, MuxedAddress,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Created,
    Funded,
    Completed,
    Refunded,
    Disputed,
    Cancelled,
}

#[contracttype]
#[derive(Clone)]
pub struct Escrow {
    pub id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub arbitrator: Address,
    pub asset: Address,
    pub amount: i128,
    pub status: EscrowStatus,
    pub created_at: u64,
    pub timeout_at: u64,
    pub released_at: Option<u64>,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    NextEscrowId,
    Escrow(u64),
}

fn read_escrow(env: &Env, escrow_id: u64) -> Result<Escrow, Error> {
    let key = DataKey::Escrow(escrow_id);
    let escrow = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotInitialized)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    Ok(escrow)
}

fn write_escrow(env: &Env, escrow: &Escrow) {
    let key = DataKey::Escrow(escrow.id);
    env.storage().persistent().set(&key, escrow);
    env.storage()
        .persistent()
        .extend_ttl(&key, INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

#[contractevent(topics = ["escrow", "created"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowCreated {
    #[topic]
    pub escrow_id: u64,
    #[topic]
    pub buyer: Address,
    #[topic]
    pub seller: Address,
    pub amount: i128,
}

#[contractevent(topics = ["escrow", "funded"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowFunded {
    #[topic]
    pub escrow_id: u64,
    pub amount: i128,
}

#[contractevent(topics = ["escrow", "released"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowReleased {
    #[topic]
    pub escrow_id: u64,
    pub amount: i128,
}

#[contractevent(topics = ["escrow", "refunded"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRefunded {
    #[topic]
    pub escrow_id: u64,
    pub amount: i128,
}

#[contractevent(topics = ["escrow", "disputed"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowDisputed {
    #[topic]
    pub escrow_id: u64,
    pub party: Address,
}

#[contractevent(topics = ["escrow", "resolved"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowResolved {
    #[topic]
    pub escrow_id: u64,
    pub winner: Address,
}

#[contractevent(topics = ["escrow", "cancelled"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowCancelled {
    #[topic]
    pub escrow_id: u64,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn __constructor(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextEscrowId, &1u64);
        extend_instance_ttl(&env);
    }

    pub fn create_escrow(
        env: Env,
        buyer: Address,
        seller: Address,
        arbitrator: Address,
        asset: Address,
        amount: i128,
        timeout_seconds: u64,
    ) -> Result<u64, Error> {
        buyer.require_auth();

        if amount <= 0 {
            return Err(Error::Unauthorized);
        }

        if buyer == seller || buyer == arbitrator || seller == arbitrator {
            return Err(Error::Unauthorized);
        }

        let next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextEscrowId)
            .ok_or(Error::NotInitialized)?;

        let now = env.ledger().timestamp();
        let escrow = Escrow {
            id: next_id,
            buyer: buyer.clone(),
            seller: seller.clone(),
            arbitrator: arbitrator.clone(),
            asset: asset.clone(),
            amount,
            status: EscrowStatus::Created,
            created_at: now,
            timeout_at: now.saturating_add(timeout_seconds),
            released_at: None,
        };

        write_escrow(&env, &escrow);
        env.storage()
            .instance()
            .set(&DataKey::NextEscrowId, &(next_id + 1));
        extend_instance_ttl(&env);

        EscrowCreated {
            escrow_id: next_id,
            buyer,
            seller,
            amount,
        }
        .publish(&env);

        Ok(next_id)
    }

    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<Escrow, Error> {
        read_escrow(&env, escrow_id)
    }

    pub fn fund_escrow(env: Env, escrow_id: u64, funder: Address) -> Result<(), Error> {
        let mut escrow = read_escrow(&env, escrow_id)?;

        if escrow.status != EscrowStatus::Created {
            return Err(Error::Unauthorized);
        }

        if funder != escrow.buyer {
            return Err(Error::Unauthorized);
        }

        if env.ledger().timestamp() >= escrow.timeout_at {
            return Err(Error::Unauthorized);
        }

        funder.require_auth();
        TokenClient::new(&env, &escrow.asset).transfer(
            &funder,
            MuxedAddress::from(env.current_contract_address()),
            &escrow.amount,
        );

        escrow.status = EscrowStatus::Funded;
        write_escrow(&env, &escrow);
        extend_instance_ttl(&env);

        EscrowFunded {
            escrow_id,
            amount: escrow.amount,
        }
        .publish(&env);

        Ok(())
    }

    pub fn release_funds(env: Env, escrow_id: u64, releaser: Address) -> Result<(), Error> {
        let mut escrow = read_escrow(&env, escrow_id)?;

        let now = env.ledger().timestamp();
        if escrow.status != EscrowStatus::Funded {
            return Err(Error::Unauthorized);
        }

        if now < escrow.timeout_at {
            if releaser != escrow.buyer && releaser != escrow.arbitrator {
                return Err(Error::Unauthorized);
            }

            releaser.require_auth();
        }

        TokenClient::new(&env, &escrow.asset).transfer(
            &env.current_contract_address(),
            MuxedAddress::from(escrow.seller.clone()),
            &escrow.amount,
        );

        escrow.status = EscrowStatus::Completed;
        escrow.released_at = Some(now);
        write_escrow(&env, &escrow);
        extend_instance_ttl(&env);

        EscrowReleased {
            escrow_id,
            amount: escrow.amount,
        }
        .publish(&env);

        Ok(())
    }

    pub fn refund_buyer(env: Env, escrow_id: u64, arbitrator: Address) -> Result<(), Error> {
        let mut escrow = read_escrow(&env, escrow_id)?;

        if escrow.status != EscrowStatus::Funded && escrow.status != EscrowStatus::Disputed {
            return Err(Error::Unauthorized);
        }

        if arbitrator != escrow.arbitrator {
            return Err(Error::Unauthorized);
        }

        arbitrator.require_auth();
        TokenClient::new(&env, &escrow.asset).transfer(
            &env.current_contract_address(),
            MuxedAddress::from(escrow.buyer.clone()),
            &escrow.amount,
        );

        escrow.status = EscrowStatus::Refunded;
        write_escrow(&env, &escrow);
        extend_instance_ttl(&env);

        EscrowRefunded {
            escrow_id,
            amount: escrow.amount,
        }
        .publish(&env);

        Ok(())
    }

    pub fn start_dispute(env: Env, escrow_id: u64, party: Address) -> Result<(), Error> {
        let mut escrow = read_escrow(&env, escrow_id)?;

        if escrow.status != EscrowStatus::Funded {
            return Err(Error::Unauthorized);
        }

        if env.ledger().timestamp() >= escrow.timeout_at {
            return Err(Error::Unauthorized);
        }

        if party != escrow.buyer && party != escrow.seller {
            return Err(Error::Unauthorized);
        }

        party.require_auth();
        escrow.status = EscrowStatus::Disputed;
        write_escrow(&env, &escrow);
        extend_instance_ttl(&env);

        EscrowDisputed { escrow_id, party }.publish(&env);

        Ok(())
    }

    pub fn resolve_dispute(
        env: Env,
        escrow_id: u64,
        arbitrator: Address,
        winner: Address,
    ) -> Result<(), Error> {
        let mut escrow = read_escrow(&env, escrow_id)?;

        if escrow.status != EscrowStatus::Disputed {
            return Err(Error::Unauthorized);
        }

        if arbitrator != escrow.arbitrator {
            return Err(Error::Unauthorized);
        }

        if winner != escrow.buyer && winner != escrow.seller {
            return Err(Error::Unauthorized);
        }

        arbitrator.require_auth();
        TokenClient::new(&env, &escrow.asset).transfer(
            &env.current_contract_address(),
            MuxedAddress::from(winner.clone()),
            &escrow.amount,
        );

        escrow.status = if winner == escrow.seller {
            EscrowStatus::Completed
        } else {
            EscrowStatus::Refunded
        };
        escrow.released_at = Some(env.ledger().timestamp());
        write_escrow(&env, &escrow);
        extend_instance_ttl(&env);

        EscrowResolved { escrow_id, winner }.publish(&env);

        Ok(())
    }

    pub fn cancel_escrow(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        let mut escrow = read_escrow(&env, escrow_id)?;

        if escrow.status != EscrowStatus::Created {
            return Err(Error::Unauthorized);
        }

        if caller != escrow.buyer && caller != escrow.seller {
            return Err(Error::Unauthorized);
        }

        caller.require_auth();
        escrow.status = EscrowStatus::Cancelled;
        write_escrow(&env, &escrow);
        extend_instance_ttl(&env);

        EscrowCancelled { escrow_id }.publish(&env);

        Ok(())
    }
}

#[cfg(test)]
mod test;
