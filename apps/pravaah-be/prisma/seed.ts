/**
 * Database seed — admins, demo users, and full KYC fixtures.
 *
 * Run:  npm run prisma:seed   (from apps/pravaah-be)
 *
 * Idempotent: every row is upserted on a stable key (unique field or fixed
 * UUID), so re-running is safe and never creates duplicates.
 *
 * KYC fixtures:
 *   • India   — VERIFIED profile: PAN, Aadhaar OKYC (DigiLocker), bank
 *               penny-drop, face-match, liveness, sanctions/PEP.
 *   • Singapore — VERIFIED via Singpass Myinfo (persona S9812379B from the
 *               Myinfo test profiles) + Singpass face verify + sanctions.
 *   • India   — IN_REVIEW profile with an OPEN review case, so the admin
 *               console review queue has a live item to action.
 *
 * All `maskedResult` / document payloads are the MASKED projection an admin is
 * allowed to see — never raw PAN/Aadhaar/NRIC numbers.
 */
import { createHash } from 'node:crypto'
import { resolve } from 'path'

import { PrismaPg } from '@prisma/adapter-pg'
import { config } from 'dotenv'

import {
  AdminRole,
  CheckStatus,
  CheckType,
  ConsentMode,
  ConsentStatus,
  Country,
  DataSessionStatus,
  DeviceStatus,
  DocStatus,
  DocType,
  FetchType,
  FiType,
  KycStatus,
  Prisma,
  PrismaClient,
  ReviewDecision,
  ReviewStatus,
} from '../generated/prisma/client'

import { encryptField } from '../src/common/crypto/field-crypto.util'

// M2 model catalogue + the pure scorecard math. Imported rather than duplicated:
// the seeded fairness verdicts must be what a live audit recomputes, and two
// copies of the scoring maths would drift apart the first time one is tuned.
import {
  DEFAULT_BANDS_JSON,
  DEFAULT_FEATURE_SCHEMA,
  MODEL_CATALOG,
} from '../src/modules/scoring/model-catalog'
import {
  applyTransform,
  FEATURE_KEYS,
  probabilityToScore,
  sigmoid,
} from '../src/modules/scoring/scoring.state'

import { buildPravaahId, PRAVAAH_ID_ENTROPY_SYMBOLS } from '@pravaah/schema'

import type { ScorecardParamsDto, ScoreFeature } from '@pravaah/schema'

/**
 * A seeded user's Pravaah ID, derived from their fixed UUID instead of drawn at
 * random. Same reason everything else here is upserted on a stable key: a fresh
 * database must reproduce the same fixtures, so docs, screenshots and demo
 * scripts that quote an ID keep matching. Live users get random IDs from
 * PravaahIdService — this determinism is a seed-only property.
 */
function seedPravaahId(userId: string): string {
  const digest = createHash('sha256').update(userId).digest()
  return buildPravaahId(digest.subarray(0, PRAVAAH_ID_ENTROPY_SYMBOLS))
}

// The seed runs outside NestJS, so load the env files ourselves (same order
// as prisma.config.ts) to pick up DATABASE_URL from .env.development.local.
const nodeEnv = process.env.NODE_ENV || 'development'
for (const file of [
  '.env',
  '.env.local',
  `.env.${nodeEnv}`,
  `.env.${nodeEnv}.local`,
]) {
  config({ path: resolve(process.cwd(), file), override: true })
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set — cannot seed. Check apps/pravaah-be/.env.development.local',
  )
}

const adapter = new PrismaPg({ connectionString })
const prisma = new PrismaClient({ adapter })

interface CheckSpec {
  checkType: CheckType
  provider: string
  status: CheckStatus
  extractedName?: string
  confidence?: number
  maskedResult?: Prisma.InputJsonValue
}

interface DocSpec {
  id: string
  docType: DocType
  storagePath: string
  maskedNumber?: string
  status: DocStatus
  ocrJson?: Prisma.InputJsonValue
}

interface KycUserSpec {
  label: string
  ids: {
    user: string
    device: string
    hardware: string
    profile: string
    consent: string
    review?: string
  }
  phone: string
  email: string
  country: Country
  kycStatus: KycStatus
  devicePlatform: string
  profile: {
    overallStatus: KycStatus
    nameMatchScore: number
    riskScore: number
    verifiedName: string | null
    completedAt: Date | null
  }
  checks: CheckSpec[]
  documents: DocSpec[]
  consent: {
    policyVersion: string
    purpose: string
    ipAddress: string
    userAgent: string
  }
  review?: {
    status: ReviewStatus
    reason: string
    assignedAdminId?: string | null
    decision?: ReviewDecision | null
    decisionNotes?: string | null
    slaDueAt?: Date | null
    resolvedAt?: Date | null
  }
}

