import { EXPLORER_TX } from '../lib/config'
import { KIND_LABEL, type SwapError } from '../lib/errors'

export type TxPhase =
  | 'idle'
  | 'validating'
  | 'quoting'
  | 'trustline'
  | 'contract'
  | 'dex'
  | 'confirming'
  | 'success'
  | 'error'

export type TxState = {
  phase: TxPhase
  message?: string
  contractTx?: string
  dexTx?: string
  swapIndex?: number
  received?: string
  receivedCode?: string
  error?: SwapError | null
}

const STEPS: { key: TxPhase; label: string }[] = [
  { key: 'validating', label: 'Validate' },
  { key: 'quoting', label: 'Quote' },
  { key: 'contract', label: 'Registry' },
  { key: 'dex', label: 'DEX swap' },
  { key: 'success', label: 'Done' },
]

const ORDER: TxPhase[] = [
  'idle',
  'validating',
  'quoting',
  'trustline',
  'contract',
  'dex',
  'confirming',
  'success',
]

function rank(p: TxPhase): number {
  const i = ORDER.indexOf(p)
  return i === -1 ? 0 : i
}

export function TxStatus({ state, onDismiss }: { state: TxState; onDismiss: () => void }) {
  if (state.phase === 'idle') return null

  const isError = state.phase === 'error'
  const current = rank(state.phase)

  return (
    <section
      className={`card tx tx--${isError ? 'error' : state.phase}`}
      aria-live="polite"
      aria-label="Transaction status"
    >
      <header className="card-head">
        <h2>Transaction status</h2>
        <button className="btn btn--ghost btn--sm" onClick={onDismiss}>
          Dismiss
        </button>
      </header>

      {!isError && (
        <ol className="steps">
          {STEPS.map((s) => {
            const r = rank(s.key)
            const done = current > r || state.phase === 'success'
            const active = current === r || (s.key === 'dex' && state.phase === 'confirming')
            return (
              <li
                key={s.key}
                className={`step ${done ? 'step--done' : ''} ${active ? 'step--active' : ''}`}
              >
                <span className="step-dot">{done ? '✓' : ''}</span>
                {s.label}
              </li>
            )
          })}
        </ol>
      )}

      {state.message && !isError && <p className="tx-msg">{state.message}</p>}

      {isError && state.error && (
        <div className="tx-error">
          <p className="tx-error-kind">
            {KIND_LABEL[state.error.kind]}
            {state.error.code !== undefined && ` · #${state.error.code}`}
          </p>
          <p className="tx-error-msg">{state.error.message}</p>
          {state.error.detail && (
            <details>
              <summary>Technical detail</summary>
              <pre>{state.error.detail}</pre>
            </details>
          )}
        </div>
      )}

      {state.phase === 'success' && (
        <p className="tx-msg tx-msg--ok">
          Swapped successfully
          {state.received && state.receivedCode
            ? ` — received ≈ ${state.received} ${state.receivedCode}`
            : ''}
          {state.swapIndex ? ` (registry swap #${state.swapIndex})` : ''}.
        </p>
      )}

      <div className="tx-links">
        {state.contractTx && (
          <a href={EXPLORER_TX(state.contractTx)} target="_blank" rel="noreferrer">
            Registry tx ↗
          </a>
        )}
        {state.dexTx && (
          <a href={EXPLORER_TX(state.dexTx)} target="_blank" rel="noreferrer">
            DEX swap tx ↗
          </a>
        )}
      </div>
    </section>
  )
}
