/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  NPCI / UPI RESPONSE CODES — the rail's vocabulary, mapped to ours.        │
 * │                                                                           │
 * │  Production-SHAPED, drawn from the UPI linking specification and the codes │
 * │  PSPs surface in practice. CONFIRM the exact set your PSP returns against  │
 * │  their reference and edit ONLY this file — every consumer reads the        │
 * │  classification, never the raw code.                                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Why a table instead of `if (code === '00')`:
 *
 * The single most expensive mistake available in payments is collapsing three
 * different meanings into one. "The payer declined" (final, no money moved), "the
 * beneficiary bank is offline" (retry later), and "nobody answered" (WE DO NOT
 * KNOW) all arrive as three-character strings, and code that treats every non-`00`
 * as a failure will refund a sender whose payment is still going to settle. That
 * is how money gets paid twice.
 *
 * So each code carries a {@link RailOutcome}, and the one that earns its keep is
 * `DEEMED`: it is not a failure, it is an absence of an answer, and the funds stay
 * in suspense until the rail or a human produces one.
 */

export type RailOutcome =
  /** Settled. Final. */
  | 'SUCCESS'
  /** Still in flight — keep the reserve, keep polling. */
  | 'PENDING'
  /** A definite no. Nothing moved; release the reserve. */
  | 'FAILED_TERMINAL'
  /** A technical decline. Nothing moved, and a fresh attempt may work. */
  | 'FAILED_RETRYABLE'
  /**
   * No definitive answer inside the window.
   *
   * NOT a failure. The money may or may not have moved, so it stays in suspense
   * and a human decides — the alternative (assume failure, refund the sender) is
   * the one that pays out twice when the rail settles an hour later.
   */
  | 'DEEMED'

export interface RailCodeMeaning {
  code: string
  outcome: RailOutcome
  /** Engineer-facing description of the rail's own meaning. */
  detail: string
  /**
   * What the user is told.
   *
   * Written to be ACTIONABLE. "Transaction failed (U30)" tells a person nothing
   * they can do; "your bank declined this — check your balance and try again"
   * tells them exactly what to try, and stops a support call.
   */
  userMessage: string
  /** Whether the payer can sensibly retry the same payment as-is. */
  retryable: boolean
}

function code(
  code: string,
  outcome: RailOutcome,
  detail: string,
  userMessage: string,
): RailCodeMeaning {
  return {
    code,
    outcome,
    detail,
    userMessage,
    retryable: outcome === 'FAILED_RETRYABLE',
  }
}

/**
 * The map. Grouped by what the code MEANS rather than alphabetically, because the
 * grouping is the part a reviewer needs to check.
 */
