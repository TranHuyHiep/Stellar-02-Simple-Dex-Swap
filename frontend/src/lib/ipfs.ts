import { SwapError } from './errors'
import { IPFS_GATEWAY, PINATA_JWT } from './config'

/**
 * Image upload to IPFS.
 *
 * With a Pinata JWT configured the file is pinned for real and the returned CID
 * is the one Pinata reports. Without a key the file is not uploaded, but we
 * still derive a genuine CIDv1 from its bytes — the same identifier any IPFS
 * node would compute — and keep the image in-browser so the page can preview
 * it. The CID recorded on chain is therefore always a real content address;
 * only the pinning is skipped.
 */

export type UploadResult = {
  cid: string
  /** URL usable in an <img> tag right now. */
  previewUrl: string
  /** Gateway URL for the CID. Only resolvable when actually pinned. */
  gatewayUrl: string
  /** False when no pinning service was configured. */
  pinned: boolean
  size: number
  contentType: string
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']

export function ipfsConfigured(): boolean {
  return PINATA_JWT.length > 0
}

export function validateImage(file: File): void {
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new SwapError(
      'validation',
      `Unsupported image type "${file.type || 'unknown'}". Use PNG, JPEG, GIF, WebP or SVG.`,
    )
  }
  if (file.size === 0) {
    throw new SwapError('validation', 'That file is empty.')
  }
  if (file.size > MAX_IMAGE_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1)
    throw new SwapError(
      'validation',
      `Image is ${mb}MB — the limit is ${MAX_IMAGE_BYTES / 1024 / 1024}MB.`,
    )
  }
}

/** `ipfs://<cid>`, the canonical form to store in metadata. */
export function ipfsUri(cid: string): string {
  return `ipfs://${cid}`
}

export function gatewayUrl(cid: string): string {
  return `${IPFS_GATEWAY.replace(/\/$/, '')}/${cid}`
}

export async function uploadImage(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<UploadResult> {
  validateImage(file)
  onProgress?.(5)

  const bytes = new Uint8Array(await file.arrayBuffer())
  onProgress?.(20)

  if (!ipfsConfigured()) {
    // No pinning service: derive the CID locally so the chain still records a
    // real content address, and preview from a blob URL.
    const cid = await computeCidV1Raw(bytes)
    onProgress?.(100)
    return {
      cid,
      previewUrl: URL.createObjectURL(file),
      gatewayUrl: gatewayUrl(cid),
      pinned: false,
      size: file.size,
      contentType: file.type,
    }
  }

  const form = new FormData()
  form.append('file', file, file.name)

  let res: Response
  try {
    res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${PINATA_JWT}` },
      body: form,
    })
  } catch (e) {
    throw new SwapError(
      'network',
      'Could not reach the IPFS pinning service. Check your connection and retry.',
      e instanceof Error ? e.message : String(e),
    )
  }
  onProgress?.(75)

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) {
      throw new SwapError(
        'validation',
        'The IPFS pinning service rejected the credentials. Check VITE_PINATA_JWT.',
        body,
      )
    }
    throw new SwapError(
      'network',
      `IPFS upload failed (HTTP ${res.status}).`,
      body,
    )
  }

  const json = (await res.json()) as { IpfsHash?: string; PinSize?: number }
  if (!json.IpfsHash) {
    throw new SwapError('network', 'IPFS upload returned no CID.', JSON.stringify(json))
  }
  onProgress?.(100)

  return {
    cid: json.IpfsHash,
    previewUrl: gatewayUrl(json.IpfsHash),
    gatewayUrl: gatewayUrl(json.IpfsHash),
    pinned: true,
    size: json.PinSize ?? file.size,
    contentType: file.type,
  }
}

/**
 * Compute the CIDv1 an IPFS node would assign to these bytes with the `raw`
 * codec and sha2-256 — i.e. `ipfs add --cid-version=1 --raw-leaves`.
 *
 * Layout: <multibase 'b'><version 0x01><codec 0x55 raw><mh 0x12 sha2-256>
 *         <length 0x20><32 digest bytes>, base32-lower encoded without padding.
 */
export async function computeCidV1Raw(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer),
  )
  const prefix = Uint8Array.from([0x01, 0x55, 0x12, 0x20])
  const full = new Uint8Array(prefix.length + digest.length)
  full.set(prefix, 0)
  full.set(digest, prefix.length)
  return 'b' + base32Lower(full)
}

/** RFC 4648 base32, lowercase, no padding — the multibase 'b' alphabet. */
function base32Lower(data: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31]
  }
  return out
}
