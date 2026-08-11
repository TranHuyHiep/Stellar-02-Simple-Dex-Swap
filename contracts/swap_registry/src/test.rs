#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Env, IntoVal, String as SString,
};

fn setup() -> (Env, SwapRegistryClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(SwapRegistry, ());
    let client = SwapRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

#[test]
fn initialize_sets_defaults() {
    let (_env, client, _admin) = setup();
    assert_eq!(client.total_swaps(), 0);
    assert_eq!(client.max_slippage_bps(), 1_000);
    assert!(!client.paused());
}

#[test]
fn initialize_twice_is_rejected() {
    let (env, client, _admin) = setup();
    let other = Address::generate(&env);
    let err = client.try_initialize(&other).unwrap_err().unwrap();
    assert_eq!(err, Error::AlreadyInitialized);
}

#[test]
fn records_a_valid_swap_and_emits_event() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let xlm = SString::from_str(&env, "XLM");
    let usdc = SString::from_str(&env, "USDC");

    // 100 XLM in, min_out 95 -> within the 10% slippage bound.
    let total = client.record_swap(&user, &xlm, &usdc, &100_0000000, &95_0000000);
    assert_eq!(total, 1);

    // `events().all()` only reports the most recent invocation, so assert on
    // the swap event before making any further contract calls.
    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let (emitting_contract, topics, _data) = events.get(0).unwrap();
    assert_eq!(emitting_contract, client.address);
    // Topics are ["swap", user] -> the prefix symbol plus the #[topic] field.
    assert_eq!(topics.len(), 2);
    let topic_user: Address = topics.get(1).unwrap().into_val(&env);
    assert_eq!(topic_user, user, "second topic should be the swapping user");

    assert_eq!(client.total_swaps(), 1);
    assert_eq!(client.user_swaps(&user), 1);

    let history = client.history(&user);
    assert_eq!(history.len(), 1);
    let rec = history.get(0).unwrap();
    assert_eq!(rec.amount_in, 100_0000000);
    assert_eq!(rec.min_out, 95_0000000);
    assert_eq!(rec.user, user);
}

// --- Error type 1 --------------------------------------------------------
#[test]
fn zero_amount_is_invalid() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let xlm = SString::from_str(&env, "XLM");
    let usdc = SString::from_str(&env, "USDC");

    let err = client
        .try_record_swap(&user, &xlm, &usdc, &0, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidAmount);
}

#[test]
fn negative_amount_is_invalid() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let xlm = SString::from_str(&env, "XLM");
    let usdc = SString::from_str(&env, "USDC");

    let err = client
        .try_record_swap(&user, &xlm, &usdc, &-5, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidAmount);
}

// --- Error type 2 --------------------------------------------------------
#[test]
fn identical_assets_are_rejected() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let xlm = SString::from_str(&env, "XLM");

    let err = client
        .try_record_swap(&user, &xlm, &xlm, &100_0000000, &95_0000000)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::IdenticalAssets);
}

// --- Error type 3 --------------------------------------------------------
#[test]
fn min_out_below_slippage_floor_is_rejected() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let xlm = SString::from_str(&env, "XLM");
    let usdc = SString::from_str(&env, "USDC");

    // 100 in but only 50 out demanded => 50% slippage, beyond the 10% cap.
    let err = client
        .try_record_swap(&user, &xlm, &usdc, &100_0000000, &50_0000000)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::SlippageTooHigh);
}

#[test]
fn zero_min_out_is_rejected_as_unprotected() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let xlm = SString::from_str(&env, "XLM");
    let usdc = SString::from_str(&env, "USDC");

    let err = client
        .try_record_swap(&user, &xlm, &usdc, &100_0000000, &0)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::SlippageTooHigh);
}

#[test]
fn exact_slippage_floor_is_accepted() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let xlm = SString::from_str(&env, "XLM");
    let usdc = SString::from_str(&env, "USDC");

    // Exactly 90% of amount_in is the boundary and must pass.
    let total = client.record_swap(&user, &xlm, &usdc, &100_0000000, &90_0000000);
    assert_eq!(total, 1);
}