async function seedKycUser(spec: KycUserSpec): Promise<void> {
  const user = await prisma.user.upsert({
    where: { phone: spec.phone },
    update: {
      email: spec.email,
      primaryCountry: spec.country,
      kycStatus: spec.kycStatus,
    },
    create: {
      id: spec.ids.user,
      pravaahId: seedPravaahId(spec.ids.user),
      phone: spec.phone,
      email: spec.email,
      primaryCountry: spec.country,
      kycStatus: spec.kycStatus,
    },
  })

  await prisma.device.upsert({
    where: { id: spec.ids.device },
    update: { status: DeviceStatus.ACTIVE },
    create: {
      id: spec.ids.device,
      userId: user.id,
      deviceId: spec.ids.hardware,
      platform: spec.devicePlatform,
      bindingTokenHash: `seed$token$${spec.ids.user.slice(0, 8)}`,
      simSerialHash: `seed$sim$${spec.ids.user.slice(0, 8)}`,
      status: DeviceStatus.ACTIVE,
    },
  })

  const profile = await prisma.kycProfile.upsert({
    where: { userId: user.id },
    update: {
      overallStatus: spec.profile.overallStatus,
      nameMatchScore: spec.profile.nameMatchScore,
      riskScore: spec.profile.riskScore,
      verifiedName: spec.profile.verifiedName,
      completedAt: spec.profile.completedAt,
    },
    create: {
      id: spec.ids.profile,
      userId: user.id,
      overallStatus: spec.profile.overallStatus,
      nameMatchScore: spec.profile.nameMatchScore,
      riskScore: spec.profile.riskScore,
      verifiedName: spec.profile.verifiedName,
      completedAt: spec.profile.completedAt,
    },
  })

  for (const c of spec.checks) {
    await prisma.kycCheck.upsert({
      where: {
        kycProfileId_checkType_attempt: {
          kycProfileId: profile.id,
          checkType: c.checkType,
          attempt: 1,
        },
      },
      update: {
        provider: c.provider,
        status: c.status,
        extractedName: c.extractedName ?? null,
        confidence: c.confidence ?? null,
        maskedResult: c.maskedResult ?? Prisma.JsonNull,
      },
      create: {
        kycProfileId: profile.id,
        provider: c.provider,
        checkType: c.checkType,
        status: c.status,
        extractedName: c.extractedName ?? null,
        confidence: c.confidence ?? null,
        maskedResult: c.maskedResult ?? Prisma.JsonNull,
        attempt: 1,
      },
    })
  }

  for (const d of spec.documents) {
    await prisma.identityDocument.upsert({
      where: { id: d.id },
      update: {
        docType: d.docType,
        storagePath: d.storagePath,
        maskedNumber: d.maskedNumber ?? null,
        status: d.status,
        ocrJson: d.ocrJson ?? Prisma.JsonNull,
      },
      create: {
        id: d.id,
        userId: user.id,
        docType: d.docType,
        storagePath: d.storagePath,
        maskedNumber: d.maskedNumber ?? null,
        status: d.status,
        ocrJson: d.ocrJson ?? Prisma.JsonNull,
      },
    })
  }

  await prisma.consentRecord.upsert({
    where: { id: spec.ids.consent },
    update: {
      policyVersion: spec.consent.policyVersion,
      purpose: spec.consent.purpose,
      ipAddress: spec.consent.ipAddress,
      userAgent: spec.consent.userAgent,
    },
    create: {
      id: spec.ids.consent,
      userId: user.id,
      policyVersion: spec.consent.policyVersion,
      purpose: spec.consent.purpose,
      ipAddress: spec.consent.ipAddress,
      userAgent: spec.consent.userAgent,
    },
  })

  if (spec.review) {
    await prisma.reviewCase.upsert({
      where: { kycProfileId: profile.id },
      update: {
        status: spec.review.status,
        reason: spec.review.reason,
        assignedAdminId: spec.review.assignedAdminId ?? null,
        decision: spec.review.decision ?? null,
        decisionNotes: spec.review.decisionNotes ?? null,
        slaDueAt: spec.review.slaDueAt ?? null,
        resolvedAt: spec.review.resolvedAt ?? null,
      },
      create: {
        id: spec.ids.review,
        kycProfileId: profile.id,
        status: spec.review.status,
        reason: spec.review.reason,
        assignedAdminId: spec.review.assignedAdminId ?? null,
        decision: spec.review.decision ?? null,
        decisionNotes: spec.review.decisionNotes ?? null,
        slaDueAt: spec.review.slaDueAt ?? null,
        resolvedAt: spec.review.resolvedAt ?? null,
      },
    })
  }

  const checkSummary = spec.checks
    .map((c) => `${c.checkType}:${c.status}`)
    .join(', ')
  console.log(
    `   ✔ ${spec.label} → ${spec.phone} (${spec.country}, ${spec.kycStatus})`,
  )
  console.log(`       checks: ${checkSummary}`)
}

