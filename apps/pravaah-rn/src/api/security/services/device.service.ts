import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import type {
  BindResult,
  BindTicket,
  DeviceContext,
  DeviceView,
  RefreshResult,
  StepUpChallenge,
} from '../schemas';

/**
 * Device binding — the layer M0 designed and never built.
 *
 * ## Why binding is a two-call flow
 *
 * `begin` returns a CHALLENGE, never a token. A bind that handed back credentials before
 * the challenge was answered would make the challenge decorative — and that is precisely
 * the account-takeover scenario, where the attacker already holds the session and needs
 * only a trusted device.
 *
 * ## Why there is no idempotency key on any of this
 *
 * None of these calls move money. `begin` is idempotent server-side on
 * `(userId, deviceId)`, and `confirm` is protected by a single-use nonce — which is a
 * stronger guarantee than a client-held key, because a second call with the same nonce is
 * REFUSED rather than replayed back as a success.
 */
class DeviceService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.SECURITY.BASE);
  }

  /** Every device on the account, newest-seen first. Revoked ones are omitted. */
  list(): Promise<DeviceView[]> {
    return this.get<DeviceView[]>(API_ENDPOINTS.SECURITY.DEVICES);
  }

  /**
   * Start registering this device.
   *
   * Returns `stepUp: null` when the device is already ACTIVE, which is the ordinary case
   * on every launch after the first — so the caller must branch on that rather than
   * assuming a challenge is always waiting.
   */
  begin(context: DeviceContext): Promise<BindTicket> {
    return this.post<BindTicket>(
      API_ENDPOINTS.SECURITY.DEVICE_BIND,
      context as unknown as object,
    );
  }

  /** Finish the bind. The binding token comes back once and is never re-issued. */
  confirm(nonce: string, answer: string): Promise<BindResult> {
    return this.post<BindResult>(API_ENDPOINTS.SECURITY.DEVICE_BIND_CONFIRM, {
      nonce,
      answer,
    });
  }

  /**
   * "This wasn't me."
   *
   * Deliberately takes no challenge. Revoking is the SAFE direction, and a user who
   * suspects a compromise must be able to act instantly — demanding an OTP from somebody
   * whose SIM was just swapped denies them the one control that actually helps.
   */
  revoke(deviceRef: string): Promise<{ deviceRef: string; status: string }> {
    return this.post(API_ENDPOINTS.SECURITY.DEVICE_REVOKE(deviceRef));
  }

  /** Ask for a challenge to re-verify a device out of `SUSPECTED_SWAP`. */
  requestRecovery(deviceRef: string): Promise<StepUpChallenge> {
    return this.post<StepUpChallenge>(
      API_ENDPOINTS.SECURITY.DEVICE_RECOVER_REQUEST(deviceRef),
    );
  }

  /**
   * Re-verify after a legitimate SIM change, re-anchoring the new serial.
   *
   * That re-anchor is what makes recovery meaningful: the real user's new SIM becomes the
   * new baseline, while an attacker who cannot answer leaves the device frozen.
   */
  recover(
    deviceRef: string,
    body: { nonce: string; answer: string; simSerial?: string },
  ): Promise<{ deviceRef: string; status: string }> {
    return this.post(API_ENDPOINTS.SECURITY.DEVICE_RECOVER(deviceRef), body);
  }

  /**
   * Rotate the binding token.
   *
   * Maintenance, not authentication — so no challenge. The caller already holds a valid
   * session and the device is already ACTIVE; demanding an OTP to refresh a credential
   * the client legitimately holds would train users to expect prompts they cannot
   * distinguish from an attacker's.
   */
  refresh(deviceRef: string): Promise<RefreshResult> {
    return this.post<RefreshResult>(
      API_ENDPOINTS.SECURITY.DEVICE_REFRESH(deviceRef),
    );
  }
}

export const deviceService = new DeviceService();