// --- Pause -------------------------------------------------------------
#[test]
fn paused_registry_rejects_swaps() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let xlm = SString::from_str(&env, "XLM");
    let usdc = SString::from_str(&env, "USDC");

    client.set_paused(&admin, &true);
    assert!(client.paused());

    let err = client
        .try_record_swap(&user, &xlm, &usdc, &100_0000000, &95_0000000)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::RegistryPaused);

    client.set_paused(&admin, &false);
    assert_eq!(client.record_swap(&user, &xlm, &usdc, &100_0000000, &95_0000000), 1);
}

// --- Error type 4: amount ceiling ---------------------------------------
#[test]
fn amount_above_ceiling_is_rejected() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let xlm = SString::from_str(&env, "XLM");
    let usdc = SString::from_str(&env, "USDC");

    let too_big = MAX_AMOUNT + 1;
    let err = client
        .try_record_swap(&user, &xlm, &usdc, &too_big, &(too_big * 95 / 100))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::AmountTooLarge);
}

#[test]
fn amount_at_ceiling_is_accepted() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let xlm = SString::from_str(&env, "XLM");
    let usdc = SString::from_str(&env, "USDC");

    // The boundary itself must pass.
    let total = client.record_swap(&user, &xlm, &usdc, &MAX_AMOUNT, &(MAX_AMOUNT * 95 / 100));
    assert_eq!(total, 1);
}

// --- Error type 5: asset code shape -------------------------------------
#[test]
fn empty_asset_code_is_rejected() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let empty = SString::from_str(&env, "");
    let usdc = SString::from_str(&env, "USDC");

    let err = client
        .try_record_swap(&user, &empty, &usdc, &100_0000000, &95_0000000)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidAsset);
}

#[test]
fn overlong_asset_code_is_rejected() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let xlm = SString::from_str(&env, "XLM");
    // 13 characters, one past the Stellar maximum.
    let overlong = SString::from_str(&env, "ABCDEFGHIJKLM");

    let err = client
        .try_record_swap(&user, &xlm, &overlong, &100_0000000, &95_0000000)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidAsset);
}

#[test]
fn twelve_character_asset_code_is_accepted() {
    let (env, client, _admin) = setup();
    let user = Address::generate(&env);
    let xlm = SString::from_str(&env, "XLM");
    let max_len = SString::from_str(&env, "ABCDEFGHIJKL");

    let total = client.record_swap(&user, &xlm, &max_len, &100_0000000, &95_0000000);
    assert_eq!(total, 1);
}

// --- Error type 6: admin-only access ------------------------------------
#[test]
fn non_admin_cannot_pause() {
    let (env, client, _admin) = setup();
    let intruder = Address::generate(&env);

    let err = client
        .try_set_paused(&intruder, &true)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Unauthorized);
    assert!(!client.paused(), "registry must stay unpaused");
}

#[test]
fn admin_can_pause() {
    let (_env, client, admin) = setup();
    client.set_paused(&admin, &true);
    assert!(client.paused());
}

#[test]
fn history_is_capped_and_per_user() {
    let (env, client, _admin) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let xlm = SString::from_str(&env, "XLM");
    let usdc = SString::from_str(&env, "USDC");

    for _ in 0..(HISTORY_LIMIT + 5) {
        client.record_swap(&a, &xlm, &usdc, &10_0000000, &10_0000000);
    }
    client.record_swap(&b, &xlm, &usdc, &10_0000000, &10_0000000);

    assert_eq!(client.history(&a).len(), HISTORY_LIMIT);
    assert_eq!(client.user_swaps(&a), HISTORY_LIMIT + 5);
    assert_eq!(client.history(&b).len(), 1);
    assert_eq!(client.user_swaps(&b), 1);
    assert_eq!(client.total_swaps(), HISTORY_LIMIT + 6);
}