async function main(): Promise<void> {
  console.log('🌱 Seeding pravaah database...')

  const admin = await prisma.adminUser.upsert({
    where: { email: 'admin@pravaah.in' },
    update: { phone: '+919000000001', role: AdminRole.ADMIN, isActive: true },
    create: {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'admin@pravaah.in',
      phone: '+919000000001',
      role: AdminRole.ADMIN,
      isActive: true,
    },
  })
  console.log(`   ✔ admin → ${admin.email} / ${admin.phone} (${admin.role})`)

  // DEV bypass admin — pairs with AUTH_DEV_BYPASS_PHONE so the console can be
  // exercised locally without real SMS. Same number the RN app uses to log in.
  const devAdmin = await prisma.adminUser.upsert({
    where: { email: 'dev-bypass@pravaah.in' },
    update: { phone: '+919998887776', role: AdminRole.ADMIN, isActive: true },
    create: {
      id: '99999999-9999-4999-8999-999999999999',
      email: 'dev-bypass@pravaah.in',
      phone: '+919998887776',
      role: AdminRole.ADMIN,
      isActive: true,
    },
  })
  console.log(
    `   ✔ dev-bypass admin → ${devAdmin.email} / ${devAdmin.phone} (${devAdmin.role})`,
  )

  const reviewer = await prisma.adminUser.upsert({
    where: { email: 'reviewer@pravaah.in' },
    update: {
      phone: '+919000000002',
      role: AdminRole.REVIEWER,
      isActive: true,
    },
    create: {
      id: '33333333-3333-4333-8333-333333333333',
      email: 'reviewer@pravaah.in',
      phone: '+919000000002',
      role: AdminRole.REVIEWER,
      isActive: true,
    },
  })
  console.log(
    `   ✔ reviewer → ${reviewer.email} / ${reviewer.phone} (${reviewer.role})`,
  )

  const user = await prisma.user.upsert({
    where: { phone: '+917389721118' },
    update: {},
    create: {
      id: '22222222-2222-4222-8222-222222222222',
      pravaahId: seedPravaahId('22222222-2222-4222-8222-222222222222'),
      phone: '+917389721118',
      email: 'user@pravaah.in',
      primaryCountry: Country.INDIA,
      kycStatus: KycStatus.NOT_STARTED,
    },
  })
  console.log(
    `   ✔ user → ${user.phone} (${user.primaryCountry}, ${user.kycStatus})`,
  )

  // ==========================================================================
  // INDIA — full VERIFIED KYC (ARJUN SHARMA)
  // ==========================================================================
  await seedKycUser({
    label: 'india-kyc (verified)',
    ids: {
      user: '10000000-0000-4000-8000-000000000001',
      device: '10000000-0000-4000-8000-0000000000d1',
      hardware: '10000000-0000-4000-8000-0000000000a1',
      profile: '10000000-0000-4000-8000-0000000000f1',
      consent: '10000000-0000-4000-8000-0000000000c1',
    },
    phone: '+919876543210',
    email: 'arjun.sharma@pravaah.in',
    country: Country.INDIA,
    kycStatus: KycStatus.VERIFIED,
    devicePlatform: 'android',
    profile: {
      overallStatus: KycStatus.VERIFIED,
      nameMatchScore: 0.98,
      riskScore: 0.08,
      verifiedName: 'ARJUN SHARMA',
      completedAt: new Date('2026-07-12T09:20:00+05:30'),
    },
    checks: [
      {
        checkType: CheckType.PAN,
        provider: 'decentro',
        status: CheckStatus.PASSED,
        extractedName: 'ARJUN SHARMA',
        maskedResult: {
          pan: 'ABCP****K',
          status: 'VALID',
          category: 'Individual',
          nameMatch: true,
        },
      },
      {
        checkType: CheckType.AADHAAR_OKYC,
        provider: 'decentro-digilocker',
        status: CheckStatus.PASSED,
        extractedName: 'ARJUN SHARMA',
        maskedResult: {
          maskedAadhaar: 'XXXX XXXX 1234',
          name: 'ARJUN SHARMA',
          dob: '1994-03-22',
          gender: 'MALE',
          address: '12, MG Road, Bengaluru, Karnataka',
          pincode: '560001',
          careOf: 'S/O RAJESH SHARMA',
        },
      },
      {
        checkType: CheckType.BANK_PENNY_DROP,
        provider: 'decentro',
        status: CheckStatus.PASSED,
        extractedName: 'ARJUN SHARMA',
        maskedResult: {
          accountLast4: '6789',
          ifsc: 'HDFC0000123',
          bankName: 'HDFC BANK',
          accountStatus: 'VALID',
          beneficiaryName: 'ARJUN SHARMA',
          nameMatchScore: 0.98,
        },
      },
      {
        checkType: CheckType.FACE_MATCH,
        provider: 'biometrics',
        status: CheckStatus.PASSED,
        confidence: 0.964,
        maskedResult: { matchScore: 0.964, threshold: 0.85 },
      },
      {
        checkType: CheckType.LIVENESS,
        provider: 'biometrics',
        status: CheckStatus.PASSED,
        confidence: 0.991,
        maskedResult: { livenessScore: 0.991, method: 'passive' },
      },
      {
        checkType: CheckType.SANCTIONS_PEP,
        provider: 'internal-screening',
        status: CheckStatus.PASSED,
        maskedResult: {
          screened: true,
          matches: 0,
          lists: ['UN', 'OFAC', 'MHA'],
        },
      },
    ],
    documents: [
      {
        id: '10000000-0000-4000-8000-0000000000e1',
        docType: DocType.PAN_CARD,
        storagePath: 'kyc/10000000/pan_card.jpg',
        maskedNumber: 'ABCP****K',
        status: DocStatus.VERIFIED,
        ocrJson: {
          name: 'ARJUN SHARMA',
          dob: '22/03/1994',
          fatherName: 'RAJESH SHARMA',
        },
      },
      {
        id: '10000000-0000-4000-8000-0000000000e2',
        docType: DocType.AADHAAR,
        storagePath: 'kyc/10000000/aadhaar.jpg',
        maskedNumber: 'XXXX XXXX 1234',
        status: DocStatus.VERIFIED,
        ocrJson: {
          name: 'ARJUN SHARMA',
          dob: '22/03/1994',
          gender: 'MALE',
          pincode: '560001',
        },
      },
      {
        id: '10000000-0000-4000-8000-0000000000e3',
        docType: DocType.SELFIE,
        storagePath: 'kyc/10000000/selfie.jpg',
        status: DocStatus.VERIFIED,
      },
    ],
    consent: {
      policyVersion: 'v1.2',
      purpose:
        'India KYC — PAN verification, Aadhaar OKYC (DigiLocker), bank account verification, liveness & face match',
      ipAddress: '103.21.58.10',
      userAgent: 'PravaahApp/1.0 (Android 14)',
    },
  })

  // ==========================================================================
  // SINGAPORE — VERIFIED via Singpass Myinfo (persona S9812379B)
  // ==========================================================================
  await seedKycUser({
    label: 'singapore-kyc (verified)',
    ids: {
      user: '20000000-0000-4000-8000-000000000001',
      device: '20000000-0000-4000-8000-0000000000d1',
      hardware: '20000000-0000-4000-8000-0000000000a1',
      profile: '20000000-0000-4000-8000-0000000000f1',
      consent: '20000000-0000-4000-8000-0000000000c1',
    },
    phone: '+6597399245',
    email: 'myinfotesting@gmail.com',
    country: Country.SINGAPORE,
    kycStatus: KycStatus.VERIFIED,
    devicePlatform: 'ios',
    profile: {
      overallStatus: KycStatus.VERIFIED,
      nameMatchScore: 1.0,
      riskScore: 0.05,
      verifiedName: 'LIM YONG XIANG JACKSON',
      completedAt: new Date('2026-07-13T14:05:00+08:00'),
    },
    checks: [
      {
        checkType: CheckType.SINGPASS_MYINFO,
        provider: 'singpass-myinfo',
        status: CheckStatus.PASSED,
        extractedName: 'LIM YONG XIANG JACKSON',
        maskedResult: {
          uinfin: 'S****379B',
          name: 'LIM YONG XIANG JACKSON',
          hanyupinyinName: 'LIN YONG XIANG',
          aliasName: 'JACKSON LIM',
          sex: 'MALE',
          race: 'CHINESE',
          dob: '1998-04-19',
          nationality: 'SINGAPORE CITIZEN',
          residentialStatus: 'CITIZEN',
          regadd:
            '123 TOA PAYOH VIEW, #13-XX, LORONG 1 TOA PAYOH, SINGAPORE 310123',
          mobileno: '+65 9739****',
          email: 'myin****@gmail.com',
        },
      },
      {
        checkType: CheckType.FACE_MATCH,
        provider: 'singpass-face-verify',
        status: CheckStatus.PASSED,
        confidence: 0.972,
        maskedResult: {
          matchScore: 0.972,
          provider: 'Singpass Face Verification',
        },
      },
      {
        checkType: CheckType.LIVENESS,
        provider: 'singpass-face-verify',
        status: CheckStatus.PASSED,
        confidence: 0.983,
        maskedResult: { livenessScore: 0.983, method: 'singpass-biometric' },
      },
      {
        checkType: CheckType.SANCTIONS_PEP,
        provider: 'internal-screening',
        status: CheckStatus.PASSED,
        maskedResult: {
          screened: true,
          matches: 0,
          lists: ['UN', 'OFAC', 'MAS'],
        },
      },
    ],
    documents: [
      {
        id: '20000000-0000-4000-8000-0000000000e1',
        docType: DocType.NRIC_FIN,
        storagePath: 'kyc/20000000/nric.json',
        maskedNumber: 'S****379B',
        status: DocStatus.VERIFIED,
        ocrJson: {
          source: 'Singpass Myinfo',
          name: 'LIM YONG XIANG JACKSON',
          dob: '1998-04-19',
          nationality: 'SINGAPORE CITIZEN',
        },
      },
      {
        id: '20000000-0000-4000-8000-0000000000e2',
        docType: DocType.SELFIE,
        storagePath: 'kyc/20000000/selfie.jpg',
        status: DocStatus.VERIFIED,
      },
    ],
    consent: {
      policyVersion: 'v1.2',
      purpose:
        'Singapore KYC — Singpass Myinfo retrieval (name, partial UINFIN, DOB, nationality, registered address) and Singpass Face Verification',
      ipAddress: '116.86.10.42',
      userAgent: 'PravaahApp/1.0 (iOS 18)',
    },
  })

  // ==========================================================================
  // INDIA — IN_REVIEW with an OPEN review case (MEERA IYER)
  // ==========================================================================
  await seedKycUser({
    label: 'india-kyc (in-review)',
    ids: {
      user: '30000000-0000-4000-8000-000000000001',
      device: '30000000-0000-4000-8000-0000000000d1',
      hardware: '30000000-0000-4000-8000-0000000000a1',
      profile: '30000000-0000-4000-8000-0000000000f1',
      consent: '30000000-0000-4000-8000-0000000000c1',
      review: '30000000-0000-4000-8000-0000000000b1',
    },
    phone: '+919812345678',
    email: 'meera.iyer@pravaah.in',
    country: Country.INDIA,
    kycStatus: KycStatus.IN_REVIEW,
    devicePlatform: 'android',
    profile: {
      overallStatus: KycStatus.IN_REVIEW,
      nameMatchScore: 0.71,
      riskScore: 0.58,
      verifiedName: null,
      completedAt: null,
    },
    checks: [
      {
        checkType: CheckType.PAN,
        provider: 'decentro',
        status: CheckStatus.PASSED,
        extractedName: 'MEERA IYER',
        maskedResult: {
          pan: 'FGHPI****L',
          status: 'VALID',
          category: 'Individual',
        },
      },
      {
        checkType: CheckType.AADHAAR_OKYC,
        provider: 'decentro-digilocker',
        status: CheckStatus.PASSED,
        extractedName: 'MEERA S IYER',
        maskedResult: {
          maskedAadhaar: 'XXXX XXXX 5678',
          name: 'MEERA S IYER',
          dob: '1996-11-08',
          gender: 'FEMALE',
          pincode: '600042',
        },
      },
      {
        checkType: CheckType.BANK_PENNY_DROP,
        provider: 'decentro',
        status: CheckStatus.MANUAL_REVIEW,
        extractedName: 'M IYER',
        maskedResult: {
          accountLast4: '4321',
          ifsc: 'ICIC0000456',
          bankName: 'ICICI BANK',
          accountStatus: 'VALID',
          beneficiaryName: 'M IYER',
          nameMatchScore: 0.71,
          note: 'Beneficiary name only partially matches profile name',
        },
      },
      {
        checkType: CheckType.FACE_MATCH,
        provider: 'biometrics',
        status: CheckStatus.PASSED,
        confidence: 0.902,
        maskedResult: { matchScore: 0.902, threshold: 0.85 },
      },
      {
        checkType: CheckType.SANCTIONS_PEP,
        provider: 'internal-screening',
        status: CheckStatus.MANUAL_REVIEW,
        maskedResult: {
          screened: true,
          matches: 1,
          lists: ['PEP'],
          note: 'Possible politically-exposed-person match — manual adjudication required',
        },
      },
    ],
    documents: [
      {
        id: '30000000-0000-4000-8000-0000000000e1',
        docType: DocType.PAN_CARD,
        storagePath: 'kyc/30000000/pan_card.jpg',
        maskedNumber: 'FGHPI****L',
        status: DocStatus.OCR_DONE,
        ocrJson: { name: 'MEERA IYER', dob: '08/11/1996' },
      },
      {
        id: '30000000-0000-4000-8000-0000000000e2',
        docType: DocType.AADHAAR,
        storagePath: 'kyc/30000000/aadhaar.jpg',
        maskedNumber: 'XXXX XXXX 5678',
        status: DocStatus.OCR_DONE,
        ocrJson: { name: 'MEERA S IYER', dob: '08/11/1996', gender: 'FEMALE' },
      },
      {
        id: '30000000-0000-4000-8000-0000000000e3',
        docType: DocType.SELFIE,
        storagePath: 'kyc/30000000/selfie.jpg',
        status: DocStatus.UPLOADED,
      },
    ],
    consent: {
      policyVersion: 'v1.2',
      purpose:
        'India KYC — PAN verification, Aadhaar OKYC (DigiLocker), bank account verification, liveness & face match',
      ipAddress: '49.207.112.5',
      userAgent: 'PravaahApp/1.0 (Android 13)',
    },
    review: {
      status: ReviewStatus.OPEN,
      reason:
        'Bank beneficiary name mismatch (0.71) and a possible PEP match — manual review required.',
      assignedAdminId: null,
      slaDueAt: new Date('2026-07-22T18:00:00+05:30'),
    },
  })

  // ==========================================================================
  // M1 — AA CONSENT (ACTIVE) + normalised FI features for ARJUN SHARMA
  // Gives the admin consent estate a live record and M2 a ready input. Skipped
  // when FIELD_ENCRYPTION_KEY is absent (the normalised blobs are encrypted).
  // ==========================================================================
  if (process.env.FIELD_ENCRYPTION_KEY) {
    await seedAaConsent()
  } else {
    console.log('   ⚠ Skipping M1 AA consent seed (FIELD_ENCRYPTION_KEY unset)')
  }

  // ==========================================================================
  // M2 — MODEL REGISTRY + FAIRNESS AUDIT COHORT
  // Registers the three shipped model versions, seeds a consented audit cohort,
  // and runs the REAL fairness computation over it so the bias dashboard has
  // earned numbers on first boot rather than asserted ones.
  // ==========================================================================
  if (process.env.FIELD_ENCRYPTION_KEY) {
    await seedScoringModels()
    await seedFairnessCohort()
  } else {
    console.log('   ⚠ Skipping M2 scoring seed (FIELD_ENCRYPTION_KEY unset)')
  }

  console.log('✅ Seed complete')
}

