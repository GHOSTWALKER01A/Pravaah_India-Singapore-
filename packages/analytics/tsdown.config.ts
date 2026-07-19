import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/core/index.ts',
    'src/catalog/index.ts',
    'src/types.ts',
    'src/adapters/posthog-web/index.ts',
    'src/adapters/posthog-rn/index.ts',
  ],
  format: ['cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
})
