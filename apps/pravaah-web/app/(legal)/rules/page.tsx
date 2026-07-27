import type { Metadata } from "next";
import Link from "next/link";
import type { ReactElement } from "react";

import { ROUTES } from "@/lib/constants/routes";
import { pageMetadata } from "@/lib/seo";
import { DocumentShell } from "@/ui/layout/DocumentShell";

export const metadata: Metadata = pageMetadata({
  title: "Rules",
  description:
    "The plain-English rules of Pravaah: who can apply, what is required on each corridor, what happens when a check fails, how long data lives, and what you can always do.",
  path: ROUTES.LEGAL.RULES,
});

/**
 * Rules — the product rules, in plain English.
 *
 * Deliberately separate from Terms. Terms is the contract; this is the set of
 * operating rules a person needs in order to know where they stand. Every rule
 * here traces to enforced behaviour in the product, not to policy aspiration.
 */
export default function RulesPage(): ReactElement {
  return (
    <DocumentShell
      title="Rules"
      reference="Operating rules · Series A"
      standfirst="The rules of the product in plain English — who can apply, what is required, what happens when something fails, and what you can always do. Not the legal contract; that is Terms."
    >
      <h2>Who can apply</h2>
      <ul>
        <li>You must be 18 or older.</li>
        <li>
          You must be verifiable on at least one side of the
          India&ndash;Singapore corridor: Indian identity documents and an Indian
          bank account, or a Singpass account. Both is stronger than either.
        </li>
        <li>
          You must apply for yourself. A Pravaah passport is a statement about
          one person, and it cannot be created on someone else&rsquo;s behalf.
        </li>
        <li>
          You must not be subject to sanctions. This is a legal constraint on us,
          not a discretionary judgement about you.
        </li>
      </ul>

      <h2>Rule 1 — Identity comes first, always</h2>
      <p>
        No financial data is requested until every required identity check has
        cleared. This is enforced in the system rather than left to policy: an
        unverified profile cannot reach the consent step at all. If the first
        link in the chain is wrong, everything built on it is worthless, so there
        is no way to skip it.
      </p>

      <h2>Rule 2 — The checks differ by corridor, and the order is fixed</h2>
      <p>
        India requires six checks: PAN, Aadhaar offline KYC via DigiLocker, a
        bank penny-drop, liveness, face match, and sanctions screening.
        Singapore requires four: Singpass Myinfo, liveness, face match, and
        sanctions screening. Applying on both sides means seven.
      </p>
      <p>
        You move through them in order. A check that has not cleared keeps you on
        that step — the flow never advances past an unverified check, so a failed
        PAN does not become a verified Aadhaar. The full sequence is on{" "}
        <Link href={ROUTES.HOW_TO_APPLY}>How to apply</Link>.
      </p>

      <h2>Rule 3 — A near-miss goes to a person, not to a rejection</h2>
      <p>
        Names transliterate badly between scripts, and initials, ordering and
        spelling legitimately differ between a PAN, a bank record and a passport.
        A partial name mismatch is routed to a human reviewer. It does not
        auto-reject, and you do not have to argue your way past a machine.
      </p>
      <p>
        While a case is in review, nothing is required from you. You are told when
        it resolves.
      </p>

      <h2>Rule 4 — Verification grants us nothing</h2>
      <p>
        Being verified means we know who you are. It does not give us access to
        your financial history. That requires a separate consent, granted by you,
        after verification. Two distinct decisions, and the second one is
        genuinely optional.
      </p>

      <h2>Rule 5 — Every consent is scoped, purposed and time-boxed</h2>
      <p>A consent request always states four things, and you see all four before you approve:</p>
      <ul>
        <li>
          <strong>What</strong> — which data categories are being requested.
        </li>
        <li>
          <strong>Why</strong> — the purpose the data may be used for.
        </li>
        <li>
          <strong>Over what period</strong> — the historical window it covers.
        </li>
        <li>
          <strong>For how long</strong> — the retention period after which it is
          deleted.
        </li>
      </ul>
      <p>
        Data may only be used for the purpose you approved. A consent granted for
        a credit assessment is not a licence to use the same data for something
        else.
      </p>

      <h2>Rule 6 — Data expires on its own</h2>
      <p>
        When the retention period you agreed to ends, the data is deleted. The
        system performs the deletion; it does not depend on you asking or on us
        remembering. This is the default behaviour, not a setting you have to
        find.
      </p>

      <h2>Rule 7 — Revocation is immediate and unconditional</h2>
      <p>
        You can revoke any consent at any time, without giving a reason, and the
        data collected under it is deleted immediately. You do not need to email
        anyone, close your account, or wait for a review.
      </p>
      <p>
        Revoking has a real consequence, and it is fair that you know it: a score
        or credential that depended on the revoked data can no longer be
        supported by it. That is the trade, and it is yours to make.
      </p>

      <h2>Rule 8 — You hold the credential</h2>
      <p>
        When the passport is issued, it is issued to you. You choose who sees it
        and when. We do not operate a directory that lets institutions look you
        up without your involvement.
      </p>

      <h2>Rule 9 — We never ask for banking credentials</h2>
      <p>
        Not your password, not your net-banking PIN, not an OTP read aloud to a
        person. There is no field for any of them anywhere in the product,
        because the Account Aggregator rail exists so that nobody needs one.
        Treat anyone asking as an impostor, regardless of what they claim.
      </p>

      <h2>Rule 10 — We do not overstate what is built</h2>
      <p>
        Identity verification and consented data collection work end to end
        today. Scoring, the issued passport, partner verification, money movement
        and insurance are still being built, and are labelled as such everywhere
        they appear on this site. The mobile app is not published in any app
        store. If you find one claiming to be Pravaah today, it is not ours.
      </p>

      <h2>What you can always do</h2>
      <ul>
        <li>See exactly which consents are active and what each one covers.</li>
        <li>Revoke any consent, immediately, without a reason.</li>
        <li>Ask for a copy of what we hold about you.</li>
        <li>Ask us to correct something that is wrong.</li>
        <li>Stop, at any point, and be no worse off than before you started.</li>
      </ul>

      <p>
        The full legal agreement is in <Link href={ROUTES.LEGAL.TERMS}>Terms</Link>.
        Data handling in detail is in{" "}
        <Link href={ROUTES.LEGAL.PRIVACY}>Privacy</Link>. How the credential
        resists forgery is in <Link href={ROUTES.SECURITY}>Security</Link>.
      </p>
    </DocumentShell>
  );
}
