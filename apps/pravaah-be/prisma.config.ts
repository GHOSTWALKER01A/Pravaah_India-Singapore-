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

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env<Env>('DATABASE_URL'),
  },
})
