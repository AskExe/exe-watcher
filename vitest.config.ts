import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Nested worktrees contain another checkout's suites; running both causes shared scan-lock contention.
    include: ['tests/**/*.test.ts'],
  },
})
