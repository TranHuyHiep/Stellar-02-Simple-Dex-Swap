import { describe, expect, it } from 'vitest'
import {
  CONTRACT_ERRORS,
  SwapError,
  contractErrorName,
  parseContractErrorCode,
  toSwapError,
} from './errors'

describe('parseContractErrorCode', () => {
  it('extracts the code from a Soroban host error', () => {
    expect(
      parseContractErrorCode('HostError: Error(Contract, #4)'),
    ).toBe(4)
  })

  it('handles the diagnostic-event form', () => {
    const raw =
      'error: transaction simulation failed: HostError: Error(Contract, #6)\n' +
      '0: [Diagnostic Event] topics:[error, Error(Contract, #6)]'
    expect(parseContractErrorCode(raw)).toBe(6)
  })

  it('returns undefined when there is no code', () => {
    expect(parseContractErrorCode('Failed to fetch')).toBeUndefined()
  })
})

describe('contractErrorName', () => {
  it('names the known codes', () => {
    expect(contractErrorName(3)).toBe('InvalidAmount')
    expect(contractErrorName(4)).toBe('SlippageTooHigh')
    expect(contractErrorName(5)).toBe('IdenticalAssets')
  })

  it('falls back for an unknown code', () => {
    expect(contractErrorName(99)).toContain('99')
  })
})

describe('toSwapError — contract errors', () => {
  // Every code the contract can return must map to a specific message, or the
  // UI degrades to "unexpected error".
  for (const code of Object.keys(CONTRACT_ERRORS).map(Number)) {
    it(`classifies contract error #${code}`, () => {
      const e = toSwapError(new Error(`HostError: Error(Contract, #${code})`))
      expect(e.kind).toBe('contract')
      expect(e.code).toBe(code)
      expect(e.message).toBe(CONTRACT_ERRORS[code])
      expect(e.detail).toContain(contractErrorName(code))
    })
  }
})

describe('toSwapError — network errors', () => {
  const cases: [string, RegExp][] = [
    ['Failed to fetch', /could not reach/i],
    ['NetworkError when attempting to fetch', /could not reach/i],
    ['{"transaction":"tx_bad_seq"}', /sequence number/i],
    ['{"transaction":"tx_no_account"}', /not indexed/i],
    ['{"operations":["op_under_dest_min"]}', /minimum received/i],
    ['{"operations":["op_no_trust"]}', /trustline/i],
    ['{"operations":["op_underfunded"]}', /insufficient balance/i],
    ['{"operations":["op_too_few_offers"]}', /liquidity/i],
    ['{"transaction":"tx_insufficient_fee"}', /fee too low/i],
  ]

  for (const [raw, pattern] of cases) {
    it(`classifies ${raw.slice(0, 40)}`, () => {
      const e = toSwapError(new Error(raw))
      expect(e.kind).toBe('network')
      expect(e.message).toMatch(pattern)
    })
  }
})

describe('toSwapError — wallet errors', () => {
  it('treats a rejected signature as a wallet error, not a failure', () => {
    const e = toSwapError(new Error('User declined the request'))
    expect(e.kind).toBe('wallet')
  })
})

describe('toSwapError — passthrough and fallback', () => {
  it('returns an existing SwapError untouched', () => {
    const original = new SwapError('validation', 'Pick two different assets.')
    expect(toSwapError(original)).toBe(original)
  })

  it('keeps the raw payload in detail when nothing matches', () => {
    const e = toSwapError(new Error('something entirely novel'))
    expect(e.kind).toBe('unknown')
    expect(e.detail).toContain('something entirely novel')
  })

  it('handles non-Error throwables', () => {
    const e = toSwapError('a bare string')
    expect(e).toBeInstanceOf(SwapError)
    expect(e.detail).toContain('a bare string')
  })
})
