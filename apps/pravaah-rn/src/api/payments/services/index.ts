/**
 * M4 payments API.
 *
 * Seven services rather than one class, because the backend mounts seven base paths and
 * `BaseApiService` binds exactly one. Grouping them would mean hand-writing absolute paths for six
 * of them and losing the base-path guarantee.
 *
 * The load-bearing detail throughout: every mutation goes through `postIdempotent` and takes the
 * key as an explicit, required argument. The key is minted by `useIdempotencyKey` at the moment the
 * user forms an INTENT — not in a service method, and not at submit time. A key minted here would
 * be fresh on every retry, and the server would read that as a second payment.
 */

export { paymentsService } from './wallet.service';
export { beneficiaryService } from './beneficiary.service';
export { transferService } from './transfer.service';
export { collectService } from './collect.service';
export { paymentQrService } from './qr.service';
export { mandateService } from './mandate.service';
export { paymentDisputeService } from './dispute.service';
