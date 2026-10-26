import { poolSizeFor } from '@/modules/database/prisma/prisma.service'

/**
 * The pool ceiling is a budget against the Supabase session pooler's 15-client limit,
 * shared with the Prisma CLI and scripts. A regression to an unbounded or 50-client
 * default reproduces EMAXCONNSESSION at every cron burst.
 */
describe('poolSizeFor', () => {
  const base =
    'postgresql://u:p@aws-1-ap-south-1.pooler.supabase.com:5432/postgres'

  it('defaults well below the session pooler limit of 15', () => {
    expect(poolSizeFor(`${base}?sslmode=no-verify`)).toBe(10)
    expect(poolSizeFor(base)).toBeLessThan(15)
  })

  it('honours an explicit connection_limit', () => {
    expect(poolSizeFor(`${base}?connection_limit=4&sslmode=require`)).toBe(4)
  })

  it.each(['0', '-3', 'abc', ''])(
    'ignores an invalid connection_limit (%s)',
    (value) => {
      expect(poolSizeFor(`${base}?connection_limit=${value}`)).toBe(10)
    },
  )
})
