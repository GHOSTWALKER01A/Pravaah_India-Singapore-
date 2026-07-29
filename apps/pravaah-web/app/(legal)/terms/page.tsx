import type { Metadata } from "next";
import Link from "next/link";
import type { ReactElement } from "react";

import { SITE_CONFIG } from "@/lib/config/site";
import { ROUTES } from "@/lib/constants/routes";
import { pageMetadata } from "@/lib/seo";
import { DocumentShell, ReplaceBeforeLaunch } from "@/ui/layout/DocumentShell";

export const metadata: Metadata = pageMetadata({
  title: "Terms",
  description:
    "The agreement between you and MyPravaah: what we provide, what we ask of you, what we do not promise, and how either side ends it.",
  path: ROUTES.LEGAL.TERMS,
});

/**
 * Terms of use.
 *
 * The legal contract, kept separate from Rules so that neither has to
 * compromise: this one can be precise, that one can be readable.
 *
 * Unverified specifics — entity, address, governing law, dispute forum — are
 * marked rather than invented. PRODUCT.md records all of them as undecided, and
 * a governing-law clause guessed by a machine is worse than an absent one.
 */
export default function TermsPage(): ReactElement {
  const { entityName, registeredAddress, grievanceEmail } = SITE_CONFIG.legal;

  return (
    <DocumentShell
      title="Terms"
      reference="Terms of use · Series A"
      standfirst="The agreement between you and MyPravaah. What we provide, what we ask of you, what we explicitly do not promise, and how either side ends it."
    >
      <ReplaceBeforeLaunch>
        This document is not yet enforceable and must not be published as final.
        It has no named contracting entity ({entityName}), no registered address
        ({registeredAddress}), no grievance contact ({grievanceEmail}), and no
        governing-law or dispute-resolution clause — those are legal choices,
        not drafting ones, and they belong to you and your counsel. Everything
        below is an accurate description of how the product behaves and is a
        starting point for that review, nothing more.
      </ReplaceBeforeLaunch>

      <h2>1. What this covers</h2>
      <p>
        These terms govern your use of the MyPravaah website and the MyPravaah mobile
        application. By using either, you agree to them. If you do not, do not use
        the service — nothing here requires you to.
      </p>

      <h2>2. What MyPravaah provides</h2>
      <p>MyPravaah is a financial reputation service. It:</p>
      <ul>
        <li>verifies your identity against authoritative sources;</li>
        <li>
          with consent you grant separately, collects financial information about
          you through India&rsquo;s regulated Account Aggregator framework;
        </li>
        <li>
          and, as those capabilities are released, produces an explainable score
          and issues it to you as a credential you hold and present.
        </li>
      </ul>
      <p>
        MyPravaah is not a bank, a lender, a credit bureau, or an insurer. We do not
        make lending decisions and we do not guarantee that any institution will
        accept your credential or act on it. What we provide is evidence; what
        another party does with that evidence is theirs to decide.
      </p>

      <h2>3. Eligibility</h2>
      <p>
        You must be at least 18, verifiable on at least one side of the
        India&ndash;Singapore corridor, acting for yourself, and not subject to
        sanctions. The operating detail is set out in{" "}
        <Link href={ROUTES.LEGAL.RULES}>Rules</Link>, which forms part of these
        terms.
      </p>

      <h2>4. What we ask of you</h2>
      <ul>
        <li>
          Give accurate information. Every downstream step depends on the
          identity established at the start, so a false statement there
          invalidates everything after it.
        </li>
        <li>
          Apply for yourself, using your own documents and your own accounts.
        </li>
        <li>
          Keep control of the device and credentials you use to reach your
          account, and tell us if either is compromised.
        </li>
        <li>
          Do not attempt to impersonate anyone, submit documents that are not
          yours, or manufacture a credential that misrepresents your position.
        </li>
        <li>
          Do not attack, overload, or attempt to circumvent the service.
          Good-faith security research is welcome and is covered separately under{" "}
          <Link href={ROUTES.SECURITY}>Security</Link>.
        </li>
      </ul>

      <h2>5. Consent and your data</h2>
      <p>
        Verification does not give us access to your financial history; a separate
        consent does, and it is genuinely optional. Every consent names the data,
        the purpose, the period covered and the retention window, and you see all
        four before approving. Data is used only for the purpose you approved.
      </p>
      <p>
        <strong>
          You may revoke any consent at any time, and the data collected under it
          is deleted immediately.
        </strong>{" "}
        You accept that revoking removes the basis for any score or credential
        that depended on that data. Full detail is in{" "}
        <Link href={ROUTES.LEGAL.PRIVACY}>Privacy</Link>.
      </p>

      <h2>6. Third parties</h2>
      <p>
        Parts of the service depend on providers outside our control — identity
        verification services, DigiLocker, Singpass, Account Aggregators, and the
        banks that hold your data. Where one of those is unavailable or returns an
        incorrect result, we will tell you what happened and what you can do. We
        are not liable for their independent acts, and they are not our agents.
      </p>

      <h2>7. Availability, and what is not a live service</h2>
      <p>
        All eight modules of MyPravaah — identity, consent and data collection,
        scoring, credential issuance, verification, money movement, insurance and
        the fraud engine — are built and exercised end to end. That is a statement
        about the software and about nothing else.
      </p>
      <p>
        <strong>
          MyPravaah does not currently operate as a licensed financial service.
        </strong>{" "}
        We are not a licensed Financial Information User, hold no payments licence
        or payment service provider agreement, and have no insurance risk carrier
        on paper. Those integrations run against provider sandboxes. No real money
        has moved through the service, and no insurance policy issued by it is in
        force. The mobile application is not published in any app store at the date
        of these terms.
      </p>
      <p>
        Nothing on this site or in the app should be read as an offer of a
        regulated service, a promise of credit, or a policy of insurance.
      </p>
      <p>
        We do not promise uninterrupted availability. We may change, suspend or
        withdraw features, and where a change materially affects you we will tell
        you before it takes effect.
      </p>

      <h2>8. No financial advice</h2>
      <p>
        Nothing MyPravaah produces is financial, legal or tax advice. A score is a
        description of evidence, not a recommendation, and it does not entitle you
        to credit, tenancy, insurance or any other outcome.
      </p>

      <h2>9. Fees</h2>
      <ReplaceBeforeLaunch>
        No pricing has been decided, so no fee terms are stated here. Do not
        launch with this section empty — an absent fee clause is not the same as
        a free service, and the difference matters in a dispute.
      </ReplaceBeforeLaunch>

      <h2>10. Intellectual property</h2>
      <p>
        The service, its software, and the MyPravaah name and marks remain ours.
        Your data remains yours; verifying and processing it under your consent
        gives us no ownership of it. A credential we issue about you is yours to
        present.
      </p>

      <h2>11. Suspension and termination</h2>
      <p>
        You may stop using MyPravaah at any time, revoke your consents, and ask for
        deletion of everything we are not legally required to retain. We may
        suspend or close an account where we have reasonable grounds to believe it
        involves impersonation, fraud, sanctions exposure, or a legal obligation
        that compels us. Where we are permitted to tell you the reason, we will.
      </p>

      <h2>12. Liability</h2>
      <ReplaceBeforeLaunch>
        Limitation of liability, indemnity, governing law, and
        dispute-resolution forum are deliberately not drafted here. These are the
        clauses that decide what happens when something goes badly wrong, and
        they must be written for the entity and jurisdictions you actually
        choose. Have counsel draft them.
      </ReplaceBeforeLaunch>

      <h2>13. Changes to these terms</h2>
      <p>
        We may update these terms. Where a change materially affects you, we will
        notify you before it takes effect rather than relying on you rereading
        this page. Continuing to use the service after that point means you accept
        the change.
      </p>

      <h2>14. Complaints</h2>
      <ReplaceBeforeLaunch>
        A named grievance officer and a contact address are required before
        launch. Populate <code>SITE_CONFIG.legal</code> in{" "}
        <code>lib/config/site.ts</code>.
      </ReplaceBeforeLaunch>

      <p>
        See also: <Link href={ROUTES.LEGAL.RULES}>Rules</Link> for the
        plain-English version of how the product operates, and{" "}
        <Link href={ROUTES.LEGAL.PRIVACY}>Privacy</Link> for data handling.
      </p>
    </DocumentShell>
  );
}
