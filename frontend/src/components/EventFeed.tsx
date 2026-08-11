import type { ContractEvent } from '../lib/contract'
import { EXPLORER_CONTRACT } from '../lib/config'
import { CONTRACT_ID } from '../lib/config'

function short(addr: string) {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr
}

export function EventFeed({
  events,
  latestLedger,
  error,
  self,
}: {
  events: ContractEvent[]
  latestLedger: number | null
  error?: string | null
  self?: string
}) {
  return (
    <section className="card feed" aria-label="Contract event feed">
      <header className="card-head">
        <h2>Registry events</h2>
        <span className="pill pill--live">
          {latestLedger ? `ledger ${latestLedger}` : 'connecting…'}
        </span>
      </header>

      <p className="feed-sub">
        Live <code>swap</code> events from{' '}
        <a href={EXPLORER_CONTRACT(CONTRACT_ID)} target="_blank" rel="noreferrer">
          {short(CONTRACT_ID)} ↗
        </a>
      </p>

      {error ? (
        <p className="error-text">{error}</p>
      ) : events.length === 0 ? (
        <p className="ob-empty">
          No swaps recorded yet. Complete a swap to see its event appear here.
        </p>
      ) : (
        <ul className="feed-list">
          {events.map((e) => (
            <li
              key={e.id}
              className={`feed-item ${self && e.user === self ? 'feed-item--mine' : ''}`}
            >
              <div className="feed-row">
                <strong>#{e.swapIndex}</strong>
                <span>
                  {e.amountIn} {e.sellAsset} → {e.buyAsset}
                </span>
              </div>
              <div className="feed-meta">
                <span title={e.user}>{short(e.user)}</span>
                <span>min {e.minOut}</span>
                <span>ledger {e.ledger}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
