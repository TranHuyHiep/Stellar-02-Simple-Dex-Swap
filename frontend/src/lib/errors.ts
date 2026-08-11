/**
 * The three classes of failure this app handles explicitly, plus a fallback.
 *
 *  1. `contract`  - the Soroban registry rejected the swap (typed #N error)
 *  2. `validation` - caught in the UI before any network call
 *  3. `network`   - Horizon/RPC unreachable, or the DEX/tx submission failed
 */
export type SwapErrorKind = 'validation' | 'contract' | 'network' | 'wallet' | 'unknown'

export class SwapError extends Error {
  kind: SwapErrorKind
  detail?: string
  code?: number

  constructor(kind: SwapErrorKind, message: string, detail?: string, code?: number) {
    super(message)
    this.name = 'SwapError'
    this.kind = kind
    this.detail = detail
    this.code = code
  }
}

/** Contract error codes, mirroring the `Error` enum in contracts/swap_registry. */
export const CONTRACT_ERRORS: Record<number, string> = {
  1: 'Registry is not initialized yet.',
  2: 'Registry is already initialized.',
  3: 'Invalid amount — the sell amount must be greater than zero.',
  4: `Slippage too high — "minimum received" is below the registry's limit (max 10%).`,
  5: 'Identical assets — pick two different tokens to swap between.',
  6: 'Registry is paused by its admin. Swaps are temporarily disabled.',
  7: 'Amount too large — this registry records at most 100,000 units per swap.',
  8: 'Unauthorized — only the registry admin can perform that action.',
  9: 'Invalid asset — asset codes must be 1–12 characters.',
}

const CONTRACT_ERROR_NAMES: Record<number, string> = {
  1: 'NotInitialized',
  2: 'AlreadyInitialized',
  3: 'InvalidAmount',
  4: 'SlippageTooHigh',
  5: 'IdenticalAssets',
  6: 'RegistryPaused',
  7: 'AmountTooLarge',
  8: 'Unauthorized',
  9: 'InvalidAsset',
}

/** Pull `Error(Contract, #N)` out of a Soroban host error string. */
export function parseContractErrorCode(raw: string): number | undefined {
  const m =
    raw.match(/Error\(Contract,\s*#(\d+)\)/) ??
    raw.match(/HostError:\s*Error\(Contract,\s*#(\d+)\)/) ??
    raw.match(/#(\d+)/)
  return m ? Number(m[1]) : undefined
}

export function contractErrorName(code: number): string {
  return CONTRACT_ERROR_NAMES[code] ?? `Unknown(#${code})`
}

/**
 * Normalise anything thrown during a swap into a `SwapError` so the UI can
 * always render a specific, actionable message.
 */
export function toSwapError(e: unknown): SwapError {
  if (e instanceof SwapError) return e

  const raw = e instanceof Error ? e.message : String(e)

  // --- 1. Contract errors -------------------------------------------------
  const code = parseContractErrorCode(raw)
  if (code !== undefined && CONTRACT_ERRORS[code]) {
    return new SwapError(
      'contract',
      CONTRACT_ERRORS[code],
      `Contract error #${code} (${contractErrorName(code)})`,
      code,
    )
  }

  // --- 2. Wallet / signing ------------------------------------------------
  if (
    /user (declined|rejected)|denied|cancell?ed|closed the popup/i.test(raw) ||
    /Not connected to (Freighter|any wallet)/i.test(raw)
  ) {
    return new SwapError('wallet', 'Wallet request was rejected or cancelled.', raw)
  }

  // --- 3. Network / Horizon / RPC ----------------------------------------
  if (/Failed to fetch|NetworkError|ERR_NETWORK|timeout|ETIMEDOUT|502|503|504/i.test(raw)) {
    return new SwapError(
      'network',
      'Network error — could not reach Horizon or the Soroban RPC. Check your connection and retry.',
      raw,
    )
  }
  if (/op_under_dest_min|under_dest_min/i.test(raw)) {
    return new SwapError(
      'network',
      'Swap failed on the DEX: the path no longer delivers your minimum received. Refresh the orderbook and retry.',
      raw,
    )
  }
  if (/op_no_trust|no_trust/i.test(raw)) {
    return new SwapError(
      'network',
      'You need a trustline for the destination asset before you can receive it.',
      raw,
    )
  }
  // Checked before the balance case: `tx_insufficient_fee` also contains
  // "insufficient", so a looser balance pattern would swallow it.
  if (/tx_insufficient_fee|insufficient_fee/i.test(raw)) {
    return new SwapError('network', 'Network fee too low for current traffic. Retry.', raw)
  }
  if (/op_underfunded|underfunded|insufficient balance|insufficient funds/i.test(raw)) {
    return new SwapError('network', 'Insufficient balance for this swap (including fees).', raw)
  }
  if (/tx_bad_seq|txBadSeq/i.test(raw)) {
    return new SwapError(
      'network',
      'Sequence number was stale — please retry the swap.',
      raw,
    )
  }
  if (/tx_no_account|txNoAccount/i.test(raw)) {
    return new SwapError(
      'network',
      'The network has not indexed your account yet. Wait a few seconds and retry.',
      raw,
    )
  }
  if (/op_too_few_offers|too_few_offers/i.test(raw)) {
    return new SwapError(
      'network',
      'Not enough DEX liquidity to fill this swap. Try a smaller amount.',
      raw,
    )
  }
  if (/op_over_source_max|over_source_max/i.test(raw)) {
    return new SwapError(
      'network',
      'The path would cost more than your send amount. Refresh the quote and retry.',
      raw,
    )
  }
  if (/op_line_full|line_full/i.test(raw)) {
    return new SwapError(
      'network',
      'Destination trustline is full — it cannot receive this much of the asset.',
      raw,
    )
  }
  if (/op_no_issuer|no_issuer/i.test(raw)) {
    return new SwapError('network', 'The asset issuer no longer exists on this network.', raw)
  }
  if (/op_cross_self|cross_self/i.test(raw)) {
    return new SwapError(
      'network',
      'This swap would cross your own offer on the orderbook.',
      raw,
    )
  }
  if (/tx_too_late|too_late/i.test(raw)) {
    return new SwapError('network', 'Transaction expired before it was submitted. Retry.', raw)
  }
  if (/404|not.?found/i.test(raw)) {
    return new SwapError(
      'network',
      'Account or orderbook not found on testnet. Fund the account with Friendbot first.',
      raw,
    )
  }

  // Nothing matched. Surface the raw payload in `detail` so the cause is at
  // least diagnosable from the UI rather than silently swallowed.
  return new SwapError(
    'unknown',
    'Unexpected error while swapping. Expand the technical detail below to see what the network returned.',
    raw,
  )
}

export const KIND_LABEL: Record<SwapErrorKind, string> = {
  validation: 'Validation error',
  contract: 'Contract error',
  network: 'Network error',
  wallet: 'Wallet error',
  unknown: 'Error',
}