async function seedAaConsent(): Promise<void> {
  const arjunId = '10000000-0000-4000-8000-000000000001'
  const consentId = '10000000-0000-4000-8000-0000000000a1'
  const sessionId = '10000000-0000-4000-8000-0000000000b1'
  const now = new Date('2026-07-14T10:00:00+05:30')
  const dataLifeExpiresAt = new Date('2027-01-14T10:00:00+05:30')

  const consent = await prisma.consent.upsert({
    where: { id: consentId },
    update: { status: ConsentStatus.ACTIVE, artefactVerified: true },
    create: {
      id: consentId,
      userId: arjunId,
      aaProvider: 'sandbox',
      providerConsentId: 'seed-consent-arjun',
      vua: '919876543210@onemoney',
      purpose: 'Assess financial reputation for a cross-border credit passport',
      purposeCode: '101',
      consentMode: ConsentMode.STORE,
      fetchType: FetchType.ONETIME,
      fiTypes: [FiType.DEPOSIT, FiType.GSTR],
      dataRangeFrom: new Date('2025-07-01T00:00:00+05:30'),
      dataRangeTo: new Date('2026-06-30T23:59:59+05:30'),
      dataLifeUnit: 'MONTH',
      dataLifeValue: 6,
      consentExpiry: new Date('2026-07-14T10:30:00+05:30'),
      status: ConsentStatus.ACTIVE,
      artefactVerified: true,
      signedArtefact: encryptField('mock.jws.artefact'),
      activatedAt: now,
      expiresAt: dataLifeExpiresAt,
    },
  })

  await prisma.dataSession.upsert({
    where: { id: sessionId },
    update: { status: DataSessionStatus.COMPLETED },
    create: {
      id: sessionId,
      consentId: consent.id,
      providerSessionId: 'seed-session-arjun',
      status: DataSessionStatus.COMPLETED,
      dataRangeFrom: consent.dataRangeFrom,
      dataRangeTo: consent.dataRangeTo,
      fipTotal: 2,
      fipCompleted: 2,
      completedAt: now,
    },
  })

  const normalizedRows: Array<{
    fiType: FiType
    features: Record<string, unknown>
    coverageScore: number
  }> = [
    {
      fiType: FiType.DEPOSIT,
      // Mirrors exactly what FiNormalizerService.normalizeDeposit emits for the
      // sandbox deposit fixture (12 months of ₹85k salary, ₹53k of outgoings, and
      // one dishonoured auto-debit). Kept in step so the seeded score equals what
      // a live sandbox fetch would produce — a seed that disagreed with the
      // pipeline would make the demo unreproducible.
      coverageScore: 0.87,
      features: {
        txnCount: 37,
        totalInflow: 1_020_000,
        totalOutflow: 636_590,
        avgBalance: 289_705,
        peakBalance: 528_410,
        minBalance: 124_000,
        closingBalance: 475_410,
        // closing ÷ peak — a genuine accumulator, not a parked lump sum.
        balanceRetention: 0.9,
        obligationRatio: 0.624,
        // The ECS return in the fixture. Gives the "why" panel a real negative.
        bounceCount: 1,
        boundarySpikeRatio: 0.167,
        incomeRegularity: 0.94,
        monthsCovered: 12,
      },
    },
    {
      fiType: FiType.GSTR,
      coverageScore: 1,
      features: {
        annualTurnover: 4820000,
        filedMonths: 12,
        filingConsistency: 1,
        lateFilings: 1,
      },
    },
  ]

  for (const row of normalizedRows) {
    await prisma.fiNormalized.upsert({
      where: {
        userId_consentId_fiType: {
          userId: arjunId,
          consentId: consent.id,
          fiType: row.fiType,
        },
      },
      update: {
        normalizedJson: encryptField(JSON.stringify(row.features)),
        coverageScore: row.coverageScore,
        dataLifeExpiresAt,
      },
      create: {
        userId: arjunId,
        consentId: consent.id,
        fiType: row.fiType,
        normalizedJson: encryptField(JSON.stringify(row.features)),
        coverageScore: row.coverageScore,
        dataLifeExpiresAt,
      },
    })
  }

  console.log(
    `   ✔ M1 AA consent → ${consent.vua} (ACTIVE, DEPOSIT+GSTR, normalised)`,
  )
}

