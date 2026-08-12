import { useCallback, useEffect, useRef, useState } from 'react'
import { useWallet } from '../useWallet'
import { WalletBar } from '../components/WalletBar'
import { TxStatus, type TxState } from '../components/TxStatus'
import { NftGallery } from '../components/NftGallery'
import { NftEventFeed } from '../components/NftEventFeed'
import { ImageDropzone } from '../components/ImageDropzone'
import { NFT_MAX_DESC_LEN, NFT_MAX_NAME_LEN } from '../lib/config'
import { toSwapError } from '../lib/errors'
import { ipfsConfigured, ipfsUri, type UploadResult } from '../lib/ipfs'
import {
  addToPool,
  fetchNftEvents,
  mintToPool,
  mintToSelf,
  readManyMetadata,
  readMintingPaused,
  readPoolClosed,
  readDepositor,
  readPoolItems,
  readPoolSize,
  readTokensOf,
  readTotalSupply,
  withdrawFromPool,
  type NftEvent,
  type NftMeta,
} from '../lib/nft'

type Destination = 'self' | 'pool'

export default function MintPage() {
  const { conn } = useWallet()

  const [upload, setUpload] = useState<UploadResult | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [destination, setDestination] = useState<Destination>('self')

  const [tx, setTx] = useState<TxState>({ phase: 'idle' })
  const [validation, setValidation] = useState<string | null>(null)

  const [mine, setMine] = useState<NftMeta[]>([])
  const [poolItems, setPoolItems] = useState<NftMeta[]>([])
  // token_id -> depositor, so only they see a Withdraw button.
  const [depositors, setDepositors] = useState<Record<number, string>>({})
  const [loadingMine, setLoadingMine] = useState(false)
  const [loadingPool, setLoadingPool] = useState(true)

  const [supply, setSupply] = useState<number | null>(null)
  const [poolSize, setPoolSize] = useState<number | null>(null)
  const [mintPaused, setMintPaused] = useState<boolean | null>(null)
  const [poolClosed, setPoolClosed] = useState<boolean | null>(null)

  const [events, setEvents] = useState<NftEvent[]>([])
  const [latestLedger, setLatestLedger] = useState<number | null>(null)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [feedLoading, setFeedLoading] = useState(true)

  const busy = ['uploading', 'validating', 'contract', 'confirming'].includes(tx.phase)

  // --- collection + pool stats ------------------------------------------
  const refreshStats = useCallback(async () => {
    try {
      const [s, p, mp, pc] = await Promise.all([
        readTotalSupply(),
        readPoolSize(),
        readMintingPaused(),
        readPoolClosed(),
      ])
      setSupply(s)
      setPoolSize(p)
      setMintPaused(mp)
      setPoolClosed(pc)
    } catch {
      /* pills stay blank if the RPC is unavailable */
    }
  }, [])

  const refreshPool = useCallback(async () => {
    setLoadingPool(true)
    try {
      const ids = await readPoolItems()
      const [metas, deps] = await Promise.all([
        readManyMetadata(ids),
        Promise.all(ids.map((id) => readDepositor(id).catch(() => null))),
      ])
      setPoolItems(metas)
      const map: Record<number, string> = {}
      ids.forEach((id, i) => {
        const d = deps[i]
        if (d) map[id] = d
      })
      setDepositors(map)
    } catch {
      setPoolItems([])
      setDepositors({})
    } finally {
      setLoadingPool(false)
    }
  }, [])

  const refreshMine = useCallback(async (address: string) => {
    setLoadingMine(true)
    try {
      const ids = await readTokensOf(address)
      setMine(await readManyMetadata(ids))
    } catch {
      setMine([])
    } finally {
      setLoadingMine(false)
    }
  }, [])

  useEffect(() => {
    void refreshStats()
    void refreshPool()
  }, [refreshStats, refreshPool])

  useEffect(() => {
    if (conn) void refreshMine(conn.address)
    else setMine([])
  }, [conn, refreshMine])

  // --- live events ------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const { events: evs, latestLedger: ll } = await fetchNftEvents()
        if (!cancelled) {
          setEvents(evs.slice(-30).reverse())
          setLatestLedger(ll)
          setFeedError(null)
        }
      } catch (e) {
        if (!cancelled) setFeedError(toSwapError(e).message)
      } finally {
        if (!cancelled) setFeedLoading(false)
      }
    }
    void tick()
    const timer = window.setInterval(tick, 7000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  // --- upload -----------------------------------------------------------
  const handleUploaded = (r: UploadResult) => {
    setUpload(r)
    setValidation(null)
  }

  // --- mint -------------------------------------------------------------
  const nameRef = useRef<HTMLInputElement>(null)

  const handleMint = async () => {
    setValidation(null)

    // Client-side checks first, mirroring the contract's own bounds so the
    // user is told before a transaction is built.
    if (!conn) {
      setValidation('Connect a wallet first.')
      return
    }
    if (!upload) {
      setValidation('Upload an image before minting.')
      return
    }
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setValidation('Give the NFT a name.')
      nameRef.current?.focus()
      return
    }
    if (trimmed.length > NFT_MAX_NAME_LEN) {
      setValidation(`Name must be ${NFT_MAX_NAME_LEN} characters or fewer.`)
      return
    }
    if (description.length > NFT_MAX_DESC_LEN) {
      setValidation(`Description must be ${NFT_MAX_DESC_LEN} characters or fewer.`)
      return
    }
    if (destination === 'pool' && poolClosed) {
      setValidation('The pool is closed, so it cannot accept new NFTs right now.')
      return
    }

    const params = { name: trimmed, description, cid: upload.cid }

    try {
      setTx({
        phase: 'contract',
        message:
          destination === 'pool'
            ? 'Minting into the pool (collection → pool)…'
            : 'Minting to your wallet…',
      })

      const fn = destination === 'pool' ? mintToPool : mintToSelf
      const r = await fn(conn, params, (m) =>
        setTx((s) => ({ ...s, phase: 'contract', message: m })),
      )

      setTx({
        phase: 'success',
        contractTx: r.hash,
        swapIndex: r.tokenId,
        message:
          destination === 'pool'
            ? `Minted NFT #${r.tokenId} straight into the pool.`
            : `Minted NFT #${r.tokenId} to your wallet.`,
      })

      // Reset the form but keep the image, so minting a series is quick.
      setName('')
      setDescription('')
      void refreshStats()
      void refreshPool()
      void refreshMine(conn.address)
    } catch (e) {
      setTx({ phase: 'error', error: toSwapError(e) })
    }
  }

  const handleAddToPool = async (tokenId: number) => {
    if (!conn) return
    try {
      setTx({ phase: 'contract', message: `Depositing NFT #${tokenId} into the pool…` })
      const r = await addToPool(conn, tokenId, (m) =>
        setTx((s) => ({ ...s, phase: 'contract', message: m })),
      )
      setTx({
        phase: 'success',
        contractTx: r.hash,
        message: `NFT #${tokenId} is now held by the pool.`,
      })
      void refreshStats()
      void refreshPool()
      void refreshMine(conn.address)
    } catch (e) {
      setTx({ phase: 'error', error: toSwapError(e) })
    }
  }

  const handleWithdraw = async (tokenId: number) => {
    if (!conn) return
    try {
      setTx({ phase: 'contract', message: `Withdrawing NFT #${tokenId} from the pool…` })
      const r = await withdrawFromPool(conn, tokenId, (m) =>
        setTx((s) => ({ ...s, phase: 'contract', message: m })),
      )
      setTx({
        phase: 'success',
        contractTx: r.hash,
        message: `NFT #${tokenId} returned to your wallet.`,
      })
      void refreshStats()
      void refreshPool()
      void refreshMine(conn.address)
    } catch (e) {
      setTx({ phase: 'error', error: toSwapError(e) })
    }
  }

  const mintLabel = !conn
    ? 'Connect wallet to mint'
    : busy
      ? 'Working…'
      : mintPaused
        ? 'Minting paused'
        : destination === 'pool'
          ? 'Mint into pool'
          : 'Mint to my wallet'

  return (
    <>
      <WalletBar
        stats={
          <>
            <span className="stat">
              <em>{supply ?? '—'}</em> minted
            </span>
            <span className="stat">
              <em>{poolSize ?? '—'}</em> in pool
            </span>
            {mintPaused && <span className="pill pill--warn">minting paused</span>}
            {poolClosed && <span className="pill pill--warn">pool closed</span>}
          </>
        }
      />

      <main className="grid">
        <div className="col">
          <section className="card" aria-label="Mint an NFT">
            <header className="card-head">
              <h2>Mint an NFT</h2>
              {!ipfsConfigured() && (
                <span
                  className="pill pill--warn"
                  title="No VITE_PINATA_JWT set. The CID is still computed from the file, but the image is not pinned."
                >
                  IPFS not pinning
                </span>
              )}
            </header>

            <ImageDropzone
              upload={upload}
              disabled={busy}
              onUploaded={handleUploaded}
              onClear={() => setUpload(null)}
              onError={(m) => setValidation(m)}
            />

            <div className="field">
              <div className="field-head">
                <label htmlFor="nft-name">Name</label>
                <span className="muted">
                  {name.trim().length}/{NFT_MAX_NAME_LEN}
                </span>
              </div>
              <input
                id="nft-name"
                ref={nameRef}
                className="text-input"
                type="text"
                placeholder="Nebula #1"
                value={name}
                maxLength={NFT_MAX_NAME_LEN}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
              />
            </div>

            <div className="field">
              <div className="field-head">
                <label htmlFor="nft-desc">Description</label>
                <span className="muted">
                  {description.length}/{NFT_MAX_DESC_LEN}
                </span>
              </div>
              <textarea
                id="nft-desc"
                className="text-input"
                rows={3}
                placeholder="What is this piece?"
                value={description}
                maxLength={NFT_MAX_DESC_LEN}
                onChange={(e) => setDescription(e.target.value)}
                disabled={busy}
              />
            </div>

            <fieldset className="dest" disabled={busy}>
              <legend>Mint to</legend>
              <label className={destination === 'self' ? 'dest-opt dest-opt--on' : 'dest-opt'}>
                <input
                  type="radio"
                  name="destination"
                  value="self"
                  checked={destination === 'self'}
                  onChange={() => setDestination('self')}
                />
                <span>
                  <strong>My wallet</strong>
                  <em>You own it; you can deposit it into the pool later.</em>
                </span>
              </label>
              <label className={destination === 'pool' ? 'dest-opt dest-opt--on' : 'dest-opt'}>
                <input
                  type="radio"
                  name="destination"
                  value="pool"
                  checked={destination === 'pool'}
                  onChange={() => setDestination('pool')}
                />
                <span>
                  <strong>The pool</strong>
                  <em>
                    One transaction, two contracts — the collection mints it owned by the
                    pool and notifies it.
                  </em>
                </span>
              </label>
            </fieldset>

            {upload && (
              <dl className="quote-info">
                <div>
                  <dt>IPFS CID</dt>
                  <dd className="mono-ellipsis" title={upload.cid}>
                    {upload.cid}
                  </dd>
                </div>
                <div>
                  <dt>Stored as</dt>
                  <dd className="mono-ellipsis">{ipfsUri(upload.cid)}</dd>
                </div>
                <div>
                  <dt>Pinned</dt>
                  <dd>{upload.pinned ? 'yes' : 'no — CID computed locally'}</dd>
                </div>
              </dl>
            )}

            {validation && (
              <p className="error-text" role="alert">
                {validation}
              </p>
            )}

            <button
              className="btn btn--primary btn--block"
              onClick={handleMint}
              disabled={busy || !conn || mintPaused === true}
              aria-busy={busy ? true : undefined}
            >
              {busy && <span className="spinner" />}
              {mintLabel}
            </button>

            <p className="fineprint">
              The image is addressed by its IPFS CID; the name, description and CID are
              stored on chain by the nft_collection contract.
            </p>
          </section>

          <TxStatus state={tx} onDismiss={() => setTx({ phase: 'idle' })} simple />
        </div>

        <div className="col">
          <NftGallery
            title="Your NFTs"
            items={mine}
            loading={loadingMine}
            empty={
              conn ? 'You do not own any NFTs yet.' : 'Connect a wallet to see your NFTs.'
            }
            action={
              conn && !poolClosed
                ? { label: 'Add to pool', onClick: handleAddToPool, disabled: busy }
                : undefined
            }
          />

          <NftGallery
            title="Pool"
            items={poolItems}
            loading={loadingPool}
            empty="The pool is empty."
            badge={poolSize !== null ? `${poolSize} held` : undefined}
            action={
              conn
                ? {
                    label: 'Withdraw',
                    onClick: handleWithdraw,
                    disabled: busy,
                    // The pool only lets the depositor withdraw, which is not
                    // necessarily the creator. Hiding the button for everyone
                    // else avoids a call that is certain to fail.
                    enabledFor: (m) => depositors[m.tokenId] === conn.address,
                  }
                : undefined
            }
          />

          <NftEventFeed
            events={events}
            latestLedger={latestLedger}
            error={feedError}
            loading={feedLoading}
            self={conn?.address}
          />
        </div>
      </main>
    </>
  )
}
