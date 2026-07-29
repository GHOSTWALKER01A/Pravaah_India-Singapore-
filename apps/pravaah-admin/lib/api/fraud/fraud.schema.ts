/**
 * M6 admin projections.
 *
 * Mirrors the server's analyst-console shapes once, here. Unlike the user-facing app, the
 * console DOES receive scores, signal types and weights — an analyst defending a hold, or
 * tuning a threshold, needs the arithmetic. That asymmetry is the reason there are two
 * projections of the same assessment rather than one.
 */

// ── vocabulary ──────────────────────────────────────────────────────────────
export type RiskDecision = 'ALLOW' | 'REVIEW' | 'STEP_UP' | 'HOLD' | 'BLOCK';

export type RiskSubjectType =
  | 'TRANSACTION'
  | 'CLAIM'
  | 'LOGIN'
  | 'DEVICE_BIND'
  | 'CONSENT'
  | 'PAYOUT';

export type FraudCaseStatus =
  | 'OPEN'
  | 'INVESTIGATING'
  | 'INFO_REQUESTED'
  | 'CLEARED'
  | 'CONFIRMED_FRAUD'
  | 'ESCALATED';

/** Declaration order IS the server's sort order — `desc` yields CRITICAL first. */
export type FraudSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * What an analyst may CHOOSE.
 *
 * A deliberate subset of `FraudCaseStatus`: `OPEN`, `INVESTIGATING` and `INFO_REQUESTED` are
 * reached by workflow transitions (claiming a case, asking the user something), not by a
 * resolve. Offering them here would let an analyst "resolve" a case back into the queue and
 * reset its SLA clock.
 */
export type FraudCaseOutcome = 'CLEARED' | 'CONFIRMED_FRAUD' | 'ESCALATED';

export type ListKind = 'WATCH' | 'BLOCK' | 'MULE' | 'SANCTIONS';

export type ListEntityType =
  | 'USER'
  | 'DEVICE'
  | 'VPA'
  | 'BENEFICIARY'
  | 'IP'
  | 'MOBILE';

export type EntityLinkType =
  | 'SHARED_DEVICE'
  | 'SHARED_BENEFICIARY'
  | 'SHARED_VPA'
  | 'SHARED_IP';

export type DeviceStatus = 'BINDING' | 'ACTIVE' | 'REVOKED' | 'SUSPECTED_SWAP';

// ── signals and assessments ─────────────────────────────────────────────────
/**
 * One signal that fired, with the weight it carried.
 *
 * `isHard` is the field that explains an otherwise inexplicable decision: a BLOCK on a score
 * of 0.02 makes no sense until you can see that one signal bypassed the arithmetic entirely.
 */
export interface RiskSignal {
  id: string;
  type: string;
  weight: number;
  /** 0..1 degree — how strongly this instance fired. */
  value: number;
  reason: string;
  isHard: boolean;
}

export interface AdminRiskAssessment {
  id: string;
  userId: string;
  subjectType: RiskSubjectType;
  /** TEXT, not a uuid — a LOGIN is scored before any row exists to point at. */
  subjectId: string;
  score: number;
  decision: RiskDecision;
  /**
   * Which weight set produced this score.
   *
   * Shown on every case, because the weights ARE the policy: a score from before a re-tune
   * cannot be compared with one from after, and an appeal months later has to be argued
   * against the rules that actually applied.
   */
  modelVersion: string;
  deviceRef: string | null;
  ipHash: string | null;
  geoHint: string | null;
  computedAt: string;
  signals: RiskSignal[];
}

/** The list projection — signal types only, to keep the queue query cheap. */
export interface AdminAssessmentRow {
  id: string;
  userId: string;
  subjectType: RiskSubjectType;
  subjectId: string;
  score: number;
  decision: RiskDecision;
  modelVersion: string;
  geoHint: string | null;
  computedAt: string;
  signals: { type: string; isHard: boolean }[];
}

// ── cases ───────────────────────────────────────────────────────────────────
export interface FraudCaseNote {
  id: string;
  analystId: string;
  note: string;
  /** "HELD_RELEASED" | "USER_BLOCKED" | "STR_FILED" | "ESCALATED" | null. */
  action: string | null;
  createdAt: string;
}

