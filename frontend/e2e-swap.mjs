/**
 * End-to-end check against live testnet: create a funded dev key in the UI,
 * then run a real swap (registry invoke + DEX path payment) and assert the
 * transaction status panel reaches success.
 *
 *   node e2e-swap.mjs
 */
import { chromium } from 'playwright'

const URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const errors = []

const browser = await chromium.launch()
const page = await browser.newPage()
// A swap is three sequential transactions plus settlement waits, so the
// 30s default is far too tight for the terminal-state assertion.
page.setDefaultTimeout(240_000)
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(e.message))

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('h1')

// --- connect: generate a Friendbot-funded testnet key -------------------
await page.click('button:has-text("Dev key")')
await page.click('button:has-text("Create + fund")')
await page.waitForSelector('.conn-badge', { timeout: 90000 })
const addr = (await page.textContent('.conn-badge')).trim()
console.log('CONNECTED:', addr)

// --- wait for the XLM balance to load ----------------------------------
await page.waitForFunction(
  () => document.querySelector('.link-btn')?.textContent?.includes('balance'),
  { timeout: 60000 },
)
console.log('BALANCE:', (await page.textContent('.link-btn')).trim())

// --- quote -------------------------------------------------------------
await page.waitForSelector('#sell-amount')
await page.fill('#sell-amount', '25')
await page.waitForFunction(
  () => (document.querySelector('#buy-amount')?.value ?? '') !== '',
  { timeout: 45000 },
)
console.log('QUOTE:', await page.inputValue('#buy-amount'))

// --- swap --------------------------------------------------------------
await page.click('.btn--block')
console.log('submitted, waiting for terminal state…')

await page.waitForFunction(
  () => {
    const t = document.querySelector('.tx')
    if (!t) return false
    return t.className.includes('tx--success') || t.className.includes('tx--error')
  },
  { timeout: 180000 },
)

const cls = await page.getAttribute('.tx', 'class')
const txText = (await page.textContent('.tx')).replace(/\s+/g, ' ').trim()
const ok = cls.includes('tx--success')

console.log(ok ? 'RESULT: SUCCESS' : 'RESULT: ERROR')
console.log('PANEL:', txText.slice(0, 500))

const links = await page.$$eval('.tx-links a', (as) =>
  as.map((a) => `${a.textContent.trim()} ${a.href}`),
)
console.log('LINKS:', links)

await page.screenshot({ path: 'e2e-result.png', fullPage: true })
console.log('CONSOLE ERRORS:', errors.length ? errors.slice(0, 8) : 'none')

await browser.close()
process.exit(ok ? 0 : 1)
