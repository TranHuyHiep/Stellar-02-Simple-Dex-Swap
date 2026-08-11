import { useState } from 'react'
import type { Connection } from '../lib/wallet'

function short(addr: string) {
  return `${addr.slice(0, 5)}…${addr.slice(-5)}`
}

export function WalletBar({
  conn,
  paused,
  totalSwaps,
  onConnect,
  onDisconnect,
  onDevKey,
  onCreateDevKey,
  busy,
}: {
  conn: Connection | null
  paused: boolean | null
  totalSwaps: number | null
  onConnect: () => void
  onDisconnect: () => void
  onDevKey: (secret: string) => void
  onCreateDevKey: () => void
  busy?: boolean
}) {
  const [showDev, setShowDev] = useState(false)
  const [secret, setSecret] = useState('')

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">⇄</span>
        <div>
          <h1>Stellar DEX Swap</h1>
          <p className="brand-sub">
            testnet · orderbook swaps recorded by a Soroban registry
          </p>
        </div>
      </div>

      <div className="topbar-right">
        <div className="stats">
          <span className="stat">
            <em>{totalSwaps ?? '—'}</em> swaps recorded
          </span>
          {paused && <span className="pill pill--warn">registry paused</span>}
        </div>

        {conn ? (
          <div className="conn">
            <span className="conn-badge" title={conn.address}>
              <span className="dot" /> {short(conn.address)}
              {conn.walletName ? ` · ${conn.walletName}` : ''}
            </span>
            <button className="btn btn--ghost" onClick={onDisconnect}>
              Disconnect
            </button>
          </div>
        ) : (
          <div className="conn">
            <button className="btn btn--primary" onClick={onConnect} disabled={busy}>
              Connect wallet
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => setShowDev((s) => !s)}
              disabled={busy}
            >
              Dev key
            </button>
          </div>
        )}
      </div>

      {showDev && !conn && (
        <div className="devkey">
          <p className="muted">
            Testnet only — paste a secret key (S…) or generate a funded one.
          </p>
          <div className="devkey-row">
            <input
              type="password"
              placeholder="S… testnet secret key"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              spellCheck={false}
            />
            <button
              className="btn btn--primary"
              onClick={() => onDevKey(secret)}
              disabled={!secret || busy}
            >
              Use key
            </button>
            <button className="btn btn--ghost" onClick={onCreateDevKey} disabled={busy}>
              {busy ? 'Funding…' : 'Create + fund'}
            </button>
          </div>
        </div>
      )}
    </header>
  )
}