// ============================================================================
// M2 — REPUTATION ENGINE
// ============================================================================

/** Register the shipped model catalogue. v1.0.0 becomes the active version. */
async function seedScoringModels(): Promise<void> {
  for (const entry of MODEL_CATALOG) {
    await prisma.modelVersion.upsert({
      where: { version: entry.version },
      // Parameters are refreshed on re-seed so a local database tracks the
      // catalogue in code. In production a registered version is IMMUTABLE —
      // ModelService.register refuses to overwrite one, because mutating a
      // version would silently rewrite the meaning of every score stamped with
      // it. This is a dev-seed affordance, not the API's behaviour.
      update: {
        name: entry.name,
        runtime: entry.runtime,
        featureSchema: DEFAULT_FEATURE_SCHEMA,
        bands: DEFAULT_BANDS_JSON,
        scorecard: (entry.scorecard ?? null) as Prisma.InputJsonValue,
        datasetRef: entry.datasetRef,
        notes: entry.notes,
      },
      create: {
        name: entry.name,
        version: entry.version,
        runtime: entry.runtime,
        featureSchema: DEFAULT_FEATURE_SCHEMA,
        bands: DEFAULT_BANDS_JSON,
        scorecard: (entry.scorecard ?? null) as Prisma.InputJsonValue,
        trainedAt: new Date(entry.trainedAt),
        datasetRef: entry.datasetRef,
        notes: entry.notes,
        fairnessPassed: false,
        isActive: false,
      },
    })
  }
  console.log(
    `   ✔ M2 model registry → ${MODEL_CATALOG.map((m) => m.version).join(', ')}`,
  )
}

