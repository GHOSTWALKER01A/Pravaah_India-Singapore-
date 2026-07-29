import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import {
  OWNER_TYPE,
  PLATFORM_OWNER,
  TRIAL_BALANCE_TOLERANCE_MINOR,
} from '@/modules/payments/payments.config'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  AccountType,
  LedgerDirection,
  LedgerLeg,
  Prisma,
  type LedgerAccount,
} from 'generated/prisma/client'

/**
 * A single ledger movement. Always POSITIVE — the sign lives in `direction`.
 */
export interface Posting {
  accountId: string
  direction: LedgerDirection
  amountMinor: bigint
  currency: string
  leg: LedgerLeg
  /**
   * Discriminator for legs that may legitimately repeat: the id of the Reversal
   * or MandateExecution that caused this entry. `''` for once-only legs.
   */
  legRef?: string
  metadata?: Prisma.InputJsonValue
}

/**
 * Thrown when a posting already exists — i.e. this leg has already been booked.
 *
 * A distinct error type rather than a generic 500, because it is not a bug: it is
 * the database winning a race that application code cannot win. Two webhooks
 * settling the same transaction at the same instant both read `PENDING`, both
 * decide to settle, and the unique constraint stops the second. The caller's
 * correct response is to roll back and treat the operation as already done.
 */
export class LedgerDuplicatePostingError extends ConflictException {
  constructor(readonly transactionId: string) {
    super(`Ledger legs for transaction ${transactionId} are already posted`)
  }
}

export function isDuplicatePostingError(
  error: unknown,
): error is LedgerDuplicatePostingError {
  return error instanceof LedgerDuplicatePostingError
}

/**
 * Account types permitted to hold a negative balance.
 *
 * The distinction is the whole point of checking at all. A negative FX_POSITION
 * means we are short that currency, which is a real and expected state that must
 * be VISIBLE. A negative USER_WALLET means we have let somebody spend money they
 * do not have, and a negative SUSPENSE means we have settled money that was never
 * reserved — both are the system already being broken, and the only useful moment
 * to find out is inside the transaction that would cause it.
 */
const MAY_GO_NEGATIVE: ReadonlySet<AccountType> = new Set([
  AccountType.FX_POSITION,
  AccountType.PLATFORM_NOSTRO,
  AccountType.EXTERNAL,
  AccountType.RECEIVABLE,
  /**
   * M5's insurance book. A negative float means claims have outrun premiums —
   * a real underwriting loss, and one that must be VISIBLE rather than block a
   * payout. Refusing the posting would mean an approved claim goes unpaid
   * because the book was thin, which is the insurer failing its own
   * policyholder to keep a number tidy.
   */
  AccountType.INSURANCE_FLOAT,
])

/**
 * The double-entry ledger. Every rupee that moves in M4 moves through here.
 *
 * Three properties, and none of them is negotiable:
 *
 *  1. **Balanced.** {@link post} rejects any set of entries whose debits and
 *     credits do not net to zero PER CURRENCY. Money is conserved by construction,
 *     not by convention.
 *  2. **Append-only.** There is no update and no delete. A correction is a new,
 *     balanced pair of entries, so the history of how a balance came to be is
 *     always reconstructible — which is exactly what a dispute six months from now
 *     is argued from.
 *  3. **Derived balances.** A balance is `Σcredits − Σdebits`, computed on demand
 *     and never stored. A cached balance column is a second source of truth, and
 *     the moment it disagrees with the entries there is no way to tell which one
 *     is the money.
 *
 * The trial-balance invariant follows for free: since every posting set nets to
 * zero, the sum of all account balances per currency is always zero. That makes
 * {@link trialBalance} a genuine alarm — a non-zero result means entries reached
 * the table without passing through {@link post}.
 */
