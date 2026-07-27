import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/common/index.ts',
    'src/auth/index.ts',
    'src/admin/index.ts',
    'src/kyc/index.ts',
    'src/consent/index.ts',
    'src/scoring/index.ts',
  ],
  format: ['cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
})
