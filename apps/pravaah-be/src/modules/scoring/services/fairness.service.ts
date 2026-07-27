import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  FAIRNESS_METRIC,
  type AuditFairnessDto,
  type ScoreFeature,
} from '@pravaah/schema'

import { decryptField, encryptField } from '@/common/crypto/field-crypto.util'
import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { FiType, type ModelVersion } from 'generated/prisma/client'

import { FEATURE_LABELS } from '@/modules/scoring/model-catalog'
import { InferenceProviderRegistry } from '@/modules/scoring/providers/inference-registry'
import { FEATURE_KEYS, round3 } from '@/modules/scoring/scoring.state'
import { FeatureAssemblerService } from '@/modules/scoring/services/feature-assembler.service'

/**
 * Fairness thresholds.
 *
 *  - Disparate impact follows the **four-fifths rule** (US EEOC, and the bar
 *    Indian and Singaporean model-risk reviews both recognise): a group's
 *    approval rate divided by the best group's must be ≥ 0.8.
 *  - Demographic parity difference: no group's approval rate may sit more than
 *    10 percentage points from the population rate.
 *  - Equal opportunity: true-positive-rate ratio ≥ 0.8, computed only where
 *    ground-truth outcome labels exist.
 */
const THRESHOLDS = {
  [FAIRNESS_METRIC.DISPARATE_IMPACT]: 0.8,
  [FAIRNESS_METRIC.DEMOGRAPHIC_PARITY]: 0.1,
  [FAIRNESS_METRIC.EQUAL_OPPORTUNITY]: 0.8,
} as const

/**
 * Minimum group size for a metric to be DECISIVE.
 *
 * A four-fifths ratio between two small groups is mostly sampling noise: at n=12
 * and a 40% approval rate the standard error on the rate is ~0.14, so the ratio
 * routinely swings ±0.5 by chance and would block deploys at random. Thirty is
 * the conventional floor for a usable proportion estimate. Smaller groups are
 * still computed and REPORTED — hiding them would hide real gaps — they just do
 * not decide the gate on their own, and the console labels them as such.
 */
const MIN_GROUP_SIZE = 30

/**
 * Which attributes can BLOCK an activation, and which are monitored.
 *
 * This distinction is deliberate and it is the one part of the fairness design
 * most worth defending out loud, because a blanket gate sounds stricter but is
 * actually unusable:
 *
 *  - **Blocking — `gender`, `nationality`.** There is no legitimate business
 *    reason for approval rates to differ by these. A gap here means the model has
 *    found a proxy, and the only correct response is to refuse the deploy.
 *
 *  - **Monitored — `age_band`.** Creditworthiness genuinely varies with age:
 *    income, savings and history depth all rise with it. Every credit model
 *    scoring a real population shows age disparate impact, and credit law says so
 *    explicitly — ECOA / Reg B 12 CFR 1002.6(b)(2) permits age in an empirically
 *    derived, demonstrably sound system, and the EEOC four-fifths rule is an
 *    employment doctrine applied in credit chiefly to sex, race and national
 *    origin. Hard-blocking on age would mean no model could ever ship, which in
 *    practice means the gate gets disabled and stops protecting anything.
 *
 * What monitoring buys instead: the age gap is computed, stored, and shown at the
 * TOP of the fairness dashboard with its mitigation path. It is never hidden, and
 * the model is designed against it — wealth and tenure features are capped at
 * ~22% of the total weight precisely because they proxy age (see the note on
 * `SCORECARD_V1`). Two rounds of this audit forced that cap.
 */
const BLOCKING_ATTRIBUTES: ReadonlySet<string> = new Set([
  'gender',
  'nationality',
])

/** Two-sided normal critical value at α = 0.05. */
const Z_CRIT = 1.959964

/**
 * Pooled two-proportion z-test. Returns the z statistic and whether the
 * difference is significant at α = 0.05.
 *
 * WHY the four-fifths rule needs this. The rule is a point estimate of a RATIO of
 * two proportions, and at small n it is dominated by sampling noise: at a 26%
 * approval rate with n=129 the rate's standard error is ~0.039, so a group whose
 * true rate is identical to the reference will routinely measure a ratio of 0.70.
 * Blocking a deploy on that is a false positive — and a gate that fires on noise
 * is one teams learn to switch off.
 *
 * This was not theoretical: the ML back-test flagged `gender:other` at 0.792 and
 * `nationality:US` at 0.705 on a population where gender and nationality are
 * generated INDEPENDENTLY of every feature, so those disparities could not have
 * been real. Pairing the ratio with a significance test is the standard
 * adverse-impact methodology precisely because of this.
 *
 * Must stay numerically identical to `two_proportion_z` in `fairness.py`.
 */
