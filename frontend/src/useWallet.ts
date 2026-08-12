import { useContext } from 'react'
import { WalletCtx, type WalletState } from './walletCtx'

/** Access the shared wallet connection. Lives apart from the provider so the
 *  provider module only exports components, keeping fast refresh working. */
export function useWallet(): WalletState {
  const v = useContext(WalletCtx)
  if (!v) throw new Error('useWallet must be used inside a WalletProvider')
  return v
}
