import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { config } from 'dotenv'

// Tests run against the real Neon database over the network, so give them
// room. They only ever touch rows flagged is_test = true.
config({ path: '.env.local', quiet: true })

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The concurrency tests assert on exact ticket counts, so test files must
    // not race each other against shared rows.
    fileParallelism: false,
  },
})
