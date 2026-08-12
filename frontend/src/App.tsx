import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { WalletProvider } from './WalletContext'
import SwapPage from './pages/SwapPage'
import MintPage from './pages/MintPage'

export default function App() {
  return (
    <BrowserRouter>
      {/* One wallet connection for both pages, so navigating does not
          disconnect the user. */}
      <WalletProvider>
        <div className="app">
          <Routes>
            <Route path="/" element={<SwapPage />} />
            <Route path="/mint" element={<MintPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </WalletProvider>
    </BrowserRouter>
  )
}
