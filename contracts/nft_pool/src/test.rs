#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Env, String as SString,
};

const CID: &str = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

struct Fixture<'a> {
    env: Env,
    pool: NftPoolClient<'a>,
    nft: nft_collection::NftCollectionClient<'a>,
    admin: Address,
}

/// Register both contracts and link them in both directions, as the deploy
/// script does on-chain.
fn setup() -> Fixture<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let nft_id = env.register(nft_collection::NftCollection, ());
    let nft = nft_collection::NftCollectionClient::new(&env, &nft_id);
    nft.initialize(&admin);

    let pool_id = env.register(NftPool, ());
    let pool = NftPoolClient::new(&env, &pool_id);
    pool.initialize(&admin);

    nft.set_pool(&admin, &pool_id);
    pool.set_collection(&admin, &nft_id);

    Fixture {
        env,
        pool,
        nft,
        admin,
    }
}

fn meta(env: &Env) -> (SString, SString, SString) {
    (
        SString::from_str(env, "Pooled #1"),
        SString::from_str(env, "held by the pool"),
        SString::from_str(env, CID),
    )
}

#[test]
fn initialize_sets_defaults() {
    let f = setup();
    assert_eq!(f.pool.size(), 0);
    assert_eq!(f.pool.total_deposits(), 0);
    assert!(!f.pool.closed());
    assert!(f.pool.collection().is_some());
    assert_eq!(f.pool.max_size(), 500);
}

#[test]
fn initialize_twice_is_rejected() {
    let f = setup();
    let err = f.pool.try_initialize(&f.admin).unwrap_err().unwrap();
    assert_eq!(err, Error::AlreadyInitialized);
}

#[test]
fn the_two_contracts_are_linked() {
    let f = setup();
    assert_eq!(f.pool.collection(), Some(f.nft.address.clone()));
    assert_eq!(f.nft.pool(), Some(f.pool.address.clone()));
}

// --- mint straight into the pool ------------------------------------------

#[test]
fn mint_to_pool_lands_in_the_pool_and_is_indexed() {
    let f = setup();
    let creator = Address::generate(&f.env);
    let (n, d, c) = meta(&f.env);

    let id = f.nft.mint_to_pool(&creator, &n, &d, &c);

    // The collection says the pool owns it...
    assert_eq!(f.nft.owner_of(&id), f.pool.address);
    // ...and the pool's own index agrees, via the on_deposit callback.
    assert!(f.pool.contains(&id));
    assert_eq!(f.pool.size(), 1);
    assert_eq!(f.pool.depositor_of(&id), Some(creator.clone()));
    assert_eq!(f.pool.total_deposits(), 1);
    // The creator holds nothing: the token never passed through their balance.
    assert_eq!(f.nft.balance_of(&creator), 0);
}

#[test]
fn mint_to_pool_records_the_creator_as_depositor() {
    let f = setup();
    let creator = Address::generate(&f.env);
    let (n, d, c) = meta(&f.env);

    let id = f.nft.mint_to_pool(&creator, &n, &d, &c);
    let m = f.nft.metadata_of(&id);
    assert_eq!(m.creator, creator, "metadata credits the creator");
    assert_eq!(m.owner, f.pool.address, "but the pool owns it");
}

#[test]
fn mint_to_pool_emits_events_from_both_contracts() {
    let f = setup();
    let creator = Address::generate(&f.env);
    let (n, d, c) = meta(&f.env);

    f.nft.mint_to_pool(&creator, &n, &d, &c);

    let events = f.env.events().all();
    // The collection's `mint` and the pool's `deposit`, from one invocation.
    assert!(
        events.len() >= 2,
        "expected events from both contracts, got {}",
        events.len()
    );
    let from_pool = events.iter().any(|(a, _, _)| a == f.pool.address);
    let from_nft = events.iter().any(|(a, _, _)| a == f.nft.address);
    assert!(from_pool, "pool should have emitted a deposit event");
    assert!(from_nft, "collection should have emitted a mint event");
}

// --- add an existing token ------------------------------------------------

#[test]
fn add_pulls_an_owned_token_into_the_pool() {
    let f = setup();
    let owner = Address::generate(&f.env);
    let (n, d, c) = meta(&f.env);

    let id = f.nft.mint(&owner, &n, &d, &c);
    assert_eq!(f.nft.balance_of(&owner), 1);

    f.pool.add(&owner, &id);

    assert_eq!(f.nft.owner_of(&id), f.pool.address);
    assert_eq!(f.nft.balance_of(&owner), 0);
    assert!(f.pool.contains(&id));
    assert_eq!(f.pool.depositor_of(&id), Some(owner));
}

#[test]
fn adding_the_same_token_twice_is_rejected() {
    let f = setup();
    let owner = Address::generate(&f.env);
    let (n, d, c) = meta(&f.env);

    let id = f.nft.mint(&owner, &n, &d, &c);
    f.pool.add(&owner, &id);

    let err = f.pool.try_add(&owner, &id).unwrap_err().unwrap();
    assert_eq!(err, Error::AlreadyInPool);
}

