import { gatewayUrl } from '../lib/ipfs'
import type { NftMeta } from '../lib/nft'

type Action = {
  label: string
  onClick: (tokenId: number) => void
  disabled?: boolean
  /** When given, the action only renders for items it returns true for. */
  enabledFor?: (m: NftMeta) => boolean
}

export function NftGallery({
  title,
  items,
  loading,
  empty,
  badge,
  action,
}: {
  title: string
  items: NftMeta[]
  loading?: boolean
  empty: string
  badge?: string
  action?: Action
}) {
  return (
    <section className="card" aria-label={title}>
      <header className="card-head">
        <h2>{title}</h2>
        {badge && <span className="pill">{badge}</span>}
      </header>

      {loading && items.length === 0 ? (
        <div className="nft-grid" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div className="nft-card" key={i}>
              <div className="skeleton nft-thumb" />
              <div className="skeleton sk-cell" style={{ margin: '8px 10px' }} />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="ob-empty">{empty}</p>
      ) : (
        <ul className="nft-grid">
          {items.map((m) => {
            const showAction = action && (!action.enabledFor || action.enabledFor(m))
            return (
              <li className="nft-card" key={m.tokenId}>
                <a
                  href={gatewayUrl(m.cid)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open on the IPFS gateway"
                >
                  <img
                    className="nft-thumb"
                    src={gatewayUrl(m.cid)}
                    alt={m.name}
                    loading="lazy"
                    // A CID that was never pinned will not resolve; show the
                    // placeholder rather than a broken-image icon.
                    onError={(e) => {
                      e.currentTarget.style.visibility = 'hidden'
                    }}
                  />
                </a>
                <div className="nft-body">
                  <div className="nft-title">
                    <strong title={m.name}>{m.name}</strong>
                    <span className="muted">#{m.tokenId}</span>
                  </div>
                  {m.description && <p className="nft-desc">{m.description}</p>}
                  {showAction && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => action!.onClick(m.tokenId)}
                      disabled={action!.disabled}
                    >
                      {action!.label}
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
