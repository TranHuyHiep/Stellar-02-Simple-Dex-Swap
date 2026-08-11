Screenshot: wallet options available

![wallet](/images/1.png)

Deployed contract address: CDYQ4AGHIHHHTRYN36FKXZM53VAGFD4NGMUZLOM4XPRTRZMEQPZC3BEY

![contract](/images/2.png)


Transaction hash of a contract call (verifiable on Stellar Explorer)

https://stellar.expert/explorer/testnet/contract/CDYQ4AGHIHHHTRYN36FKXZM53VAGFD4NGMUZLOM4XPRTRZMEQPZC3BEY

![Stellar Explorer](/images/3.png)

# Stellar Token Swap Interface — Level 2

A swap UI built on the **real Stellar DEX orderbook**, where every swap is
validated and recorded by a **Soroban smart contract deployed on testnet**.

Swaps execute as classic `path_payment_strict_send` operations against live DEX
liquidity, while a Soroban registry contract enforces the swap's invariants and
emits an event that the UI streams back in real time.

---

## Level 2 requirements

| Requirement | Where it lives |
| --- | --- |
| **3 error types handled** | [`frontend/src/lib/errors.ts`](frontend/src/lib/errors.ts) — validation, contract (`#1`–`#6`), network/DEX. Verified by [`e2e-errors.mjs`](frontend/e2e-errors.mjs) |
| **Contract deployed on testnet** | `CDYQ4AGHIHHHTRYN36FKXZM53VAGFD4NGMUZLOM4XPRTRZMEQPZC3BEY` — see [`deployment.json`](deployment.json) |
| **Contract called from the frontend** | [`frontend/src/lib/contract.ts`](frontend/src/lib/contract.ts) → `record_swap`, plus read-only simulations for `total_swaps` / `paused` |
| **Transaction status visible** | [`frontend/src/components/TxStatus.tsx`](frontend/src/components/TxStatus.tsx) — staged progress, error detail, explorer links for both txs |
| **2+ meaningful commits** | contract → deploy → frontend → docs |
| **Multi-wallet** | [`frontend/src/lib/wallet.ts`](frontend/src/lib/wallet.ts) — 6 wallets via Stellar Wallets Kit + dev keypair |
| **Real-time event integration** | [`frontend/src/components/EventFeed.tsx`](frontend/src/components/EventFeed.tsx) — polls `swap` events from the deployed contract |

---

## Architecture

```
                    ┌──────────────────────────────────────────┐
                    │            React swap UI                 │
                    └──────────────────────────────────────────┘
                         │              │               │
        orderbook +      │              │ record_swap   │  swap events
        strict-send      │              │ (signed)      │  (polled)
        quotes           ▼              ▼               ▼
                  ┌────────────┐  ┌───────────────────────────┐
                  │  Horizon   │  │   Soroban RPC (testnet)   │
                  │  (classic  │  │  swap_registry contract   │
                  │   DEX)     │  │  · validates the swap     │
                  └────────────┘  │  · counts + stores history│
                         ▲        │  · emits SwapEvent        │
                         │        └───────────────────────────┘
       path_payment_strict_send
       (the actual swap settles here)
```

Two ledgers, two purposes: the **classic DEX** provides the liquidity and the
real orderbook, and the **Soroban contract** is the programmable guard rail —
it refuses to record a swap whose `min_out` implies more than 10% slippage, and
its events give the UI a live, on-chain activity feed.

### Swap flow

1. **Validate** in the browser (amount > 0, distinct assets, sufficient balance).
2. **Quote** via Horizon `strict_send_paths` — the real route and destination amount.
3. **Trustline** for the destination asset, created automatically if missing.
4. **Registry** — `record_swap(user, sell, buy, amount_in, min_out)` is simulated,
   signed and submitted. A typed contract error here costs the user nothing,
   because simulation rejects it before submission.
5. **DEX swap** — `path_payment_strict_send` with `destMin` derived from the
   chosen slippage tolerance.

---

## The contract

[`contracts/swap_registry/src/lib.rs`](contracts/swap_registry/src/lib.rs)

```rust
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    InvalidAmount = 3,      // amount_in <= 0, or min_out < 0
    SlippageTooHigh = 4,    // min_out below 90% of amount_in, or zero
    IdenticalAssets = 5,    // sell_asset == buy_asset
    RegistryPaused = 6,     // admin killswitch
}
```

| Function | Purpose |
| --- | --- |
| `initialize(admin)` | Set the admin; rejects a second call |
| `record_swap(user, sell, buy, amount_in, min_out)` | Validate, count, store history, emit `SwapEvent`. Requires `user` auth |
| `total_swaps()` / `user_swaps(user)` | Counters |
| `history(user)` | Last 20 swaps for a user |
| `max_slippage_bps()` / `paused()` | Registry configuration |
| `set_paused(bool)` | Admin-only killswitch |

`SwapEvent` is declared with `#[contractevent]` and published with topics
`["swap", user]`, so the frontend can filter the event stream to this contract
and (optionally) to a single account.

### Tests

11 unit tests, including one per error path and an assertion that the swap
event is emitted with the right topics:

```
$ cargo test
running 11 tests
test test::exact_slippage_floor_is_accepted ... ok
test test::history_is_capped_and_per_user ... ok
test test::identical_assets_are_rejected ... ok
test test::initialize_sets_defaults ... ok
test test::initialize_twice_is_rejected ... ok
test test::min_out_below_slippage_floor_is_rejected ... ok
test test::negative_amount_is_invalid ... ok
test test::paused_registry_rejects_swaps ... ok
test test::records_a_valid_swap_and_emits_event ... ok
test test::zero_amount_is_invalid ... ok
test test::zero_min_out_is_rejected_as_unprotected ... ok

test result: ok. 11 passed; 0 failed
```

