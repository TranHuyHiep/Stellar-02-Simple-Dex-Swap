# Demo script

A ~6 minute walkthrough. Everything below runs against live Stellar testnet.

**Deployed contracts**

| Contract | Address |
| --- | --- |
| `swap_registry` | `CD3QTWMRPZCVCKYRLT6EDLBBLLLRKAR7WXXBJSRGX73B65FA7C4EPOFH` |
| `fee_vault` | `CAIGJ2FLWFDBDTEQILJIO32UGSQP5SJRI7ZON6XFI5JBGJDB657ZQ5AX` |

---

## 0. Setup (before the demo)

```bash
cd frontend && npm install && npm run dev
```

Open http://localhost:5173. Leave it a few seconds so the orderbook and the
event feed populate — the skeletons are worth showing, but only once.

---

## 1. The tests pass (30s)

```bash
cargo test
```

> 37 tests. Eleven for the fee vault, twenty-six for the registry — and eight of
> those register the *real* vault in the test host, so the cross-contract path
> is exercised rather than mocked.

```bash
cd frontend && npm run test:run
```

> 43 assertions over the error taxonomy and the stroop maths. These caught a
> real bug: a fee error was being reported as an insufficient balance.

---

## 2. Two contracts, one invocation (90s)

This is the centrepiece. Show that a single call fans out across contracts.

```bash
export PATH="$HOME/.cargo/bin:$PATH"
R=CD3QTWMRPZCVCKYRLT6EDLBBLLLRKAR7WXXBJSRGX73B65FA7C4EPOFH
V=CAIGJ2FLWFDBDTEQILJIO32UGSQP5SJRI7ZON6XFI5JBGJDB657ZQ5AX
D=$(stellar keys address deployer)

# The two contracts point at each other — mutual, admin-gated trust.
stellar contract invoke --id $R --source deployer --network testnet -- fee_vault
stellar contract invoke --id $V --source deployer --network testnet -- registry
```

> The registry knows the vault; the vault knows the registry. Neither trusts the
> other implicitly — both links are admin-only.

```bash
# Volume before
stellar contract invoke --id $V --source deployer --network testnet -- \
  volume_of --user $D

# One call to the registry
stellar contract invoke --id $R --source deployer --network testnet --send=yes -- \
  record_swap --user $D --sell_asset XLM --buy_asset USDC \
  --amount_in 1000000000 --min_out 950000000
```

> Two events from one invocation: `fee_vault` emitted `accrued`, and
> `swap_registry` emitted `swap` carrying `fee_bps: 30` — a value it did not
> compute itself, it asked the vault for it.

```bash
# Volume after — the vault's state changed as a side effect
stellar contract invoke --id $V --source deployer --network testnet -- \
  volume_of --user $D
stellar contract invoke --id $V --source deployer --network testnet -- total_fees
```

> If a read looks stale, run it again. Horizon and the Soroban RPC index ledgers
> independently, which is exactly the lag the frontend has to handle.

---

## 3. Error handling (90s)

**Contract errors** — rejected during simulation, so they cost no fee:

```bash
# #3 InvalidAmount
stellar contract invoke --id $R --source deployer --network testnet --send=yes -- \
  record_swap --user $D --sell_asset XLM --buy_asset USDC --amount_in 0 --min_out 1

# #5 IdenticalAssets
stellar contract invoke --id $R --source deployer --network testnet --send=yes -- \
  record_swap --user $D --sell_asset XLM --buy_asset XLM \
  --amount_in 1000000000 --min_out 950000000

# #4 SlippageTooHigh — 50% slippage, past the 10% cap
stellar contract invoke --id $R --source deployer --network testnet --send=yes -- \
  record_swap --user $D --sell_asset XLM --buy_asset USDC \
  --amount_in 1000000000 --min_out 500000000
```

**Cross-contract authorisation** — the vault rejects anyone but the registry:

```bash
stellar contract invoke --id $V --source deployer --network testnet --send=yes -- \
  accrue --caller $D --user $D --amount 1000000000 --asset XLM
```

> `Error(Contract, #4)` — `UnauthorizedCaller`. Only the registered registry can
> accrue volume, even though I am the admin.

**In the UI** — show all four classes render distinctly:

```bash
cd frontend && npm run e2e:errors
```

> Validation, contract, network, wallet. Each with its own label, message and
> expandable technical detail. The fallback includes the raw payload, so an
> unrecognised error is still diagnosable.

---

## 4. A real swap in the browser (90s)

In the UI: **Dev key → Create + fund** (Friendbot), then swap 25 XLM → USDC.

Narrate the staged status panel as it advances:

> Validate → Quote → Registry → DEX swap → Done. Five stages, and the panel says
> which one is running. The Registry step is where the cross-contract call
> happens; the DEX step is the actual `path_payment_strict_send` against real
> orderbook liquidity.

When it completes, point at the event feed:

> The new swap appears in the feed with the fee the vault quoted — `fee 0.3
> (30bps)`. That number came from a different contract, in the same transaction.

Both explorer links at the bottom of the panel are live.

Or run it headlessly:

```bash
npm run e2e:swap
```

---

## 5. Mobile (30s)

Open devtools → device toolbar → iPhone SE (375px).

> Single column, full-width wallet buttons, 44px touch targets. Inputs stay at
> 16px so iOS doesn't zoom on focus, and safe-area insets keep content clear of
> the notch. No horizontal overflow at 375, 390 or 768px.

---

## 6. CI/CD and deployment (60s)

```bash
cat .github/workflows/ci.yml
```

> Every push runs `cargo fmt --check`, clippy with `-D warnings`, all 37
> contract tests, a wasm build with size reporting, then the frontend
> typecheck, lint, unit tests and build. Both jobs upload artifacts.

```bash
cat .github/workflows/deploy.yml
```

> Deploy is `workflow_dispatch` only — never on push. It's scoped to a GitHub
> environment so the secret is gated, and a concurrency group stops two runs
> racing for the same sequence number.

```bash
./scripts/deploy.sh --help 2>/dev/null || head -30 scripts/deploy.sh
```

> One command deploys both contracts, initializes them, links them in both
> directions and verifies the link before writing `deployment.json`. It retries
> the transient RPC failures that break naive deploy scripts — stale sequence
> numbers, "Wasm does not exist" before the upload settles, connection resets.

---

## Talking points if asked

**Why two contracts?** The registry decides whether a swap is *allowed*; the
vault decides what it *costs*. Fee policy can change — new rates, new tiers —
without redeploying the contract holding the swap history. The registry declares
the vault's interface with `#[contractclient]` rather than importing the crate,
so they stay independently deployable.

**Why is the swap not atomic?** The registry call and the DEX settlement are
separate transactions. Making them atomic would require routing funds through a
Soroban contract, which means giving up the classic orderbook — the thing that
provides the real liquidity. The UI reports exactly which stage failed and links
both transactions.

**Hardest bug?** Swaps failed intermittently with `txBadSeq`. A swap submits up
to three transactions back to back, and Horizon and the Soroban RPC index
ledgers independently — so whichever one was asked for the next sequence number
could be behind. The fix reads both and builds on the higher, retrying until the
sequence actually advances. Neither error code was mapped either, so it surfaced
as "Unexpected error".

**Are fees collected?** No — quoted and accounted, not custodied. Charging them
would need a token transfer inside the swap, which is a materially different and
custodial design.
