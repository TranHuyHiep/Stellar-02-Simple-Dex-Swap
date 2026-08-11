import { Asset } from '@stellar/stellar-sdk'

export const NETWORK = 'TESTNET' as const
export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
export const HORIZON_URL = 'https://horizon-testnet.stellar.org'
export const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'
/** Testnet Friendbot (friendbot.stellar.org resolves to the same service). */
export const FRIENDBOT_URL = 'https://friendbot-testnet.stellar.org'

/** Deployed swap_registry contract (see deployment.json at the repo root). */
export const CONTRACT_ID = 'CDYQ4AGHIHHHTRYN36FKXZM53VAGFD4NGMUZLOM4XPRTRZMEQPZC3BEY'

export const EXPLORER_TX = (hash: string) =>
  `https://stellar.expert/explorer/testnet/tx/${hash}`
export const EXPLORER_CONTRACT = (id: string) =>
  `https://stellar.expert/explorer/testnet/contract/${id}`

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
