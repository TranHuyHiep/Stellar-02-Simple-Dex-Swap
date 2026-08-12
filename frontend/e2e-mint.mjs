/**
 * End-to-end check against live testnet: connect a funded dev key, upload an
 * image, mint an NFT to the wallet, deposit it into the pool, then mint a
 * second one straight into the pool (which exercises the cross-contract call).
 *
 *   node e2e-mint.mjs
 */
import { chromium } from 'playwright'

const URL = (process.env.APP_URL ?? 'http://127.0.0.1:5173/').replace(/\/$/, '') + '/mint'
const errors = []

const browser = await chromium.launch()
const page = await browser.newPage()
page.setDefaultTimeout(240_000)
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(e.message))

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('h1')

// --- connect -------------------------------------------------------------
await page.click('button:has-text("Dev key")')
await page.click('button:has-text("Create + fund")')
await page.waitForSelector('.conn-badge', { timeout: 120000 })
console.log('CONNECTED:', (await page.textContent('.conn-badge')).trim())

// --- upload an image -----------------------------------------------------
// A tiny valid PNG, so the CID is computed from real image bytes.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFUlEQVR42mNk' +
    'YPjPwMDAwMgAAwAeAAX8A/pAAAAAAElFTkSuQmCC',
  'base64',
)
await page.setInputFiles('.drop-input', {
  name: 'pixel.png',
  mimeType: 'image/png',
  buffer: png,
})
await page.waitForSelector('.drop--filled', { timeout: 60000 })
const cid = (await page.textContent('.drop-meta .mono-ellipsis')).trim()
console.log('CID:', cid)
if (!cid.startsWith('bafkrei')) {
  throw new Error(`expected a raw CIDv1, got "${cid}"`)
}

const waitForTerminal = async () =>
  page.waitForFunction(
    () => {
      const t = document.querySelector('.tx')
      return t && (t.className.includes('tx--success') || t.className.includes('tx--error'))
    },
    { timeout: 240000 },
  )

const report = async (label) => {
  const cls = await page.getAttribute('.tx', 'class')
  const ok = cls.includes('tx--success')
  if (ok) {
    console.log(`${label}: SUCCESS — ${(await page.textContent('.tx-msg')).trim()}`)
  } else {
    console.log(`${label}: ERROR — ${(await page.textContent('.tx-error-msg')).trim()}`)
    const detail = await page.textContent('.tx-error pre').catch(() => '')
    if (detail) console.log('  detail:', detail.trim().slice(0, 300))
  }
  return ok
}

// --- 1. mint to the wallet ----------------------------------------------
await page.fill('#nft-name', 'E2E Pixel')
await page.fill('#nft-desc', 'minted by the e2e suite')
await page.check('input[value="self"]')
await page.click('.btn--block')
await waitForTerminal()
const mintedSelf = await report('mint-to-self')
await page.click('button:has-text("Dismiss")')

// --- 2. deposit it into the pool ---------------------------------------
let deposited = false
if (mintedSelf) {
  await page.waitForSelector('button:has-text("Add to pool")', { timeout: 120000 })
  await page.click('button:has-text("Add to pool")')
  await waitForTerminal()
  deposited = await report('add-to-pool')
  await page.click('button:has-text("Dismiss")')
}

// --- 3. mint straight into the pool (cross-contract) -------------------
await page.fill('#nft-name', 'E2E Pooled')
await page.check('input[value="pool"]')
await page.click('.btn--block')
await waitForTerminal()
const mintedPool = await report('mint-to-pool')

// --- pool contents ------------------------------------------------------
await page.waitForTimeout(2000)
const poolCount = await page.$$eval('section[aria-label="Pool"] .nft-card', (n) => n.length)
console.log('POOL CARDS:', poolCount)

await page.screenshot({ path: 'e2e-mint.png', fullPage: true })
console.log('CONSOLE ERRORS:', errors.length ? errors.slice(0, 6) : 'none')

await browser.close()
process.exit(mintedSelf && deposited && mintedPool ? 0 : 1)
