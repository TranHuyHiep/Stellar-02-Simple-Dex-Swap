import { useCallback, useRef, useState } from 'react'
import { toSwapError } from '../lib/errors'
import { MAX_IMAGE_BYTES, uploadImage, type UploadResult } from '../lib/ipfs'

/** Bytes for small files, KB/MB above that — "0 KB" for a 90-byte icon is wrong. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function ImageDropzone({
  upload,
  disabled,
  onUploaded,
  onClear,
  onError,
}: {
  upload: UploadResult | null
  disabled?: boolean
  onUploaded: (r: UploadResult) => void
  onClear: () => void
  onError: (message: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)

  const handleFile = useCallback(
    async (file: File) => {
      setProgress(0)
      try {
        const r = await uploadImage(file, setProgress)
        onUploaded(r)
      } catch (e) {
        onError(toSwapError(e).message)
      } finally {
        setProgress(null)
      }
    },
    [onUploaded, onError],
  )

  const busy = progress !== null

  if (upload) {
    return (
      <div className="drop drop--filled">
        <img src={upload.previewUrl} alt="NFT preview" className="drop-preview" />
        <div className="drop-meta">
          <span className="mono-ellipsis" title={upload.cid}>
            {upload.cid}
          </span>
          <span className="muted">
            {formatBytes(upload.size)} · {upload.pinned ? 'pinned' : 'not pinned'}
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onClear}
            disabled={disabled}
          >
            Replace image
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`drop ${dragging ? 'drop--over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled && !busy) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (disabled || busy) return
        const f = e.dataTransfer.files?.[0]
        if (f) void handleFile(f)
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        className="drop-input"
        disabled={disabled || busy}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void handleFile(f)
          // Allow re-selecting the same file after a failure.
          e.target.value = ''
        }}
        aria-label="NFT image"
      />

      {busy ? (
        <div className="drop-inner">
          <span className="spinner" />
          <strong>Uploading to IPFS…</strong>
          <div className="progress" role="progressbar" aria-valuenow={progress ?? 0}>
            <span style={{ width: `${progress ?? 0}%` }} />
          </div>
        </div>
      ) : (
        <div className="drop-inner">
          <span className="drop-icon" aria-hidden="true">
            ⬆
          </span>
          <strong>Drop an image, or click to choose</strong>
          <span className="muted">
            PNG, JPEG, GIF, WebP or SVG · up to {MAX_IMAGE_BYTES / 1024 / 1024}MB
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
          >
            Choose file
          </button>
        </div>
      )}
    </div>
  )
}
