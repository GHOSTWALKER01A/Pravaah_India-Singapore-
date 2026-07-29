import { z } from 'zod';

import { APIResponseSchema } from '../core/api.schema';

/**
 * M3 · The Passport, as surfaced to admins — the credential-risk console.
 *
 * Note what these shapes deliberately do NOT carry: claim VALUES. A credential's audit view
 * exposes which claims EXIST (`claimKeys`), its provenance, its status-list position, and
 * every presentation it has made — but never the holder's name, nationality or score value.
 * The signed credential and its cleartext disclosures stay encrypted server-side: an admin
 * has a legitimate need to know a passport asserts a nationality, and no need to know which
 * one.
 */

export const CredentialStatusSchema = z.enum([
  'ISSUED',
  'SUSPENDED',
  'REVOKED',
  'EXPIRED',
]);
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;

export const CardStatusSchema = z.enum(['ACTIVE', 'LOST', 'REVOKED']);

const ScoreBandSchema = z.enum([
  'POOR',
  'FAIR',
  'GOOD',
  'VERY_GOOD',
  'EXCELLENT',
]);

// ── the credential list ─────────────────────────────────────────────────────
export const CredentialListItemSchema = z.object({
  id: z.string(),
  credentialNumber: z.string(),
  status: CredentialStatusSchema,
  scoreBand: ScoreBandSchema.nullable(),
  dataRails: z.array(z.string()),
  passportBound: z.boolean(),
  deviceLabel: z.string().nullable(),
  /** The PUBLIC user identifier. Never the row UUID — an admin list gets screenshotted. */
  pravaahId: z.string().nullable(),
  country: z.string(),
  issuerKid: z.string(),
  presentationCount: z.number(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  revokeReason: z.string().nullable(),
});
export type CredentialListItem = z.infer<typeof CredentialListItemSchema>;

// ── one credential in full ──────────────────────────────────────────────────
export const PresentationRowSchema = z.object({
  id: z.string(),
  verifier: z.string(),
  verifierCountry: z.string().nullable(),
  disclosedClaims: z.array(z.string()),
  channel: z.string(),
  valid: z.boolean(),
  holderVerified: z.boolean(),
  failureReason: z.string().nullable(),
  presentedAt: z.string(),
});
export type PresentationRow = z.infer<typeof PresentationRowSchema>;

export const CredentialDetailSchema = z.object({
  id: z.string(),
  credentialNumber: z.string(),
  vct: z.string(),
  status: CredentialStatusSchema,
  /**
   * Identifies the DEVICE, which is what a suspected-theft investigation actually needs.
   * The public key is included because it is public by construction — it travels inside
   * every credential.
   */
  subjectDid: z.string(),
  holderJwkThumbprint: z.string(),
  deviceLabel: z.string().nullable(),
  scoreBand: ScoreBandSchema.nullable(),
  dataRails: z.array(z.string()),
  passportBound: z.boolean(),
  /** Claim NAMES only. The values are never decrypted for this view. */
  claimKeys: z.array(z.string()),
  statusList: z.object({
    uri: z.string(),
    index: z.number(),
    version: z.number(),
  }),
  issuerKey: z.object({
    kid: z.string(),
    isActive: z.boolean(),
    retiredAt: z.string().nullable(),
  }),
  pravaahId: z.string().nullable(),
  country: z.string(),
  kycStatus: z.string(),
  score: z
    .object({
      id: z.string(),
      band: ScoreBandSchema.nullable(),
      confidence: z.number().nullable(),
      coverageScore: z.number().nullable(),
      computedAt: z.string().nullable(),
      status: z.string(),
      modelVersion: z.object({ name: z.string(), version: z.string() }),
    })
    .nullable(),
  /** The re-issue chain: which credential was live on a given date. */
  chain: z.object({
    supersedes: z
      .object({
        id: z.string(),
        credentialNumber: z.string(),
        revokedAt: z.string().nullable(),
      })
      .nullable(),
    supersededBy: z
      .object({
        id: z.string(),
        credentialNumber: z.string(),
        issuedAt: z.string(),
      })
      .nullable(),
  }),
  card: z
    .object({
      cardSerial: z.string(),
      status: CardStatusSchema,
      nfcWritten: z.boolean(),
      issuedAt: z.string(),
      lastVerifiedAt: z.string().nullable(),
    })
    .nullable(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  revokeReason: z.string().nullable(),
  presentations: z.array(PresentationRowSchema),
});
export type CredentialDetail = z.infer<typeof CredentialDetailSchema>;

export const CredentialAuditRowSchema = z.object({
  id: z.string(),
  action: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: z.string(),
});
export type CredentialAuditRow = z.infer<typeof CredentialAuditRowSchema>;

// ── issuer keys ─────────────────────────────────────────────────────────────
export const IssuerKeySchema = z.object({
  id: z.string(),
  kid: z.string(),
  alg: z.string(),
  isActive: z.boolean(),
  /** RFC 7638 thumbprint — a stable fingerprint an operator can compare by eye. */
  thumbprint: z.string(),
  createdAt: z.string(),
  rotatedAt: z.string().nullable(),
  /** Set only once every credential this key signed has expired. */
  retiredAt: z.string().nullable(),
  credentialCount: z.number(),
});
export type IssuerKey = z.infer<typeof IssuerKeySchema>;

// ── verifier partners ───────────────────────────────────────────────────────
export const PartnerSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The identifier that MUST appear as the KB-JWT `aud`. Immutable once issued. */
  audience: z.string(),
  country: z.string().nullable(),
  contactEmail: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  requestCount: z.number(),
  presentationCount: z.number(),
});
export type Partner = z.infer<typeof PartnerSchema>;

