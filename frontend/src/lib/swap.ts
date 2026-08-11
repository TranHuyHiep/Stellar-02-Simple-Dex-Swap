import {
  Asset,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE, SOROBAN_RPC_URL } from './config'
import { horizon } from './horizon'
import { toSwapError } from './errors'
import { signXdr, type Connection } from './wallet'

export type SubmitResult = {
  hash: string
  ledger?: number
}

const rpcServer = new rpc.Server(SOROBAN_RPC_URL)

/**
 * Anything TransactionBuilder accepts as a source. Soroban RPC returns an
 * `Account`; Horizon returns an `AccountResponse`. Both satisfy the builder.
 */
type TxSource = ConstructorParameters<typeof TransactionBuilder>[0]

/**
 * Load the account's current sequence number.
 *
 * Soroban RPC reads live ledger state, whereas Horizon only reflects a
 * submitted transaction after it has indexed the ledger it landed in. Since a
 * swap submits several transactions back to back, reading from Horizon here
 * would hand us a stale sequence and fail with txBadSeq. Horizon remains the
 * fallback in case the RPC is unavailable.
 */
async function loadSource(address: string): Promise<TxSource> {
  // Query both and take whichever reports the higher sequence number. Horizon
  // and the Soroban RPC index ledgers independently, so during a multi-
  // transaction swap either one can be the stale one. Trusting the maximum
  // avoids building on a sequence the network has already consumed.
  const [viaRpc, viaHorizon] = await Promise.allSettled([
    rpcServer.getAccount(address),
    horizon.loadAccount(address),
  ])

  const candidates: TxSource[] = []
  if (viaRpc.status === 'fulfilled') candidates.push(viaRpc.value)
  if (viaHorizon.status === 'fulfilled') candidates.push(viaHorizon.value)

  if (candidates.length === 0) {
    throw toSwapError(
      viaRpc.status === 'rejected' ? viaRpc.reason : (viaHorizon as PromiseRejectedResult).reason,
    )
  }

  return candidates.reduce((best, c) =>
    BigInt(c.sequenceNumber()) > BigInt(best.sequenceNumber()) ? c : best,
  )
}

function resultCode(e: unknown): string {
  const err = e as {
    response?: { data?: { extras?: { result_codes?: { transaction?: string } } } }
    message?: string
  }
  return `${err.response?.data?.extras?.result_codes?.transaction ?? ''} ${err.message ?? String(e)}`
}

/** True when Horizon/RPC rejected the transaction for a stale sequence. */
function isBadSeq(e: unknown): boolean {
  return /tx_bad_seq|txBadSeq/i.test(resultCode(e))
}

/** True when the node has not indexed the account yet. */
function isNoAccount(e: unknown): boolean {
  return /tx_no_account|txNoAccount|Account not found|404/i.test(resultCode(e))
}

/**
 * Poll both indexes until one reports a sequence number past `usedSeq`, so the
 * rebuild lands on a number the network has not already consumed.
 */
async function waitForSequencePast(
  address: string,
  usedSeq: string,
  timeoutMs = 25_000,
): Promise<void> {
  const target = BigInt(usedSeq)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200))
    try {
      const s = await loadSource(address)
      if (BigInt(s.sequenceNumber()) >= target) return
    } catch {
      /* keep polling */
    }
  }
}

/**
 * Submit a freshly built transaction, rebuilding once against a re-read
 * sequence number if the network says ours was stale.
 */