/**
 * The fairness audit cohort.
 *
 * A bias audit needs a population, and a fresh database has exactly one scored
 * user — so the audit would refuse to run and the flagship demo (open the bias
 * dashboard, watch the gate block a failing model) would be undemonstrable.
 *
 * The cohort is generated from a FIXED SEED, so it is identical on every machine
 * and the audit numbers are reproducible. Its one designed property:
 *
 *   **age band genuinely drives history depth and balance** — younger subjects
 *   have shorter histories and smaller buffers, which is true of real
 *   populations. Gender and nationality are deliberately UNcorrelated with the
 *   features.
 *
 * The consequence is the whole point of M2 §11: the balance-weighted legacy model
 * (v0.9.0) fails the four-fifths rule on `age_band` even though it never sees an
 * age, while the trend-weighted v1.0.0 passes. Dropping the protected attribute
 * did not delete the bias — only measuring the OUTCOME finds it.
 */
async function seedFairnessCohort(): Promise<void> {
  // 200 subjects → 50 per gender, 40 per age band, 100 per nationality. Every
  // group clears the 30-subject decisiveness floor, which is the point: a
  // four-fifths ratio computed off a dozen people is sampling noise, and an audit
  // that passes because every group was "too small to judge" is a green tick with
  // nothing behind it.
  const COHORT_SIZE = 200
  const rand = mulberry32(0x9e3779b9)

  const subjects = Array.from({ length: COHORT_SIZE }, (_, i) =>
    buildCohortSubject(i, rand),
  )

  // ── persist users + consent + normalised features ────────────────────────
  const dataLifeExpiresAt = new Date('2027-06-30T23:59:59+05:30')
  for (const s of subjects) {
    await prisma.user.upsert({
      where: { id: s.userId },
      update: { kycStatus: KycStatus.VERIFIED },
      create: {
        id: s.userId,
        pravaahId: seedPravaahId(s.userId),
        phone: s.phone,
        email: `${s.handle}@cohort.pravaah.test`,
        primaryCountry:
          s.nationality === 'SG' ? Country.SINGAPORE : Country.INDIA,
        kycStatus: KycStatus.VERIFIED,
      },
    })

    await prisma.consent.upsert({
      where: { id: s.consentId },
      update: { status: ConsentStatus.ACTIVE },
      create: {
        id: s.consentId,
        userId: s.userId,
        aaProvider: 'sandbox',
        providerConsentId: `seed-cohort-${s.handle}`,
        vua: `${s.phone.replace(/^\+/, '')}@onemoney`,
        purpose: 'Fairness audit cohort — synthetic consented data share',
        purposeCode: '101',
        consentMode: ConsentMode.STORE,
        fetchType: FetchType.ONETIME,
        fiTypes: [FiType.DEPOSIT],
        dataRangeFrom: new Date('2025-07-01T00:00:00+05:30'),
        dataRangeTo: new Date('2026-06-30T23:59:59+05:30'),
        dataLifeUnit: 'MONTH',
        dataLifeValue: 12,
        consentExpiry: new Date('2026-07-14T10:30:00+05:30'),
        status: ConsentStatus.ACTIVE,
        artefactVerified: true,
        activatedAt: new Date('2026-07-14T10:00:00+05:30'),
        expiresAt: dataLifeExpiresAt,
      },
    })

    await prisma.fiNormalized.upsert({
      where: {
        userId_consentId_fiType: {
          userId: s.userId,
          consentId: s.consentId,
          fiType: FiType.DEPOSIT,
        },
      },
      update: {
        normalizedJson: encryptField(JSON.stringify(s.normalized)),
        coverageScore: s.coverage,
        dataLifeExpiresAt,
      },
      create: {
        userId: s.userId,
        consentId: s.consentId,
        fiType: FiType.DEPOSIT,
        normalizedJson: encryptField(JSON.stringify(s.normalized)),
        coverageScore: s.coverage,
        dataLifeExpiresAt,
      },
    })

    // The separate, explicit consent for audit-only protected attributes.
    // Encrypted, exactly as the live API stores them.
    await prisma.protectedAttribute.upsert({
      where: { userId: s.userId },
      update: {
        gender: encryptField(s.gender),
        ageBand: encryptField(s.ageBand),
        nationality: encryptField(s.nationality),
        consentGiven: true,
        consentedAt: new Date('2026-07-14T10:05:00+05:30'),
      },
      create: {
        userId: s.userId,
        gender: encryptField(s.gender),
        ageBand: encryptField(s.ageBand),
        nationality: encryptField(s.nationality),
        consentGiven: true,
        consentedAt: new Date('2026-07-14T10:05:00+05:30'),
      },
    })
  }
  console.log(
    `   ✔ M2 fairness cohort → ${subjects.length} consented subjects (DEPOSIT + protected attrs)`,
  )

  // ── run the REAL audit for every registered version ─────────────────────
  // Same pure scorecard math the API uses, so these rows are what a live
  // `POST /admin/score/models/:id/audit-fairness` would recompute.
  for (const entry of MODEL_CATALOG) {
    if (!entry.scorecard) continue
    const model = await prisma.modelVersion.findUnique({
      where: { version: entry.version },
    })
    if (!model) continue

    const approvedByGroup = new Map<string, number[]>()
    let approvedTotal = 0
    for (const s of subjects) {
      const score = scoreWithScorecard(entry.scorecard, s.features)
      const approved = score >= FAIRNESS_POSITIVE_BAND_MIN ? 1 : 0
      approvedTotal += approved
      for (const group of [
        `gender:${s.gender}`,
        `age_band:${s.ageBand}`,
        `nationality:${s.nationality}`,
      ]) {
        approvedByGroup.set(group, [
          ...(approvedByGroup.get(group) ?? []),
          approved,
        ])
      }
    }

    const reports = fairnessReports(
      approvedByGroup,
      approvedTotal / subjects.length,
    )
    // Only statistically meaningful groups of BLOCKING attributes decide the
    // gate; the monitored age gap is stored and reported but never blocks.
    const decisive = reports.filter(
      (r) =>
        r.sampleSize >= FAIRNESS_MIN_GROUP_SIZE &&
        FAIRNESS_BLOCKING_ATTRIBUTES.has(r.attribute),
    )
    const passed = decisive.length > 0 && decisive.every((r) => r.passed)
    const monitored = reports.filter(
      (r) =>
        r.sampleSize >= FAIRNESS_MIN_GROUP_SIZE &&
        !FAIRNESS_BLOCKING_ATTRIBUTES.has(r.attribute) &&
        !r.passed,
    )

    await prisma.$transaction([
      prisma.fairnessReport.deleteMany({ where: { modelVersionId: model.id } }),
      prisma.fairnessReport.createMany({
        data: reports.map((r) => ({ modelVersionId: model.id, ...r })),
      }),
      prisma.modelVersion.update({
        where: { id: model.id },
        data: {
          // v1.1.0 stays UNAUDITED on purpose: it is the version an admin tries
          // to activate in the demo, and watches the gate refuse.
          fairnessPassed: entry.version === '1.1.0' ? false : passed,
          fairnessAt: entry.version === '1.1.0' ? null : new Date(),
        },
      }),
    ])

    const failing = decisive.filter((r) => !r.passed)
    const verdict =
      entry.version === '1.1.0'
        ? 'UNAUDITED (activation blocked — this is the gate demo)'
        : passed
          ? 'PASSED'
          : `FAILED (${failing.length} blocking group metric${failing.length === 1 ? '' : 's'})`
    console.log(`      · v${entry.version} fairness → ${verdict}`)
    for (const r of failing.slice(0, 4)) {
      console.log(
        `          ✗ blocking: ${r.metric} ${r.group} = ${r.value} (needs ${
          r.metric === 'demographic_parity' ? '≤' : '≥'
        } ${r.threshold})`,
      )
    }
    if (monitored.length) {
      console.log(
        `          · monitored (age): ${monitored.length} metric${monitored.length === 1 ? '' : 's'} outside threshold — reported, not blocking`,
      )
    }
  }

  // v1.0.0 becomes the active version so the app can score immediately.
  const active = await prisma.modelVersion.findUnique({
    where: { version: '1.0.0' },
  })
  if (active?.fairnessPassed) {
    await prisma.$transaction([
      prisma.modelVersion.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      }),
      prisma.modelVersion.update({
        where: { id: active.id },
        data: { isActive: true, activatedAt: new Date() },
      }),
    ])
    console.log('   ✔ M2 active model → v1.0.0 (fairness passed)')
  } else {
    console.log(
      '   ⚠ v1.0.0 did NOT pass the fairness audit, so it was NOT activated. ' +
        'That is the gate working — no model goes live unaudited.',
    )
  }
}

