import { EXPLORER_CONTRACT, NFT_COLLECTION_ID, NFT_POOL_ID } from '../lib/config'
import type { NftEvent } from '../lib/nft'

function short(addr: string) {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr
}

const KIND_LABEL: Record<NftEvent['kind'], string> = {
  mint: 'Minted',
  transfer: 'Transferred',
  deposit: 'Deposited',
  withdraw: 'Withdrawn',
}

export function NftEventFeed({
  events,
  latestLedger,
  error,
  loading,
  self,
}: {
  events: NftEvent[]
  latestLedger: number | null
  error?: string | null
  loading?: boolean
  self?: string
}) {
  return (
    <section className="card feed" aria-label="NFT contract event feed">
      <header className="card-head">
        <h2>NFT events</h2>
        <span className="pill pill--live">
          {latestLedger ? (
            `ledger ${latestLedger}`
          ) : (
            <>
              <span className="spinner spinner--sm" /> connecting
            </>
          )}
        </span>
      </header>

      <p className="feed-sub">
        Live from{' '}
        <a href={EXPLORER_CONTRACT(NFT_COLLECTION_ID)} target="_blank" rel="noreferrer">
          collection ↗
        </a>{' '}
        and{' '}
        <a href={EXPLORER_CONTRACT(NFT_POOL_ID)} target="_blank" rel="noreferrer">
          pool ↗
        </a>
      </p>

      {error ? (
        <p className="error-text">{error}</p>
      ) : loading && events.length === 0 ? (
        <div aria-busy="true" aria-label="Loading events">
          {Array.from({ length: 3 }).map((_, i) => (
            <div className="skeleton sk-feed" key={i} />
          ))}
        </div>
      ) : events.length === 0 ? (
        <p className="ob-empty">
          Nothing yet. Mint an NFT to see events appear here in real time.
        </p>
      ) : (
        <ul className="feed-list">
          {events.map((e) => (
            <li
              key={e.id}
              className={`feed-item ${self && e.actor === self ? 'feed-item--mine' : ''}`}
            >
              <div className="feed-row">
                <strong>
                  <span className={`tag tag--${e.kind}`}>{KIND_LABEL[e.kind]}</span> #
                  {e.tokenId}
                </strong>
                <span>{e.name ?? ''}</span>
              </div>
              <div className="feed-meta">
                <span title={e.actor}>{short(e.actor)}</span>
                {e.toPool && <span>→ pool</span>}
                {e.minted === false && <span>deposited</span>}
                {e.poolSize !== undefined && <span>pool {e.poolSize}</span>}
                <span>ledger {e.ledger}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
