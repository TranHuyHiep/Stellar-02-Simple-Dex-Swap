import { describe, expect, it } from 'vitest'
import { computeCidV1Raw, gatewayUrl, ipfsUri, validateImage } from './ipfs'

/** Minimal File stand-in: Vitest runs in node, where File may be unavailable. */
function fakeFile(bytes: number, type: string): File {
  return { size: bytes, type, name: 'x' } as File
}

describe('computeCidV1Raw', () => {
  it('matches the canonical IPFS CID for "hello world"', async () => {
    // `ipfs add --cid-version=1 --raw-leaves` on the bytes "hello world".
    // If this ever drifts, the CIDs we write on chain stop being real content
    // addresses, so the vector is pinned here deliberately.
    const cid = await computeCidV1Raw(new TextEncoder().encode('hello world'))
    expect(cid).toBe('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e')
  })

  it('produces the documented CIDv1 shape', async () => {
    const cid = await computeCidV1Raw(new Uint8Array([1, 2, 3]))
    // multibase 'b' + base32; raw+sha256 CIDs always start "bafkrei".
    expect(cid.startsWith('bafkrei')).toBe(true)
    expect(cid).toMatch(/^b[a-z2-7]+$/)
    expect(cid).toHaveLength(59)
  })

  it('is deterministic', async () => {
    const a = await computeCidV1Raw(new Uint8Array([9, 9, 9]))
    const b = await computeCidV1Raw(new Uint8Array([9, 9, 9]))
    expect(a).toBe(b)
  })

  it('differs for different content', async () => {
    const a = await computeCidV1Raw(new Uint8Array([1]))
    const b = await computeCidV1Raw(new Uint8Array([2]))
    expect(a).not.toBe(b)
  })

  it('handles empty input', async () => {
    const cid = await computeCidV1Raw(new Uint8Array([]))
    expect(cid.startsWith('bafkrei')).toBe(true)
  })

  it('fits the CID length bounds the contract enforces (10-128)', async () => {
    const cid = await computeCidV1Raw(new Uint8Array([1, 2, 3]))
    expect(cid.length).toBeGreaterThanOrEqual(10)
    expect(cid.length).toBeLessThanOrEqual(128)
  })
})

describe('ipfsUri / gatewayUrl', () => {
  it('builds the canonical ipfs:// form', () => {
    expect(ipfsUri('bafkreiabc')).toBe('ipfs://bafkreiabc')
  })

  it('builds a gateway URL without a double slash', () => {
    expect(gatewayUrl('bafkreiabc')).toMatch(/\/ipfs\/bafkreiabc$/)
    expect(gatewayUrl('bafkreiabc')).not.toContain('//bafkrei')
  })
})

describe('validateImage', () => {
  it('accepts a normal PNG', () => {
    expect(() => validateImage(fakeFile(1024, 'image/png'))).not.toThrow()
  })

  it('rejects a non-image type', () => {
    expect(() => validateImage(fakeFile(1024, 'application/pdf'))).toThrow(/Unsupported/i)
  })

  it('rejects an empty file', () => {
    expect(() => validateImage(fakeFile(0, 'image/png'))).toThrow(/empty/i)
  })

  it('rejects a file over the size limit', () => {
    expect(() => validateImage(fakeFile(6 * 1024 * 1024, 'image/png'))).toThrow(/limit/i)
  })

  it('accepts every documented image type', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']) {
      expect(() => validateImage(fakeFile(100, t))).not.toThrow()
    }
  })
})
