import { resolve } from 'path'

import { config } from 'dotenv'
import { defineConfig, env } from 'prisma/config'

// The Prisma CLI does not go through NestJS's ConfigModule, so load the env
// files ourselves (later files override earlier ones). This makes
// `.env.development.local` — where DATABASE_URL lives — available to the CLI.
const nodeEnv = process.env.NODE_ENV || 'development'
const envFiles = [
  '.env',
  '.env.local',
  `.env.${nodeEnv}`,
  `.env.${nodeEnv}.local`,
]

for (const envFile of envFiles) {
  config({ path: resolve(process.cwd(), envFile), override: true })
}

type Env = {
  DATABASE_URL: string
}

/**
 * `prisma generate` only reads the schema — it never opens a connection. But
 * `env()` resolves eagerly while this config module loads, so on a builder with no
 * DATABASE_URL (Vercel, or any CI that builds before secrets are wired) the whole
 * build dies with `PrismaConfigEnvError` before `nest build` is even reached.
 *
 * So `generate` falls back to a placeholder. Every command that actually connects
 * — `migrate`, `db push`, `studio`, `seed` — still goes through `env()` and still
 * fails loudly when the real value is absent.
 */
const GENERATE_ONLY_PLACEHOLDER_URL =
  'postgresql://placeholder:placeholder@localhost:5432/placeholder'

function resolveBuildTimeUrl(): string | undefined {
  const configured = process.env.DATABASE_URL
  // A variable that exists but is blank is not a usable URL — a dashboard entry
  // created without a value must behave the same as no variable at all.
  if (configured !== undefined && configured.trim() !== '') {
    return configured
  }

  if (process.argv.includes('generate')) {
    return GENERATE_ONLY_PLACEHOLDER_URL
  }

  return undefined
}

const buildTimeUrl = resolveBuildTimeUrl()

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: buildTimeUrl ?? env<Env>('DATABASE_URL'),
  },
})
