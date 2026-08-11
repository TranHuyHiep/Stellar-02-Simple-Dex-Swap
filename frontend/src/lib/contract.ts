import {
  Address,
  BASE_FEE,
  Contract,
  Horizon,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import { CONTRACT_ID, NETWORK_PASSPHRASE, SOROBAN_RPC_URL } from './config'
import { SwapError, toSwapError } from './errors'
import { horizon } from './horizon'
import { signXdr, type Connection } from './wallet'

export const server = new rpc.Server(SOROBAN_RPC_URL)
export const contract = new Contract(CONTRACT_ID)

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * True when the failure means "the node's view of the account is behind"
 * rather than a genuine problem with the swap: a stale sequence number, or an
 * account the node has not indexed yet. Both are fixed by re-reading and
 * rebuilding.
 */
function isStaleState(e: unknown): boolean {
  const raw = e instanceof Error ? e.message : String(e)
  return /tx_bad_seq|txBadSeq|tx_no_account|txNoAccount|Account not found/i.test(raw)
}

/**
 * Read the account from both the RPC and Horizon and keep the higher sequence
 * number — either index can lag mid-swap, and the stale one causes txBadSeq.
 */
type TxSource = ConstructorParameters<typeof TransactionBuilder>[0]

async function loadHighestSequence(address: string): Promise<TxSource> {
  const [viaRpc, viaHorizon] = await Promise.allSettled([
    server.getAccount(address),
    horizon.loadAccount(address),
  ])

  const candidates: TxSource[] = []
  if (viaRpc.status === 'fulfilled') candidates.push(viaRpc.value)
  if (viaHorizon.status === 'fulfilled') candidates.push(viaHorizon.value)

  if (candidates.length === 0) {
    throw viaRpc.status === 'rejected'
      ? viaRpc.reason
      : (viaHorizon as PromiseRejectedResult).reason
  }

  return candidates.reduce((best, c) =>
    BigInt(c.sequenceNumber()) > BigInt(best.sequenceNumber()) ? c : best,
  )
}

/** Poll until an index reports a sequence at or past `usedSeq`. */
async function waitForSequencePast(
  address: string,
  usedSeq: string,
  timeoutMs = 25_000,
): Promise<void> {
  const target = BigInt(usedSeq)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await delay(1200)
    try {
      const s = await loadHighestSequence(address)
      if (BigInt(s.sequenceNumber()) >= target) return
    } catch {
      /* keep polling */
    }
  }
}

/** Read-only contract call via simulation — no signature, no fee. */
async function simulateRead(method: string, ...args: xdr.ScVal[]) {
  const source = await horizon
    .loadAccount('GCZ2VHJ5X44SFOTKOOFX4LYL2YK242USUW43NTCK2ODQ3MODX2O4CZB4')
    .catch(() => null)
  if (!source) {
    throw new SwapError('network', 'Could not load a source account to simulate the read.')
  }

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    throw toSwapError(new Error(sim.error))
  }
  if (!sim.result?.retval) {
    throw new SwapError('unknown', `Contract read "${method}" returned nothing.`)
  }
  return scValToNative(sim.result.retval)
}

export async function readTotalSwaps(): Promise<number> {
  return Number(await simulateRead('total_swaps'))
}

export async function readPaused(): Promise<boolean> {
  return Boolean(await simulateRead('paused'))
}

export async function readMaxSlippageBps(): Promise<number> {
  return Number(await simulateRead('max_slippage_bps'))
}

export async function readUserSwaps(address: string): Promise<number> {
  return Number(
    await simulateRead('user_swaps', new Address(address).toScVal()),
  )
}

export type ContractSwapRecord = {
  user: string
  sell_asset: string
  buy_asset: string
  amount_in: bigint
  min_out: bigint
  ledger: number
}

export async function readHistory(address: string): Promise<ContractSwapRecord[]> {
  const raw = await simulateRead('history', new Address(address).toScVal())
  return (raw ?? []) as ContractSwapRecord[]
}

/** 7-decimal stroops, matching Stellar's amount scale. */
export function toStroops(amount: string): bigint {
  const [whole, frac = ''] = amount.split('.')
  const padded = (frac + '0000000').slice(0, 7)
  return BigInt(whole || '0') * 10_000_000n + BigInt(padded || '0')
}

