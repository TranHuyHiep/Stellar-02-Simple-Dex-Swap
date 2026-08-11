import { TOKENS, assetKey, type TokenDef } from '../lib/config'
import type { Quote } from '../lib/horizon'

export function SwapForm({
  sell,
  buy,
  amount,
  slippage,
  quote,
  quoting,
  balances,
  disabled,
  onSell,
  onBuy,
  onAmount,
  onSlippage,
  onFlip,
  onSubmit,
  submitLabel,
  validation,
  busy,
}: {
  sell: TokenDef
  buy: TokenDef
  amount: string
  slippage: number
  quote: Quote | null
  quoting: boolean
  balances: Record<string, string>
  disabled: boolean
  onSell: (t: TokenDef) => void
  onBuy: (t: TokenDef) => void
  onAmount: (v: string) => void
  onSlippage: (v: number) => void
  onFlip: () => void
  onSubmit: () => void
  submitLabel: string
  validation?: string | null
  /** A swap is in flight; show a spinner on the submit button. */
  busy?: boolean
}) {
  const sellBal = balances[assetKey(sell)]
  const minReceived =
    quote && Number.isFinite(Number(quote.destAmount))
      ? ((Number(quote.destAmount) * (100 - slippage)) / 100).toFixed(7)
      : null

  const rate =
    quote && Number(amount) > 0
      ? (Number(quote.destAmount) / Number(amount)).toFixed(7)
      : null

  return (
    <section className="card swap" aria-label="Swap form">
      <header className="card-head">
        <h2>Swap</h2>
        <label className="slip">
          slippage
          <select
            value={slippage}
            onChange={(e) => onSlippage(Number(e.target.value))}
          >
            <option value={0.5}>0.5%</option>
            <option value={1}>1%</option>
            <option value={3}>3%</option>
            <option value={5}>5%</option>
            <option value={10}>10%</option>
          </select>
        </label>
      </header>

      <div className="field">
        <div className="field-head">
          <label htmlFor="sell-amount">You sell</label>
          {sellBal && (
            <button
              type="button"
              className="link-btn"
              onClick={() => onAmount(sellBal)}
              disabled={disabled}
            >
              balance {Number(sellBal).toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </button>
          )}
        </div>
        <div className="field-row">
          <input
            id="sell-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => onAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          />
          <select
            value={assetKey(sell)}
            onChange={(e) => {
              const t = TOKENS.find((x) => assetKey(x) === e.target.value)
              if (t) onSell(t)
            }}
            aria-label="Asset to sell"
          >
            {TOKENS.map((t) => (
              <option key={assetKey(t)} value={assetKey(t)}>
                {t.code}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flip-wrap">
        <button
          type="button"
          className="flip"
          onClick={onFlip}
          aria-label="Swap direction"
        >
          ↓↑
        </button>
      </div>

      <div className="field">
        <div className="field-head">
          <label htmlFor="buy-amount">You receive (estimated)</label>
          {quoting && (
            <span className="muted">
              <span className="spinner spinner--sm" /> quoting
            </span>
          )}
        </div>
        <div className="field-row">
          <input
            id="buy-amount"
            type="text"
            readOnly
            placeholder="0.0"
            value={quote?.destAmount ?? ''}
          />
          <select
            value={assetKey(buy)}
            onChange={(e) => {
              const t = TOKENS.find((x) => assetKey(x) === e.target.value)
              if (t) onBuy(t)
            }}
            aria-label="Asset to buy"
          >
            {TOKENS.map((t) => (
              <option key={assetKey(t)} value={assetKey(t)}>
                {t.code}
              </option>
            ))}
          </select>
        </div>
      </div>

      <dl className="quote-info">
        <div>
          <dt>Rate</dt>
          <dd>{rate ? `1 ${sell.code} ≈ ${rate} ${buy.code}` : '—'}</dd>
        </div>
        <div>
          <dt>Minimum received</dt>
          <dd>{minReceived ? `${minReceived} ${buy.code}` : '—'}</dd>
        </div>
        <div>
          <dt>Route</dt>
          <dd>
            {quote
              ? [sell.code, ...quote.path.map((p) => (p.isNative() ? 'XLM' : p.getCode())), buy.code].join(' → ')
              : '—'}
          </dd>
        </div>
      </dl>

      {validation && <p className="error-text" role="alert">{validation}</p>}

      <button
        className="btn btn--primary btn--block"
        onClick={onSubmit}
        disabled={disabled}
        aria-busy={busy ? true : undefined}
      >
        {busy && <span className="spinner" />}
        {submitLabel}
      </button>

      <p className="fineprint">
        Each swap is validated and recorded by the Soroban registry, then
        executed on the Stellar DEX as a strict-send path payment.
      </p>
    </section>
  )
}
