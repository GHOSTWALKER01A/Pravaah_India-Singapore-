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
    'src/passport/index.ts',
    'src/payments/index.ts',
    'src/insurance/index.ts',
    'src/fraud/index.ts',
    'src/partner/index.ts',
  ],
  format: ['cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
})
