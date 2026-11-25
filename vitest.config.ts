import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'node_modules.incomplete-*/**'],
    maxWorkers: 1,
  },
})