#[test]
fn adding_a_token_you_do_not_own_fails_in_the_collection() {
    let f = setup();
    let owner = Address::generate(&f.env);
    let impostor = Address::generate(&f.env);
    let (n, d, c) = meta(&f.env);

    let id = f.nft.mint(&owner, &n, &d, &c);

    // The collection rejects the transfer, so the pool never indexes it.
    assert!(f.pool.try_add(&impostor, &id).is_err());
    assert!(!f.pool.contains(&id));
    assert_eq!(f.nft.owner_of(&id), owner);
}

// --- withdraw -------------------------------------------------------------

#[test]
fn depositor_can_withdraw() {
    let f = setup();
    let owner = Address::generate(&f.env);
    let (n, d, c) = meta(&f.env);

    let id = f.nft.mint(&owner, &n, &d, &c);
    f.pool.add(&owner, &id);
    f.pool.withdraw(&owner, &id);

    assert_eq!(f.nft.owner_of(&id), owner);
    assert!(!f.pool.contains(&id));
    assert_eq!(f.pool.size(), 0);
    assert_eq!(f.pool.depositor_of(&id), None);
    // The lifetime counter does not go down.
    assert_eq!(f.pool.total_deposits(), 1);
}

#[test]
fn a_non_depositor_cannot_withdraw() {
    let f = setup();
    let owner = Address::generate(&f.env);
    let thief = Address::generate(&f.env);
    let (n, d, c) = meta(&f.env);

    let id = f.nft.mint(&owner, &n, &d, &c);
    f.pool.add(&owner, &id);

    let err = f.pool.try_withdraw(&thief, &id).unwrap_err().unwrap();
    assert_eq!(err, Error::NotDepositor);
    assert_eq!(f.nft.owner_of(&id), f.pool.address, "token stays put");
}

#[test]
fn withdrawing_a_token_not_in_the_pool_is_rejected() {
    let f = setup();
    let user = Address::generate(&f.env);

    let err = f.pool.try_withdraw(&user, &999).unwrap_err().unwrap();
    assert_eq!(err, Error::NotInPool);
}

#[test]
fn a_minted_token_can_be_withdrawn_by_its_creator() {
    let f = setup();
    let creator = Address::generate(&f.env);
    let (n, d, c) = meta(&f.env);

    let id = f.nft.mint_to_pool(&creator, &n, &d, &c);
    f.pool.withdraw(&creator, &id);

    assert_eq!(f.nft.owner_of(&id), creator);
    assert_eq!(f.pool.size(), 0);
}

// --- authorisation --------------------------------------------------------

#[test]
fn on_deposit_rejects_a_caller_that_is_not_the_collection() {
    let f = setup();
    let impostor = Address::generate(&f.env);
    let user = Address::generate(&f.env);

    // Without this check, anyone could poison the pool's index with tokens the
    // pool does not own.
    let err = f
        .pool
        .try_on_deposit(&impostor, &1, &user)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Unauthorized);
    assert_eq!(f.pool.size(), 0);
}

#[test]
fn only_admin_can_set_the_collection() {
    let f = setup();
    let impostor = Address::generate(&f.env);
    let other = Address::generate(&f.env);

    let err = f
        .pool
        .try_set_collection(&impostor, &other)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Unauthorized);
}

#[test]
fn a_closed_pool_rejects_deposits() {
    let f = setup();
    let owner = Address::generate(&f.env);
    let (n, d, c) = meta(&f.env);
    let id = f.nft.mint(&owner, &n, &d, &c);

    f.pool.set_closed(&f.admin, &true);
    assert!(f.pool.closed());

    assert!(f.pool.try_add(&owner, &id).is_err());
    assert_eq!(f.pool.size(), 0);

    f.pool.set_closed(&f.admin, &false);
    f.pool.add(&owner, &id);
    assert_eq!(f.pool.size(), 1);
}

#[test]
fn pool_holds_tokens_from_several_depositors() {
    let f = setup();
    let a = Address::generate(&f.env);
    let b = Address::generate(&f.env);
    let (n, d, c) = meta(&f.env);

    let id_a = f.nft.mint(&a, &n, &d, &c);
    let id_b = f.nft.mint(&b, &n, &d, &c);
    f.pool.add(&a, &id_a);
    f.pool.add(&b, &id_b);

    assert_eq!(f.pool.size(), 2);
    assert_eq!(f.pool.depositor_of(&id_a), Some(a.clone()));
    assert_eq!(f.pool.depositor_of(&id_b), Some(b));
    // Each may only take their own back.
    assert!(f.pool.try_withdraw(&a, &id_b).is_err());
    f.pool.withdraw(&a, &id_a);
    assert_eq!(f.pool.size(), 1);
}