export interface FraudCaseRow {
  id: string;
  userId: string;
  status: FraudCaseStatus;
  severity: FraudSeverity;
  /** Comma-joined signal types. The one-line "why" a queue row shows. */
  reason: string;
  subjectType: RiskSubjectType;
  subjectId: string;
  assignedAnalystId: string | null;
  slaDueAt: string | null;
  openedAt: string;
  resolvedAt: string | null;
  /**
   * The analyst's stated reason, on a resolved case.
   *
   * Distinct from the note trail: this is the ONE reason attached to the outcome, whereas the
   * notes are the working record that led to it. A resolved case shows this rather than the last
   * note, because the last note is often a mid-investigation observation and would misrepresent
   * the decision.
   */
  resolution: string | null;
  /**
   * Whether the held action was actually released or blocked downstream.
   *
   * Separate from `status` because they can genuinely disagree: a case may be CLEARED while
   * the release fails because the transaction expired during review. One field for both would
   * report success for an action that never happened.
   */
  actionApplied: boolean;
  actionResult: string | null;
  /** Computed server-side against the clock, so it cannot be stale. */
  slaBreached: boolean;
  assessment: {
    score: number;
    decision: RiskDecision;
    modelVersion: string;
    signals: Pick<RiskSignal, 'type' | 'weight' | 'value' | 'isHard'>[];
  } | null;
  user: {
    id: string;
    pravaahId: string | null;
    kycStatus: string;
    isSuspended: boolean;
  };
  _count: { notes: number };
}

export interface FraudCaseDetail
  extends Omit<FraudCaseRow, 'assessment' | 'user' | '_count'> {
  assessment: AdminRiskAssessment | null;
  notes: FraudCaseNote[];
  user: {
    id: string;
    pravaahId: string | null;
    phone: string | null;
    kycStatus: string;
    isSuspended: boolean;
    createdAt: string;
  };
  assignedAnalyst: { id: string; email: string; role: string } | null;
}

// ── stats ───────────────────────────────────────────────────────────────────
export interface FraudStats {
  cases: {
    open: number;
    /**
     * People whose money has been held past the promised window.
     *
     * The one number on this page worth paging on. Everything else is context for it.
     */
    slaBreached: number;
    byStatus: Partial<Record<FraudCaseStatus, number>>;
    byOpenSeverity: Partial<Record<FraudSeverity, number>>;
  };
  /** The last 24 hours' decision mix — the model's behaviour at a glance. */
  decisions24h: Partial<Record<RiskDecision, number>>;
  providers: {
    telco: {
      mode: string;
      provider: string;
      /** `false` for the dev stub. Surfaced so nobody infers corroboration we do not have. */
      live: boolean;
      configured: boolean;
    };
  };
}

// ── the user's risk picture ─────────────────────────────────────────────────
export interface AdminDeviceRow {
  id: string;
  deviceId: string;
  platform: string;
  status: DeviceStatus;
  integrity: string;
  coolingOffUntil: string | null;
  boundAt: string | null;
  lastSeenAt: string;
  createdAt: string;
  swapDetectedAt: string | null;
}

export interface DeviceEventRow {
  type: string;
  geoHint: string | null;
  integrity: string | null;
  createdAt: string;
}

/**
 * The graph neighbourhood around one account.
 *
 * `sharedKeyHash` is deliberately absent: it is unreadable to a human anyway, and shipping it
 * to a browser would put the one value that could be brute-forced offline into a client.
 */
export interface GraphNeighbourhood {
  clusterId: string | null;
  clusterSize: number;
  muleScore: number;
  members: { userId: string; muleScore: number; degree: number }[];
  edgeTypes: { linkType: EntityLinkType; count: number }[];
}

export interface UserRiskProfile {
  user: {
    id: string;
    pravaahId: string | null;
    phone: string | null;
    email: string | null;
    kycStatus: string;
    isSuspended: boolean;
    primaryCountry: string;
    createdAt: string;
  } | null;
  devices: AdminDeviceRow[];
  /** The USER-facing projection: reasons, no scores. See the note on the two projections. */
  assessments: {
    id: string;
    subjectType: RiskSubjectType;
    decision: RiskDecision;
    computedAt: string;
    reasons: string[];
  }[];
  cases: Pick<
    FraudCaseRow,
    'id' | 'status' | 'severity' | 'reason' | 'openedAt' | 'resolvedAt'
  >[];
  graph: GraphNeighbourhood;
  recentEvents: DeviceEventRow[];
}

// ── lists ───────────────────────────────────────────────────────────────────
export interface ListSummaryRow {
  kind: ListKind;
  entityType: ListEntityType;
  count: number;
}

// ── requests ────────────────────────────────────────────────────────────────
export interface ResolveCaseRequest {
  outcome: FraudCaseOutcome;
  /** Mandatory on every branch, including CLEARED. See the service's note on why. */
  note: string;
}

export interface AddListEntryRequest {
  kind: ListKind;
  entityType: ListEntityType;
  /**
   * The identifier in PLAINTEXT. Hashed server-side.
   *
   * Not a `valueHash`: if the client supplied the hash, the client would choose the salt, so
   * two consoles would produce two different hashes for one VPA and neither would ever match
   * a lookup. The salt is a server secret.
   */
  value: string;
  reason: string;
  expiresAt?: string;
}

export interface RemoveListEntryRequest {
  kind: ListKind;
  entityType: ListEntityType;
  value: string;
  reason: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface ResolveCaseResult {
  caseId: string;
  status: FraudCaseStatus;
  actionApplied: boolean;
  actionResult: string;
}

export interface GraphRecomputeResult {
  edges: number;
  nodes: number;
  clusters: number;
}
