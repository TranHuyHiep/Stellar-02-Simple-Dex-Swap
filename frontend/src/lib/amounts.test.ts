import { describe, expect, it } from 'vitest'
import { fromStroops, toStroops } from './contract'
import { applySlippage } from './swap'

describe('toStroops', () => {
  it('scales whole units by 1e7', () => {
    expect(toStroops('1')).toBe(10_000_000n)
    expect(toStroops('100')).toBe(1_000_000_000n)
  })

  it('handles fractional input', () => {
    expect(toStroops('0.5')).toBe(5_000_000n)
    expect(toStroops('1.2345678')).toBe(12_345_678n)
  })

  it('truncates beyond 7 decimals rather than rounding up', () => {
    // Rounding up could push min_out above what the DEX will deliver.
    expect(toStroops('1.23456789')).toBe(12_345_678n)
  })

  it('pads short fractions correctly', () => {
    expect(toStroops('1.1')).toBe(11_000_000n)
    expect(toStroops('1.01')).toBe(10_100_000n)
  })

  it('treats an empty whole part as zero', () => {
    expect(toStroops('.5')).toBe(5_000_000n)
  })

  it('handles zero', () => {
    expect(toStroops('0')).toBe(0n)
  })
})

describe('fromStroops', () => {
  it('inverts toStroops for whole units', () => {
    expect(fromStroops(10_000_000n)).toBe('1')
    expect(fromStroops(1_000_000_000n)).toBe('100')
  })

  it('trims trailing zeros in the fraction', () => {
    expect(fromStroops(5_000_000n)).toBe('0.5')
    expect(fromStroops(11_000_000n)).toBe('1.1')
  })

  it('keeps significant decimals', () => {
    expect(fromStroops(12_345_678n)).toBe('1.2345678')
  })

  it('accepts strings and numbers', () => {
    expect(fromStroops('10000000')).toBe('1')
    expect(fromStroops(10_000_000)).toBe('1')
  })

  it('round-trips through toStroops', () => {
    for (const v of ['1', '0.5', '1.2345678', '100', '0.0000001']) {
      expect(fromStroops(toStroops(v))).toBe(v)
    }
  })
})

describe('applySlippage', () => {
  it('reduces the quote by the tolerance', () => {
    expect(Number(applySlippage('100', 1))).toBeCloseTo(99, 7)
    expect(Number(applySlippage('100', 5))).toBeCloseTo(95, 7)
  })

  it('returns the full amount at zero slippage', () => {
    expect(Number(applySlippage('44.8906481', 0))).toBeCloseTo(44.8906481, 7)
  })

  it('emits at most 7 decimals, matching Stellar precision', () => {
    const out = applySlippage('1.2345678', 3)
    expect(out.split('.')[1]?.length ?? 0).toBeLessThanOrEqual(7)
  })

  it('is defensive about non-numeric input', () => {
    expect(applySlippage('not a number', 1)).toBe('0')
  })

  it('never exceeds the input quote', () => {
    for (const pct of [0.5, 1, 3, 5, 10]) {
      expect(Number(applySlippage('100', pct))).toBeLessThanOrEqual(100)
    }
  })
})
