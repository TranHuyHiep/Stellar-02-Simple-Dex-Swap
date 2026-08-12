#!/usr/bin/env bash
#
# Deploy both contracts to a Stellar network and wire them together.
#
#   ./scripts/deploy.sh [network] [identity]
#
# Idempotent in the sense that it always deploys fresh contract instances and
# writes the resulting addresses to deployment.json. It does not attempt to
# upgrade an existing deployment.
#
# Requires: stellar CLI, jq, and a funded identity.
set -euo pipefail

NETWORK="${1:-testnet}"
IDENTITY="${2:-deployer}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/deployment.json"

BASE_FEE_BPS="${BASE_FEE_BPS:-30}"
DISCOUNT_FEE_BPS="${DISCOUNT_FEE_BPS:-10}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

command -v stellar >/dev/null || die "stellar CLI not found on PATH"
command -v jq >/dev/null || die "jq not found on PATH"

cd "$ROOT"

# --- identity ---------------------------------------------------------------
if ! stellar keys address "$IDENTITY" >/dev/null 2>&1; then
  log "Identity '$IDENTITY' not found; generating and funding it"
  stellar keys generate "$IDENTITY" --network "$NETWORK" --fund
fi
ADMIN="$(stellar keys address "$IDENTITY")"
log "Admin: $ADMIN"

# --- build ------------------------------------------------------------------
log "Building contracts"
stellar contract build >/dev/null
REGISTRY_WASM="target/wasm32v1-none/release/swap_registry.wasm"
VAULT_WASM="target/wasm32v1-none/release/fee_vault.wasm"
NFT_WASM="target/wasm32v1-none/release/nft_collection.wasm"
POOL_WASM="target/wasm32v1-none/release/nft_pool.wasm"
for w in "$REGISTRY_WASM" "$VAULT_WASM" "$NFT_WASM" "$POOL_WASM"; do
  [[ -f "$w" ]] || die "missing $w"
done

# --- deploy -----------------------------------------------------------------
# `stellar contract deploy` installs the wasm and creates the instance. The
# install and the create are separate transactions, so a stale sequence number
# can surface here; retry once against the already-installed hash.
deploy() {
  local wasm="$1" label="$2" id hash attempt
  log "Deploying $label" >&2

  # Install and deploy are two separate transactions. The deploy can simulate
  # before the install's ledger is visible to the RPC, which surfaces as
  # TxBadSeq or "Wasm does not exist" (Storage, MissingValue). Install once,
  # wait for the hash to be readable, then create the instance.
  hash="$(stellar contract upload --wasm "$wasm" \
    --source "$IDENTITY" --network "$NETWORK" 2>/dev/null \
    | grep -oE '^[0-9a-f]{64}$' | tail -1)"
  if [[ -z "$hash" ]]; then
    # Upload is idempotent: if the wasm is already on-chain the CLI may print
    # nothing new. The hash is just sha256 of the file, so derive it locally.
    hash="$(sha256sum "$wasm" | cut -d' ' -f1)"
    warn "$label: upload returned no hash, using local sha256 $hash" >&2
  fi
  [[ -n "$hash" ]] || die "$label: could not determine wasm hash"

  for attempt in 1 2 3 4 5 6 7 8; do
    if id="$(stellar contract deploy --wasm-hash "$hash" \
          --source "$IDENTITY" --network "$NETWORK" 2>/tmp/deploy.err)"; then
      echo "$id"
      return 0
    fi
    if grep -qE 'MissingValue|Wasm does not exist|TxBadSeq|timeout|TryAgainLater|50[234]|connection reset|connection error|Networking or low-level' \
        /tmp/deploy.err; then
      warn "$label: transient failure (attempt $attempt), retrying…" >&2
      sleep 5
      continue
    fi
    cat /tmp/deploy.err >&2
    die "$label deployment failed"
  done
  die "$label: deploy kept failing after the wasm upload"
}

VAULT_ID="$(deploy "$VAULT_WASM" fee_vault)"
log "fee_vault:       $VAULT_ID"
REGISTRY_ID="$(deploy "$REGISTRY_WASM" swap_registry)"
log "swap_registry:   $REGISTRY_ID"
NFT_ID="$(deploy "$NFT_WASM" nft_collection)"
log "nft_collection:  $NFT_ID"
POOL_ID="$(deploy "$POOL_WASM" nft_pool)"
log "nft_pool:        $POOL_ID"

# Invoke a contract function, retrying while the RPC has not caught up to the
# ledger that created or last touched the contract.
invoke() {
  local id="$1"; shift
  local attempt out
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if out="$(stellar contract invoke --id "$id" --source "$IDENTITY" \
          --network "$NETWORK" --send=yes -- "$@" 2>/tmp/invoke.err)"; then
      printf '%s' "$out"
      return 0
    fi
    if grep -qE 'Contract not found|MissingValue|TxBadSeq|timeout|TryAgainLater|50[234]|connection reset|connection error|Networking or low-level' \
        /tmp/invoke.err; then
      warn "invoke $1: not settled yet (attempt $attempt), retrying…" >&2
      sleep 4
      continue
    fi
    cat /tmp/invoke.err >&2
    return 1
  done
  die "invoke $1 on $id kept failing"
}