// ── cohort generation ───────────────────────────────────────────────────────
const FAIRNESS_POSITIVE_BAND_MIN = 670 // GOOD or better
/** Must match MIN_GROUP_SIZE in fairness.service.ts. */
const FAIRNESS_MIN_GROUP_SIZE = 30
/** Must match BLOCKING_ATTRIBUTES in fairness.service.ts. */
const FAIRNESS_BLOCKING_ATTRIBUTES = new Set(['gender', 'nationality'])

/**
 * History depth by age band. Near-deterministic on purpose — you cannot hold two
 * years of bank statements at nineteen.
 */
const AGE_MONTHS: Record<string, [number, number]> = {
  '18-25': [3, 9],
  '26-35': [7, 18],
  '36-45': [11, 24],
  '46-60': [16, 24],
  '60+': [20, 24],
}

/**
 * Average balance by gender, at comparable incomes.
 *
 * This encodes a real, documented pattern rather than an invented one: women in
 * India hold materially lower average account balances than men at comparable
 * incomes (unpaid care work, joint-account dynamics, and lower asset titling all
 * contribute), while their repayment BEHAVIOUR is at least as good — the
 * microfinance literature is unambiguous there.
 *
 * The consequence is the whole point of the activation gate: `avg_balance` is a
 * gender PROXY and behaviour features are not, so the balance-weighted v0.9.0
 * launders gender and fails the audit, while the behaviour-weighted v1.0.0 passes
 * — neither model ever sees a gender.
 */
const BALANCE_BY_GENDER: Record<string, number> = {
  female: 0.52,
  other: 0.85,
  prefer_not_to_say: 0.9,
  male: 1.0,
}

const COHORT_GENDERS = ['female', 'male', 'other', 'prefer_not_to_say']
const COHORT_AGE_BANDS = ['18-25', '26-35', '36-45', '46-60', '60+']
const COHORT_NATIONALITIES = ['IN', 'SG']