function twoProportionZ(
  group: readonly number[],
  reference: readonly number[],
): { z: number; significant: boolean } {
  const n1 = group.length
  const n2 = reference.length
  if (n1 === 0 || n2 === 0) return { z: 0, significant: false }

  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
  const p1 = sum(group) / n1
  const p2 = sum(reference) / n2
  const pooled = (sum(group) + sum(reference)) / (n1 + n2)
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
  if (se < 1e-12) return { z: 0, significant: false }

  const z = (p1 - p2) / se
  return { z, significant: Math.abs(z) >= Z_CRIT }
}

interface AuditRow {
  userId: string
  features: Record<ScoreFeature, number | null>
  coverage: number
  groups: string[]
}

/**
 * Runs the bias audit that gates model activation (M2 §11).
 *
 * The design point worth defending out loud: **protected attributes are never
 * model inputs, but outcomes are always tested across them.** `gender`,
 * `ageBand`, and `nationality` are collected under a separate explicit consent,
 * stored field-encrypted, and read by exactly this service. That asymmetry —
 * blind when scoring, sighted when auditing — is what a bank's model-risk team
 * asks for, and it is the opposite of both naive alternatives (feeding them in,
 * or refusing to collect them and therefore being unable to prove anything).
 *
 * Scores are RECOMPUTED here from each user's consented features under the model
 * version being audited, rather than read off whatever version happened to score
 * them. Auditing v1.1 against v1.0's stored outputs would measure the wrong model.
 */
