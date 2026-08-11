// `defineConfig` from vitest/config is Vite's own, widened to accept `test`.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The wallet modules pull in CommonJS-only packages (Freighter's API among
    // them). Inlining them lets Vitest transform them the way the browser
    // build does, instead of failing on a missing named export.
    server: {
      deps: {
        inline: [/@creit\.tech\/stellar-wallets-kit/, /@stellar\/freighter-api/],
      },
    },
  },
})
