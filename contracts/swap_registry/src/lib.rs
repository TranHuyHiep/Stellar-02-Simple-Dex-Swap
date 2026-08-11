#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, String, Vec,
};

/// Maximum slippage the registry will ever accept, in basis points (10%).
const MAX_SLIPPAGE_BPS: u32 = 1_000;
/// Cap on how many recent swaps we retain per user.
const HISTORY_LIMIT: u32 = 20;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The contract has not been initialised yet, or is being initialised twice.
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// A swap was submitted with a non-positive amount.
    InvalidAmount = 3,
    /// `min_out` implies a slippage tolerance beyond MAX_SLIPPAGE_BPS,
    /// or is not reachable given `amount`.
    SlippageTooHigh = 4,
    /// Selling and buying the same asset is a no-op and rejected.
    IdenticalAssets = 5,
    /// The registry is paused by its admin.
    RegistryPaused = 6,
}

/// Emitted for every accepted swap. The frontend streams these to build its
/// live activity feed.
#[contractevent(topics = ["swap"], data_format = "map")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapEvent {
    #[topic]
    pub user: Address,
    pub sell_asset: String,
    pub buy_asset: String,
    pub amount_in: i128,
    pub min_out: i128,
    pub swap_index: u32,
}

/// Emitted when the admin flips the pause switch.
#[contractevent(topics = ["paused"], data_format = "map")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PausedEvent {
    #[topic]
    pub admin: Address,
    pub value: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapRecord {
    pub user: Address,
    pub sell_asset: String,
    pub buy_asset: String,
    pub amount_in: i128,
    pub min_out: i128,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Paused,
    TotalSwaps,
    UserCount(Address),
    History(Address),
}

#[contract]
pub struct SwapRegistry;

#[contractimpl]
impl SwapRegistry {
    /// Set the admin. Must be called once after deployment.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::TotalSwaps, &0u32);
        Ok(())
    }

    /// Validate and record a swap the frontend is about to submit to the DEX.
    ///
    /// This is the function the swap UI calls before building its
    /// path-payment: it enforces the registry's invariants, bumps counters and
    /// emits a `swap` event that the frontend streams back in real time.
    pub fn record_swap(
        env: Env,
        user: Address,
        sell_asset: String,
        buy_asset: String,
        amount_in: i128,
        min_out: i128,
    ) -> Result<u32, Error> {
        // The caller must prove they control `user`.
        user.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        let _ = admin;

        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(Error::RegistryPaused);
        }

        // --- Error type 1: amount validation -------------------------------
        if amount_in <= 0 || min_out < 0 {
            return Err(Error::InvalidAmount);
        }

        // --- Error type 2: identical assets --------------------------------
        if sell_asset == buy_asset {
            return Err(Error::IdenticalAssets);
        }

        // --- Error type 3: slippage bound ----------------------------------
        // `min_out` must be at least (100% - MAX_SLIPPAGE_BPS) of `amount_in`
        // when expressed in the same 7-decimal stroop scale. A min_out of 0
        // means "no protection", which the registry refuses to record.
        if min_out == 0 {
            return Err(Error::SlippageTooHigh);
        }
        let floor = amount_in
            .checked_mul((10_000 - MAX_SLIPPAGE_BPS) as i128)
            .ok_or(Error::InvalidAmount)?
            / 10_000;
        if min_out < floor {
            return Err(Error::SlippageTooHigh);
        }

        // --- Persist -------------------------------------------------------
        let total: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSwaps)
            .unwrap_or(0);
        let total = total.saturating_add(1);
        env.storage().instance().set(&DataKey::TotalSwaps, &total);

        let ucount: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserCount(user.clone()))
            .unwrap_or(0);
        let ucount = ucount.saturating_add(1);
        env.storage()
            .persistent()
            .set(&DataKey::UserCount(user.clone()), &ucount);

        let record = SwapRecord {
            user: user.clone(),
            sell_asset: sell_asset.clone(),
            buy_asset: buy_asset.clone(),
            amount_in,
            min_out,
            ledger: env.ledger().sequence(),
        };

        let hkey = DataKey::History(user.clone());
        let mut history: Vec<SwapRecord> = env
            .storage()
            .persistent()
            .get(&hkey)
            .unwrap_or_else(|| Vec::new(&env));
        if history.len() >= HISTORY_LIMIT {
            history.remove(0);
        }
        history.push_back(record);
        env.storage().persistent().set(&hkey, &history);

        // --- Emit the event the UI streams ---------------------------------
        SwapEvent {
            user,
            sell_asset,
            buy_asset,
            amount_in,
            min_out,
            swap_index: total,
        }
        .publish(&env);

        Ok(total)
    }

    pub fn total_swaps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSwaps)
            .unwrap_or(0)
    }

    pub fn user_swaps(env: Env, user: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::UserCount(user))
            .unwrap_or(0)
    }

    pub fn history(env: Env, user: Address) -> Vec<SwapRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::History(user))
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn max_slippage_bps(_env: Env) -> u32 {
        MAX_SLIPPAGE_BPS
    }

    pub fn paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Admin-only pause switch, used to demonstrate the RegistryPaused error.
    pub fn set_paused(env: Env, value: bool) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &value);
        PausedEvent { admin, value }.publish(&env);
        Ok(())
    }
}

mod test;
