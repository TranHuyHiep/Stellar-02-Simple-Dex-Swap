#![no_std]
//! A pool that custodies NFTs from a linked `nft_collection`.
//!
//! Two ways in:
//!   * the collection mints straight into the pool and calls `on_deposit`
//!   * a holder calls `add`, which pulls the token in via the collection
//!
//! One way out: `withdraw`, restricted to whoever deposited the token. The pool
//! never invents ownership — it asks the collection to move the token and only
//! then updates its own index.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, Address,
    Env, Vec,
};

/// Cap on the pool's index so listing stays bounded.
const MAX_POOL_SIZE: u32 = 500;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    /// The linked collection has not been set.
    CollectionNotSet = 4,
    /// The token is already tracked by the pool.
    AlreadyInPool = 5,
    /// The token is not in the pool.
    NotInPool = 6,
    /// Only the account that deposited a token may withdraw it.
    NotDepositor = 7,
    /// The pool is full.
    PoolFull = 8,
    /// The pool is closed by its admin.
    PoolClosed = 9,
}

#[contractevent(topics = ["deposit"], data_format = "map")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DepositEvent {
    #[topic]
    pub depositor: Address,
    pub token_id: u32,
    pub pool_size: u32,
    /// True when the token arrived via `mint_to_pool` rather than `add`.
    pub minted: bool,
}

#[contractevent(topics = ["withdraw"], data_format = "map")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawEvent {
    #[topic]
    pub to: Address,
    pub token_id: u32,
    pub pool_size: u32,
}

/// The slice of `nft_collection` the pool calls into.
#[contractclient(name = "CollectionClient")]
pub trait CollectionInterface {
    fn transfer(env: Env, from: Address, to: Address, token_id: u32);
    fn transfer_from_pool(env: Env, pool: Address, to: Address, token_id: u32);
    fn owner_of(env: Env, token_id: u32) -> Address;
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Closed,
    Collection,
    /// Every token id currently held.
    Items,
    /// Who deposited a given token, so only they can take it back.
    Depositor(u32),
    TotalDeposits,
}

#[contract]
pub struct NftPool;

#[contractimpl]
impl NftPool {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Closed, &false);
        env.storage().instance().set(&DataKey::TotalDeposits, &0u32);
        Ok(())
    }

    /// Called by the collection when a token is minted directly into the pool.
    ///
    /// Only the linked collection may call this: the pool trusts the contract,
    /// not the end user, so the index cannot be poisoned with tokens the pool
    /// does not actually own.
    pub fn on_deposit(
        env: Env,
        caller: Address,
        token_id: u32,
        depositor: Address,
    ) -> Result<(), Error> {
        caller.require_auth();

        let collection: Address = env
            .storage()
            .instance()
            .get(&DataKey::Collection)
            .ok_or(Error::CollectionNotSet)?;
        if caller != collection {
            return Err(Error::Unauthorized);
        }

        Self::insert(&env, token_id, &depositor, true)
    }

    /// Deposit a token the caller already owns.
    ///
    /// The pool pulls the token through the collection, so ownership and the
    /// pool's index move together or not at all.
    pub fn add(env: Env, owner: Address, token_id: u32) -> Result<(), Error> {
        owner.require_auth();

        let collection: Address = env
            .storage()
            .instance()
            .get(&DataKey::Collection)
            .ok_or(Error::CollectionNotSet)?;

        if env
            .storage()
            .persistent()
            .has(&DataKey::Depositor(token_id))
        {
            return Err(Error::AlreadyInPool);
        }

        // Cross-contract: move the token into the pool's custody first. If the
        // caller does not own it, the collection rejects and nothing is indexed.
        CollectionClient::new(&env, &collection).transfer(
            &owner,
            &env.current_contract_address(),
            &token_id,
        );

        Self::insert(&env, token_id, &owner, false)
    }

    fn insert(env: &Env, token_id: u32, depositor: &Address, minted: bool) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }
        if env
            .storage()
            .instance()
            .get(&DataKey::Closed)
            .unwrap_or(false)
        {
            return Err(Error::PoolClosed);
        }

        let mut items = Self::item_ids(env);
        if items.contains(token_id) {
            return Err(Error::AlreadyInPool);
        }
        if items.len() >= MAX_POOL_SIZE {
            return Err(Error::PoolFull);
        }
        items.push_back(token_id);
        env.storage().persistent().set(&DataKey::Items, &items);
        env.storage()
            .persistent()
            .set(&DataKey::Depositor(token_id), depositor);

        let total: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDeposits)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalDeposits, &total.saturating_add(1));

        DepositEvent {
            depositor: depositor.clone(),
            token_id,
            pool_size: items.len(),
            minted,
        }
        .publish(env);

        Ok(())
    }

    /// Take a token back out. Only the original depositor may do this.
    pub fn withdraw(env: Env, to: Address, token_id: u32) -> Result<(), Error> {
        to.require_auth();

        let collection: Address = env
            .storage()
            .instance()
            .get(&DataKey::Collection)
            .ok_or(Error::CollectionNotSet)?;

        let depositor: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Depositor(token_id))
            .ok_or(Error::NotInPool)?;
        if depositor != to {
            return Err(Error::NotDepositor);
        }

        // Hand the token back through the collection before dropping the index
        // entry, so a rejected transfer leaves the pool's view intact.
        CollectionClient::new(&env, &collection).transfer_from_pool(
            &env.current_contract_address(),
            &to,
            &token_id,
        );

        let items = Self::item_ids(&env);
        let mut kept = Vec::new(&env);
        for id in items.iter() {
            if id != token_id {
                kept.push_back(id);
            }
        }
        env.storage().persistent().set(&DataKey::Items, &kept);
        env.storage()
            .persistent()
            .remove(&DataKey::Depositor(token_id));

        WithdrawEvent {
            to,
            token_id,
            pool_size: kept.len(),
        }
        .publish(&env);

        Ok(())
    }

    fn item_ids(env: &Env) -> Vec<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::Items)
            .unwrap_or_else(|| Vec::new(env))
    }

    // --- reads --------------------------------------------------------------

    pub fn items(env: Env) -> Vec<u32> {
        Self::item_ids(&env)
    }

    pub fn size(env: Env) -> u32 {
        Self::item_ids(&env).len()
    }

    pub fn contains(env: Env, token_id: u32) -> bool {
        Self::item_ids(&env).contains(token_id)
    }

    pub fn depositor_of(env: Env, token_id: u32) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Depositor(token_id))
    }

    pub fn total_deposits(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TotalDeposits)
            .unwrap_or(0)
    }

    pub fn collection(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Collection)
    }

    pub fn closed(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Closed)
            .unwrap_or(false)
    }

    pub fn max_size(_env: Env) -> u32 {
        MAX_POOL_SIZE
    }

    // --- admin --------------------------------------------------------------

    pub fn set_collection(env: Env, caller: Address, collection: Address) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;
        env.storage()
            .instance()
            .set(&DataKey::Collection, &collection);
        Ok(())
    }

    pub fn set_closed(env: Env, caller: Address, value: bool) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;
        env.storage().instance().set(&DataKey::Closed, &value);
        Ok(())
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if *caller != admin {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }
}

mod test;
