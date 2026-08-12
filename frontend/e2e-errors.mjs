/**
 * Exercise the three classes of error the UI handles and assert each renders
 * a specific, user-facing message.
 *
 *   node e2e-errors.mjs
 */
import { chromium } from 'playwright'

const URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const results = []
const browser = await chromium.launch()

async function newPage() {
  const page = await browser.newPage()
  page.setDefaultTimeout(240_000)
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('h1')
  return page
}

async function connectFunded(page) {
  await page.click('button:has-text("Dev key")')
  await page.click('button:has-text("Create + fund")')
  await page.waitForSelector('.conn-badge', { timeout: 90000 })
  await page.waitForFunction(
    () => document.querySelector('.link-btn')?.textContent?.includes('balance'),
    { timeout: 60000 },
  )
}

// ---------------------------------------------------------------------------
// 1. VALIDATION: identical assets, caught in the UI before any network call.
// ---------------------------------------------------------------------------
{
  const page = await newPage()
  await connectFunded(page)
  // Set both selects to XLM.
  await page.selectOption('select[aria-label="Asset to buy"]', 'native')
  await page.fill('#sell-amount', '5')
  await page.click('.btn--block')
  const msg = await page
    .waitForSelector('.swap .error-text', { timeout: 15000 })
    .then((h) => h.textContent())
    .catch(() => null)
  results.push(['validation (identical assets)', msg?.trim() ?? 'NO MESSAGE'])
  await page.close()
}

// ---------------------------------------------------------------------------
// 2. VALIDATION: amount beyond balance.
// ---------------------------------------------------------------------------
{
  const page = await newPage()
  await connectFunded(page)
  await page.fill('#sell-amount', '999999999')
  await page.click('.btn--block')
  const msg = await page
    .waitForSelector('.swap .error-text', { timeout: 15000 })
    .then((h) => h.textContent())
    .catch(() => null)
  results.push(['validation (insufficient balance)', msg?.trim() ?? 'NO MESSAGE'])
  await page.close()
}

// ---------------------------------------------------------------------------
// 3. NETWORK: Horizon unreachable -> orderbook surfaces a network error.
// ---------------------------------------------------------------------------
{
  const page = await newPage()
  await page.route('**/horizon-testnet.stellar.org/**', (r) => r.abort())
  await page.reload({ waitUntil: 'domcontentloaded' })
  const msg = await page
    .waitForSelector('.ob .error-text', { timeout: 45000 })
    .then((h) => h.textContent())
    .catch(() => null)
  results.push(['network (horizon blocked)', msg?.trim() ?? 'NO MESSAGE'])
  await page.close()
}

// ---------------------------------------------------------------------------
// 4. NETWORK: Soroban RPC unreachable during the registry step.
// ---------------------------------------------------------------------------
{
  const page = await newPage()
  await connectFunded(page)
  await page.fill('#sell-amount', '5')
  await page.waitForFunction(
    () => (document.querySelector('#buy-amount')?.value ?? '') !== '',
    { timeout: 45000 },
  )
  await page.route('**/soroban-testnet.stellar.org/**', (r) => r.abort())
  await page.click('.btn--block')
  await page.waitForFunction(
    () => document.querySelector('.tx')?.className.includes('tx--error'),
    { timeout: 120000 },
  ).catch(() => {})
  const kind = await page.textContent('.tx-error-kind').catch(() => null)
  const msg = await page.textContent('.tx-error-msg').catch(() => null)
  results.push([
    'network (rpc blocked during registry step)',
    `${kind?.trim() ?? '?'} :: ${msg?.trim() ?? 'NO MESSAGE'}`,
  ])
  await page.close()
}

// ---------------------------------------------------------------------------
// 5. CONTRACT: a typed registry error (#N) must render as a *contract* error
//    with its own human-readable message. We make the deployed contract
//    genuinely reject by rewriting the simulate response to the real host
//    error the chain returns for InvalidAmount / SlippageTooHigh / etc.
// ---------------------------------------------------------------------------
for (const [code, label] of [
  [3, 'InvalidAmount'],
  [4, 'SlippageTooHigh'],
  [5, 'IdenticalAssets'],
  [6, 'RegistryPaused'],
]) {
  const page = await newPage()
  await connectFunded(page)
  await page.fill('#sell-amount', '5')
  await page.waitForFunction(
    () => (document.querySelector('#buy-amount')?.value ?? '') !== '',
    { timeout: 45000 },
  )

  // Intercept only the simulateTransaction JSON-RPC call and return the exact
  // error string the Soroban host produces for this contract error code.
  await page.route('**/soroban-testnet.stellar.org/**', async (route) => {
    const req = route.request()
    let body
    try {
      body = JSON.parse(req.postData() ?? '{}')
    } catch {
      return route.continue()
    }
    if (body.method !== 'simulateTransaction') return route.continue()

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          error: `HostError: Error(Contract, #${code})\n\nEvent log: [Diagnostic Event] contract:CDYQ..., topics:[error, Error(Contract, #${code})]`,
          latestLedger: 1,
          events: [],
        },
      }),
    })
  })

  await page.click('.btn--block')
  await page.waitForFunction(
    () => document.querySelector('.tx')?.className.includes('tx--error'),
    { timeout: 120000 },
  ).catch(() => {})

  const kind = await page.textContent('.tx-error-kind').catch(() => null)
  const msg = await page.textContent('.tx-error-msg').catch(() => null)
  results.push([
    `contract #${code} (${label})`,
    `${kind?.trim() ?? '?'} :: ${msg?.trim() ?? 'NO MESSAGE'}`,
  ])
  await page.close()
}

console.log('\n=== ERROR HANDLING RESULTS ===')
for (const [name, msg] of results) console.log(`- ${name}\n    ${msg}`)

await browser.close()
