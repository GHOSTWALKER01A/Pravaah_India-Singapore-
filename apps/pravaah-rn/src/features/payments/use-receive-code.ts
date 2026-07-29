import { useCallback, useEffect, useRef, useState } from 'react';

import { paymentQrService, paymentsService } from '@/api/payments/services';
import type { PaymentQrView, UpiHandleView } from '@/api/payments/schemas';

/**
 * The holder's address and receive code, provisioned WITHOUT asking them for anything.
 *
 * The screen this replaces printed "no upi id yet" along the base of the leaf and put a notice on the
 * page telling the holder to go and create one. That was busywork dressed as a choice. By the time
 * somebody reaches the Pay tab, M0 has already collected and verified their legal name, and the
 * backend's `UpiHandleService.allocate` already seeds the address from exactly that field —
 * `user.kycProfile.verifiedName` — falling back to the Pravaah ID. There was never a question to ask:
 * the answer was already in the KYC record.
 *
 * So this hook allocates on first sight of the tab and mints a static receive QR against it. Both
 * calls are idempotent server-side — `allocate` returns the existing primary handle when one exists,
 * and a static QR is reusable by definition — which is what makes it safe to run on focus.
 *
 * **The one state that is genuinely a question, and is preserved as one:** the backend refuses to
 * issue an address to an unverified identity, because a UPI address is a way to receive money from
 * strangers and handing one to an unverified account creates a mule carrying our handle. That refusal
 * arrives as a 400 and must surface as "finish verifying", never as a retry loop — hence
 * `blockedReason` rather than a generic error.
 */
export function useReceiveCode(enabled: boolean) {
  const [handle, setHandle] = useState<UpiHandleView | null>(null);
  const [code, setCode] = useState<PaymentQrView | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);

  /**
   * One attempt per mount, tracked in a ref rather than in state.
   *
   * The Pay tab refetches on focus, and focus fires often. A state flag would be read stale inside the
   * same tick that started the request, so two focus events in quick succession would both pass the
   * guard and race — producing two allocation attempts and, worse, two QR rows for one holder. The ref
   * closes in the same tick the request starts.
   */
  const attempted = useRef(false);

  const provision = useCallback(async () => {
    if (attempted.current || !enabled) return;
    attempted.current = true;

    setProvisioning(true);
    try {
      const existing = await paymentsService.listHandles();
      const primary =
        existing.find((h) => h.isPrimary && h.status === 'ACTIVE') ??
        existing.find((h) => h.status === 'ACTIVE') ??
        existing[0] ??
        // Nothing on file: derive one from the verified identity we already hold.
        (await paymentsService.createHandle());

      setHandle(primary);
      setBlockedReason(null);

      /**
       * A STATIC code, and only a static one.
       *
       * A static QR carries no amount, so the payer types it — which is what makes the same code
       * reusable forever and printable on a shopfront. A dynamic code is a single bill and would have
       * to be re-minted on every render of this tab.
       */
      const codes = await paymentQrService.list();
      const reusable = codes.find((qr) => qr.kind === 'STATIC' && qr.isActive);
      setCode(
        reusable ??
          (await paymentQrService.create({
            kind: 'STATIC',
            purposeCode: 'P2P_TRANSFER',
            currency: 'INR',
          })),
      );
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Could not set up your UPI ID.';
      setBlockedReason(message);
      // Allow one retry on the next focus for a transient failure. A verification block is not
      // transient, but re-attempting it costs one cheap 400 and keeps the recovery automatic once the
      // holder finishes verifying.
      attempted.current = false;
    } finally {
      setProvisioning(false);
    }
  }, [enabled]);

  useEffect(() => {
    void provision();
  }, [provision]);

  return { handle, code, provisioning, blockedReason, retry: provision };
}