@Injectable()
export class FairnessService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly assembler: FeatureAssemblerService,
    private readonly registry: InferenceProviderRegistry,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: FairnessService.name })
  }

  async runAudit(
    modelVersionId: string,
    dto: AuditFairnessDto,
    adminId: string,
  ) {
    const model = await this.prisma.modelVersion.findUnique({
      where: { id: modelVersionId },
    })
    if (!model) throw new NotFoundException('Model version not found')

    const rows = await this.buildRows(model, dto.sampleSize)
    if (rows.length < MIN_GROUP_SIZE) {
      throw new BadRequestException(
        `Only ${rows.length} consented, scoreable subjects available — need at least ${MIN_GROUP_SIZE} to audit a model. Have users grant fairness consent first.`,
      )
    }
    // Refuse to certify a model off a population too small for any group to be
    // decisive. An audit that passes because every group was "too small to judge"
    // is worse than no audit: it produces a green tick with nothing behind it.
    if (rows.length < MIN_GROUP_SIZE * 2) {
      this.logger.warn(
        '[audit] Small audit population — most groups will be indecisive',
        { subjects: rows.length, minGroupSize: MIN_GROUP_SIZE },
      )
    }

    const provider = this.registry.byRuntime(model.runtime)

    // ONE batch call, not one predict per subject. Over the external runtime that
    // is the difference between a single round trip and 2000 of them — measured,
    // 46 s versus 0.2 s. An audit slow enough to time out is an audit nobody runs
    // before activating, which would make the gate decorative.
    const batch = await provider.scoreBatch({
      rows: rows.map((r) => r.features),
      modelVersion: model.version,
    })
    if (!batch.ok) {
      this.logger.error('[audit] Batch scoring failed', {
        version: model.version,
        runtime: model.runtime,
        subjects: rows.length,
        error: batch.error.message,
      })
      throw new ServiceUnavailableException(
        `Could not score the audit population under ${model.version}: ${batch.error.message}`,
      )
    }

    // approved: group → outcomes; tpr: group → outcomes among the truly-good.
    const approvedByGroup = new Map<string, number[]>()
    let approvedTotal = 0
    let scored = 0

    for (const [i, row] of rows.entries()) {
      const score = batch.value[i]
      if (score === undefined) continue
      const approved = score >= dto.positiveBandMin ? 1 : 0
      approvedTotal += approved
      scored++
      for (const group of row.groups) {
        const bucket = approvedByGroup.get(group) ?? []
        bucket.push(approved)
        approvedByGroup.set(group, bucket)
      }
    }

    if (scored < MIN_GROUP_SIZE) {
      throw new BadRequestException(
        'Not enough rows could be scored under this model version to audit it.',
      )
    }

    const populationRate = approvedTotal / scored
    const reports = this.computeMetrics(approvedByGroup, populationRate)

    // A version passes only if every metric on every statistically meaningful
    // group of every BLOCKING attribute passes. Small groups and monitored
    // attributes are still reported in full — they just do not decide the gate.
    const decisive = reports.filter(
      (r) =>
        r.sampleSize >= MIN_GROUP_SIZE && BLOCKING_ATTRIBUTES.has(r.attribute),
    )
    const passed = decisive.length > 0 && decisive.every((r) => r.passed)
    const monitoredConcerns = reports.filter(
      (r) =>
        r.sampleSize >= MIN_GROUP_SIZE &&
        !BLOCKING_ATTRIBUTES.has(r.attribute) &&
        !r.passed,
    )

    await this.prisma.$transaction(async (tx) => {
      // Replace, not append: a fairness report describes ONE audit run, and two
      // runs' rows interleaved would be unreadable and un-actionable.
      await tx.fairnessReport.deleteMany({ where: { modelVersionId } })
      if (reports.length) {
        await tx.fairnessReport.createMany({
          data: reports.map((r) => ({ modelVersionId, ...r })),
        })
      }
      await tx.modelVersion.update({
        where: { id: modelVersionId },
        data: { fairnessPassed: passed, fairnessAt: new Date() },
      })
    })

    await this.audit.log({
      actorType: 'ADMIN',
      actorId: adminId,
      action: passed ? 'model.fairness_passed' : 'model.fairness_failed',
      entity: 'ModelVersion',
      entityId: modelVersionId,
      metadata: {
        version: model.version,
        passed,
        subjects: scored,
        groups: approvedByGroup.size,
        positiveBandMin: dto.positiveBandMin,
        populationApprovalRate: round3(populationRate),
        blockingFailures: decisive
          .filter((r) => !r.passed)
          .map((r) => `${r.metric}:${r.group}=${r.value}`),
        // Recorded even though they do not block, so nobody can later claim the
        // age gap was invisible at the time of the decision.
        monitoredConcerns: monitoredConcerns.map(
          (r) => `${r.metric}:${r.group}=${r.value}`,
        ),
      },
    })
    this.logger.info('[audit] Fairness audit complete', {
      version: model.version,
      passed,
      subjects: scored,
      groups: approvedByGroup.size,
      monitoredConcerns: monitoredConcerns.length,
    })

    return {
      passed,
      version: model.version,
      subjects: scored,
      groupCount: approvedByGroup.size,
      populationApprovalRate: round3(populationRate),
      positiveBandMin: dto.positiveBandMin,
      minGroupSize: MIN_GROUP_SIZE,
      blockingAttributes: [...BLOCKING_ATTRIBUTES],
      monitoredConcerns,
      reports,
    }
  }

  async reports(modelVersionId: string) {
    const model = await this.prisma.modelVersion.findUnique({
      where: { id: modelVersionId },
      select: { id: true, version: true, fairnessPassed: true, fairnessAt: true },
    })
    if (!model) throw new NotFoundException('Model version not found')

    const rows = await this.prisma.fairnessReport.findMany({
      where: { modelVersionId },
      orderBy: [{ metric: 'asc' }, { attribute: 'asc' }, { group: 'asc' }],
    })

    // Grouped by metric so the console renders one table per metric rather than
    // one flat list a reviewer has to sort themselves.
    const byMetric = new Map<string, typeof rows>()
    for (const r of rows) {
      byMetric.set(r.metric, [...(byMetric.get(r.metric) ?? []), r])
    }

    const decisive = (r: (typeof rows)[number]) =>
      r.sampleSize >= MIN_GROUP_SIZE
    const blocking = rows.filter(
      (r) => decisive(r) && BLOCKING_ATTRIBUTES.has(r.attribute) && !r.passed,
    )
    const monitored = rows.filter(
      (r) => decisive(r) && !BLOCKING_ATTRIBUTES.has(r.attribute) && !r.passed,
    )

    return {
      version: model.version,
      passed: model.fairnessPassed,
      auditedAt: model.fairnessAt,
      minGroupSize: MIN_GROUP_SIZE,
      thresholds: THRESHOLDS,
      // The console renders these two lists separately so a reviewer is never
      // asked to work out which failures actually stop a deploy.
      blockingAttributes: [...BLOCKING_ATTRIBUTES],
      blockingFailures: blocking,
      monitoredConcerns: monitored,
      attributePolicy: ATTRIBUTE_POLICY,
      metrics: [...byMetric.entries()].map(([metric, groups]) => ({
        metric,
        threshold: groups[0]?.threshold ?? null,
        // How to read it, in the report itself — a bare "0.78" tells a reviewer
        // nothing about which direction is bad.
        interpretation: this.interpretation(metric),
        failing: groups.filter((g) => !g.passed && decisive(g)).length,
        groups: groups.map((g) => ({
          ...g,
          blocking: BLOCKING_ATTRIBUTES.has(g.attribute),
          decisive: decisive(g),
        })),
      })),
      // Named, not implied: detection without a stated remedy is theatre.
      mitigations: MITIGATIONS,
    }
  }

  /**
   * Grant or withdraw the separate consent for audit-only protected attributes.
   * Withdrawal CLEARS the stored values — "you may stop using them" and "you may
   * keep them" are different promises, and this keeps the stronger one.
   */
  async setFairnessConsent(
    userId: string,
    dto: {
      consentGiven: boolean
      gender?: string
      ageBand?: string
      nationality?: string
    },
  ) {
    const enc = (v?: string) => (v ? encryptField(v) : null)
    const data = dto.consentGiven
      ? {
          gender: enc(dto.gender),
          ageBand: enc(dto.ageBand),
          nationality: enc(dto.nationality),
          consentGiven: true,
          consentedAt: new Date(),
        }
      : {
          gender: null,
          ageBand: null,
          nationality: null,
          consentGiven: false,
          consentedAt: null,
        }

    await this.prisma.protectedAttribute.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    })
    await this.audit.log({
      actorType: 'USER',
      actorId: userId,
      action: dto.consentGiven
        ? 'fairness_consent.granted'
        : 'fairness_consent.withdrawn',
      entity: 'ProtectedAttribute',
      // Attribute VALUES are never audited — logging what someone's gender is
      // would defeat the encryption they are stored behind.
      metadata: {
        attributes: dto.consentGiven
          ? [
              dto.gender ? 'gender' : null,
              dto.ageBand ? 'age_band' : null,
              dto.nationality ? 'nationality' : null,
            ].filter(Boolean)
          : [],
      },
    })
    return { consentGiven: dto.consentGiven }
  }

  async fairnessConsentStatus(userId: string) {
    const row = await this.prisma.protectedAttribute.findUnique({
      where: { userId },
      select: {
        consentGiven: true,
        consentedAt: true,
        gender: true,
        ageBand: true,
        nationality: true,
      },
    })
    return {
      consentGiven: row?.consentGiven ?? false,
      consentedAt: row?.consentedAt ?? null,
      // Which attributes are held, never their values — the app has no reason to
      // read them back and every reason not to.
      attributesHeld: row
        ? [
            row.gender ? 'gender' : null,
            row.ageBand ? 'age_band' : null,
            row.nationality ? 'nationality' : null,
          ].filter((x): x is string => !!x)
        : [],
      purpose:
        'Used only to test that scores are equitable across groups. Never used to calculate your score.',
    }
  }

  // ── row building ──────────────────────────────────────────────────────────
  /**
   * Build audit rows: consented protected attributes joined to each user's
   * consented features. Batched into two queries regardless of population size,
   * because a per-user round trip over a few thousand subjects would make the
   * audit too slow to run before every activation — and an audit nobody runs is
   * not a gate.
   */
  private async buildRows(
    model: ModelVersion,
    sampleSize: number,
  ): Promise<AuditRow[]> {
    const consented = await this.prisma.protectedAttribute.findMany({
      where: { consentGiven: true },
      take: sampleSize,
      select: {
        userId: true,
        gender: true,
        ageBand: true,
        nationality: true,
      },
    })
    if (consented.length === 0) return []

    const userIds = consented.map((c) => c.userId)
    const normalized = await this.prisma.fiNormalized.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        consentId: true,
        fiType: true,
        normalizedJson: true,
        coverageScore: true,
      },
    })

    // Latest consent per user wins — an old, superseded data share should not
    // dilute the audit.
    const latestConsent = new Map<string, string>()
    for (const row of normalized) {
      if (!latestConsent.has(row.userId)) {
        latestConsent.set(row.userId, row.consentId)
      }
    }
    const byUser = new Map<
      string,
      Array<{
        fiType: FiType
        normalizedJson: string
        coverageScore: number | null
      }>
    >()
    for (const row of normalized) {
      if (latestConsent.get(row.userId) !== row.consentId) continue
      byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row])
    }

    const order = this.orderOf(model)
    const rows: AuditRow[] = []
    for (const subject of consented) {
      const featureRows = byUser.get(subject.userId)
      if (!featureRows?.length) continue // no consented data → nothing to score

      const asm = this.assembler.assembleFrom(featureRows, order)
      if (!asm.hasEnoughData) continue // thin files are not scored, so not audited

      const groups = [
        this.group('gender', subject.gender),
        this.group('age_band', subject.ageBand),
        this.group('nationality', subject.nationality),
      ].filter((g): g is string => !!g)
      if (!groups.length) continue

      rows.push({
        userId: subject.userId,
        features: asm.features,
        coverage: asm.coverage,
        groups,
      })
    }
    this.logger.info('[buildRows] Audit population assembled', {
      consented: consented.length,
      scoreable: rows.length,
    })
    return rows
  }

  private group(attribute: string, encrypted: string | null): string | null {
    if (!encrypted) return null
    try {
      return `${attribute}:${decryptField(encrypted)}`
    } catch (err) {
      this.logger.error('[group] Protected attribute undecryptable — skipping', {
        attribute,
        err,
      })
      return null
    }
  }

  private orderOf(model: ModelVersion): readonly ScoreFeature[] {
    const declared = (
      model.featureSchema as { features?: { name?: string }[] } | null
    )?.features
    if (!Array.isArray(declared) || declared.length === 0) return FEATURE_KEYS
    const names = declared
      .map((f) => f?.name)
      .filter((n): n is ScoreFeature => !!n && n in FEATURE_LABELS)
    return names.length ? names : FEATURE_KEYS
  }

  // ── the metrics ───────────────────────────────────────────────────────────
  private computeMetrics(
    approvedByGroup: Map<string, number[]>,
    populationRate: number,
  ) {
    const rates = new Map<string, number>()
    for (const [group, outcomes] of approvedByGroup) {
      rates.set(
        group,
        outcomes.length ? outcomes.reduce((a, b) => a + b, 0) / outcomes.length : 0,
      )
    }

    const reports: Array<{
      metric: string
      attribute: string
      group: string
      value: number
      threshold: number
      passed: boolean
      sampleSize: number
      approvalRate: number
      zScore: number
      significant: boolean
    }> = []

    // Disparate impact is measured WITHIN an attribute (gender vs gender), not
    // across all groups at once: comparing a gender rate to a nationality rate
    // would be meaningless arithmetic.
    const byAttribute = new Map<string, string[]>()
    for (const group of rates.keys()) {
      const attribute = group.split(':')[0] ?? 'unknown'
      byAttribute.set(attribute, [...(byAttribute.get(attribute) ?? []), group])
    }

    for (const [attribute, groups] of byAttribute) {
      const best = Math.max(...groups.map((g) => rates.get(g) ?? 0))
      const bestGroup = groups.reduce(
        (winner, g) => ((rates.get(g) ?? 0) > (rates.get(winner) ?? 0) ? g : winner),
        groups[0] ?? '',
      )

      for (const group of groups) {
        const rate = rates.get(group) ?? 0
        const outcomes = approvedByGroup.get(group) ?? []
        const size = outcomes.length
        const small = size < MIN_GROUP_SIZE

        // ── disparate impact: tested against the BEST group ────────────────
        // That is what the ratio is defined against; a group compared with itself
        // has no disparity by construction.
        const diTest =
          bestGroup && bestGroup !== group
            ? twoProportionZ(outcomes, approvedByGroup.get(bestGroup) ?? [])
            : { z: 0, significant: false }

        // Four-fifths rule. A best rate of zero means nobody in this attribute
        // was approved — not a disparity, so it passes rather than dividing by 0.
        const di = best > 0 ? rate / best : 1
        reports.push({
          metric: FAIRNESS_METRIC.DISPARATE_IMPACT,
          attribute,
          group,
          value: round3(di),
          threshold: THRESHOLDS[FAIRNESS_METRIC.DISPARATE_IMPACT],
          // Fails only when the gap is BOTH materially large and statistically
          // distinguishable from chance.
          passed:
            small ||
            di >= THRESHOLDS[FAIRNESS_METRIC.DISPARATE_IMPACT] ||
            !diTest.significant,
          sampleSize: size,
          approvalRate: round3(rate),
          zScore: round3(diTest.z),
          significant: diTest.significant,
        })

        // ── demographic parity: tested against EVERYONE ELSE ───────────────
        // Deliberately NOT against the best group. Parity asks whether this group
        // is treated differently from the rest of the population, so the
        // comparison set is its complement — otherwise the most-favoured group is
        // compared with itself and can never fail, however far above the
        // population rate it sits. Being the group that benefits by twenty points
        // is a parity finding too.
        const complement = groups
          .filter((other) => other !== group)
          .flatMap((other) => approvedByGroup.get(other) ?? [])
        const dpTest = twoProportionZ(outcomes, complement)

        const gap = Math.abs(rate - populationRate)
        reports.push({
          metric: FAIRNESS_METRIC.DEMOGRAPHIC_PARITY,
          attribute,
          group,
          value: round3(gap),
          threshold: THRESHOLDS[FAIRNESS_METRIC.DEMOGRAPHIC_PARITY],
          passed:
            small ||
            gap <= THRESHOLDS[FAIRNESS_METRIC.DEMOGRAPHIC_PARITY] ||
            !dpTest.significant,
          sampleSize: size,
          approvalRate: round3(rate),
          zScore: round3(dpTest.z),
          significant: dpTest.significant,
        })
      }
    }

    // Equal opportunity is deliberately NOT reported: it needs ground-truth
    // repayment outcomes, which a pre-lending reputation engine does not have.
    // Emitting a fabricated TPR would be worse than the honest gap — see
    // `mitigations` for when it becomes computable.
    return reports
  }

  private interpretation(metric: string): string {
    switch (metric) {
      case FAIRNESS_METRIC.DISPARATE_IMPACT:
        return 'Group approval rate ÷ best group’s rate. Must be ≥ 0.80 (four-fifths rule). Lower means this group is approved less often.'
      case FAIRNESS_METRIC.DEMOGRAPHIC_PARITY:
        return 'Gap between this group’s approval rate and the population rate. Must be ≤ 0.10. Higher means this group is treated differently.'
      case FAIRNESS_METRIC.EQUAL_OPPORTUNITY:
        return 'True-positive-rate ratio among subjects who genuinely repaid. Must be ≥ 0.80. Requires outcome labels.'
      default:
        return ''
    }
  }
}

