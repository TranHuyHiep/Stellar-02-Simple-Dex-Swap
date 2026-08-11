import { Asset } from '@stellar/stellar-sdk'

/**
 * Configuration is read from Vite env vars so a build can be pointed at a
 * different network or a fresh deployment without editing source. The defaults
 * match the addresses in `deployment.json` at the repo root, so a plain
 * `npm run dev` works with no `.env` file at all.
 */
function env(key: string, fallback: string): string {
  const v = import.meta.env?.[key]
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

export const NETWORK = env('VITE_NETWORK', 'testnet')
export const NETWORK_PASSPHRASE = env(
  'VITE_NETWORK_PASSPHRASE',
  'Test SDF Network ; September 2015',
)
export const HORIZON_URL = env('VITE_HORIZON_URL', 'https://horizon-testnet.stellar.org')
export const SOROBAN_RPC_URL = env(
  'VITE_SOROBAN_RPC_URL',
  'https://soroban-testnet.stellar.org',
)
/** Testnet Friendbot (friendbot.stellar.org resolves to the same service). */
export const FRIENDBOT_URL = env('VITE_FRIENDBOT_URL', 'https://friendbot-testnet.stellar.org')

/** Deployed swap_registry contract (see deployment.json at the repo root). */
export const CONTRACT_ID = env(
  'VITE_CONTRACT_ID',
  'CD3QTWMRPZCVCKYRLT6EDLBBLLLRKAR7WXXBJSRGX73B65FA7C4EPOFH',
)

/** Deployed fee_vault contract the registry delegates fee policy to. */
export const FEE_VAULT_ID = env(
  'VITE_FEE_VAULT_ID',
  'CAIGJ2FLWFDBDTEQILJIO32UGSQP5SJRI7ZON6XFI5JBGJDB657ZQ5AX',
)

export const EXPLORER_TX = (hash: string) =>
  `https://stellar.expert/explorer/${NETWORK}/tx/${hash}`
export const EXPLORER_CONTRACT = (id: string) =>
  `https://stellar.expert/explorer/${NETWORK}/contract/${id}`

/** Mirrors MAX_SLIPPAGE_BPS in the contract. */
export const MAX_SLIPPAGE_BPS = 1000

/**
 * Mirrors MAX_AMOUNT in the contract (1e12 stroops), expressed in whole units
 * of a 7-decimal asset.
 */
export const MAX_SWAP_AMOUNT = 100_000

/** Mirrors MAX_ASSET_CODE_LEN in the contract. */
export const MAX_ASSET_CODE_LEN = 12

/** A Stellar asset code is 1-12 characters. */
export const isValidAssetCode = (code: string): boolean =>
  code.length > 0 && code.length <= MAX_ASSET_CODE_LEN

export type TokenDef = {
  code: string
  issuer?: string
  label: string
}

/**
 * Testnet assets with real orderbook liquidity against XLM. The issuers below
 * are the well-known SDF testnet anchors used by the Stellar demo assets.
 */
export const TOKENS: TokenDef[] = [
  { code: 'XLM', label: 'XLM (native)' },
  {
    code: 'USDC',
    issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    label: 'USDC (SDF testnet)',
  },
  {
    code: 'EURC',
    issuer: 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO',
    label: 'EURC (SDF testnet)',
  },
]

export function toAsset(t: TokenDef): Asset {
  return t.issuer ? new Asset(t.code, t.issuer) : Asset.native()
}

export function assetKey(t: TokenDef): string {
  return t.issuer ? `${t.code}:${t.issuer}` : 'native'
}

export function findToken(key: string): TokenDef | undefined {
  return TOKENS.find((t) => assetKey(t) === key)
}
