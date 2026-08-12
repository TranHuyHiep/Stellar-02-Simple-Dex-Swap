import { createContext } from 'react'
import type { SwapError } from './lib/errors'
import type { Connection } from './lib/wallet'

/**
 * The shared wallet connection, in its own module so both the provider and the
 * hook can import it without either file exporting a mix of components and
 * non-components (which breaks fast refresh).
 */
export type WalletState = {
  conn: Connection | null
  busy: boolean
  error: SwapError | null
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  applyDevKey: (secret: string) => void
  createDevKey: () => Promise<void>
  clearError: () => void
}

export const WalletCtx = createContext<WalletState | null>(null)