---

## Error handling

Three classes, each surfaced with its own label, message and technical detail.

**1. Validation** — caught in the UI, no network call:

```
Pick two different assets.
Insufficient XLM balance (you have 10000).
```

**2. Contract** — a typed `Error(Contract, #N)` from the deployed registry,
mapped to a plain-language message and shown with its code:

```
CONTRACT ERROR · #3   Invalid amount — the sell amount must be greater than zero.
CONTRACT ERROR · #4   Slippage too high — "minimum received" is below the registry's limit (max 10%).
CONTRACT ERROR · #5   Identical assets — pick two different tokens to swap between.
CONTRACT ERROR · #6   Registry is paused by its admin. Swaps are temporarily disabled.
```

**3. Network / DEX** — Horizon or RPC unreachable, plus specific Stellar
operation result codes (`op_under_dest_min`, `op_no_trust`, `op_underfunded`,
`tx_bad_seq`, `tx_insufficient_fee`, …):

```
NETWORK ERROR   Network error — could not reach Horizon or the Soroban RPC.
NETWORK ERROR   Swap failed on the DEX: the path no longer delivers your minimum received.
NETWORK ERROR   You need a trustline for the destination asset before you can receive it.
```

Wallet rejections are handled as a fourth, separate class so a cancelled
signature never looks like a failure.

---

## Verified on testnet

The contract's error paths were exercised directly against the deployed
contract with the Stellar CLI:

| Call | Result |
| --- | --- |
| `initialize` (second time) | `Error(Contract, #2)` |
| `record_swap` with `amount_in = 0` | `Error(Contract, #3)` |
| `record_swap` with `min_out` at 50% | `Error(Contract, #4)` |
| `record_swap` with `XLM → XLM` | `Error(Contract, #5)` |
| `record_swap` valid | success, `SwapEvent` emitted |

A full swap was then driven through the browser against live testnet:

```
CONNECTED: GBSNW…6FMNN · Dev keypair
BALANCE:   10,000 XLM
QUOTE:     25 XLM → 44.8906481 USDC
RESULT:    SUCCESS  (registry swap #2)
Registry tx  0b6d7e6ad27653e5df2ced5351caf89fdfc275c88da94ee3da49f9395871a50b
DEX swap tx  311e2c95f06bc8707e6337ddbbe5de90011782c577213edd1cc69c18131b4199
```

Both confirmed on-chain — the registry invocation succeeded at ledger 4072410,
and the DEX operation moved exactly `25.0000000 XLM → 44.8906481 USDC`.

---

## Running it

### Prerequisites

- Node 20+
- Rust with the `wasm32v1-none` target, and the [Stellar CLI](https://github.com/stellar/stellar-cli) (only needed to rebuild/redeploy the contract)

### Frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

The deployed contract is already wired up in
[`frontend/src/lib/config.ts`](frontend/src/lib/config.ts), so the app works
immediately.

Connect with any supported browser wallet, or click **Dev key → Create + fund**
to generate a Friendbot-funded testnet account — handy for demos and required
for the headless tests.

> The dev-keypair mode keeps a secret key in `localStorage`. It is a testnet
> convenience only; never paste a mainnet secret into it.

### Contract

```bash
cargo test                                    # 11 unit tests
stellar contract build                        # -> target/wasm32v1-none/release/swap_registry.wasm

stellar keys generate deployer --network testnet --fund
stellar contract deploy \
  --wasm target/wasm32v1-none/release/swap_registry.wasm \
  --source deployer --network testnet

# The contract has no constructor, so initialize explicitly:
stellar contract invoke --id <CONTRACT_ID> --source deployer \
  --network testnet --send=yes -- initialize --admin <ADMIN_ADDRESS>
```

If you redeploy, update `CONTRACT_ID` in `frontend/src/lib/config.ts` and
`deployment.json`.

### End-to-end tests

With the dev server running:

```bash
cd frontend
node e2e-swap.mjs      # real swap on testnet: connect -> quote -> registry -> DEX
node e2e-errors.mjs    # asserts all three error classes render correctly
```

`e2e-swap.mjs` spends real testnet XLM (funded by Friendbot) and exits non-zero
if the swap does not reach the success state.

---

## Layout

```
contracts/swap_registry/
  src/lib.rs           the registry contract: errors, events, storage
  src/test.rs          11 unit tests
frontend/src/
  lib/config.ts        network, contract id, token list
  lib/errors.ts        the three-class error taxonomy
  lib/horizon.ts       orderbook, quotes, balances, trade stream
  lib/contract.ts      Soroban invoke + event polling
  lib/swap.ts          path payment + trustline
  lib/wallet.ts        multi-wallet + dev keypair
  components/          SwapForm, OrderBookView, TxStatus, EventFeed, WalletBar
  e2e-swap.mjs         end-to-end swap against testnet
  e2e-errors.mjs       error-path assertions
deployment.json        deployed addresses and verification record
```

---

## Notes and limitations

- **Testnet only.** The token issuers in `config.ts` are SDF testnet assets.
- **Two transactions per swap.** The registry call and the DEX settlement are
  separate transactions, so a swap can in principle be recorded and then fail
  at the DEX step. The UI reports exactly which stage failed and links both
  transactions. Making this atomic would require the swap itself to move
  through a Soroban contract holding the funds, which is a different design
  (and gives up the classic orderbook).
- **Events are polled, not streamed.** Soroban RPC exposes no SSE endpoint, so
  the feed polls `getEvents` every 7s over a bounded ledger window. Horizon's
  classic trade stream *is* SSE and is available in `horizon.ts`.
- **Orderbook liquidity on testnet is thin**, so quoted rates and the visible
  spread can look extreme compared to mainnet.
