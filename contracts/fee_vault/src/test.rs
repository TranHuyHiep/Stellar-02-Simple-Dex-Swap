#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Env, String as SString};

struct Fixture<'a> {
    env: Env,
    client: FeeVaultClient<'a>,
    admin: Address,
    registry: Address,
}

fn setup() -> Fixture<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(FeeVault, ());
    let client = FeeVaultClient::new(&env, &id);
    let admin = Address::generate(&env);
    // 30 bps base, 10 bps for the discounted tier.
    client.initialize(&admin, &30, &10);
    let registry = Address::generate(&env);
    client.set_registry(&registry);
    Fixture {
        env,
        client,
        admin,
        registry,
    }
}

#[test]
fn initialize_sets_fee_schedule() {
    let f = setup();
    assert_eq!(f.client.fees(), (30, 10));
    assert_eq!(f.client.total_volume(), 0);
    assert_eq!(f.client.total_fees(), 0);
    assert_eq!(f.client.registry(), Some(f.registry.clone()));
    assert_eq!(f.client.max_fee_bps(), 500);
}

#[test]
fn initialize_twice_is_rejected() {
    let f = setup();
    let err = f
        .client
        .try_initialize(&f.admin, &30, &10)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::AlreadyInitialized);
}

#[test]
fn fee_above_ceiling_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(FeeVault, ());
    let client = FeeVaultClient::new(&env, &id);
    let admin = Address::generate(&env);

    let err = client
        .try_initialize(&admin, &501, &10)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::FeeTooHigh);
}

#[test]
fn set_fees_enforces_ceiling() {
    let f = setup();
    let err = f.client.try_set_fees(&600, &10).unwrap_err().unwrap();
    assert_eq!(err, Error::FeeTooHigh);
    // A valid update goes through.
    f.client.set_fees(&40, &20);
    assert_eq!(f.client.fees(), (40, 20));
}

#[test]
fn quote_uses_base_fee_before_the_tier() {
    let f = setup();
    let user = Address::generate(&f.env);
    // 100 XLM at 30 bps -> 0.3 XLM.
    let q = f.client.quote_fee(&user, &100_0000000);
    assert_eq!(q.bps, 30);
    assert_eq!(q.amount, 3000000);
    assert!(!q.discounted);
}

#[test]
fn quote_rejects_non_positive_amount() {
    let f = setup();
    let user = Address::generate(&f.env);
    let err = f.client.try_quote_fee(&user, &0).unwrap_err().unwrap();
    assert_eq!(err, Error::InvalidAmount);
}

#[test]
fn accrue_tracks_volume_and_fees() {
    let f = setup();
    let user = Address::generate(&f.env);
    let xlm = SString::from_str(&f.env, "XLM");

    let vol = f.client.accrue(&f.registry, &user, &100_0000000, &xlm);
    assert_eq!(vol, 100_0000000);
    assert_eq!(f.client.volume_of(&user), 100_0000000);
    assert_eq!(f.client.total_volume(), 100_0000000);
    assert_eq!(f.client.total_fees(), 3000000);
}

#[test]
fn crossing_the_threshold_unlocks_the_discount() {
    let f = setup();
    let user = Address::generate(&f.env);
    let xlm = SString::from_str(&f.env, "XLM");

    // Push volume to exactly the threshold.
    f.client
        .accrue(&f.registry, &user, &f.client.tier_threshold(), &xlm);

    let q = f.client.quote_fee(&user, &100_0000000);
    assert!(q.discounted, "volume at threshold should qualify");
    assert_eq!(q.bps, 10);
    assert_eq!(q.amount, 1000000);
}

#[test]
fn only_the_registry_may_accrue() {
    let f = setup();
    let user = Address::generate(&f.env);
    let impostor = Address::generate(&f.env);
    let xlm = SString::from_str(&f.env, "XLM");

    let err = f
        .client
        .try_accrue(&impostor, &user, &100_0000000, &xlm)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::UnauthorizedCaller);
}

#[test]
fn accrue_rejects_non_positive_amount() {
    let f = setup();
    let user = Address::generate(&f.env);
    let xlm = SString::from_str(&f.env, "XLM");

    let err = f
        .client
        .try_accrue(&f.registry, &user, &0, &xlm)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidAmount);
}

#[test]
fn volume_is_tracked_per_account() {
    let f = setup();
    let a = Address::generate(&f.env);
    let b = Address::generate(&f.env);
    let xlm = SString::from_str(&f.env, "XLM");

    f.client.accrue(&f.registry, &a, &50_0000000, &xlm);
    f.client.accrue(&f.registry, &b, &20_0000000, &xlm);

    assert_eq!(f.client.volume_of(&a), 50_0000000);
    assert_eq!(f.client.volume_of(&b), 20_0000000);
    assert_eq!(f.client.total_volume(), 70_0000000);
}
