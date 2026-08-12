import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import {
  NFT_COLLECTION_ID,
  NFT_POOL_ID,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
} from './config'
import { SwapError, toSwapError } from './errors'
import { horizon } from './horizon'
import { signXdr, type Connection } from './wallet'

const server = new rpc.Server(SOROBAN_RPC_URL)
export const collection = new Contract(NFT_COLLECTION_ID)
export const pool = new Contract(NFT_POOL_ID)

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Any funded account works as the envelope source for a read-only simulation. */
const READ_SOURCE = 'GCZ2VHJ5X44SFOTKOOFX4LYL2YK242USUW43NTCK2ODQ3MODX2O4CZB4'

/** Errors that mean an index is behind rather than the call being wrong. */
function isStaleState(e: unknown): boolean {
  const raw = e instanceof Error ? e.message : String(e)
  return /tx_bad_seq|txBadSeq|tx_no_account|txNoAccount|Account not found|Contract not found/i.test(
    raw,
  )
}

type TxSource = ConstructorParameters<typeof TransactionBuilder>[0]

/**
 * Read the account from both indexes and keep the higher sequence number.
 * Horizon and the RPC index ledgers independently; see lib/swap.ts.
 */
async function loadSource(address: string): Promise<TxSource> {
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

/** Read-only call via simulation: no signature, no fee. */
async function simulateRead(
  contract: Contract,
  method: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  // Simulation still needs a source account in the envelope even though
  // nothing is signed or submitted; the deployer works for that.
  const src = await server.getAccount(READ_SOURCE).catch(() => null)
  if (!src) {
    throw new SwapError('network', 'Could not load an account to simulate the read.')
  }

  const tx = new TransactionBuilder(src, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw toSwapError(new Error(sim.error))
  if (!sim.result?.retval) return null
  return scValToNative(sim.result.retval)
}

// --- reads -----------------------------------------------------------------

export type NftMeta = {
  tokenId: number
  owner: string
  name: string
  description: string
  cid: string
  creator: string
  ledger: number
}

function toMeta(raw: Record<string, unknown>): NftMeta {
  return {
    tokenId: Number(raw.token_id ?? 0),
    owner: String(raw.owner ?? ''),
    name: String(raw.name ?? ''),
    description: String(raw.description ?? ''),
    cid: String(raw.cid ?? ''),
    creator: String(raw.creator ?? ''),
    ledger: Number(raw.ledger ?? 0),
  }
}

export async function readTotalSupply(): Promise<number> {
  return Number((await simulateRead(collection, 'total_supply')) ?? 0)
}

export async function readPoolSize(): Promise<number> {
  return Number((await simulateRead(pool, 'size')) ?? 0)
}

export async function readMintingPaused(): Promise<boolean> {
  return Boolean(await simulateRead(collection, 'paused'))
}

export async function readPoolClosed(): Promise<boolean> {
  return Boolean(await simulateRead(pool, 'closed'))
}

export async function readMetadata(tokenId: number): Promise<NftMeta> {
  const raw = (await simulateRead(
    collection,
    'metadata_of',
    nativeToScVal(tokenId, { type: 'u32' }),
  )) as Record<string, unknown>
  return toMeta(raw)
}

export async function readTokensOf(address: string): Promise<number[]> {
  const raw = (await simulateRead(
    collection,
    'tokens_of',
    new Address(address).toScVal(),
  )) as unknown[]
  return (raw ?? []).map(Number)
}

export async function readPoolItems(): Promise<number[]> {
  const raw = (await simulateRead(pool, 'items')) as unknown[]
  return (raw ?? []).map(Number)
}

/**
 * Who deposited a token, which is who the pool will let withdraw it. This is
 * not the same as the token's creator: anyone may deposit an NFT they own.
 */
export async function readDepositor(tokenId: number): Promise<string | null> {
  const raw = await simulateRead(
    pool,
    'depositor_of',
    nativeToScVal(tokenId, { type: 'u32' }),
  )
  return raw ? String(raw) : null
}

/** Fetch metadata for several ids, skipping any that fail to read. */
export async function readManyMetadata(ids: number[]): Promise<NftMeta[]> {
  const settled = await Promise.allSettled(ids.map((id) => readMetadata(id)))
  return settled
    .filter((r): r is PromiseFulfilledResult<NftMeta> => r.status === 'fulfilled')
    .map((r) => r.value)
}

// --- writes ---------------------------------------------------------------

export type InvokeResult = { hash: string; returned: unknown }

/**
 * Build → simulate → sign → send → confirm, retrying while an index is behind.
 * Simulation is where the contract's typed errors surface, so a rejected call
 * costs the user nothing.
 */
async function invoke(
  conn: Connection,
  contract: Contract,
  method: string,
  args: xdr.ScVal[],
  onStatus?: (s: string) => void,
): Promise<InvokeResult> {
  const attempts = 4
  let sent: Awaited<ReturnType<typeof server.sendTransaction>> | null = null
  let built: ReturnType<TransactionBuilder['build']> | null = null

  for (let attempt = 0; attempt < attempts; attempt++) {
    onStatus?.('Loading account…')
    const source = await loadSource(conn.address).catch((e: unknown) => {
      if (attempt < attempts - 1 && isStaleState(e)) return null
      throw toSwapError(e)
    })
    if (!source) {
      await delay(1500)
      continue
    }

    built = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(60)
      .build()

    onStatus?.('Simulating…')
    const sim = await server.simulateTransaction(built)
    if (rpc.Api.isSimulationError(sim)) {
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

    onStatus?.('Submitting…')
    const res = await server.sendTransaction(tx)
    if (res.status === 'ERROR') {
      const raw = JSON.stringify(res.errorResult ?? res)
      if (attempt < attempts - 1 && isStaleState(new Error(raw))) {
        onStatus?.('Ledger moved on — rebuilding…')
        await delay(1500)
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
      'Could not submit the transaction — the network kept reporting stale state. Retry.',
    )
  }

  onStatus?.('Confirming…')
  let got = await server.getTransaction(sent.hash)
  const deadline = Date.now() + 45_000
  while (got.status === 'NOT_FOUND' && Date.now() < deadline) {
    await delay(1200)
    got = await server.getTransaction(sent.hash)
  }

  if (got.status === 'FAILED') {
    throw toSwapError(
      new Error(got.resultXdr?.toXDR('base64') ?? 'Contract invocation failed on-chain.'),
    )
  }
  if (got.status === 'NOT_FOUND') {
    throw new SwapError(
      'network',
      'Timed out waiting for confirmation. The transaction may still land — check the explorer.',
      sent.hash,
    )
  }

  let returned: unknown = null
  try {
    if (got.returnValue) returned = scValToNative(got.returnValue)
  } catch {
    /* best effort */
  }
  return { hash: sent.hash, returned }
}

export type MintParams = {
  name: string
  description: string
  cid: string
}

/** Mint an NFT owned by the connected account. */
export async function mintToSelf(
  conn: Connection,
  p: MintParams,
  onStatus?: (s: string) => void,
): Promise<{ hash: string; tokenId: number }> {
  const r = await invoke(
    conn,
    collection,
    'mint',
    [
      new Address(conn.address).toScVal(),
      nativeToScVal(p.name, { type: 'string' }),
      nativeToScVal(p.description, { type: 'string' }),
      nativeToScVal(p.cid, { type: 'string' }),
    ],
    onStatus,
  )
  return { hash: r.hash, tokenId: Number(r.returned ?? 0) }
}

/**
 * Mint an NFT straight into the pool. One transaction, two contracts: the
 * collection mints it owned by the pool and calls the pool's `on_deposit`.
 */
export async function mintToPool(
  conn: Connection,
  p: MintParams,
  onStatus?: (s: string) => void,
): Promise<{ hash: string; tokenId: number }> {
  const r = await invoke(
    conn,
    collection,
    'mint_to_pool',
    [
      new Address(conn.address).toScVal(),
      nativeToScVal(p.name, { type: 'string' }),
      nativeToScVal(p.description, { type: 'string' }),
      nativeToScVal(p.cid, { type: 'string' }),
    ],
    onStatus,
  )
  return { hash: r.hash, tokenId: Number(r.returned ?? 0) }
}

/** Deposit an NFT the account already owns into the pool. */
export async function addToPool(
  conn: Connection,
  tokenId: number,
  onStatus?: (s: string) => void,
): Promise<{ hash: string }> {
  const r = await invoke(
    conn,
    pool,
    'add',
    [new Address(conn.address).toScVal(), nativeToScVal(tokenId, { type: 'u32' })],
    onStatus,
  )
  return { hash: r.hash }
}

/** Withdraw an NFT the account deposited. */
export async function withdrawFromPool(
  conn: Connection,
  tokenId: number,
  onStatus?: (s: string) => void,
): Promise<{ hash: string }> {
  const r = await invoke(
    conn,
    pool,
    'withdraw',
    [new Address(conn.address).toScVal(), nativeToScVal(tokenId, { type: 'u32' })],
    onStatus,
  )
  return { hash: r.hash }
}

// --- events ---------------------------------------------------------------

export type NftEvent = {
  id: string
  ledger: number
  kind: 'mint' | 'transfer' | 'deposit' | 'withdraw'
  tokenId: number
  /** The event's indexed address: recipient, sender, or depositor. */
  actor: string
  name?: string
  cid?: string
  toPool?: boolean
  minted?: boolean
  poolSize?: number
}

function decode(e: rpc.Api.EventResponse): NftEvent | null {
  try {
    const topics = e.topic.map((t) => scValToNative(t))
    const kind = String(topics[0])
    if (!['mint', 'transfer', 'deposit', 'withdraw'].includes(kind)) return null
    const d = scValToNative(e.value) as Record<string, unknown>
    return {
      id: e.id,
      ledger: e.ledger,
      kind: kind as NftEvent['kind'],
      tokenId: Number(d.token_id ?? 0),
      actor: String(topics[1] ?? ''),
      name: d.name !== undefined ? String(d.name) : undefined,
      cid: d.cid !== undefined ? String(d.cid) : undefined,
      toPool: d.to_pool !== undefined ? Boolean(d.to_pool) : undefined,
      minted: d.minted !== undefined ? Boolean(d.minted) : undefined,
      poolSize: d.pool_size !== undefined ? Number(d.pool_size) : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Poll both NFT contracts for events. Soroban RPC has no SSE, so this short
 * poll over recent ledgers is the real-time mechanism.
 */
export async function fetchNftEvents(): Promise<{
  events: NftEvent[]
  latestLedger: number
}> {
  const latest = await server.getLatestLedger()
  const from = Math.max(latest.sequence - 8_000, 1)

  const res = await server.getEvents({
    startLedger: from,
    filters: [
      { type: 'contract', contractIds: [NFT_COLLECTION_ID] },
      { type: 'contract', contractIds: [NFT_POOL_ID] },
    ],
    limit: 100,
  })

  const events = (res.events ?? [])
    .map(decode)
    .filter((x): x is NftEvent => x !== null)

  return { events, latestLedger: res.latestLedger ?? latest.sequence }
}
