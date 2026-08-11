# Stellar Token Swap Interface

A swap UI built on the **real Stellar DEX orderbook**, where every swap is
validated and recorded by **two Soroban contracts deployed on testnet** that
call each other.

Swaps execute as classic `path_payment_strict_send` operations against live DEX
liquidity. A `swap_registry` contract enforces the swap's invariants, delegates
fee policy to a second `fee_vault` contract via a cross-contract call, and emits
an event the UI streams back in real time.

---

## Screenshots

Wallet options available:

![wallet](/images/1.png)

Deployed contract:

![contract](/images/2.png)

Transaction verifiable on Stellar Explorer:

![Stellar Explorer](/images/3.png)

---

## Deployed contracts (testnet)

| Contract | Address |
| --- | --- |
| `swap_registry` | [`CD3QTWMRPZCVCKYRLT6EDLBBLLLRKAR7WXXBJSRGX73B65FA7C4EPOFH`](https://stellar.expert/explorer/testnet/contract/CD3QTWMRPZCVCKYRLT6EDLBBLLLRKAR7WXXBJSRGX73B65FA7C4EPOFH) |
| `fee_vault` | [`CAIGJ2FLWFDBDTEQILJIO32UGSQP5SJRI7ZON6XFI5JBGJDB657ZQ5AX`](https://stellar.expert/explorer/testnet/contract/CAIGJ2FLWFDBDTEQILJIO32UGSQP5SJRI7ZON6XFI5JBGJDB657ZQ5AX) |

Both are recorded in [`deployment.json`](deployment.json), which
[`scripts/deploy.sh`](scripts/deploy.sh) writes.

---

## Level 3 requirements

| Requirement | Where it lives |
| --- | --- |
| **Advanced smart contract development** | Typed error enums, `#[contractevent]` typed events, instance vs. persistent storage, admin auth with `require_auth`, bounded history, a pause killswitch, and a checked-arithmetic slippage floor — [`swap_registry`](contracts/swap_registry/src/lib.rs), [`fee_vault`](contracts/fee_vault/src/lib.rs) |
| **Inter-contract communication** | `record_swap` calls `fee_vault.quote_fee` + `accrue` in one invocation via `#[contractclient]` — [`lib.rs`](contracts/swap_registry/src/lib.rs) `apply_fees` |
| **Event streaming & real-time updates** | `swap` events polled from the RPC into a live feed; Horizon orderbook polled on a 6s tick — [`EventFeed.tsx`](frontend/src/components/EventFeed.tsx), [`contract.ts`](frontend/src/lib/contract.ts) |
| **CI/CD pipeline setup** | [`ci.yml`](.github/workflows/ci.yml) — fmt, clippy, tests, wasm build, frontend typecheck/lint/test/build |
| **Smart contract deployment workflow** | [`scripts/deploy.sh`](scripts/deploy.sh) and manual-only [`deploy.yml`](.github/workflows/deploy.yml) |
| **Mobile responsive frontend** | Phone/tablet breakpoints, 44px touch targets, safe-area insets — [`index.css`](frontend/src/index.css) |
| **Error handling & loading states** | Four error classes plus shimmer skeletons and spinners — [`errors.ts`](frontend/src/lib/errors.ts), [`OrderBookView.tsx`](frontend/src/components/OrderBookView.tsx) |
| **Tests for contracts and frontend** | 37 Rust tests (incl. 8 cross-contract), 43 Vitest assertions, 2 Playwright e2e suites |
| **Production-ready architecture** | Env-driven config, layered `lib/`, retry/propagation handling, mutual contract authorisation |
| **Documentation & demo** | This file, plus [`DEMO.md`](DEMO.md) |

---

## Architecture

```
                        ┌──────────────────────────────┐
                        │        React swap UI         │
                        └──────────────────────────────┘
             orderbook +      │           │            │  swap events
             strict-send      │           │ record_swap│  (polled)
             quotes           ▼           ▼            ▼
                      ┌────────────┐  ┌──────────────────────────┐
                      │  Horizon   │  │   Soroban RPC (testnet)  │
                      │ (classic   │  │                          │
                      │  DEX)      │  │  ┌────────────────────┐  │
                      └────────────┘  │  │   swap_registry    │  │
                             ▲        │  │  · validates       │  │
                             │        │  │  · counts, history │  │
                             │        │  │  · emits SwapEvent │  │
                             │        │  └─────────┬──────────┘  │
                             │        │            │ cross-      │
                             │        │            │ contract    │
                             │        │            ▼             │
                             │        │  ┌────────────────────┐  │
                             │        │  │     fee_vault      │  │
                             │        │  │  · quote_fee       │  │
                             │        │  │  · accrue (volume) │  │
                             │        │  │  · emits Accrued   │  │
                             │        │  └────────────────────┘  │
                             │        └──────────────────────────┘
            path_payment_strict_send
            (the actual swap settles here)
```

Two ledgers, two purposes: the **classic DEX** provides liquidity and the real
orderbook; the **Soroban contracts** are the programmable guard rail.

Splitting the contracts is the point of the second one. The registry decides
whether a swap is *allowed*; the vault decides what it *costs*. Fee policy can
change — new rates, new tiers — without redeploying the registry that holds the
swap history.

### Swap flow

1. **Validate** in the browser (amount, distinct assets, balance, asset codes).
2. **Quote** via Horizon `strict_send_paths` — the real route and amount.
3. **Trustline** for the destination asset, created if missing.
4. **Registry** — `record_swap` is simulated, signed and submitted. Inside that
   one invocation it calls into `fee_vault` twice. A typed contract error here
   costs nothing, because simulation rejects it before submission.
5. **DEX swap** — `path_payment_strict_send` with `destMin` from the slippage.

---

## The contracts

### `swap_registry`

```rust
pub enum Error {
    NotInitialized = 1,   AlreadyInitialized = 2,
    InvalidAmount = 3,    SlippageTooHigh = 4,
    IdenticalAssets = 5,  RegistryPaused = 6,
    AmountTooLarge = 7,   Unauthorized = 8,
    InvalidAsset = 9,     VaultNotSet = 10,
}
```

| Function | Purpose |
| --- | --- |
| `initialize(admin)` | Set the admin; rejects a second call |
| `record_swap(user, sell, buy, amount_in, min_out)` | Validate, quote+accrue through the vault, count, store history, emit `SwapEvent` |
| `set_fee_vault(caller, vault)` | Admin-only; links the vault |
| `preview_fee(user, amount)` | Reads through to the vault |
| `history(user)` / `total_swaps()` / `user_swaps(user)` | Read state |
| `set_paused(caller, value)` | Admin-only killswitch |

### `fee_vault`

```rust
pub enum Error {
    NotInitialized = 1,     AlreadyInitialized = 2,
    FeeTooHigh = 3,         UnauthorizedCaller = 4,
    InvalidAmount = 5,
}
```

| Function | Purpose |
| --- | --- |
| `initialize(admin, base_fee_bps, discount_fee_bps)` | Fee schedule, capped at 5% |
| `set_registry(registry)` | Admin-only; the only address allowed to `accrue` |
| `quote_fee(user, amount)` | Pure read: bps, absolute fee, whether the tier applies |
| `accrue(caller, user, amount, asset)` | Registry-only; records volume, emits `Accrued` |
| `volume_of(user)` / `total_volume()` / `total_fees()` | Read state |

### Inter-contract communication

The registry declares only the slice of the vault it needs, rather than
importing the crate, so the two stay independently deployable:

```rust
#[contractclient(name = "FeeVaultClient")]
pub trait FeeVaultInterface {
    fn quote_fee(env: Env, user: Address, amount: i128) -> FeeQuote;
    fn accrue(env: Env, caller: Address, user: Address, amount: i128, asset: String) -> i128;
}
```

The trust is **mutual and explicit**: the registry stores the vault's address
(admin-only), and the vault stores the registry's (admin-only) and rejects
`accrue` from anyone else with `UnauthorizedCaller`. The registry passes
`env.current_contract_address()` as `caller`, so the vault authorises the
*contract*, not the end user.

The registry also stays useful unlinked — no vault means fees are skipped, not
an error — so the dependency is an enhancement rather than a hard requirement.

---

## Testing

```bash
cargo test                  # 37 tests: 26 registry (8 cross-contract) + 11 vault
cd frontend && npm run test:run   # 43 Vitest assertions
```

**Contract tests** cover every error path, the slippage boundary, history
capping, admin authorisation, and — with the real vault registered in the test
host, not a stub — that a swap accrues volume, that the tier discount applies
across the contract boundary, and that the emitted event carries the fee the
vault quoted.

**Frontend unit tests** cover the error taxonomy (every contract code and the
Stellar operation result codes) and the stroop/slippage maths, including
round-tripping and the truncate-not-round rule that keeps `min_out` reachable.

Writing these caught a real bug: `tx_insufficient_fee` was matching a broader
`insufficient` pattern meant for balance errors, so a fee problem reported
"insufficient balance".

**End-to-end** (needs a dev server, spends testnet XLM):

```bash
npm run e2e:swap      # connect -> quote -> registry -> DEX, asserts success
npm run e2e:errors    # asserts all error classes render
```

---

## Error handling

Four classes, each with its own label, message and expandable detail.

**1. Validation** — caught in the UI, no network call:

```
Pick two different assets.
Insufficient XLM balance (you have 10000).
```

**2. Contract** — a typed `Error(Contract, #N)`, mapped to plain language:

```
CONTRACT ERROR · #3   Invalid amount — the sell amount must be greater than zero.
CONTRACT ERROR · #4   Slippage too high — below the registry's limit (max 10%).
CONTRACT ERROR · #5   Identical assets — pick two different tokens.
CONTRACT ERROR · #6   Registry is paused by its admin.
```

**3. Network / DEX** — Horizon or RPC unreachable, plus specific Stellar result
codes (`op_under_dest_min`, `op_no_trust`, `op_underfunded`,
`op_too_few_offers`, `tx_bad_seq`, `tx_no_account`, `tx_insufficient_fee`, …).

**4. Wallet** — a cancelled signature is its own class, so declining never
looks like a failure.

### Loading states

Shimmer skeletons match the shape of the content they replace (the orderbook's
three-column rows, the feed's item height) so the layout doesn't jump. Spinners
mark the submit button, the quote field, and the live pills. The event feed
distinguishes "still loading" from "no swaps yet".

---

## Verified on testnet

A single `record_swap` invocation produced events from **both** contracts:

```
fee_vault      accrued  { amount: 1000000000, fee: 3000000, total_volume: 1000000000 }
swap_registry  swap     { amount_in: 1000000000, fee_bps: 30, fee_amount: 3000000,
                          sell_asset: XLM, buy_asset: USDC, swap_index: 1 }
```

A full swap driven through the browser against live testnet:

```
CONNECTED: GCZRF…LHOVO · Dev keypair
QUOTE:     25 XLM → 44.8192760 USDC
RESULT:    SUCCESS (registry swap #2)
Registry tx  0a8085d746a8e72cb559f1047dfaa40c464e068d552743efc760a79aa7c0b7c2
DEX swap tx  e72d85e5353bb6ca3803be92a8ec9a767d07db9c00e5dba580170d6b1c4b6d03
```

The vault's totals then read `total_volume: 1250000000`, `total_fees: 3750000` —
exactly 30 bps of both swaps.

Error paths were also exercised directly against the deployed contracts:

| Call | Result |
| --- | --- |
| `initialize` (second time) | `Error(Contract, #2)` |
| `record_swap` with `amount_in = 0` | `Error(Contract, #3)` |
| `record_swap` with `min_out` at 50% | `Error(Contract, #4)` |
| `record_swap` with `XLM → XLM` | `Error(Contract, #5)` |
| `accrue` from a non-registry address | `Error(Contract, #4)` (vault) |

---

## Running it

### Prerequisites

- Node 20+
- Rust with the `wasm32v1-none` target
- [Stellar CLI](https://github.com/stellar/stellar-cli) and `jq` (only to deploy)

### Frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

The deployed addresses are the defaults in
[`config.ts`](frontend/src/lib/config.ts), so this works with no `.env` file.
To point at a different deployment, copy `.env.example` to `.env.local`.

Connect any supported wallet (Freighter, xBull, Albedo, Rabet, Lobstr, Hana),
or click **Dev key → Create + fund** for a Friendbot-funded testnet account.

> Dev-keypair mode keeps a secret key in `localStorage`. Testnet convenience
> only — never paste a mainnet secret.

### Deploying

```bash
./scripts/deploy.sh testnet deployer
```

Builds both contracts, uploads and instantiates them, initializes both, links
them in **both** directions, verifies the link, and writes `deployment.json`.

Neither contract has a constructor, so `initialize` must be called explicitly —
passing `--admin` to `stellar contract deploy` is silently ignored.

The script retries the transient RPC failures that otherwise break a
multi-transaction deploy: stale sequence numbers (`TxBadSeq`), `Wasm does not
exist` when the upload hasn't settled, `Contract not found` before the instance
is indexed, and connection resets.

---

## Layout

```
contracts/
  swap_registry/src/lib.rs   registry: validation, events, storage, vault client
  swap_registry/src/test.rs  26 tests, 8 of them cross-contract
  fee_vault/src/lib.rs       fee policy + volume accounting
  fee_vault/src/test.rs      11 tests
frontend/src/
  lib/config.ts       env-driven network + contract addresses
  lib/errors.ts        the four-class error taxonomy
  lib/horizon.ts       orderbook, quotes, balances, trade stream
  lib/contract.ts      Soroban invoke + event polling
  lib/swap.ts          path payment, trustline, sequence handling
  lib/wallet.ts        multi-wallet + dev keypair
  lib/*.test.ts        Vitest unit tests
  components/          SwapForm, OrderBookView, TxStatus, EventFeed, WalletBar
frontend/e2e-*.mjs     Playwright suites against live testnet
scripts/deploy.sh      deploy + link + verify
.github/workflows/     ci.yml (push/PR), deploy.yml (manual)
deployment.json        deployed addresses and fee policy
DEMO.md                demo script
```

---

## Production-ready practices

- **Config over constants.** Network, RPC and contract addresses come from Vite
  env vars, so one build artifact can target several environments.
- **Mutual authorisation.** Neither contract implicitly trusts the other; each
  stores the other's address behind an admin check.
- **Propagation is handled, not hoped for.** Horizon and the Soroban RPC index
  ledgers independently. A swap spans three transactions, so account state is
  read from both and built on the higher sequence number, with retries that wait
  for the sequence to advance rather than sleeping a fixed interval. This was a
  real intermittent failure (`txBadSeq` / `txNoAccount`), not a theoretical one.
- **Simulate before submitting.** Contract errors surface during simulation, so
  a rejected swap costs the user no fee.
- **CI gates on warnings.** `RUSTFLAGS: -D warnings` plus `cargo fmt --check`
  and clippy, so lint debt cannot accumulate.
- **Deploys are deliberate.** The deploy workflow is manual-only, environment-
  scoped, and serialised by a concurrency group.

---

## Notes and limitations

- **Testnet only.** The token issuers in `config.ts` are SDF testnet assets.
- **Two transactions per swap.** The registry call and the DEX settlement are
  separate transactions, so a swap can be recorded and then fail at the DEX
  step. The UI reports which stage failed and links both. Making it atomic
  would mean routing funds through a Soroban contract, which gives up the
  classic orderbook.
- **Fees are accounted, not collected.** `fee_vault` quotes and tracks fees;
  it does not custody tokens. Charging them would require a token transfer
  inside the swap, which is a different (and custodial) design.
- **Events are polled.** Soroban RPC has no SSE endpoint, so the feed polls
  `getEvents` every 7s over a bounded ledger window. Horizon's classic trade
  stream *is* SSE and is available in `horizon.ts`.
- **Testnet orderbook liquidity is thin**, so quoted rates and the visible
  spread can look extreme next to mainnet.