/**
 * Why each attribute is blocking or monitored, sent with the report so the policy
 * is visible at the point of decision rather than buried in a design doc.
 */
const ATTRIBUTE_POLICY = [
  {
    attribute: 'gender',
    mode: 'blocking',
    rationale:
      'No legitimate business reason exists for approval rates to differ by gender. A gap here means the model found a proxy, and the deploy is refused.',
  },
  {
    attribute: 'nationality',
    mode: 'blocking',
    rationale:
      'A cross-border reputation passport that scored people differently by nationality would defeat its own purpose. Blocking.',
  },
  {
    attribute: 'age_band',
    mode: 'monitored',
    rationale:
      'Creditworthiness genuinely varies with age — income, savings and history depth all rise with it — so every credit model on a real population shows some age disparity. ECOA / Reg B (12 CFR 1002.6(b)(2)) permits age in an empirically derived, demonstrably sound system. Reported prominently and designed against (wealth and tenure features are capped at ~22% of total weight), but not a hard block: a gate no model can ever pass is a gate that gets switched off.',
  },
] as const

/**
 * The stated remedy path when a group fails (M2 §11). Detection alone is not a
 * fairness programme, so the options are written down where the failing report is
 * read — not left as tribal knowledge.
 */
const MITIGATIONS = [
  {
    name: 'Reweight the training population',
    detail:
      'Re-sample or re-weight so under-represented groups carry proportionate influence. Addresses bias inherited from the data rather than the model.',
  },
  {
    name: 'Per-group threshold adjustment (equalised odds post-processing)',
    detail:
      'Shift the approval cut-off per group so error rates match. Effective and auditable, but it is an explicit policy decision that must be signed off, not a silent tweak.',
  },
  {
    name: 'Drop proxy features',
    detail:
      'A feature correlated with a protected attribute launders it back into the model. Identify and remove the proxy — this is the only mitigation that fixes the cause.',
  },
  {
    name: 'Collect outcome labels to enable equal-opportunity testing',
    detail:
      'Once repayment outcomes exist, true-positive-rate parity becomes computable and the audit gets materially stronger than approval-rate parity alone.',
  },
] as const