export const UPI_RESPONSE_CODES: Record<string, RailCodeMeaning> = {
  // ── success ───────────────────────────────────────────────────────────────
  '00': code(
    '00',
    'SUCCESS',
    'Approved / completed successfully',
    'Payment successful',
  ),

  // ── the payer said no, or authenticated wrongly ────────────────────────────
  // Terminal by definition: a retry would need the payer to act differently, and
  // silently re-presenting a payment somebody declined is the worst possible read
  // of their intent.
  ZA: code(
    'ZA',
    'FAILED_TERMINAL',
    'Transaction declined by the customer',
    'You cancelled this payment',
  ),
  ZM: code(
    'ZM',
    'FAILED_TERMINAL',
    'Invalid / incorrect UPI PIN',
    'Incorrect UPI PIN. Please try again from your UPI app',
  ),
  Z6: code(
    'Z6',
    'FAILED_TERMINAL',
    'Number of PIN attempts exceeded',
    'Too many incorrect PIN attempts. Your bank has locked UPI briefly',
  ),
  '75': code(
    '75',
    'FAILED_TERMINAL',
    'Allowable PIN tries exceeded',
    'Too many incorrect PIN attempts',
  ),
  ZR: code(
    'ZR',
    'FAILED_TERMINAL',
    'Invalid or expired token / OTP',
    'That authorisation expired. Please start again',
  ),
  '84': code(
    '84',
    'FAILED_TERMINAL',
    'Invalid authorisation lifecycle',
    'This payment could not be authorised. Please start again',
  ),

  // ── the money is not there ────────────────────────────────────────────────
  Z9: code(
    'Z9',
    'FAILED_TERMINAL',
    'Insufficient funds in the payer account',
    'Not enough balance in your account',
  ),
  '51': code(
    '51',
    'FAILED_TERMINAL',
    'Insufficient funds',
    'Not enough balance in your account',
  ),

  // ── the payee is wrong ────────────────────────────────────────────────────
  // Terminal, and this is the group where retrying is actively harmful: the
  // address is wrong, so a retry either fails identically or — worse, after a
  // typo is "fixed" by a recycled VPA — reaches somebody else.
  ZH: code(
    'ZH',
    'FAILED_TERMINAL',
    'Invalid virtual payment address',
    "That UPI ID doesn't exist. Check it and try again",
  ),
  ZY: code(
    'ZY',
    'FAILED_TERMINAL',
    'Invalid beneficiary',
    "The person you're paying couldn't be found",
  ),
  Z5: code(
    'Z5',
    'FAILED_TERMINAL',
    'Invalid beneficiary credentials',
    "The recipient's details are not valid",
  ),
  XH: code(
    'XH',
    'FAILED_TERMINAL',
    'Account does not exist',
    "The recipient's account doesn't exist",
  ),
  '14': code(
    '14',
    'FAILED_TERMINAL',
    'Invalid account number',
    "The recipient's account number is not valid",
  ),
  '76': code(
    '76',
    'FAILED_TERMINAL',
    'Invalid / incorrect beneficiary',
    "The recipient's details are not valid",
  ),
  ZX: code(
    'ZX',
    'FAILED_TERMINAL',
    'Beneficiary account inactive or dormant',
    "The recipient's account is inactive",
  ),
  XV: code(
    'XV',
    'FAILED_TERMINAL',
    'Account inactive or dormant',
    'That account is inactive or dormant',
  ),
  X6: code(
    'X6',
    'FAILED_TERMINAL',
    'Invalid IFSC',
    'That IFSC code is not valid',
  ),
  B1: code(
    'B1',
    'FAILED_TERMINAL',
    'Registered mobile number differs from the account',
    "Your bank says the mobile number on this account doesn't match",
  ),

  // ── not permitted ─────────────────────────────────────────────────────────
  '57': code(
    '57',
    'FAILED_TERMINAL',
    'Transaction not permitted to the payer',
    'Your bank does not allow this type of payment',
  ),
  '58': code(
    '58',
    'FAILED_TERMINAL',
    'Transaction not permitted to the acquirer',
    'This payment type is not supported here',
  ),
  '61': code(
    '61',
    'FAILED_TERMINAL',
    'Exceeds the withdrawal amount limit',
    "This is over your bank's per-payment limit",
  ),
  '65': code(
    '65',
    'FAILED_TERMINAL',
    'Exceeds the withdrawal frequency limit',
    "You've reached your bank's daily payment limit",
  ),
  '05': code(
    '05',
    'FAILED_TERMINAL',
    'Do not honour',
    'Your bank declined this payment',
  ),
  '03': code(
    '03',
    'FAILED_TERMINAL',
    'Invalid merchant',
    'This merchant could not be verified',
  ),
  '13': code(
    '13',
    'FAILED_TERMINAL',
    'Invalid amount',
    'That amount is not valid',
  ),
  '12': code(
    '12',
    'FAILED_TERMINAL',
    'Invalid transaction',
    'This payment is not valid',
  ),
  '30': code(
    '30',
    'FAILED_TERMINAL',
    'Format error in the request',
    'Something was wrong with this request',
  ),

  // ── risk / fraud ──────────────────────────────────────────────────────────
  U16: code(
    'U16',
    'FAILED_TERMINAL',
    'Risk threshold exceeded',
    'This payment was blocked for your safety. Contact support',
  ),
  K1: code(
    'K1',
    'FAILED_TERMINAL',
    'Suspected fraud — declined on risk',
    'This payment was blocked for your safety. Contact support',
  ),

  // ── technical declines: nothing moved, a retry may work ───────────────────
  U30: code(
    'U30',
    'FAILED_RETRYABLE',
    'Debit failure at the payer PSP',
    'Your bank could not complete this. Please try again',
  ),
  U31: code(
    'U31',
    'FAILED_RETRYABLE',
    'Credit failure at the payee PSP',
    "The recipient's bank could not accept this. Please try again",
  ),
  U53: code(
    'U53',
    'FAILED_RETRYABLE',
    'Beneficiary bank offline',
    "The recipient's bank is temporarily unavailable",
  ),
  Y1: code(
    'Y1',
    'FAILED_RETRYABLE',
    'Beneficiary bank offline',
    "The recipient's bank is temporarily unavailable",
  ),
  U28: code(
    'U28',
    'FAILED_RETRYABLE',
    'Payee PSP unavailable',
    "The recipient's app is temporarily unavailable",
  ),
  U66: code(
    'U66',
    'FAILED_RETRYABLE',
    'Payer PSP unavailable',
    'Your bank is temporarily unavailable',
  ),
  '91': code(
    '91',
    'FAILED_RETRYABLE',
    'Issuer or switch inoperative',
    'Your bank is temporarily unavailable. Please try again shortly',
  ),
  '92': code(
    '92',
    'FAILED_RETRYABLE',
    'Financial institution not found',
    'That bank could not be reached',
  ),
  '96': code(
    '96',
    'FAILED_RETRYABLE',
    'System malfunction',
    'A temporary system problem stopped this payment',
  ),
  RB: code(
    'RB',
    'FAILED_RETRYABLE',
    'Credit to the beneficiary failed',
    'The money could not reach the recipient and is being returned',
  ),

  // ── still in flight ───────────────────────────────────────────────────────
  U09: code(
    'U09',
    'PENDING',
    'Debit reversal confirmation awaited',
    "We're confirming this with your bank",
  ),
  '20': code(
    '20',
    'PENDING',
    'Invalid response — awaiting confirmation',
    "We're still confirming this payment",
  ),

  // ── no answer: DEEMED, never "failed" ─────────────────────────────────────
  // Every code here means the rail did not tell us the outcome. The temptation to
  // treat a timeout as a failure is exactly what this classification exists to
  // resist: if we refund the sender and the rail settles afterwards, the
  // beneficiary keeps a payment nobody funded.
  BT: code(
    'BT',
    'DEEMED',
    'Transaction timed out at the acquirer',
    "We're still confirming this. Your money is safe while we check",
  ),
  U54: code(
    'U54',
    'DEEMED',
    'Transaction timed out at the payer PSP',
    "We're still confirming this. Your money is safe while we check",
  ),
  U67: code(
    'U67',
    'DEEMED',
    'Debit timeout',
    "We're still confirming this. Your money is safe while we check",
  ),
  U68: code(
    'U68',
    'DEEMED',
    'Credit timeout — outcome unknown',
    "We're still confirming this. Your money is safe while we check",
  ),
  U88: code(
    'U88',
    'DEEMED',
    'Request timeout',
    "We're still confirming this. Your money is safe while we check",
  ),
  '68': code(
    '68',
    'DEEMED',
    'Response received too late',
    "We're still confirming this. Your money is safe while we check",
  ),
  '21': code(
    '21',
    'DEEMED',
    'No action taken — outcome unknown',
    "We're still confirming this. Your money is safe while we check",
  ),

  // ── collect / mandate specific ────────────────────────────────────────────
  U69: code(
    'U69',
    'FAILED_TERMINAL',
    'Collect request expired',
    'The payment request expired before it was approved',
  ),
  M1: code(
    'M1',
    'FAILED_TERMINAL',
    'Mandate not found',
    'That AutoPay mandate could not be found',
  ),
  M2: code(
    'M2',
    'FAILED_TERMINAL',
    'Mandate already revoked',
    'That AutoPay mandate has been cancelled',
  ),
  M3: code(
    'M3',
    'FAILED_TERMINAL',
    'Mandate amount exceeds the authorised limit',
    'This debit is larger than the amount you approved',
  ),
  M4: code(
    'M4',
    'FAILED_TERMINAL',
    'Mandate expired',
    'That AutoPay mandate has expired',
  ),
  M5: code(
    'M5',
    'FAILED_TERMINAL',
    'Pre-debit notification not sent',
    'We could not debit this without notifying you first',
  ),

  // ── duplicates ────────────────────────────────────────────────────────────
  /**
   * The rail telling us it has already seen this.
   *
   * Classified SUCCESS, which looks wrong until you consider what it means: the
   * rail is confirming a transaction with our reference exists. Treating it as a
   * failure would make us reverse a reserve for a payment the rail is holding, so
   * the reconciler resolves the true state from the status call — and the one thing
   * it must not do is assume nothing happened.
   */
  '94': code(
    '94',
    'SUCCESS',
    'Duplicate transmission — the rail already has this reference',
    'Payment successful',
  ),
}

