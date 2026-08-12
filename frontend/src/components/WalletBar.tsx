import { useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useWallet } from '../useWallet'

function short(addr: string) {
  return `${addr.slice(0, 5)}…${addr.slice(-5)}`
}

/**
 * Shared header: brand, page nav, per-page stats slot, and the wallet controls.
 * The connection itself lives in WalletContext so it survives navigation.
 */
export function WalletBar({ stats }: { stats?: ReactNode }) {
  const { conn, busy, error, connect, disconnect, applyDevKey, createDevKey } = useWallet()
  const [showDev, setShowDev] = useState(false)
  const [secret, setSecret] = useState('')

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          ⇄
        </span>
        <div>
          <h1>Stellar Studio</h1>
          <p className="brand-sub">testnet · DEX swaps and NFT minting on Soroban</p>
        </div>
      </div>

      <nav className="nav" aria-label="Pages">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'nav-link nav-link--on' : 'nav-link')}>
          Swap
        </NavLink>
        <NavLink to="/mint" className={({ isActive }) => (isActive ? 'nav-link nav-link--on' : 'nav-link')}>
          Mint NFT
        </NavLink>
      </nav>

      <div className="topbar-right">
        {stats && <div className="stats">{stats}</div>}

        {conn ? (
          <div className="conn">
            <span className="conn-badge" title={conn.address}>
              <span className="dot" /> {short(conn.address)}
              {conn.walletName ? ` · ${conn.walletName}` : ''}
            </span>
            <button className="btn btn--ghost" onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        ) : (
          <div className="conn">
            <button
              className="btn btn--primary"
              onClick={() => void connect()}
              disabled={busy}
              aria-busy={busy ? true : undefined}
            >
              {busy && <span className="spinner" />}
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
              onClick={() => applyDevKey(secret)}
              disabled={!secret || busy}
            >
              Use key
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => void createDevKey()}
              disabled={busy}
            >
              {busy ? 'Funding…' : 'Create + fund'}
            </button>
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error.message}
            </p>
          )}
        </div>
      )}
    </header>
  )
}
