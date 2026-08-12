#![no_std]
//! A minimal non-fungible token collection.
//!
//! Each token carries a name, a description and an IPFS content identifier for
//! its image. Tokens can be minted directly to an account, or minted straight
//! into an `nft_pool` contract — in which case this contract notifies the pool
//! through a cross-contract call so the pool's index stays in step with
//! ownership.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, Address,
    Env, String, Vec,
};

/// Stellar-style bounds, chosen so a token's metadata cannot bloat the ledger.
const MAX_NAME_LEN: u32 = 64;
const MAX_DESC_LEN: u32 = 256;
/// A CIDv0 is 46 chars, CIDv1 base32 is 59; allow room for longer codecs.
const MAX_CID_LEN: u32 = 128;
const MIN_CID_LEN: u32 = 10;
/// Cap on how many token ids we track per owner, keeping reads bounded.
const MAX_TOKENS_PER_OWNER: u32 = 200;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// A non-admin called an admin-only function.
    Unauthorized = 3,
    /// The token id does not exist.
    TokenNotFound = 4,
    /// `name` was empty or longer than MAX_NAME_LEN.
    InvalidName = 5,
    /// `description` was longer than MAX_DESC_LEN.
    InvalidDescription = 6,
    /// `cid` was not a plausible IPFS content identifier.
    InvalidCid = 7,
    /// The caller does not own the token they tried to move.
    NotOwner = 8,
    /// Minting into a pool was requested but no pool is linked.
    PoolNotSet = 9,
    /// The owner already holds MAX_TOKENS_PER_OWNER tokens.
    OwnerTokenLimit = 10,
    /// Minting is paused by the admin.
    MintingPaused = 11,
}

/// Emitted for every mint. The UI streams these into its activity feed.
#[contractevent(topics = ["mint"], data_format = "map")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MintEvent {
    #[topic]
    pub to: Address,
    pub token_id: u32,
    pub name: String,
    pub cid: String,
    /// True when the token was minted straight into the pool.
    pub to_pool: bool,
}

#[contractevent(topics = ["transfer"], data_format = "map")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferEvent {
    #[topic]
    pub from: Address,
    pub to: Address,
    pub token_id: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenMeta {
    pub token_id: u32,
    pub owner: Address,
    pub name: String,
    pub description: String,
    /// Bare IPFS CID, without the `ipfs://` scheme.
    pub cid: String,
    pub creator: Address,
    pub ledger: u32,
}

/// The slice of `nft_pool` this contract calls into.
#[contractclient(name = "NftPoolClient")]
pub trait NftPoolInterface {
    fn on_deposit(env: Env, caller: Address, token_id: u32, depositor: Address);
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Paused,
    NextId,
    TotalSupply,
    Token(u32),
    OwnerTokens(Address),
    /// The linked `nft_pool` contract, if any.
    Pool,
}

#[contract]
pub struct NftCollection;

