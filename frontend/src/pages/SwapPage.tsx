import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SwapForm } from '../components/SwapForm'
import { OrderBookView } from '../components/OrderBookView'
import { TxStatus, type TxState } from '../components/TxStatus'
import { EventFeed } from '../components/EventFeed'
import { WalletBar } from '../components/WalletBar'
import {
  TOKENS,
  assetKey,
  toAsset,
  type TokenDef,
  MAX_SLIPPAGE_BPS,
  MAX_SWAP_AMOUNT,
  isValidAssetCode,
} from '../lib/config'
import {
  fetchBalances,
  fetchOrderBook,
  fetchQuote,
  type OrderBook,
  type Quote,
} from '../lib/horizon'
import { SwapError, toSwapError } from '../lib/errors'
import {
  fetchSwapEvents,
  readPaused,
  readTotalSwaps,
  recordSwap,
  type ContractEvent,
} from '../lib/contract'
import { applySlippage, ensureTrustline, submitPathPayment } from '../lib/swap'
import { useWallet } from '../useWallet'

export default function SwapPage() {
  const { conn } = useWallet()

  const [sell, setSell] = useState<TokenDef>(TOKENS[0])
  const [buy, setBuy] = useState<TokenDef>(TOKENS[1])
  const [amount, setAmount] = useState('')
  const [slippage, setSlippage] = useState(1)

  const [book, setBook] = useState<OrderBook | null>(null)
  const [bookLoading, setBookLoading] = useState(false)
  const [bookError, setBookError] = useState<string | null>(null)

  const [quote, setQuote] = useState<Quote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)

  const [balances, setBalances] = useState<Record<string, string>>({})
  const [tx, setTx] = useState<TxState>({ phase: 'idle' })
  const [validation, setValidation] = useState<string | null>(null)

  const [events, setEvents] = useState<ContractEvent[]>([])
  const [latestLedger, setLatestLedger] = useState<number | null>(null)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [feedLoading, setFeedLoading] = useState(true)

  const [totalSwaps, setTotalSwaps] = useState<number | null>(null)
  const [paused, setPaused] = useState<boolean | null>(null)

  const sellAsset = useMemo(() => toAsset(sell), [sell])
  const buyAsset = useMemo(() => toAsset(buy), [buy])

  // --- Registry state ---------------------------------------------------
  const refreshRegistry = useCallback(async () => {
    try {
      const [t, p] = await Promise.all([readTotalSwaps(), readPaused()])
      setTotalSwaps(t)
      setPaused(p)
    } catch {
      /* the pill simply stays blank if the RPC is unavailable */
    }
  }, [])

  useEffect(() => {
    void refreshRegistry()
  }, [refreshRegistry])

  // --- Live orderbook ---------------------------------------------------
  useEffect(() => {
    let cancelled = false

    const tick = async () => {
      if (assetKey(sell) === assetKey(buy)) {
        setBook(null)
        setBookError('Pick two different assets to see an orderbook.')
        return
      }
      setBookLoading(true)
      try {
        const b = await fetchOrderBook(sellAsset, buyAsset)
        if (!cancelled) {
          setBook(b)
          setBookError(null)
        }
      } catch (e) {
        if (!cancelled) setBookError(toSwapError(e).message)
      } finally {
        if (!cancelled) setBookLoading(false)
      }
    }

    void tick()
    const timer = window.setInterval(tick, 6000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sellAsset, buyAsset, sell, buy])

  // --- Live contract events --------------------------------------------
  useEffect(() => {
    let cancelled = false

    const tick = async () => {
      try {
        const { events: evs, latestLedger: ll } = await fetchSwapEvents()
        if (!cancelled) {
          setEvents(evs.slice(-25).reverse())
          setLatestLedger(ll)
          setFeedError(null)
        }
      } catch (e) {
        if (!cancelled) setFeedError(toSwapError(e).message)
      } finally {
        // After the first poll, an empty list means "no swaps yet" rather than
        // "still loading", so the skeleton must stop either way.
        if (!cancelled) setFeedLoading(false)
      }
    }

    void tick()
    const timer = window.setInterval(tick, 7000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  // --- Balances ---------------------------------------------------------
  const refreshBalances = useCallback(async (address: string) => {
    try {
      const lines = await fetchBalances(address)
      const map: Record<string, string> = {}
      for (const l of lines) {
        map[l.issuer ? `${l.code}:${l.issuer}` : 'native'] = l.balance
      }
      setBalances(map)
    } catch {
      setBalances({})
    }
  }, [])

  useEffect(() => {
    if (conn) void refreshBalances(conn.address)
    else setBalances({})
  }, [conn, refreshBalances])

  // --- Quote (debounced) ------------------------------------------------
  const quoteSeq = useRef(0)
  useEffect(() => {
    const seq = ++quoteSeq.current
    const n = Number(amount)
    if (!amount || !Number.isFinite(n) || n <= 0 || assetKey(sell) === assetKey(buy)) {
      setQuote(null)
      setQuoteError(null)
      return
    }

    setQuoting(true)
    const handle = window.setTimeout(async () => {
      try {
        const q = await fetchQuote(sellAsset, buyAsset, amount)
        if (quoteSeq.current === seq) {
          setQuote(q)
          setQuoteError(null)
        }
      } catch (e) {
        // A failed quote used to clear the field with no explanation, which
        // read as the app hanging. Say why instead.
        if (quoteSeq.current === seq) {
          setQuote(null)
          setQuoteError(toSwapError(e).message)
        }
      } finally {
        if (quoteSeq.current === seq) setQuoting(false)
      }
    }, 450)

    return () => window.clearTimeout(handle)
  }, [amount, sellAsset, buyAsset, sell, buy])

  const handleFlip = () => {
    setSell(buy)
    setBuy(sell)
    setQuote(null)
  }

  // --- The swap ---------------------------------------------------------
  const busy = ['validating', 'quoting', 'trustline', 'contract', 'dex', 'confirming'].includes(
    tx.phase,
  )

  const handleSwap = async () => {
    setValidation(null)

    // === Error class 1: client-side validation, before any network call ===
    if (!conn) {
      setValidation('Connect a wallet first.')
      return
    }
    const n = Number(amount)
    if (!amount || !Number.isFinite(n) || n <= 0) {
      setValidation('Enter an amount greater than zero.')
      return
    }
    if (n > MAX_SWAP_AMOUNT) {
      setValidation(
        `Amount above the registry limit of ${MAX_SWAP_AMOUNT.toLocaleString()} ${sell.code}.`,
      )
      return
    }
    if (assetKey(sell) === assetKey(buy)) {
      setValidation('Pick two different assets.')
      return
    }
    if (!isValidAssetCode(sell.code) || !isValidAssetCode(buy.code)) {
      setValidation('Asset codes must be 1–12 characters.')
      return
    }
    const bal = Number(balances[assetKey(sell)] ?? '0')
    if (n > bal) {
      setValidation(`Insufficient ${sell.code} balance (you have ${bal}).`)
      return
    }
    if (slippage * 100 > MAX_SLIPPAGE_BPS) {
      setValidation(`Slippage above the registry limit of ${MAX_SLIPPAGE_BPS / 100}%.`)
      return
    }

    try {
      setTx({ phase: 'quoting', message: 'Fetching the best DEX path…' })
      const fresh = await fetchQuote(sellAsset, buyAsset, amount)
      setQuote(fresh)

      const destMin = applySlippage(fresh.destAmount, slippage)
      if (Number(destMin) <= 0) {
        throw new SwapError(
          'validation',
          'Quote is too small to swap safely. Try a larger amount.',
        )
      }

      // Trustline for the destination asset, if needed.
      setTx({ phase: 'trustline', message: 'Checking trustlines…' })
      await ensureTrustline(conn, buyAsset, (m) =>
        setTx((s) => ({ ...s, phase: 'trustline', message: m })),
      )

      // === Error class 2: the deployed contract validates and records ===
      setTx({ phase: 'contract', message: 'Recording swap in the Soroban registry…' })
      const rec = await recordSwap(
        conn,
        {
          sellAsset: sell.code,
          buyAsset: buy.code,
          amountIn: amount,
          minOut: destMin,
        },
        (m) => setTx((s) => ({ ...s, phase: 'contract', message: m })),
      )

      setTx({
        phase: 'dex',
        message: 'Executing the swap on the Stellar DEX…',
        contractTx: rec.hash,
        swapIndex: rec.swapIndex,
      })

      // === Error class 3: network / DEX submission failures ===
      const dex = await submitPathPayment(
        conn,
        {
          sendAsset: sellAsset,
          destAsset: buyAsset,
          amount,
          destMin,
          path: fresh.path,
        },
        (m) => setTx((s) => ({ ...s, phase: 'confirming', message: m })),
      )

      setTx({
        phase: 'success',
        contractTx: rec.hash,
        dexTx: dex.hash,
        swapIndex: rec.swapIndex,
        received: fresh.destAmount,
        receivedCode: buy.code,
      })

      void refreshBalances(conn.address)
      void refreshRegistry()
    } catch (e) {
      setTx({ phase: 'error', error: toSwapError(e) })
    }
  }

  const submitLabel = !conn
    ? 'Connect wallet to swap'
    : busy
      ? 'Working…'
      : paused
        ? 'Registry paused'
        : `Swap ${sell.code} → ${buy.code}`

  return (
    <>
      <WalletBar
        stats={
          <>
            <span className="stat">
              <em>{totalSwaps ?? '—'}</em> swaps recorded
            </span>
            {paused && <span className="pill pill--warn">registry paused</span>}
          </>
        }
      />

      <main className="grid">
        <div className="col">
          <SwapForm
            sell={sell}
            buy={buy}
            amount={amount}
            slippage={slippage}
            quote={quote}
            quoting={quoting}
            balances={balances}
            disabled={busy || !conn || paused === true}
            onSell={setSell}
            onBuy={setBuy}
            onAmount={setAmount}
            onSlippage={setSlippage}
            onFlip={handleFlip}
            onSubmit={handleSwap}
            submitLabel={submitLabel}
            validation={validation ?? quoteError}
            busy={busy}
          />
          <TxStatus state={tx} onDismiss={() => setTx({ phase: 'idle' })} />
        </div>

        <div className="col">
          <OrderBookView
            book={book}
            loading={bookLoading}
            sellCode={sell.code}
            buyCode={buy.code}
            error={bookError}
          />
          <EventFeed
            events={events}
            latestLedger={latestLedger}
            error={feedError}
            loading={feedLoading}
            self={conn?.address}
          />
        </div>
      </main>
    </>
  )
}