export function fromStroops(v: bigint | string | number): string {
  const b = BigInt(v)
  const whole = b / 10_000_000n
  const frac = (b % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

export type InvokeResult = {
  hash: string
  swapIndex: number
}

/**
 * Call `record_swap` on the deployed contract: build → simulate → sign → send
 * → poll. Simulation is where the contract's typed errors surface, so a
 * rejected swap costs the user nothing.
 */
export async function recordSwap(
  conn: Connection,
  params: {
    sellAsset: string
    buyAsset: string
    amountIn: string
    minOut: string
  },
  onStatus?: (s: string) => void,
): Promise<InvokeResult> {
  const op = contract.call(
    'record_swap',
    new Address(conn.address).toScVal(),
    nativeToScVal(params.sellAsset, { type: 'string' }),
    nativeToScVal(params.buyAsset, { type: 'string' }),
    nativeToScVal(toStroops(params.amountIn), { type: 'i128' }),
    nativeToScVal(toStroops(params.minOut), { type: 'i128' }),
  )

  // A preceding transaction (e.g. the trustline) may not be visible to the RPC
  // yet, which shows up as txBadSeq or txNoAccount. Re-read the account and
  // rebuild rather than failing the swap.
  let sent: Awaited<ReturnType<typeof server.sendTransaction>> | null = null
  const attempts = 4

  for (let attempt = 0; attempt < attempts; attempt++) {
    onStatus?.('Loading account…')
    const source = await loadHighestSequence(conn.address).catch((e: unknown) => {
      if (attempt < attempts - 1 && isStaleState(e)) return null
      throw toSwapError(e)
    })
    if (!source) {
      await delay(1500)
      continue
    }

    const built = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(op)
      .setTimeout(60)
      .build()

    onStatus?.('Simulating on Soroban RPC…')
    const sim = await server.simulateTransaction(built)
    if (rpc.Api.isSimulationError(sim)) {
      // Typed contract errors (#3/#4/#5/#6) land here and are never retried:
      // the registry rejected the swap on its merits.
      if (attempt < attempts - 1 && isStaleState(new Error(sim.error))) {
        await delay(1500)
        continue
      }
      throw toSwapError(new Error(sim.error))
    }

    const prepared = rpc.assembleTransaction(built, sim).build()

    onStatus?.('Waiting for wallet signature…')
    const signed = await signXdr(conn, prepared.toXDR())
    const tx = TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE)

    onStatus?.('Submitting to the network…')
    const res = await server.sendTransaction(tx)
    if (res.status === 'ERROR') {
      const raw = JSON.stringify(res.errorResult ?? res)
      if (attempt < attempts - 1 && isStaleState(new Error(raw))) {
        // Wait for an index to advance past the sequence we just used instead
        // of sleeping a fixed interval and hoping.
        onStatus?.('Ledger state moved on — rebuilding…')
        await waitForSequencePast(conn.address, source.sequenceNumber())
        continue
      }
      throw toSwapError(new Error(raw))
    }
    sent = res
    break
  }

  if (!sent) {
    throw new SwapError(
      'network',
      'Could not submit the registry call — the network kept reporting stale account state. Please retry.',
    )
  }

  onStatus?.('Confirming…')
  let got = await server.getTransaction(sent.hash)
  const deadline = Date.now() + 45_000
  while (got.status === 'NOT_FOUND' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200))
    got = await server.getTransaction(sent.hash)
  }

  if (got.status === 'FAILED') {
    throw toSwapError(
      new Error(
        got.resultXdr?.toXDR('base64') ?? 'Contract invocation failed on-chain.',
      ),
    )
  }
  if (got.status === 'NOT_FOUND') {
    throw new SwapError(
      'network',
      'Timed out waiting for confirmation. The transaction may still land — check the explorer.',
      sent.hash,
    )
  }

  let swapIndex = 0
  try {
    if (got.returnValue) swapIndex = Number(scValToNative(got.returnValue))
  } catch {
    /* return value is best-effort */
  }

  return { hash: sent.hash, swapIndex }
}

export type ContractEvent = {
  id: string
  ledger: number
  user: string
  sellAsset: string
  buyAsset: string
  amountIn: string
  minOut: string
  swapIndex: number
  /** Fee rate the fee_vault quoted, in basis points. 0 when unlinked. */
  feeBps: number
  /** Absolute fee the vault quoted, in whole units. */
  feeAmount: string
}

function decodeSwapEvent(
  e: rpc.Api.EventResponse,
): ContractEvent | null {
  try {
    const topics = e.topic.map((t) => scValToNative(t))
    if (String(topics[0]) !== 'swap') return null
    const data = scValToNative(e.value) as Record<string, unknown>
    return {
      id: e.id,
      ledger: e.ledger,
      user: String(topics[1] ?? ''),
      sellAsset: String(data.sell_asset ?? ''),
      buyAsset: String(data.buy_asset ?? ''),
      amountIn: fromStroops(String(data.amount_in ?? '0')),
      minOut: fromStroops(String(data.min_out ?? '0')),
      swapIndex: Number(data.swap_index ?? 0),
      // Present only on events emitted after the fee_vault was linked.
      feeBps: Number(data.fee_bps ?? 0),
      feeAmount: fromStroops(String(data.fee_amount ?? '0')),
    }
  } catch {
    return null
  }
}

/**
 * Poll the RPC for `swap` events from our contract. Soroban RPC has no SSE, so
 * this is the real-time mechanism: a short poll over recent ledgers.
 */
export async function fetchSwapEvents(startLedger?: number): Promise<{
  events: ContractEvent[]
  latestLedger: number
}> {
  const latest = await server.getLatestLedger()
  // RPC retains a limited window; stay inside it.
  const from = Math.max(
    startLedger ?? latest.sequence - 8_000,
    latest.sequence - 16_000,
    1,
  )

  const res = await server.getEvents({
    startLedger: from,
    filters: [
      {
        type: 'contract',
        contractIds: [CONTRACT_ID],
        topics: [[xdr.ScVal.scvSymbol('swap').toXDR('base64'), '*']],
      },
    ],
    limit: 100,
  })

  const events = (res.events ?? [])
    .map(decodeSwapEvent)
    .filter((x): x is ContractEvent => x !== null)

  return { events, latestLedger: res.latestLedger ?? latest.sequence }
}

export { Networks, Horizon }