/** `POST /partners` returns the key ONCE. Nothing can retrieve it afterwards. */
export const PartnerCreatedSchema = z.object({
  id: z.string(),
  name: z.string(),
  audience: z.string(),
  country: z.string().nullable(),
  createdAt: z.string(),
  apiKey: z.string(),
  warning: z.string(),
});
export type PartnerCreated = z.infer<typeof PartnerCreatedSchema>;

// ── operational overview ────────────────────────────────────────────────────
export const PassportStatsSchema = z.object({
  credentials: z.record(z.string(), z.number()),
  credentialsTotal: z.number(),
  last30Days: z.object({
    presentations: z.number(),
    /**
     * The number that matters more than the successes: a spike in invalid presentations
     * against one credential is the shape a theft attempt makes, and it is invisible on a
     * dashboard that only plots issuance.
     */
    failedPresentations: z.number(),
    failureRate: z.number(),
  }),
  activePartners: z.number(),
  publishedKeys: z.number(),
  cards: z.record(z.string(), z.number()),
});
export type PassportStats = z.infer<typeof PassportStatsSchema>;

export const StatusChangeSchema = z.object({
  status: CredentialStatusSchema,
  changed: z.boolean(),
});

// ── response envelopes ──────────────────────────────────────────────────────
export const CredentialListResponseSchema = APIResponseSchema(
  z.object({
    items: z.array(CredentialListItemSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    hasMore: z.boolean().optional(),
  }),
);
export const CredentialDetailResponseSchema = APIResponseSchema(
  CredentialDetailSchema,
);
export const CredentialAuditResponseSchema = APIResponseSchema(
  z.array(CredentialAuditRowSchema),
);
export const IssuerKeyListResponseSchema = APIResponseSchema(
  z.array(IssuerKeySchema),
);
export const RotateKeyResponseSchema = APIResponseSchema(
  z.object({ kid: z.string() }),
);
export const PartnerListResponseSchema = APIResponseSchema(
  z.array(PartnerSchema),
);
export const PartnerCreatedResponseSchema =
  APIResponseSchema(PartnerCreatedSchema);
export const PassportStatsResponseSchema =
  APIResponseSchema(PassportStatsSchema);
export const StatusChangeResponseSchema = APIResponseSchema(StatusChangeSchema);
