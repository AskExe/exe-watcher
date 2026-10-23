import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: ['@odd-core/analytics'],
  sourcemap: true,
  dts: false,
  banner: {
    js: '#!/usr/bin/env -S node --max-old-space-size=256 --expose-gc',
  },
})
