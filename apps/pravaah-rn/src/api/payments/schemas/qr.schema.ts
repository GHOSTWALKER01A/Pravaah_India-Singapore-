import type { MoneyView, QrKind } from './vocabulary';

/** QR codes — the ones we mint, and the ones we are handed. */

export interface PaymentQrView {
  id: string;
  ref: string;
  kind: QrKind;
  /** The `upi://pay?...` intent string, exactly as encoded into the image. */
  payload: string;
  vpa: string;
  amount: MoneyView | null;
  currency: string;
  mcc: string | null;
  narration: string | null;
  isActive: boolean;
  scanCount: number;
  expiresAt: string | null;
  consumedAt: string | null;
  createdAt: string;
}

/**
 * A decoded scan.
 *
 * `printedName` and `registeredName` are deliberately separate fields, and collapsing them would
 * hand an attacker the label. The first is chosen by whoever printed the code and proves nothing —
 * anyone can print "Pravaah Support" on a sticker. The second comes from the payee's bank and is the
 * one the payer must confirm.
 *
 * `payable` and `blockedReason` are the server's verdict rather than the client's. A screen that
 * decided for itself whether a scan was safe would have to duplicate sanctions screening, the
 * merchant blocklist, and the QR signature check.
 */
export interface ScannedQrView {
  payeeAddress: string;
  printedName: string | null;
  registeredName: string | null;
  bankName: string | null;
  reachable: boolean;
  amount: MoneyView | null;
  /** A static QR carries no amount: the payer types it, which is what makes it reusable. */
  amountEditable: boolean;
  currency: string;
  merchantCode: string | null;
  narration: string | null;
  isPravaahQr: boolean;
  kind: QrKind | null;
  signatureValid: boolean | null;
  payable: boolean;
  blockedReason: string | null;
}
