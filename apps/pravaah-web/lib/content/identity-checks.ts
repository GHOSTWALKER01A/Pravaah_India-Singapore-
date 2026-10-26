/**
 * The identity checks a person actually completes, in the order the product
 * enforces them.
 *
 * SOURCE OF TRUTH: `REQUIRED_CHECKS.INDIA` in apps/pravaah-rn/src/features/kyc/
 * flow.ts and `CHECK_META` in check-labels.ts, which themselves mirror the
 * backend kyc.state.ts. If the India flow changes there, change it here — this
 * page promises a sequence, so it must not drift from the one that ships.
 *
 * India only. The app and API still carry the Singapore (Singpass) and "both"
 * branches from the corridor build; they are retired from the product and are
 * deliberately not presented here. Removing them from flow.ts and kyc.state.ts
 * is tracked separately and does not change this sequence.
 */

export type CheckId =
  | "PAN"
  | "AADHAAR_OKYC"
  | "BANK_PENNY_DROP"
  | "LIVENESS"
  | "FACE_MATCH"
  | "SANCTIONS_PEP";

export interface Check {
  /** Matches CheckType in the app so the two can be diffed by eye. */
  id: CheckId;
  label: string;
  /** The one-line subtitle the app itself shows. */
  subtitle: string;
  /** What the applicant physically does. Written for a first-time reader. */
  action: string;
  /** What the check proves — the reason it exists in the chain. */
  proves: string;
  /** What the applicant needs in hand before starting. */
  needs: string;
  /** Realistic elapsed time for the step itself, not the whole queue. */
  duration: string;
}

export const CHECKS: Record<CheckId, Check> = {
  PAN: {
    id: "PAN",
    label: "PAN verification",
    subtitle: "Income-tax identity",
    action: "Enter your 10-character PAN.",
    proves:
      "That the tax identity is real and registered, and tells us the name recorded against it.",
    needs: "Your PAN number.",
    duration: "Under a minute",
  },
  AADHAAR_OKYC: {
    id: "AADHAAR_OKYC",
    label: "Aadhaar OKYC",
    subtitle: "DigiLocker offline KYC",
    action:
      "You are handed to DigiLocker, sign in there, and authorise the release of your Aadhaar record.",
    proves:
      "The government's own record of who you are — pulled from the source, not typed in by you.",
    needs: "An Aadhaar-linked mobile number for the DigiLocker OTP.",
    duration: "Two to three minutes",
  },
  BANK_PENNY_DROP: {
    id: "BANK_PENNY_DROP",
    label: "Bank account",
    subtitle: "Penny-drop name match",
    action:
      "Enter your account number and IFSC. We deposit ₹1; your bank replies with the account holder's name.",
    proves:
      "That the account is live and that you are the person who owns it. The ₹1 is ours, not yours.",
    needs: "Account number and IFSC code.",
    duration: "Under a minute",
  },
  LIVENESS: {
    id: "LIVENESS",
    label: "Liveness",
    subtitle: "Confirm you are a real person",
    action: "A short guided selfie — you will be asked to blink or turn your head.",
    proves:
      "That a living person is present right now, not a photograph of a photograph.",
    needs: "A front camera and reasonable light.",
    duration: "Thirty seconds",
  },
  FACE_MATCH: {
    id: "FACE_MATCH",
    label: "Face match",
    subtitle: "Selfie vs. document photo",
    action: "Nothing extra — the liveness capture is compared to your document photo.",
    proves: "That the person completing the checks is the person on the documents.",
    needs: "Nothing. Runs automatically after liveness.",
    duration: "Automatic",
  },
  SANCTIONS_PEP: {
    id: "SANCTIONS_PEP",
    label: "Sanctions & PEP",
    subtitle: "Watchlist screening",
    action:
      "Nothing — your verified name is screened against sanctions and politically-exposed-person lists.",
    proves:
      "That issuing you a receipt is lawful. Required of every regulated financial participant.",
    needs: "Nothing. Runs automatically.",
    duration: "Automatic",
  },
};

/** Order defines the on-boarding sequence. Mirrors REQUIRED_CHECKS.INDIA exactly. */
export const REQUIRED_CHECKS: readonly CheckId[] = [
  "PAN",
  "AADHAAR_OKYC",
  "BANK_PENNY_DROP",
  "LIVENESS",
  "FACE_MATCH",
  "SANCTIONS_PEP",
];

/** The sequence, resolved to its check records. */
export const SEQUENCE: readonly Check[] = REQUIRED_CHECKS.map((id) => CHECKS[id]);
