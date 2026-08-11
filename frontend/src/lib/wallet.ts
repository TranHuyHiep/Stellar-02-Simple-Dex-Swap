import { StellarWalletsKit, Networks } from '@creit.tech/stellar-wallets-kit'
import { FreighterModule } from '@creit.tech/stellar-wallets-kit/modules/freighter'
import { xBullModule } from '@creit.tech/stellar-wallets-kit/modules/xbull'
import { AlbedoModule } from '@creit.tech/stellar-wallets-kit/modules/albedo'
import { RabetModule } from '@creit.tech/stellar-wallets-kit/modules/rabet'
import { LobstrModule } from '@creit.tech/stellar-wallets-kit/modules/lobstr'
import { HanaModule } from '@creit.tech/stellar-wallets-kit/modules/hana'
import { Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import { FRIENDBOT_URL, HORIZON_URL, NETWORK_PASSPHRASE } from './config'
import { SwapError } from './errors'

let kitReady = false

/** Multi-wallet: six browser/hardware wallets behind one modal. */
export function initKit() {
  if (kitReady) return
  StellarWalletsKit.init({
    network: Networks.TESTNET,
    modules: [
      new FreighterModule(),
      new xBullModule(),
      new AlbedoModule(),
      new RabetModule(),
      new LobstrModule(),
      new HanaModule(),
    ],
  })
  kitReady = true
}

export type ConnectionMode = 'wallet' | 'devkey'

export type Connection = {
  mode: ConnectionMode
  address: string
  /** Present only in devkey mode. */
  secret?: string
  walletName?: string
}

const DEVKEY_STORAGE = 'swapui.devkey'

/** Open the multi-wallet picker and return the chosen account. */
export async function connectWallet(): Promise<Connection> {
  initKit()
  const { address } = await StellarWalletsKit.authModal()
  let walletName: string | undefined
  try {
    walletName = StellarWalletsKit.selectedModule?.productName
  } catch {
    walletName = undefined
  }
  return { mode: 'wallet', address, walletName }
}

export async function disconnectWallet(): Promise<void> {
  try {
    await StellarWalletsKit.disconnect()
  } catch {
    /* already disconnected */
  }
}

/**
 * Testnet-only fallback so the app is usable without a browser extension
 * (and so it can be demoed headlessly). Never use a mainnet secret here.
 */
export function connectDevKey(secret: string): Connection {
  let kp: Keypair
  try {
    kp = Keypair.fromSecret(secret.trim())
  } catch {
    throw new SwapError(
      'wallet',
      'That is not a valid Stellar secret key (it should start with "S").',
    )
  }
  localStorage.setItem(DEVKEY_STORAGE, secret.trim())
  return { mode: 'devkey', address: kp.publicKey(), secret: secret.trim(), walletName: 'Dev keypair' }
}

export function loadStoredDevKey(): Connection | null {
  const s = localStorage.getItem(DEVKEY_STORAGE)
  if (!s) return null
  try {
    return connectDevKey(s)
  } catch {
    localStorage.removeItem(DEVKEY_STORAGE)
    return null
  }
}

export function clearStoredDevKey() {
  localStorage.removeItem(DEVKEY_STORAGE)
}

/**
 * Generate and fund a fresh testnet account via Friendbot.
 *
 * Friendbot returning 200 only means the funding transaction was submitted;
 * Horizon may not have indexed the new account yet. We poll until the account
 * is actually readable, otherwise the first swap fails with "Account not
 * found" or builds on a sequence number that does not exist yet.
 */
export async function createFundedDevKey(): Promise<Connection> {
  const kp = Keypair.random()
  const res = await fetch(
    `${FRIENDBOT_URL}?addr=${encodeURIComponent(kp.publicKey())}`,
  )
  if (!res.ok) {
    throw new SwapError(
      'network',
      'Friendbot could not fund the new testnet account. Try again shortly.',
      await res.text().catch(() => ''),
    )
  }

  await waitForAccount(kp.publicKey())
  return connectDevKey(kp.secret())
}

/** Poll Horizon until the account exists (Friendbot funding has landed). */
async function waitForAccount(address: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${HORIZON_URL}/accounts/${address}`)
      if (r.ok) return
    } catch {
      /* keep polling */
    }
    await new Promise((res) => setTimeout(res, 800))
  }
  throw new SwapError(
    'network',
    'Funded the account but Horizon has not indexed it yet. Wait a moment and reconnect.',
  )
}

/**
 * Sign a transaction with whichever connection is active, returning the
 * signed XDR ready for submission.
 */
export async function signXdr(conn: Connection, xdr: string): Promise<string> {
  if (conn.mode === 'devkey') {
    if (!conn.secret) throw new SwapError('wallet', 'Dev keypair is missing its secret.')
    const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as Transaction
    tx.sign(Keypair.fromSecret(conn.secret))
    return tx.toXDR()
  }

  initKit()
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: conn.address,
  })
  return signedTxXdr
}
