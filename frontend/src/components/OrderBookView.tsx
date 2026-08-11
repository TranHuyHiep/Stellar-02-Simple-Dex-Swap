import type { OrderBook } from '../lib/horizon'

type Props = {
  book: OrderBook | null
  loading: boolean
  sellCode: string
  buyCode: string
  error?: string | null
}

function Row({
  level,
  max,
  side,
}: {
  level: { price: number; amount: number; total: number }
  max: number
  side: 'bid' | 'ask'
}) {
  const pct = max > 0 ? (level.total / max) * 100 : 0
  return (
    <div className={`ob-row ob-row--${side}`}>
      <span className="ob-depth" style={{ width: `${pct}%` }} aria-hidden="true" />
      <span className="ob-price">{level.price.toFixed(7).replace(/0+$/, '').replace(/\.$/, '')}</span>
      <span className="ob-amount">{level.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
      <span className="ob-total">{level.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
    </div>
  )
}

/** Placeholder matching the real book's row grid, so nothing shifts on load. */
function OrderBookSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading orderbook">
      <div className="ob-head">
        <span>Price</span>
        <span>Amount</span>
        <span>Total</span>
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div className="sk-row" key={`a${i}`}>
          <span className="skeleton sk-cell" />
          <span className="skeleton sk-cell" />
          <span className="skeleton sk-cell" />
        </div>
      ))}
      <div className="ob-mid">
        <span className="skeleton sk-cell" style={{ width: 70 }} />
        <span className="skeleton sk-cell" style={{ width: 90 }} />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div className="sk-row" key={`b${i}`}>
          <span className="skeleton sk-cell" />
          <span className="skeleton sk-cell" />
          <span className="skeleton sk-cell" />
        </div>
      ))}
    </div>
  )
}

export function OrderBookView({ book, loading, sellCode, buyCode, error }: Props) {
  const maxTotal = Math.max(
    book?.bids.at(-1)?.total ?? 0,
    book?.asks.at(-1)?.total ?? 0,
  )

  return (
    <section className="card ob" aria-label="Stellar DEX orderbook">
      <header className="card-head">
        <h2>
          Orderbook <span className="muted">{sellCode}/{buyCode}</span>
        </h2>
        <span className="pill pill--live">
          {loading ? (
            <>
              <span className="spinner spinner--sm" /> refreshing
            </>
          ) : (
            'live from Horizon'
          )}
        </span>
      </header>

      {error ? (
        <p className="ob-empty error-text">{error}</p>
      ) : !book ? (
        <OrderBookSkeleton />
      ) : book.bids.length === 0 && book.asks.length === 0 ? (
        <p className="ob-empty">
          No open orders for this pair on testnet. Try XLM/USDC.
        </p>
      ) : (
        <>
          <div className="ob-head">
            <span>Price</span>
            <span>Amount</span>
            <span>Total</span>
          </div>

          <div className="ob-side">
            {[...book.asks].reverse().map((l, i) => (
              <Row key={`a${i}`} level={l} max={maxTotal} side="ask" />
            ))}
          </div>

          <div className="ob-mid">
            {book.mid !== null ? (
              <>
                <strong>{book.mid.toFixed(7).replace(/0+$/, '').replace(/\.$/, '')}</strong>
                <span className="muted">
                  spread{' '}
                  {book.spreadPct !== null ? `${book.spreadPct.toFixed(2)}%` : '—'}
                </span>
              </>
            ) : (
              <span className="muted">one-sided book</span>
            )}
          </div>

          <div className="ob-side">
            {book.bids.map((l, i) => (
              <Row key={`b${i}`} level={l} max={maxTotal} side="bid" />
            ))}
          </div>
        </>
      )}
    </section>
  )
}
