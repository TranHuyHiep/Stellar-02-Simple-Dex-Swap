#![no_std]
//! Fee policy and volume accounting for the swap registry.
//!
//! This contract owns two things the registry deliberately does not: the fee
//! schedule, and the running volume per account. `swap_registry` reaches it
//! through a cross-contract call on every recorded swap, so the fee policy can
//! change without redeploying the registry.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, String,
};

/// Hard ceiling on the configurable fee, in basis points (5%).
const MAX_FEE_BPS: u32 = 500;
/// Volume above which an account earns the discounted tier: 10,000 units of a
/// 7-decimal asset, expressed in stroops.
const TIER_THRESHOLD: i128 = 100_000_000_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// A fee above MAX_FEE_BPS was proposed.
    FeeTooHigh = 3,
    /// Only the registered registry contract may accrue volume.
    UnauthorizedCaller = 4,
    /// accrue() was called with a non-positive amount.
    InvalidAmount = 5,
}

#[contractevent(topics = ["accrued"], data_format = "map")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccruedEvent {
    #[topic]
    pub user: Address,
    pub amount: i128,
    pub fee: i128,
    pub total_volume: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeQuote {
    /// Fee in basis points applied to this account.
    pub bps: u32,
    /// Absolute fee for the quoted amount, in stroops.
    pub amount: i128,
    /// True when the account qualified for the discounted tier.
    pub discounted: bool,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    /// The only contract permitted to call `accrue`.
    Registry,
    BaseFeeBps,
    DiscountFeeBps,
    Volume(Address),
    TotalVolume,
    TotalFees,
}

#[contract]
pub struct FeeVault;

#[contractimpl]
impl FeeVault {
    pub fn initialize(
        env: Env,
        admin: Address,
        base_fee_bps: u32,
        discount_fee_bps: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        if base_fee_bps > MAX_FEE_BPS || discount_fee_bps > MAX_FEE_BPS {
            return Err(Error::FeeTooHigh);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::BaseFeeBps, &base_fee_bps);
        env.storage()
            .instance()
            .set(&DataKey::DiscountFeeBps, &discount_fee_bps);
        env.storage().instance().set(&DataKey::TotalVolume, &0i128);
        env.storage().instance().set(&DataKey::TotalFees, &0i128);
        Ok(())
    }

    /// Register the registry contract allowed to call `accrue`.
    pub fn set_registry(env: Env, registry: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::Registry, &registry);
        Ok(())
    }

    pub fn set_fees(env: Env, base_fee_bps: u32, discount_fee_bps: u32) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if base_fee_bps > MAX_FEE_BPS || discount_fee_bps > MAX_FEE_BPS {
            return Err(Error::FeeTooHigh);
        }
        env.storage()
            .instance()
            .set(&DataKey::BaseFeeBps, &base_fee_bps);
        env.storage()
            .instance()
            .set(&DataKey::DiscountFeeBps, &discount_fee_bps);
        Ok(())
    }

    /// Pure read: what fee would `user` pay on `amount`?
    ///
    /// The registry calls this during its own `record_swap` so the quote shown
    /// to the user and the quote used on-chain cannot drift apart.
    pub fn quote_fee(env: Env, user: Address, amount: i128) -> Result<FeeQuote, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let base: u32 = env
            .storage()
            .instance()
            .get(&DataKey::BaseFeeBps)
            .ok_or(Error::NotInitialized)?;
        let discount: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DiscountFeeBps)
            .unwrap_or(base);

        let volume: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Volume(user))
            .unwrap_or(0);
        let discounted = volume >= TIER_THRESHOLD;
        let bps = if discounted { discount } else { base };

        let fee = amount
            .checked_mul(bps as i128)
            .ok_or(Error::InvalidAmount)?
            / 10_000;

        Ok(FeeQuote {
            bps,
            amount: fee,
            discounted,
        })
    }

    /// Record swap volume for `user`. Callable only by the registered registry.
    ///
    /// `caller` is the registry's own contract address; it must authorize the
    /// call, which a contract does by invoking this through the SDK client.
    pub fn accrue(
        env: Env,
        caller: Address,
        user: Address,
        amount: i128,
        _asset: String,
    ) -> Result<i128, Error> {
        caller.require_auth();

        let registry: Address = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(Error::NotInitialized)?;
        if caller != registry {
            return Err(Error::UnauthorizedCaller);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let quote = Self::quote_fee(env.clone(), user.clone(), amount)?;

        let vkey = DataKey::Volume(user.clone());
        let volume: i128 = env.storage().persistent().get(&vkey).unwrap_or(0);
        let volume = volume.saturating_add(amount);
        env.storage().persistent().set(&vkey, &volume);

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalVolume)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalVolume, &total.saturating_add(amount));

        let fees: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalFees)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalFees, &fees.saturating_add(quote.amount));

        AccruedEvent {
            user,
            amount,
            fee: quote.amount,
            total_volume: volume,
        }
        .publish(&env);

        Ok(volume)
    }

    pub fn volume_of(env: Env, user: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Volume(user))
            .unwrap_or(0)
    }

    pub fn total_volume(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalVolume)
            .unwrap_or(0)
    }

    pub fn total_fees(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalFees)
            .unwrap_or(0)
    }

    pub fn registry(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Registry)
    }

    pub fn fees(env: Env) -> (u32, u32) {
        (
            env.storage()
                .instance()
                .get(&DataKey::BaseFeeBps)
                .unwrap_or(0),
            env.storage()
                .instance()
                .get(&DataKey::DiscountFeeBps)
                .unwrap_or(0),
        )
    }

    pub fn tier_threshold(_env: Env) -> i128 {
        TIER_THRESHOLD
    }

    pub fn max_fee_bps(_env: Env) -> u32 {
        MAX_FEE_BPS
    }
}

mod test;