@Injectable()
export class LedgerService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: LedgerService.name })
  }

  // ── accounts ──────────────────────────────────────────────────────────────
  /**
   * Get or create an account.
   *
   * Two concurrent first-time transfers by the same user race to create the same
   * wallet, so this has to tolerate losing that race. What it must NOT do is
   * tolerate it by catching the violation and reading the row back, which is what
   * it used to do:
   *
   * ```ts
   * try { return await client.ledgerAccount.create({ … }) }
   * catch (error) {
   *   if (isUniqueViolation(error)) {
   *     const found = await client.ledgerAccount.findUnique({ where })  // ← poisoned
   * ```
   *
   * `client` is normally a TRANSACTION client, because posting money is one
   * transaction. In Postgres a failed statement aborts the entire transaction, so
   * the moment that `create` violated the constraint, every later command on the
   * same `tx` returned:
   *
   *     25P02  current transaction is aborted, commands ignored until end of
   *            transaction block
   *
   * So the `findUnique` in the catch block could never succeed, and worse, the
   * 25P02 it raised REPLACED the unique violation on the way out — the logs named
   * a Postgres state error while the real cause was a lost race on a wallet row.
   * That is why `recoverStuckSagas` then failed the same way on every retry: each
   * re-drive raced the same account creation and poisoned its own transaction.
   * Recovering inside a transaction needs a SAVEPOINT, and Prisma's interactive
   * transactions do not wrap individual statements in one.
   *
   * `createMany` with `skipDuplicates` compiles to `INSERT … ON CONFLICT DO
   * NOTHING`. A conflict is then not an error at all, so nothing is aborted and
   * there is nothing to catch — the row is simply read back afterwards. `upsert`
   * would also work when Prisma emits its native `ON CONFLICT DO UPDATE`, but it
   * silently falls back to a non-atomic read-then-write when a query does not
   * qualify, and this is not a place to depend on that staying true.
   */
  async ensureAccount(
    ownerType: string,
    ownerId: string | null,
    type: AccountType,
    currency: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<LedgerAccount> {
    // `''`, never null — a nullable owner would make the unique constraint
    // toothless, since Postgres treats NULLs as distinct. See LedgerAccount.
    const owner = ownerId ?? PLATFORM_OWNER
    const where = {
      ownerType_ownerId_type_currency: {
        ownerType,
        ownerId: owner,
        type,
        currency,
      },
    }

    const existing = await client.ledgerAccount.findUnique({ where })
    if (existing) return existing

    await client.ledgerAccount.createMany({
      data: [
        {
          ownerType,
          ownerId: owner,
          type,
          currency,
          label: `${type} · ${currency}`,
          allowNegative: MAY_GO_NEGATIVE.has(type),
        },
      ],
      // The whole point. Losing the race is an expected outcome, not a failure,
      // and it must not abort the money-moving transaction this runs inside.
      skipDuplicates: true,
    })

    /**
     * `OrThrow`, because by this line the row exists or something is genuinely
     * wrong.
     *
     * Either this call inserted it or a concurrent one did. A miss would mean the
     * unique index does not cover the columns this `where` names — exactly the
     * class of drift that let three rows share one `vpa` on `UpiHandle` — and a
     * silent `null` here would surface later as a foreign-key error on a ledger
     * entry, a long way from the cause.
     */
    return client.ledgerAccount.findUniqueOrThrow({ where })
  }

  /** The user's spendable wallet. */
  userWallet(
    userId: string,
    currency: string,
    client?: Prisma.TransactionClient,
  ): Promise<LedgerAccount> {
    return this.ensureAccount(
      OWNER_TYPE.USER,
      userId,
      AccountType.USER_WALLET,
      currency,
      client,
    )
  }

  /** A platform-owned account. Owner is `''` by construction. */
  platformAccount(
    type: AccountType,
    currency: string,
    client?: Prisma.TransactionClient,
  ): Promise<LedgerAccount> {
    return this.ensureAccount(
      OWNER_TYPE.PLATFORM,
      PLATFORM_OWNER,
      type,
      currency,
      client,
    )
  }

  /** The outside world, as seen from one beneficiary. */
  externalAccount(
    beneficiaryRef: string,
    currency: string,
    client?: Prisma.TransactionClient,
  ): Promise<LedgerAccount> {
    return this.ensureAccount(
      OWNER_TYPE.EXTERNAL,
      beneficiaryRef,
      AccountType.EXTERNAL,
      currency,
      client,
    )
  }

  // ── posting ───────────────────────────────────────────────────────────────
  /**
   * Post a balanced set of entries. Atomic, all-or-nothing.
   *
   * MUST be called inside a `$transaction` — it takes the client rather than
   * opening its own, so the ledger write and the status change it justifies commit
   * or roll back together. A settlement whose entries committed and whose status
   * update did not is a transaction the reconciler will try to settle again.
   */
  async post(
    tx: Prisma.TransactionClient,
    transactionId: string,
    postings: Posting[],
  ): Promise<void> {
    if (postings.length === 0) {
      throw new BadRequestException('Ledger post with no entries')
    }

    const merged = aggregatePostings(postings)
    this.assertBalanced(merged)

    const accounts = await this.loadAccounts(tx, merged)
    this.assertCurrenciesMatch(merged, accounts)

    try {
      await tx.ledgerEntry.createMany({
        data: merged.map((posting) => ({
          transactionId,
          accountId: posting.accountId,
          direction: posting.direction,
          amountMinor: posting.amountMinor,
          currency: posting.currency,
          leg: posting.leg,
          legRef: posting.legRef ?? '',
          metadata: posting.metadata,
        })),
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The constraint did its job. Not an error to log at error level — it is
        // the expected outcome of two concurrent settlements.
        this.logger.warn(`[${this.post.name}] Duplicate ledger legs rejected`, {
          transactionId,
          legs: merged.map((p) => p.leg),
        })
        throw new LedgerDuplicatePostingError(transactionId)
      }
      throw error
    }

    await this.assertNoOverdraft(tx, merged, accounts)
  }

  /**
   * Reject any set whose debits and credits do not net to zero, per currency.
   *
   * Per currency, not overall. A cross-border settlement touches two currencies
   * and their amounts are not comparable — netting SGD cents against INR paise
   * would produce a number that means nothing and would "balance" a set that had
   * silently created money on one side.
   */
  private assertBalanced(postings: Posting[]): void {
    const net = new Map<string, bigint>()

    for (const posting of postings) {
      if (posting.amountMinor <= 0n) {
        throw new BadRequestException(
          `Ledger posting amount must be positive (${posting.leg} on ${posting.accountId})`,
        )
      }
      // Credits positive, debits negative. The convention only has to be
      // consistent; it is stated here because it is the one every reader checks.
      const signed =
        posting.direction === LedgerDirection.DEBIT
          ? -posting.amountMinor
          : posting.amountMinor
      net.set(posting.currency, (net.get(posting.currency) ?? 0n) + signed)
    }

    for (const [currency, balance] of net) {
      if (balance !== 0n) {
        throw new BadRequestException(
          `Ledger imbalance in ${currency}: ${balance.toString()} minor units`,
        )
      }
    }
  }

  private async loadAccounts(
    tx: Prisma.TransactionClient,
    postings: Posting[],
  ): Promise<Map<string, LedgerAccount>> {
    const ids = [...new Set(postings.map((posting) => posting.accountId))]
    const rows = await tx.ledgerAccount.findMany({ where: { id: { in: ids } } })
    if (rows.length !== ids.length) {
      throw new BadRequestException(
        'Ledger posting references an unknown account',
      )
    }
    return new Map(rows.map((row) => [row.id, row]))
  }

  /**
   * An entry's currency must match the account's.
   *
   * Cheap to check and catastrophic to miss: crediting SGD cents to an INR account
   * still balances arithmetically, so nothing else in the system would notice. The
   * balance would simply be wrong by a factor of the exchange rate, and it would
   * stay wrong forever because the ledger is append-only.
   */
  private assertCurrenciesMatch(
    postings: Posting[],
    accounts: Map<string, LedgerAccount>,
  ): void {
    for (const posting of postings) {
      const account = accounts.get(posting.accountId)
      if (account && account.currency !== posting.currency) {
        throw new BadRequestException(
          `Ledger posting in ${posting.currency} against a ${account.currency} account (${account.type})`,
        )
      }
    }
  }

  /**
   * After the write, no account that must stay non-negative may be negative.
   *
   * Checked AFTER the insert, inside the same transaction, so the query sees our
   * own uncommitted rows and the whole thing rolls back if the invariant broke.
   * Checking beforehand would be checking a balance that the very next statement
   * changes.
   *
   * This is a backstop, not the primary control — the reserve path locks the wallet
   * row and checks the balance before spending. It exists because a backstop is
   * what catches the path nobody thought to guard.
   */
  private async assertNoOverdraft(
    tx: Prisma.TransactionClient,
    postings: Posting[],
    accounts: Map<string, LedgerAccount>,
  ): Promise<void> {
    const debited = [
      ...new Set(
        postings
          .filter((posting) => posting.direction === LedgerDirection.DEBIT)
          .map((posting) => posting.accountId),
      ),
    ].filter((id) => {
      const account = accounts.get(id)
      return account ? !account.allowNegative : false
    })

    for (const accountId of debited) {
      const balance = await this.balance(accountId, tx)
      if (balance < 0n) {
        const account = accounts.get(accountId)
        throw new ConflictException(
          `Posting would overdraw ${account?.type ?? 'account'} ${accountId} to ${balance.toString()}`,
        )
      }
    }
  }

  // ── balances ──────────────────────────────────────────────────────────────
  /**
   * `Σcredits − Σdebits`. Computed, never stored.
   *
   * A cached balance column is a second source of truth, and the moment it
   * disagrees with the entries there is no way to tell which one is the money.
   */
  async balance(
    accountId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<bigint> {
    const rows = await client.ledgerEntry.groupBy({
      by: ['direction'],
      where: { accountId },
      _sum: { amountMinor: true },
    })

    let credit = 0n
    let debit = 0n
    for (const row of rows) {
      const sum = row._sum.amountMinor ?? 0n
      if (row.direction === LedgerDirection.CREDIT) credit += sum
      else debit += sum
    }
    return credit - debit
  }

  /**
   * Lock a ledger account for the rest of the transaction.
   *
   * `SELECT … FOR UPDATE`, and it is what makes the reserve safe. Prisma's
   * interactive transactions run at READ COMMITTED, which does NOT prevent two
   * concurrent transfers from both reading a ₹1,000 balance and both spending it —
   * neither sees the other's uncommitted entry, so both balance checks pass and the
   * wallet goes to −₹1,000. The check is not wrong; it is simply not atomic with
   * the spend. This row lock makes it so.
   *
   * Serialisable isolation would also work, at the cost of retry loops on every
   * conflict. A row lock is narrower and its contention is confined to one user's
   * own wallet.
   */
  async lockAccount(
    tx: Prisma.TransactionClient,
    accountId: string,
  ): Promise<void> {
    // The model has no `@@map`, so the table is the quoted model name.
    const locked = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM "LedgerAccount" WHERE id = ${accountId}::uuid FOR UPDATE`,
    )
    if (locked.length === 0) {
      throw new InternalServerErrorException(
        `Ledger account ${accountId} vanished while locking`,
      )
    }
  }

  /**
   * Lock a wallet and return its balance, in one step.
   *
   * The two belong together: a balance read without the lock is advisory, and a
   * lock without an immediate read is pointless. Callers get the pair or neither.
   */
  async lockWalletAndBalance(
    tx: Prisma.TransactionClient,
    userId: string,
    currency: string,
  ): Promise<{ account: LedgerAccount; balance: bigint }> {
    const account = await this.userWallet(userId, currency, tx)
    await this.lockAccount(tx, account.id)
    return { account, balance: await this.balance(account.id, tx) }
  }

  /** Every account a user holds, with its derived balance. */
  async userBalances(
    userId: string,
  ): Promise<Array<{ account: LedgerAccount; balance: bigint }>> {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: { ownerType: OWNER_TYPE.USER, ownerId: userId },
      orderBy: { currency: 'asc' },
    })
    return Promise.all(
      accounts.map(async (account) => ({
        account,
        balance: await this.balance(account.id),
      })),
    )
  }

  // ── the alarm ─────────────────────────────────────────────────────────────
  /**
   * The trial balance: the sum of every account's balance, per currency.
   *
   * It must be exactly zero, in every currency, always. Since {@link post} rejects
   * an unbalanced set, a non-zero result cannot come from a bad posting — it means
   * entries reached the table WITHOUT passing through `post`: a raw SQL fix, a
   * migration, a direct database edit. That is precisely the class of change that
   * loses money quietly, which is why this is the one number an operator should be
   * paged about.
   *
   * There is no tolerance. Double-entry either holds or it does not, and a "small
   * acceptable drift" is an unexplained loss with a budget.
   */
  async trialBalance(currency?: string): Promise<
    Array<{
      currency: string
      credits: bigint
      debits: bigint
      net: bigint
      balanced: boolean
    }>
  > {
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['currency', 'direction'],
      where: currency ? { currency } : undefined,
      _sum: { amountMinor: true },
    })

    const totals = new Map<string, { credits: bigint; debits: bigint }>()
    for (const row of grouped) {
      const entry = totals.get(row.currency) ?? { credits: 0n, debits: 0n }
      const sum = row._sum.amountMinor ?? 0n
      if (row.direction === LedgerDirection.CREDIT) entry.credits += sum
      else entry.debits += sum
      totals.set(row.currency, entry)
    }

    return [...totals.entries()].map(([code, { credits, debits }]) => {
      const net = credits - debits
      const balanced = (net < 0n ? -net : net) <= TRIAL_BALANCE_TOLERANCE_MINOR
      if (!balanced) {
        this.logger.error(
          `[${this.trialBalance.name}] TRIAL BALANCE BROKEN in ${code}`,
          { currency: code, net: net.toString() },
        )
      }
      return { currency: code, credits, debits, net, balanced }
    })
  }

  /**
   * Per-account balances, for the admin ledger view.
   *
   * Read from the entries rather than from a balances table, so what an operator
   * sees during an incident is derived from the same source as the money itself.
   */
  async accountBalances(currency?: string): Promise<
    Array<{
      account: LedgerAccount
      balance: bigint
    }>
  > {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: currency ? { currency } : undefined,
      orderBy: [{ currency: 'asc' }, { type: 'asc' }],
    })
    return Promise.all(
      accounts.map(async (account) => ({
        account,
        balance: await this.balance(account.id),
      })),
    )
  }

  /** The entries behind one transaction, in posting order. */
  entriesForTransaction(transactionId: string) {
    return this.prisma.ledgerEntry.findMany({
      where: { transactionId },
      include: { account: true },
      orderBy: { postedAt: 'asc' },
    })
  }
}

/**
 * Merge postings that share `(account, direction, leg, legRef)`.
 *
 * Necessary, not tidy-up. Several flows naturally produce two movements against
 * one account in the same leg — a full refund returns both the transferred amount
 * and the fee to the same wallet, and a domestic recovery debits one FX position
 * twice. Those are two INSERTs that collide on the unique constraint, so the
 * legitimate operation would fail as though it were a duplicate. Summing them is
 * the correct reading: one leg, one net movement per account.
 *
 * It also runs BEFORE the balance check, so a caller cannot smuggle an unbalanced
 * set past it by splitting one side into two entries.
 */
export function aggregatePostings(postings: Posting[]): Posting[] {
  const merged = new Map<string, Posting>()

  for (const posting of postings) {
    const key = [
      posting.accountId,
      posting.direction,
      posting.leg,
      posting.legRef ?? '',
    ].join('|')

    const existing = merged.get(key)
    if (existing) {
      existing.amountMinor += posting.amountMinor
    } else {
      merged.set(key, { ...posting, legRef: posting.legRef ?? '' })
    }
  }

  return [...merged.values()]
}

/** Prisma's unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  )
}