# --- initialize -------------------------------------------------------------
# Neither contract has a constructor, so initialize explicitly. Passing
# --admin to `contract deploy` would be silently ignored.
log "Initializing fee_vault (base ${BASE_FEE_BPS}bps, discount ${DISCOUNT_FEE_BPS}bps)"
invoke "$VAULT_ID" initialize --admin "$ADMIN" \
  --base_fee_bps "$BASE_FEE_BPS" --discount_fee_bps "$DISCOUNT_FEE_BPS" >/dev/null

log "Initializing swap_registry"
invoke "$REGISTRY_ID" initialize --admin "$ADMIN" >/dev/null

log "Initializing nft_collection"
invoke "$NFT_ID" initialize --admin "$ADMIN" >/dev/null

log "Initializing nft_pool"
invoke "$POOL_ID" initialize --admin "$ADMIN" >/dev/null

# --- link the contract pairs ------------------------------------------------
# Each link is one-directional and admin-gated, so both sides must opt in
# before a cross-contract call is accepted.
log "Linking swap_registry <-> fee_vault"
invoke "$REGISTRY_ID" set_fee_vault --caller "$ADMIN" --vault "$VAULT_ID" >/dev/null
invoke "$VAULT_ID" set_registry --registry "$REGISTRY_ID" >/dev/null

log "Linking nft_collection <-> nft_pool"
invoke "$NFT_ID" set_pool --caller "$ADMIN" --pool "$POOL_ID" >/dev/null
invoke "$POOL_ID" set_collection --caller "$ADMIN" --collection "$NFT_ID" >/dev/null

# --- verify -----------------------------------------------------------------
log "Verifying the links"
LINKED_VAULT="$(invoke "$REGISTRY_ID" fee_vault | tr -d '"')"
LINKED_REG="$(invoke "$VAULT_ID" registry | tr -d '"')"
[[ "$LINKED_VAULT" == "$VAULT_ID" ]] || die "registry points at $LINKED_VAULT, expected $VAULT_ID"
[[ "$LINKED_REG" == "$REGISTRY_ID" ]] || die "vault points at $LINKED_REG, expected $REGISTRY_ID"

LINKED_POOL="$(invoke "$NFT_ID" pool | tr -d '"')"
LINKED_COLL="$(invoke "$POOL_ID" collection | tr -d '"')"
[[ "$LINKED_POOL" == "$POOL_ID" ]] || die "collection points at $LINKED_POOL, expected $POOL_ID"
[[ "$LINKED_COLL" == "$NFT_ID" ]] || die "pool points at $LINKED_COLL, expected $NFT_ID"

FEE_PREVIEW="$(invoke "$REGISTRY_ID" preview_fee --user "$ADMIN" --amount 1000000000)"
log "preview_fee(100 units) -> $FEE_PREVIEW"
log "nft total_supply       -> $(invoke "$NFT_ID" total_supply)"
log "nft_pool size          -> $(invoke "$POOL_ID" size)"

case "$NETWORK" in
  testnet)  PASSPHRASE="Test SDF Network ; September 2015"
            RPC="https://soroban-testnet.stellar.org"
            HORIZON="https://horizon-testnet.stellar.org" ;;
  mainnet|public)
            PASSPHRASE="Public Global Stellar Network ; September 2015"
            RPC="https://soroban-rpc.mainnet.stellar.gateway.fm"
            HORIZON="https://horizon.stellar.org" ;;
  *)        PASSPHRASE="unknown"; RPC="unknown"; HORIZON="unknown" ;;
esac

jq -n \
  --arg network "$NETWORK" \
  --arg passphrase "$PASSPHRASE" \
  --arg rpc "$RPC" \
  --arg horizon "$HORIZON" \
  --arg registry "$REGISTRY_ID" \
  --arg vault "$VAULT_ID" \
  --arg nft "$NFT_ID" \
  --arg pool "$POOL_ID" \
  --arg admin "$ADMIN" \
  --argjson baseFee "$BASE_FEE_BPS" \
  --argjson discountFee "$DISCOUNT_FEE_BPS" \
  '{
    network: $network,
    networkPassphrase: $passphrase,
    rpcUrl: $rpc,
    horizonUrl: $horizon,
    contracts: {
      swap_registry: $registry,
      fee_vault: $vault,
      nft_collection: $nft,
      nft_pool: $pool
    },
    admin: $admin,
    feePolicy: { baseFeeBps: $baseFee, discountFeeBps: $discountFee },
    explorer: {
      swap_registry: "https://stellar.expert/explorer/\($network)/contract/\($registry)",
      fee_vault: "https://stellar.expert/explorer/\($network)/contract/\($vault)",
      nft_collection: "https://stellar.expert/explorer/\($network)/contract/\($nft)",
      nft_pool: "https://stellar.expert/explorer/\($network)/contract/\($pool)"
    }
  }' > "$OUT"

log "Wrote $OUT"
cat "$OUT"

cat <<EOF

Next: point the frontend at these addresses.

  frontend/.env.local
    VITE_CONTRACT_ID=$REGISTRY_ID
    VITE_FEE_VAULT_ID=$VAULT_ID
    VITE_NFT_COLLECTION_ID=$NFT_ID
    VITE_NFT_POOL_ID=$POOL_ID
EOF