function buildCohortSubject(index: number, rand: () => number) {
  // Round-robin over the strata so every group clears the minimum sample size —
  // an audit that reports "n=3" is noise, not evidence.
  const gender = COHORT_GENDERS[index % COHORT_GENDERS.length]
  const ageBand = COHORT_AGE_BANDS[index % COHORT_AGE_BANDS.length]
  const nationality = COHORT_NATIONALITIES[index % COHORT_NATIONALITIES.length]
  const ageIndex =
    COHORT_AGE_BANDS.indexOf(ageBand) / (COHORT_AGE_BANDS.length - 1)

  const monthsCovered = Math.round(between(rand, ...AGE_MONTHS[ageBand]))

  // Earning power is INDEPENDENT of age. Real populations contain well-paid
  // 23-year-olds and struggling 50-year-olds; a cohort where age band determines
  // income is a caricature, and auditing a caricature tells you nothing.
  const earningPower = between(rand, 0.15, 1.0)
  const ageWage = ageBand === '60+' ? 0.35 : ageIndex // pensions, not peak salary
  const monthlyIncome = Math.round(
    20_000 + (0.35 * ageWage + 0.65 * earningPower) * 180_000,
  )
  // Savings rise with age, but the random spread is far wider than the age
  // spread — savings rate varies enormously at identical incomes.
  const avgBalance = Math.round(
    monthlyIncome *
      between(rand, 0.3, 3.5) *
      (0.6 + 1.2 * ageIndex) *
      (BALANCE_BY_GENDER[gender] ?? 1),
  )
  const totalInflow = monthlyIncome * monthsCovered

  // Behaviour is at PARITY for the group with lower balances — a small edge, not
  // a large one. Overstating it would flip the disparity the other way and make
  // the audit measure the fixture rather than the model.
  const edge = gender === 'female' ? 0.02 : 0
  const incomeRegularity = round3(
    Math.min(0.98, between(rand, 0.6, 0.97) + edge),
  )
  const balanceRetention = round3(
    Math.min(0.98, between(rand, 0.35, 0.95) + edge),
  )
  const obligationRatio = round3(Math.max(0.2, between(rand, 0.4, 1.05) - edge))
  const bounceCount = rand() < 0.3 ? (rand() < 0.4 ? 2 : 1) : 0

  const handle = `cohort-${String(index + 1).padStart(3, '0')}`
  const normalized = {
    txnCount: monthsCovered * 3,
    totalInflow,
    totalOutflow: Math.round(totalInflow * obligationRatio),
    avgBalance,
    peakBalance: Math.round(avgBalance / Math.max(0.2, balanceRetention)),
    minBalance: Math.round(avgBalance * 0.4),
    closingBalance: avgBalance,
    balanceRetention,
    obligationRatio,
    bounceCount,
    boundarySpikeRatio: round3(2 / monthsCovered),
    incomeRegularity,
    monthsCovered,
    coverageScore: round3(
      0.5 * Math.min(1, (monthsCovered * 3) / 50) +
        0.5 * Math.min(1, monthsCovered / 6),
    ),
  }

  return {
    // Fixed, derivable ids so re-seeding updates rather than duplicates.
    userId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    consentId: `41000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    phone: `+9198${String(70_000_000 + index).padStart(8, '0')}`,
    handle,
    gender,
    ageBand,
    nationality,
    coverage: normalized.coverageScore,
    normalized,
    features: {
      // The FEATURE is a monthly rate; `totalInflow` above is what M1 persists.
      monthly_inflow: monthlyIncome,
      income_regularity: incomeRegularity,
      avg_balance: avgBalance,
      balance_retention: balanceRetention,
      obligation_ratio: obligationRatio,
      months_covered: monthsCovered,
      bounce_count: bounceCount,
      // Salaried cohort: no GST file. Optional features, so their absence costs
      // nothing — it is not-applicable, not missing.
      gst_turnover: null,
      gst_filing_consistency: null,
    } as Record<ScoreFeature, number | null>,
  }
}

/**
 * The scorecard, evaluated exactly as `LocalScorecardProvider` does — same pure
 * helpers, so the seeded fairness rows equal what a live audit recomputes.
 */
function scoreWithScorecard(
  params: ScorecardParamsDto,
  features: Record<ScoreFeature, number | null>,
): number {
  const { a, b } = params.calibration
  let margin = a * params.intercept + b
  for (const key of FEATURE_KEYS) {
    const transform = params.transforms[key]
    if (!transform) continue
    const weight = params.weights[key] ?? 0
    const reference = params.reference[key] ?? 0
    const raw = features[key]
    const value = raw === null || !Number.isFinite(raw) ? reference : raw
    margin += a * weight * applyTransform(value, transform)
  }
  return probabilityToScore(sigmoid(margin))
}

/** Two-sided normal critical value at alpha = 0.05. */
const FAIRNESS_Z_CRIT = 1.959964

/**
 * Pooled two-proportion z-test. Kept numerically identical to `twoProportionZ` in
 * fairness.service.ts and `two_proportion_z` in fairness.py — the seeded verdicts
 * must be what a live audit recomputes.
 */
function twoProportionZ(
  group: readonly number[],
  reference: readonly number[],
): { z: number; significant: boolean } {
  const n1 = group.length
  const n2 = reference.length
  if (n1 === 0 || n2 === 0) return { z: 0, significant: false }
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
  const pooled = (sum(group) + sum(reference)) / (n1 + n2)
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
  if (se < 1e-12) return { z: 0, significant: false }
  const z = (sum(group) / n1 - sum(reference) / n2) / se
  return { z, significant: Math.abs(z) >= FAIRNESS_Z_CRIT }
}

/**
 * Four-fifths rule + demographic parity, per group, within each attribute.
 *
 * Each metric fails only when the disparity is BOTH materially large and
 * statistically significant: the ratio alone is dominated by sampling noise at
 * small group sizes and would block deploys at random. Disparate impact is tested
 * against the best group (what the ratio is defined against); parity is tested
 * against the group's COMPLEMENT, so the most-favoured group can also fail.
 */
function fairnessReports(
  approvedByGroup: Map<string, number[]>,
  populationRate: number,
) {
  const rates = new Map<string, number>()
  for (const [group, outcomes] of approvedByGroup) {
    rates.set(
      group,
      outcomes.length
        ? outcomes.reduce((x, y) => x + y, 0) / outcomes.length
        : 0,
    )
  }

  const byAttribute = new Map<string, string[]>()
  for (const group of rates.keys()) {
    const attribute = group.split(':')[0] ?? 'unknown'
    byAttribute.set(attribute, [...(byAttribute.get(attribute) ?? []), group])
  }

  const out: Array<{
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

  for (const [attribute, groups] of byAttribute) {
    const best = Math.max(...groups.map((g) => rates.get(g) ?? 0))
    const bestGroup = groups.reduce(
      (winner, g) =>
        (rates.get(g) ?? 0) > (rates.get(winner) ?? 0) ? g : winner,
      groups[0] ?? '',
    )

    for (const group of groups) {
      const rate = rates.get(group) ?? 0
      const outcomes = approvedByGroup.get(group) ?? []
      const sampleSize = outcomes.length
      // Small groups are still REPORTED — hiding them would hide real gaps —
      // they simply pass rather than deciding the gate on noise.
      const small = sampleSize < FAIRNESS_MIN_GROUP_SIZE

      const diTest =
        bestGroup && bestGroup !== group
          ? twoProportionZ(outcomes, approvedByGroup.get(bestGroup) ?? [])
          : { z: 0, significant: false }
      const di = best > 0 ? rate / best : 1
      out.push({
        metric: 'disparate_impact',
        attribute,
        group,
        value: round3(di),
        threshold: 0.8,
        passed: small || di >= 0.8 || !diTest.significant,
        sampleSize,
        approvalRate: round3(rate),
        zScore: round3(diTest.z),
        significant: diTest.significant,
      })

      const complement = groups
        .filter((other) => other !== group)
        .flatMap((other) => approvedByGroup.get(other) ?? [])
      const dpTest = twoProportionZ(outcomes, complement)
      const gap = Math.abs(rate - populationRate)
      out.push({
        metric: 'demographic_parity',
        attribute,
        group,
        value: round3(gap),
        threshold: 0.1,
        passed: small || gap <= 0.1 || !dpTest.significant,
        sampleSize,
        approvalRate: round3(rate),
        zScore: round3(dpTest.z),
        significant: dpTest.significant,
      })
    }
  }
  return out
}

/**
 * Deterministic PRNG (mulberry32). `Math.random()` would make the cohort — and
 * therefore the seeded fairness verdicts — different on every machine, which is
 * the opposite of what a reproducibility story needs.
 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let x = Math.imul(t ^ (t >>> 15), 1 | t)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296
  }
}

function between(rand: () => number, lo: number, hi: number): number {
  return lo + rand() * (hi - lo)
}

function round3(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(3)) : 0
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error('❌ Seed failed:', error)
    await prisma.$disconnect()
    process.exit(1)
  })