#[contractimpl]
impl NftCollection {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::NextId, &1u32);
        env.storage().instance().set(&DataKey::TotalSupply, &0u32);
        Ok(())
    }

    /// Mint a token to `to`. Anyone may mint to themselves; `to` must authorise.
    pub fn mint(
        env: Env,
        to: Address,
        name: String,
        description: String,
        cid: String,
    ) -> Result<u32, Error> {
        to.require_auth();
        Self::mint_internal(&env, &to, &to, name, description, cid, false)
    }

    /// Mint a token whose owner is the linked pool contract.
    ///
    /// The token never touches the depositor's balance: it is created already
    /// owned by the pool, and the pool is told about it in the same invocation
    /// so its index cannot drift from actual ownership.
    pub fn mint_to_pool(
        env: Env,
        creator: Address,
        name: String,
        description: String,
        cid: String,
    ) -> Result<u32, Error> {
        creator.require_auth();

        let pool: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::PoolNotSet)?;

        let id = Self::mint_internal(&env, &pool, &creator, name, description, cid, true)?;

        // Cross-contract: keep the pool's own index in step. The pool checks
        // that `caller` is this collection.
        NftPoolClient::new(&env, &pool).on_deposit(&env.current_contract_address(), &id, &creator);

        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    fn mint_internal(
        env: &Env,
        owner: &Address,
        creator: &Address,
        name: String,
        description: String,
        cid: String,
        to_pool: bool,
    ) -> Result<u32, Error> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(Error::MintingPaused);
        }

        // --- metadata validation ------------------------------------------
        let nlen = name.len();
        if nlen == 0 || nlen > MAX_NAME_LEN {
            return Err(Error::InvalidName);
        }
        if description.len() > MAX_DESC_LEN {
            return Err(Error::InvalidDescription);
        }
        if !(MIN_CID_LEN..=MAX_CID_LEN).contains(&cid.len()) {
            return Err(Error::InvalidCid);
        }

        let id: u32 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);

        let mut owned = Self::owned_ids(env, owner);
        if owned.len() >= MAX_TOKENS_PER_OWNER {
            return Err(Error::OwnerTokenLimit);
        }
        owned.push_back(id);
        env.storage()
            .persistent()
            .set(&DataKey::OwnerTokens(owner.clone()), &owned);

        let meta = TokenMeta {
            token_id: id,
            owner: owner.clone(),
            name: name.clone(),
            description,
            cid: cid.clone(),
            creator: creator.clone(),
            ledger: env.ledger().sequence(),
        };
        env.storage().persistent().set(&DataKey::Token(id), &meta);

        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        let supply: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &supply.saturating_add(1));

        MintEvent {
            to: owner.clone(),
            token_id: id,
            name,
            cid,
            to_pool,
        }
        .publish(env);

        Ok(id)
    }

    /// Move a token. `from` must own it and authorise the call.
    pub fn transfer(env: Env, from: Address, to: Address, token_id: u32) -> Result<(), Error> {
        from.require_auth();
        Self::transfer_internal(&env, &from, &to, token_id)
    }

    /// Transfer used by the pool to pull a token in, or push it back out.
    ///
    /// The pool is the caller and must authorise; it may only move a token that
    /// the token's owner has separately approved by authorising the pool's own
    /// entry point. This keeps the collection from having to know about the
    /// pool's internal rules.
    pub fn transfer_from_pool(
        env: Env,
        pool: Address,
        to: Address,
        token_id: u32,
    ) -> Result<(), Error> {
        pool.require_auth();

        let linked: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::PoolNotSet)?;
        if pool != linked {
            return Err(Error::Unauthorized);
        }

        Self::transfer_internal(&env, &pool, &to, token_id)
    }

    fn transfer_internal(
        env: &Env,
        from: &Address,
        to: &Address,
        token_id: u32,
    ) -> Result<(), Error> {
        let mut meta: TokenMeta = env
            .storage()
            .persistent()
            .get(&DataKey::Token(token_id))
            .ok_or(Error::TokenNotFound)?;

        if meta.owner != *from {
            return Err(Error::NotOwner);
        }

        // Remove from the sender's index.
        let from_ids = Self::owned_ids(env, from);
        let mut kept = Vec::new(env);
        for id in from_ids.iter() {
            if id != token_id {
                kept.push_back(id);
            }
        }
        env.storage()
            .persistent()
            .set(&DataKey::OwnerTokens(from.clone()), &kept);

        // Add to the recipient's index.
        let mut to_ids = Self::owned_ids(env, to);
        if to_ids.len() >= MAX_TOKENS_PER_OWNER {
            return Err(Error::OwnerTokenLimit);
        }
        to_ids.push_back(token_id);
        env.storage()
            .persistent()
            .set(&DataKey::OwnerTokens(to.clone()), &to_ids);

        meta.owner = to.clone();
        env.storage()
            .persistent()
            .set(&DataKey::Token(token_id), &meta);

        TransferEvent {
            from: from.clone(),
            to: to.clone(),
            token_id,
        }
        .publish(env);

        Ok(())
    }

    fn owned_ids(env: &Env, owner: &Address) -> Vec<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::OwnerTokens(owner.clone()))
            .unwrap_or_else(|| Vec::new(env))
    }

    // --- reads --------------------------------------------------------------

    pub fn owner_of(env: Env, token_id: u32) -> Result<Address, Error> {
        let meta: TokenMeta = env
            .storage()
            .persistent()
            .get(&DataKey::Token(token_id))
            .ok_or(Error::TokenNotFound)?;
        Ok(meta.owner)
    }

    pub fn metadata_of(env: Env, token_id: u32) -> Result<TokenMeta, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Token(token_id))
            .ok_or(Error::TokenNotFound)
    }

    pub fn tokens_of(env: Env, owner: Address) -> Vec<u32> {
        Self::owned_ids(&env, &owner)
    }

    pub fn balance_of(env: Env, owner: Address) -> u32 {
        Self::owned_ids(&env, &owner).len()
    }

    pub fn total_supply(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    pub fn pool(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Pool)
    }

    pub fn paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn limits(_env: Env) -> (u32, u32, u32, u32) {
        (
            MAX_NAME_LEN,
            MAX_DESC_LEN,
            MAX_CID_LEN,
            MAX_TOKENS_PER_OWNER,
        )
    }

    // --- admin --------------------------------------------------------------

    pub fn set_pool(env: Env, caller: Address, pool: Address) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;
        env.storage().instance().set(&DataKey::Pool, &pool);
        Ok(())
    }

    pub fn set_paused(env: Env, caller: Address, value: bool) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;
        env.storage().instance().set(&DataKey::Paused, &value);
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