async function submitWithSeqRetry(
  conn: Connection,
  build: (source: TxSource) => ReturnType<TransactionBuilder["build"]>,
  onStatus?: (s: string) => void,
): Promise<SubmitResult> {
  const attempts = 5
  for (let attempt = 0; attempt < attempts; attempt++) {
    const source = await loadSource(conn.address)
    const usedSeq = source.sequenceNumber()
    const tx = build(source)
    const signed = await signXdr(conn, tx.toXDR())
    const readyTx = TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE)

    try {
      const res = await horizon.submitTransaction(readyTx)
      return { hash: res.hash, ledger: res.ledger }
    } catch (e) {
      const last = attempt === attempts - 1
      if (!last && (isBadSeq(e) || isNoAccount(e))) {
        // Both indexes can still be behind. Wait until one of them reports a
        // sequence past the one we just tried, rather than guessing a delay.
        onStatus?.('Sequence number moved on — rebuilding…')
        await waitForSequencePast(conn.address, usedSeq)
        continue
      }
      const err = e as {
        response?: { data?: { extras?: { result_codes?: unknown } } }
        message?: string
      }
      const codes = err.response?.data?.extras?.result_codes
      throw toSwapError(
        new Error(codes ? JSON.stringify(codes) : (err.message ?? String(e))),
      )
    }
  }
  throw toSwapError(new Error('tx_bad_seq: could not obtain a fresh sequence number.'))
}

/**
 * Execute the swap on the Stellar DEX with a strict-send path payment: sell
 * exactly `amount`, refusing to settle for less than `destMin`.
 */
export async function submitPathPayment(
  conn: Connection,
  params: {
    sendAsset: Asset
    destAsset: Asset
    amount: string
    destMin: string
    path: Asset[]
  },
  onStatus?: (s: string) => void,
): Promise<SubmitResult> {
  onStatus?.('Waiting for wallet signature…')
  return submitWithSeqRetry(
    conn,
    (source) =>
      new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.pathPaymentStrictSend({
            sendAsset: params.sendAsset,
            sendAmount: params.amount,
            destination: conn.address,
            destAsset: params.destAsset,
            destMin: params.destMin,
            path: params.path,
          }),
        )
        .setTimeout(90)
        .build(),
    onStatus,
  )
}

/** Ensure the account can hold the destination asset. */
export async function ensureTrustline(
  conn: Connection,
  asset: Asset,
  onStatus?: (s: string) => void,
): Promise<SubmitResult | null> {
  if (asset.isNative()) return null

  const account = await loadAccountWithRetry(conn.address)
  const has = account.balances.some(
    (b) =>
      'asset_code' in b &&
      b.asset_code === asset.getCode() &&
      b.asset_issuer === asset.getIssuer(),
  )
  if (has) return null

  onStatus?.(`Creating trustline for ${asset.getCode()}…`)
  const res = await submitWithSeqRetry(
    conn,
    (source) =>
      new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(Operation.changeTrust({ asset }))
        .setTimeout(60)
        .build(),
    onStatus,
  )

  // Do not return until the Soroban RPC can see the ledger this landed in.
  // Otherwise the next transaction is built on a sequence number the RPC has
  // not caught up to yet, and fails with txBadSeq / txNoAccount.
  onStatus?.('Waiting for the trustline to settle…')
  await waitForSequenceAtLeast(conn.address, account.sequenceNumber())
  return res
}

/**
 * Horizon can 404 an account that was only just funded. Poll briefly rather
 * than surfacing "account not found" for what is really propagation lag.
 */
async function loadAccountWithRetry(address: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      return await horizon.loadAccount(address)
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw toSwapError(last)
}

/**
 * Block until the RPC reports a sequence number strictly greater than the one
 * we last built on — i.e. our previous transaction is visible to it.
 */
async function waitForSequenceAtLeast(
  address: string,
  previousSeq: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const prev = BigInt(previousSeq)
  while (Date.now() < deadline) {
    try {
      const acct = await rpcServer.getAccount(address)
      if (BigInt(acct.sequenceNumber()) > prev) return
    } catch {
      /* not indexed yet — keep waiting */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  // Fall through: the caller's own retry loop is the backstop.
}

/** Apply a slippage tolerance (in %) to a quoted destination amount. */
export function applySlippage(destAmount: string, slippagePct: number): string {
  const v = Number(destAmount)
  if (!Number.isFinite(v)) return '0'
  return ((v * (100 - slippagePct)) / 100).toFixed(7)
}
