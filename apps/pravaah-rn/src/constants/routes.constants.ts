import { type Href } from 'expo-router';

/**
 * Typed route paths for expo-router. Keeps navigation strings in one place
 * so screens never hard-code hrefs.
 */
export const ROUTES = {
  AUTH: {
    SEND_OTP: '/(auth)/send-otp',
    VERIFY_OTP: '/(auth)/verify-otp',
    ONBOARDING: '/(auth)/onboarding',
  },
  TABS: {
    HOME: '/(app)/(tabs)',
    KYC: '/(app)/(tabs)/kyc',
    // M2's main screen IS this tab. There is no `/(app)/score` index route —
    // `(app)` and `(tabs)` are groups and contribute no path segment, so an index
    // there would resolve to `/score` too and collide with the tab.
    /**
     * M4's wallet IS this tab — the current leaf of the cheque book. `/(app)/pay` has no index
     * route; that path holds only the pushed children.
     */
    PAY: '/(app)/(tabs)/pay',
    /**
     * M5's marketplace IS this tab. `/(app)/insurance` has no index route; that path
     * holds only the pushed children.
     */
    INSURANCE: '/(app)/(tabs)/insurance',
    PROFILE: '/(app)/(tabs)/profile',
  },
  // Cast to Href (matches the flow.ts convention) so these are stable even
  // while expo-router's generated route types are mid-regeneration.
  CONSENT: {
    DASHBOARD: '/(app)/consent' as Href,
    NEW: '/(app)/consent/new' as Href,
    DETAIL: (id: string) =>
      ({ pathname: '/(app)/consent/[id]', params: { id } }) as Href,
  },
  /**
   * M2 child screens pushed on top of the Reputation tab. The tab itself is
   * `/(app)/score` now HAS an index route (the score left the tab bar), mirroring how
   * `/(app)/kyc` holds only children for the Verify tab.
   */
  SCORE: {
    /**
     * The score's own screen. No longer a tab: it moved out of the bar so the raised scan action
     * could take the centre slot, and because the passport already reveals the number as its latent
     * image. Reached from the passport panel and from the Bearer tab.
     */
    ROOT: '/(app)/score' as Href,
    HISTORY: '/(app)/score/history' as Href,
    // The separate, optional consent for audit-only protected attributes.
    FAIRNESS: '/(app)/score/fairness' as Href,
  },
  /**
   * M3 child screens pushed on top of the Passport tab. The tab itself is TABS.HOME —
   * `/(app)/passport` has no index route, mirroring how `/(app)/score` holds only children
   * for the Reputation tab.
   */
  PASSPORT: {
    /** The wallet: the credential, its inbox, and where it leads. */
    WALLET: '/(app)/passport/wallet' as Href,
    /** The consent-to-disclose screen. Also the deep-link target for a card tap. */
    REQUEST: (requestId: string) =>
      ({ pathname: '/(app)/passport/request/[requestId]', params: { requestId } }) as Href,
    CARD: '/(app)/passport/card' as Href,
    HISTORY: '/(app)/passport/history' as Href,
    /**
     * M7 — every share with a registered ORGANISATION, as a consent receipt the holder can
     * withdraw. Distinct from HISTORY, which logs every presentation (people too, and
     * failed attempts): a receipt is the durable consent artefact, a history row is an event.
     */
    SHARES: '/(app)/passport/shares' as Href,
    SHARE: (receiptId: string) =>
      ({ pathname: '/(app)/passport/shares/[receiptId]', params: { receiptId } }) as Href,
    /**
     * The SCANNER's side of a peer check — where you wait for the person whose code you
     * just scanned, and where their details appear once they approve.
     *
     * Distinct from REQUEST, which is the HOLDER's side. Two screens rather than one
     * because they are opposite roles in the same handshake: one waits and receives, the
     * other decides and discloses, and a shared screen would have to guess which of the
     * two people is looking at it.
     */
    CHECK: (requestId: string) =>
      ({ pathname: '/(app)/passport/check/[requestId]', params: { requestId } }) as Href,
  },
  /**
   * M4 child screens pushed on top of the Pay tab. The tab itself is TABS.PAY.
   *
   * The send flow is four pushed screens rather than one form, because each step is a
   * decision that must be made before the next one can be shown honestly: you cannot
   * price a transfer before knowing the payee's corridor, and you cannot ask for a
   * name confirmation before the payee bank has returned a name.
   */
  PAY: {
    /** Step 1 — who. */
    SEND: '/(app)/payments/send' as Href,
    /** Step 2 — how much, priced live against the corridor's cap. */
    SEND_AMOUNT: (beneficiaryId: string) =>
      ({
        pathname: '/(app)/payments/send/[beneficiaryId]',
        params: { beneficiaryId },
      }) as Href,
    /** Step 3 — the drawn cheque: figures, words, payee line, authorise. */
    SEND_CONFIRM: (beneficiaryId: string, quoteId: string) =>
      ({
        pathname: '/(app)/payments/send/confirm',
        params: { beneficiaryId, quoteId },
      }) as Href,

    /**
     * Pay to a phone number — the destination people reach for first.
     *
     * Its own screen rather than a mode of "add a payee", because the two ask different questions.
     * Adding a payee asks for an address; this asks for a number and then SEARCHES for the address,
     * which can find several or none. Folding a search that may fail into a form that always succeeds
     * would leave the user staring at a validation error for a number that is perfectly correct.
     */
    TO_PHONE: '/(app)/payments/to-phone' as Href,

    PAYEES: '/(app)/payments/payees' as Href,
    PAYEE_ADD: '/(app)/payments/payees/add' as Href,
    PAYEE_DETAIL: (id: string) =>
      ({ pathname: '/(app)/payments/payees/[id]', params: { id } }) as Href,

    /** The counterfoil — a payment's stub, and the receipt. */
    RECEIPT: (id: string) =>
      ({ pathname: '/(app)/payments/[id]', params: { id } }) as Href,
    /** The passbook: every ledger movement, not just the transfers. */
    STATEMENT: '/(app)/payments/statement' as Href,

    SCAN: '/(app)/payments/scan' as Href,
    MY_QR: '/(app)/payments/qr' as Href,

    REQUEST: '/(app)/payments/request' as Href,
    REQUESTS: '/(app)/payments/requests' as Href,

    TOPUP: '/(app)/payments/topup' as Href,
    WITHDRAW: '/(app)/payments/withdraw' as Href,

    AUTOPAY: '/(app)/payments/autopay' as Href,
    AUTOPAY_NEW: '/(app)/payments/autopay/new' as Href,
    AUTOPAY_DETAIL: (id: string) =>
      ({ pathname: '/(app)/payments/autopay/[id]', params: { id } }) as Href,

    DISPUTES: '/(app)/payments/disputes' as Href,
    DISPUTE_NEW: (transactionId: string) =>
      ({
        pathname: '/(app)/payments/disputes/new',
        params: { transactionId },
      }) as Href,
  },
  /**
   * M5 child screens pushed on top of the Insurance tab. The tab itself is
   * TABS.INSURANCE — `/(app)/insurance` has no index route, mirroring how
   * `/(app)/payments` holds only children for the Pay tab.
   *
   * The buy flow is THREE pushed screens rather than one form, for the same reason the
   * send flow is four: each step is a decision that cannot be shown honestly before the
   * previous one is made. You cannot price cover before knowing how much of it somebody
   * wants, and you cannot ask them to accept exclusions before they have seen the price
   * those exclusions apply to.
   */
  INSURANCE: {
    /** Step 1 — how much cover, on one product. */
    COVER: (productId: string) =>
      ({
        pathname: '/(app)/insurance/cover/[productId]',
        params: { productId },
      }) as Href,
    /** Step 2 — the price, the waiting period, the exclusions, and the decision. */
    QUOTE: (quoteId: string) =>
      ({ pathname: '/(app)/insurance/quote/[quoteId]', params: { quoteId } }) as Href,

    /** The policy wallet: everything held, including what has lapsed. */
    POLICIES: '/(app)/insurance/policies' as Href,
    POLICY: (policyId: string) =>
      ({ pathname: '/(app)/insurance/policy/[policyId]', params: { policyId } }) as Href,
    /**
     * Each premium period and what happened to it.
     *
     * A SIBLING of the policy route rather than a child of it, which looks like the wrong
     * shape and is the app's actual convention: `payments/send/` holds a flat
     * `[beneficiaryId].tsx` beside a static `confirm.tsx`, and there is no
     * directory-index dynamic route anywhere in this router. A
     * `policy/[policyId]/premiums` would need `policy/[policyId]/index.tsx`, which
     * expo-router's generated types do not express as a navigable href — so the nesting
     * would have to be cast past the type system to compile.
     */
    PREMIUMS: (policyId: string) =>
      ({
        pathname: '/(app)/insurance/premiums/[policyId]',
        params: { policyId },
      }) as Href,

    CLAIMS: '/(app)/insurance/claims' as Href,
    /** File against one policy. The policy is the subject, so it is in the path. */
    CLAIM_NEW: (policyId: string) =>
      ({ pathname: '/(app)/insurance/claims/new', params: { policyId } }) as Href,
    CLAIM: (claimId: string) =>
      ({ pathname: '/(app)/insurance/claims/[claimId]', params: { claimId } }) as Href,
    /**
     * Evidence, on its own screen.
     *
     * Separate from the claim detail because uploading is a task with its own progress
     * and its own failure modes — a photograph that would not send, a document the OCR
     * could not read — and burying it inside a status screen would leave the claimant
     * unsure whether their bill had actually arrived.
     */
    CLAIM_DOCUMENTS: (claimId: string) =>
      ({
        pathname: '/(app)/insurance/documents/[claimId]',
        params: { claimId },
      }) as Href,
  },
  KYC: {
    STATUS: '/(app)/kyc/status',
    // Shared across rails
    LIVENESS: '/(app)/kyc/liveness',
    FACE_MATCH: '/(app)/kyc/face-match',
    SANCTIONS: '/(app)/kyc/sanctions',
    INDIA: {
      PAN: '/(app)/kyc/india/pan',
      AADHAAR: '/(app)/kyc/india/aadhaar',
      BANK: '/(app)/kyc/india/bank',
    },
    SINGAPORE: '/(app)/kyc/singapore',
  },
  /**
   * M6 — the user's own security surface.
   *
   * Two screens rather than one, because they answer two different questions and are reached
   * at different moments: "which devices can act as me" is a thing a worried user goes
   * looking for, while "why was I asked to confirm that" is a thing they follow up on after
   * being challenged.
   *
   * There is deliberately no step-up ROUTE. A challenge on a payment is rendered on that
   * payment's own receipt, so it can be read alongside the amount and the payee and survives
   * the app being killed — a dedicated screen would have to be handed the nonce through
   * params and would strand the payment if dismissed.
   */
  SECURITY: {
    DEVICES: '/(app)/security' as Href,
    ACTIVITY: '/(app)/security/activity' as Href,
    /** Set a PIN for the first time. Refuses if one already exists — use PIN_CHANGE. */
    PIN: '/(app)/security/pin' as Href,
    /** Change or reset. One screen, because a user who forgot arrives wanting the other one. */
    PIN_CHANGE: '/(app)/security/pin-change' as Href,
  },
} as const;
