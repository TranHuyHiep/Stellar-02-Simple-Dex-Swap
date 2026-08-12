#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Env, String as SString,
};

const CID: &str = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

fn setup() -> (Env, NftCollectionClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(NftCollection, ());
    let client = NftCollectionClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

fn meta(env: &Env) -> (SString, SString, SString) {
    (
        SString::from_str(env, "Nebula #1"),
        SString::from_str(env, "A test token"),
        SString::from_str(env, CID),
    )
}

#[test]
fn initialize_sets_defaults() {
    let (_env, client, _admin) = setup();
    assert_eq!(client.total_supply(), 0);
    assert!(!client.paused());
    assert_eq!(client.pool(), None);
    assert_eq!(client.limits(), (64, 256, 128, 200));
}

#[test]
fn initialize_twice_is_rejected() {
    let (env, client, _admin) = setup();
    let other = Address::generate(&env);
    let err = client.try_initialize(&other).unwrap_err().unwrap();
    assert_eq!(err, Error::AlreadyInitialized);
}

#[test]
fn mint_assigns_sequential_ids_and_metadata() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let (n, d, c) = meta(&env);

    let id1 = client.mint(&user, &n, &d, &c);
    assert_eq!(id1, 1);
    let id2 = client.mint(&user, &n, &d, &c);
    assert_eq!(id2, 2);

    let m = client.metadata_of(&id1);
    assert_eq!(m.token_id, 1);
    assert_eq!(m.owner, user);
    assert_eq!(m.creator, user);
    assert_eq!(m.name, n);
    assert_eq!(m.cid, c);

    assert_eq!(client.owner_of(&id1), user);
    assert_eq!(client.balance_of(&user), 2);
    assert_eq!(client.total_supply(), 2);
    assert_eq!(client.tokens_of(&user).len(), 2);
}

#[test]
fn mint_emits_an_event() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let (n, d, c) = meta(&env);

    client.mint(&user, &n, &d, &c);

    let events = env.events().all();
    assert_eq!(events.len(), 1, "one mint event expected");
    let (addr, topics, _) = events.get(0).unwrap();
    assert_eq!(addr, client.address);
    assert_eq!(topics.len(), 2, "topics are [\"mint\", to]");
}

// --- metadata validation --------------------------------------------------

#[test]
fn empty_name_is_rejected() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let (_, d, c) = meta(&env);
    let empty = SString::from_str(&env, "");

    let err = client.try_mint(&user, &empty, &d, &c).unwrap_err().unwrap();
    assert_eq!(err, Error::InvalidName);
}

#[test]
fn overlong_name_is_rejected() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let (_, d, c) = meta(&env);
    // 65 characters, one past MAX_NAME_LEN.
    let long = SString::from_str(
        &env,
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    let err = client.try_mint(&user, &long, &d, &c).unwrap_err().unwrap();
    assert_eq!(err, Error::InvalidName);
}

#[test]
fn short_cid_is_rejected() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let (n, d, _) = meta(&env);
    let bad = SString::from_str(&env, "abc");

    let err = client.try_mint(&user, &n, &d, &bad).unwrap_err().unwrap();
    assert_eq!(err, Error::InvalidCid);
}

#[test]
fn empty_description_is_allowed() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let (n, _, c) = meta(&env);
    let empty = SString::from_str(&env, "");

    // A description is optional; only an over-long one is rejected.
    let id = client.mint(&user, &n, &empty, &c);
    assert_eq!(id, 1);
}

// --- transfers -------------------------------------------------------------

#[test]
fn transfer_moves_ownership_and_indexes() {
    let (env, client, _admin) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let (n, d, c) = meta(&env);

    let id = client.mint(&a, &n, &d, &c);
    client.transfer(&a, &b, &id);

    assert_eq!(client.owner_of(&id), b);
    assert_eq!(client.balance_of(&a), 0);
    assert_eq!(client.balance_of(&b), 1);
    assert_eq!(client.tokens_of(&b).get(0).unwrap(), id);
    // Total supply is unaffected by a move.
    assert_eq!(client.total_supply(), 1);
}

#[test]
fn transferring_someone_elses_token_is_rejected() {
    let (env, client, _admin) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let (n, d, c) = meta(&env);

    let id = client.mint(&a, &n, &d, &c);
    let err = client.try_transfer(&b, &b, &id).unwrap_err().unwrap();
    assert_eq!(err, Error::NotOwner);
}

#[test]
fn transferring_a_missing_token_is_rejected() {
    let (env, client, _admin) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let err = client.try_transfer(&a, &b, &999).unwrap_err().unwrap();
    assert_eq!(err, Error::TokenNotFound);
}

#[test]
fn reading_a_missing_token_is_rejected() {
    let (_env, client, _admin) = setup();
    let err = client.try_metadata_of(&42).unwrap_err().unwrap();
    assert_eq!(err, Error::TokenNotFound);
}

// --- pool linkage ---------------------------------------------------------

#[test]
fn mint_to_pool_without_a_pool_is_rejected() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let (n, d, c) = meta(&env);

    let err = client
        .try_mint_to_pool(&user, &n, &d, &c)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::PoolNotSet);
}

#[test]
fn only_admin_can_set_the_pool() {
    let (env, client, _admin) = setup();
    let impostor = Address::generate(&env);
    let pool = Address::generate(&env);

    let err = client.try_set_pool(&impostor, &pool).unwrap_err().unwrap();
    assert_eq!(err, Error::Unauthorized);
}

#[test]
fn transfer_from_pool_rejects_a_non_pool_caller() {
    let (env, client, admin) = setup();
    let pool = Address::generate(&env);
    let impostor = Address::generate(&env);
    let to = Address::generate(&env);
    client.set_pool(&admin, &pool);

    let err = client
        .try_transfer_from_pool(&impostor, &to, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Unauthorized);
}

// --- pause ----------------------------------------------------------------

#[test]
fn paused_collection_rejects_minting() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let (n, d, c) = meta(&env);

    client.set_paused(&admin, &true);
    assert!(client.paused());

    let err = client.try_mint(&user, &n, &d, &c).unwrap_err().unwrap();
    assert_eq!(err, Error::MintingPaused);

    client.set_paused(&admin, &false);
    assert_eq!(client.mint(&user, &n, &d, &c), 1);
}

#[test]
fn only_admin_can_pause() {
    let (env, client, _admin) = setup();
    let impostor = Address::generate(&env);

    let err = client
        .try_set_paused(&impostor, &true)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Unauthorized);
}

#[test]
fn tokens_are_indexed_per_owner() {
    let (env, client, _admin) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let (n, d, c) = meta(&env);

    client.mint(&a, &n, &d, &c);
    client.mint(&a, &n, &d, &c);
    client.mint(&b, &n, &d, &c);

    assert_eq!(client.tokens_of(&a).len(), 2);
    assert_eq!(client.tokens_of(&b).len(), 1);
    assert_eq!(client.total_supply(), 3);
}