/**
 * Classify a rail code.
 *
 * An UNKNOWN code is DEEMED, not FAILED. That default is the most important line
 * in this file: rails add codes, PSPs return undocumented ones, and a system that
 * reads "I have never seen this code" as "nothing happened" will refund senders
 * for payments that settled. Not knowing is a state we can hold safely; guessing
 * is not.
 */
export function classifyRailCode(
  railCode: string | null | undefined,
): RailCodeMeaning {
  if (!railCode) {
    return code(
      'UNKNOWN',
      'DEEMED',
      'No response code supplied by the rail',
      "We're still confirming this. Your money is safe while we check",
    )
  }
  const normalised = railCode.trim().toUpperCase()
  return (
    UPI_RESPONSE_CODES[normalised] ??
    code(
      normalised,
      'DEEMED',
      `Unrecognised rail response code ${normalised}`,
      "We're still confirming this. Your money is safe while we check",
    )
  )
}

export function isSuccessCode(railCode: string | null | undefined): boolean {
  return classifyRailCode(railCode).outcome === 'SUCCESS'
}

/** Whether the reserve may be released — only on a DEFINITE no. */
export function releasesReserve(railCode: string | null | undefined): boolean {
  const outcome = classifyRailCode(railCode).outcome
  return outcome === 'FAILED_TERMINAL' || outcome === 'FAILED_RETRYABLE'
}
