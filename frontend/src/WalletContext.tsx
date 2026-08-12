import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { toSwapError, type SwapError } from './lib/errors'
import { WalletCtx } from './walletCtx'
import {
  clearStoredDevKey,
  connectDevKey,
  connectWallet,
  createFundedDevKey,
  disconnectWallet,
  loadStoredDevKey,
  type Connection,
} from './lib/wallet'

/**
 * One wallet connection shared by every page, so navigating between the swap
 * and mint views does not drop the session.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [conn, setConn] = useState<Connection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<SwapError | null>(null)

  useEffect(() => {
    const stored = loadStoredDevKey()
    if (stored) setConn(stored)
  }, [])

  const connect = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setConn(await connectWallet())
    } catch (e) {
      setError(toSwapError(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const disconnect = useCallback(async () => {
    await disconnectWallet()
    clearStoredDevKey()
    setConn(null)
  }, [])

  const applyDevKey = useCallback((secret: string) => {
    setError(null)
    try {
      setConn(connectDevKey(secret))
    } catch (e) {
      setError(toSwapError(e))
    }
  }, [])

  const createDevKey = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setConn(await createFundedDevKey())
    } catch (e) {
      setError(toSwapError(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const value = useMemo(
    () => ({
      conn,
      busy,
      error,
      connect,
      disconnect,
      applyDevKey,
      createDevKey,
      clearError: () => setError(null),
    }),
    [conn, busy, error, connect, disconnect, applyDevKey, createDevKey],
  )

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>
}
