import { Horizon, Asset } from '@stellar/stellar-sdk'
import { HORIZON_URL } from './config'
import { SwapError } from './errors'

export const horizon = new Horizon.Server(HORIZON_URL)

export type OrderBookLevel = { price: number; amount: number; total: number }
export type OrderBook = {
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  spread: number | null
  spreadPct: number | null
  mid: number | null
}

/** Cumulative depth, so the UI can draw depth bars. */
function withTotals(
  levels: { price: string; amount: string }[],
): OrderBookLevel[] {
  let running = 0
  return levels.map((l) => {
    const amount = Number(l.amount)
    running += amount
    return { price: Number(l.price), amount, total: running }
  })
}

/**
 * Live orderbook straight from the Stellar DEX.
 * `selling` is the asset being sold, `buying` the asset being bought.
 */
export async function fetchOrderBook(
  selling: Asset,
  buying: Asset,
  limit = 12,
): Promise<OrderBook> {
  const res = await horizon.orderbook(selling, buying).limit(limit).call()

  const bids = withTotals(res.bids ?? [])
  const asks = withTotals(res.asks ?? [])

  const bestBid = bids[0]?.price ?? null
  const bestAsk = asks[0]?.price ?? null
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null
  const mid = bestBid !== null && bestAsk !== null ? (bestAsk + bestBid) / 2 : null
  const spreadPct = spread !== null && mid ? (spread / mid) * 100 : null

  return { bids, asks, spread, spreadPct, mid }
}

export type Quote = {
  destAmount: string
  path: Asset[]
  sourceAmount: string
}

/**
 * Ask Horizon what this sell amount actually yields across DEX paths.
 * This is the real quote the swap will execute against.
 */
export async function fetchQuote(
  from: Asset,
  to: Asset,
  amount: string,
): Promise<Quote> {
  const res = await horizon
    .strictSendPaths(from, amount, [to])
    .call()

  const best = res.records?.[0]
  if (!best) {
    throw new SwapError(
      'network',
      'No DEX path found for this pair/amount. Try a smaller amount or another pair.',
    )
  }

  const path = (best.path ?? []).map((p) =>
    p.asset_type === 'native'
      ? Asset.native()
      : new Asset(p.asset_code!, p.asset_issuer!),
  )

  return {
    destAmount: best.destination_amount,
    sourceAmount: best.source_amount,
    path,
  }
}

export type BalanceLine = { code: string; issuer?: string; balance: string }

export async function fetchBalances(accountId: string): Promise<BalanceLine[]> {
  const acct = await horizon.loadAccount(accountId)
  return acct.balances.map((b) => {
    if (b.asset_type === 'native') return { code: 'XLM', balance: b.balance }
    const line = b as Horizon.HorizonApi.BalanceLineAsset
    return { code: line.asset_code, issuer: line.asset_issuer, balance: line.balance }
  })
}

/** Stream trades for a pair so the UI reflects DEX activity in real time. */
export function streamTrades(
  selling: Asset,
  buying: Asset,
  onTrade: (t: Horizon.ServerApi.TradeRecord) => void,
): () => void {
  return horizon
    .trades()
    .forAssetPair(selling, buying)
    .cursor('now')
    .stream({
      onmessage: (t) => onTrade(t as Horizon.ServerApi.TradeRecord),
      onerror: () => {
        /* Horizon SSE reconnects on its own; surfaced via the connection pill. */
      },
    })
}
