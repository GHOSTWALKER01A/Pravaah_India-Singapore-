import { API_ENDPOINTS } from '@/features/endpoints';

import { BaseAPIService } from '../core/base-api-service';
import {
  CredentialAuditResponseSchema,
  CredentialDetailResponseSchema,
  CredentialListResponseSchema,
  IssuerKeyListResponseSchema,
  PartnerCreatedResponseSchema,
  PartnerListResponseSchema,
  PassportStatsResponseSchema,
  RotateKeyResponseSchema,
  StatusChangeResponseSchema,
  type CredentialStatus,
} from './passport.schema';

/**
 * M3 admin console — credential oversight, issuer keys, and verifier registration.
 *
 * The destructive actions here (revoke, suspend, resume, rotate) call the SAME backend
 * services the holder and the schedulers use. There is deliberately no admin-only
 * revocation path: two implementations of "revoke" eventually revoke differently, and the
 * status-list bit and the credential row must never disagree.
 */
class PassportService extends BaseAPIService {
  constructor() {
    super(API_ENDPOINTS.PASSPORT.BASE);
  }

  // ── oversight ─────────────────────────────────────────────────────────────
  async listCredentials(params: {
    status?: string;
    passportBound?: boolean;
    userId?: string;
    limit?: number;
    offset?: number;
  }) {
    const query = new URLSearchParams();
    if (params.status && params.status !== 'ALL') {
      query.set('status', params.status);
    }
    if (params.passportBound !== undefined) {
      query.set('passportBound', String(params.passportBound));
    }
    if (params.userId) query.set('userId', params.userId);
    query.set('limit', String(params.limit ?? 50));
    query.set('offset', String(params.offset ?? 0));

    const res = await this.get(
      `${API_ENDPOINTS.PASSPORT.LIST}?${query.toString()}`,
    );
    return CredentialListResponseSchema.parse(res).data;
  }

  async getCredential(id: string) {
    const res = await this.get(API_ENDPOINTS.PASSPORT.DETAIL(id));
    return CredentialDetailResponseSchema.parse(res).data;
  }

  async getAudit(id: string) {
    const res = await this.get(API_ENDPOINTS.PASSPORT.AUDIT(id));
    return CredentialAuditResponseSchema.parse(res).data;
  }

  async stats() {
    const res = await this.get(API_ENDPOINTS.PASSPORT.STATS);
    return PassportStatsResponseSchema.parse(res).data;
  }

  // ── intervention ──────────────────────────────────────────────────────────
  /**
   * Revoke. TERMINAL — there is no un-revoke, because a credential a verifier already
   * rejected must never start passing again; no verifier caches revocation with that
   * possibility in mind. The holder re-issues instead.
   */
  async revoke(id: string, reason: string) {
    const res = await this.post(API_ENDPOINTS.PASSPORT.REVOKE(id), { reason });
    return StatusChangeResponseSchema.parse(res).data;
  }

  /** Reversible hold. Flips the same status-list bit, so verifiers fail closed. */
  async suspend(id: string, reason: string) {
    const res = await this.post(API_ENDPOINTS.PASSPORT.SUSPEND(id), { reason });
    return StatusChangeResponseSchema.parse(res).data;
  }

  async resume(id: string, reason: string) {
    const res = await this.post(API_ENDPOINTS.PASSPORT.RESUME(id), { reason });
    return StatusChangeResponseSchema.parse(res).data;
  }

  // ── issuer keys ───────────────────────────────────────────────────────────
  async listKeys() {
    const res = await this.get(API_ENDPOINTS.PASSPORT.KEYS);
    return IssuerKeyListResponseSchema.parse(res).data;
  }

  /**
   * Rotate the signing key.
   *
   * Safe by construction, which is what makes it pressable during an incident: the old
   * public key stays in the DID document and JWKS until every credential it signed has
   * expired, so rotation never invalidates a credential already in the wild.
   */
  async rotateKey() {
    const res = await this.post(API_ENDPOINTS.PASSPORT.KEYS_ROTATE);
    return RotateKeyResponseSchema.parse(res).data;
  }

  // ── verifier partners ─────────────────────────────────────────────────────
  async listPartners() {
    const res = await this.get(API_ENDPOINTS.PASSPORT.PARTNERS);
    return PartnerListResponseSchema.parse(res).data;
  }

  /**
   * Register a verifier. The API key comes back ONCE and only its hash is stored — a key we
   * could re-read is a key that leaks with the database.
   *
   * The body is passed through unvalidated on purpose, matching the M2 model-registration
   * convention: the backend's Zod schema is the authority, and its issue list is a better
   * error message than a duplicated client-side schema could produce — one which would also
   * silently drift from the server's.
   */
  async registerPartner(payload: Record<string, unknown>) {
    const res = await this.post(API_ENDPOINTS.PASSPORT.PARTNERS, payload);
    return PartnerCreatedResponseSchema.parse(res).data;
  }

  async deactivatePartner(id: string) {
    const res = await this.post(API_ENDPOINTS.PASSPORT.PARTNER_REVOKE(id));
    return res;
  }
}

export const passportService = new PassportService();
export type { CredentialStatus };
