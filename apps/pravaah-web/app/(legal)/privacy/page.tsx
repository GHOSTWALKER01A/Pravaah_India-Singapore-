import type { Metadata } from "next";
import Link from "next/link";
import type { ReactElement } from "react";

import { SITE_CONFIG } from "@/lib/config/site";
import { ROUTES } from "@/lib/constants/routes";
import { pageMetadata } from "@/lib/seo";
import { DocumentShell, ReplaceBeforeLaunch } from "@/ui/layout/DocumentShell";

export const metadata: Metadata = pageMetadata({
  title: "Privacy",
  description:
    "What Pravaah collects, why, how long it is kept, who it is shared with, and exactly how you revoke consent and have your data deleted.",
  path: ROUTES.LEGAL.PRIVACY,
});

/**
 * Privacy.
 *
 * Written from the mechanisms that actually exist (PRODUCT.md §Operating
 * Context) rather than from a template. Every unverified specific — entity,
 * address, DPO contact — surfaces as a visible ReplaceBeforeLaunch block
 * instead of being invented or silently omitted.
 */
export default function PrivacyPage(): ReactElement {
  const { entityName, registeredAddress, privacyEmail, grievanceOfficer } =
    SITE_CONFIG.legal;

  return (
    <DocumentShell
      title="Privacy"
      reference="Privacy notice · Series A"
      standfirst="This notice explains what we collect, why we are allowed to collect it, how long we hold it, and how you take it back. It is written to be read, not to be survived."
    >
      <ReplaceBeforeLaunch>
        This notice does not yet name a legal entity, a registered address, or a
        data-protection contact, because those have not been finalised. The
        values live in <code>lib/config/site.ts</code> under{" "}
        <code>SITE_CONFIG.legal</code> — filling them in updates every document
        on this site. Current placeholders: {entityName}, {registeredAddress},{" "}
        {privacyEmail}, {grievanceOfficer}. This notice should not be treated as
        final until they are replaced and a lawyer has reviewed it.
      </ReplaceBeforeLaunch>

      <h2>The short version</h2>
      <ul>
        <li>
          We collect identity data to prove you are who you say you are, and
          financial data only after you separately consent to it.
        </li>
        <li>
          Financial data reaches us through India&rsquo;s regulated Account
          Aggregator framework. We never ask for, store, or transmit your
          banking credentials.
        </li>
        <li>
          Every consent has a purpose and an expiry that you see before you
          agree. When it expires, the data is deleted automatically.
        </li>
        <li>
          <strong>You can revoke consent at any time and the data is deleted
          immediately.</strong>
        </li>
        <li>We do not sell your data. There is no advertising business here.</li>
      </ul>

      <h2>What we collect, and why</h2>

      <h3>Identity data</h3>
      <p>
        To verify you, we collect and process the following, depending on your
        corridor:
      </p>
      <ul>
        <li>
          <strong>PAN</strong> — the number you enter, and the name registered
          against it as returned by the verification provider.
        </li>
        <li>
          <strong>Aadhaar offline KYC</strong> — the record you release to us
          through DigiLocker. We receive what DigiLocker sends; we do not read
          your DigiLocker account.
        </li>
        <li>
          <strong>Bank account details</strong> — account number and IFSC, plus
          the account holder name your bank returns in response to a ₹1
          penny-drop.
        </li>
        <li>
          <strong>Singpass Myinfo</strong> — the fields you choose to release
          when you authorise the connection.
        </li>
        <li>
          <strong>A liveness capture and a face comparison result</strong> — a
          short selfie capture with a prompted movement, compared against your
          document photograph.
        </li>
        <li>
          <strong>Sanctions and PEP screening results</strong> — the outcome of
          screening your verified name against watchlists.
        </li>
      </ul>
      <p>
        The purpose is narrow and singular: establishing that you are a real,
        identifiable person, because nothing else in the product may run until
        that is true.
      </p>

      <h3>Financial data</h3>
      <p>
        Only after you are verified, and only after you separately approve a
        consent request, do we receive financial information — typically deposit
        account transactions, balances, and where relevant business or GST
        income. The request always names the data categories, the purpose, the
        period it covers, and how long we may retain it. You see all four before
        you approve anything.
      </p>

      <h3>What we do not collect</h3>
      <ul>
        <li>
          <strong>Your banking password, PIN, or net-banking credentials.</strong>{" "}
          There is no field for them anywhere in the product. Anyone asking you
          for these on our behalf is not us.
        </li>
        <li>Your contacts, photo library, SMS messages, or call logs.</li>
        <li>Data outside the scope of a consent you granted.</li>
      </ul>

      <h2>How financial data reaches us</h2>
      <p>
        Through the Account Aggregator framework, which exists specifically so
        that nobody has to share banking credentials. Three parties are
        involved:
      </p>
      <ul>
        <li>
          Your bank, which holds the data (the Financial Information Provider).
        </li>
        <li>
          Pravaah, which requests it (the Financial Information User).
        </li>
        <li>
          A licensed Account Aggregator, which brokers your permission and
          carries the data.
        </li>
      </ul>
      <p>
        Your bank encrypts the payload before it leaves. It travels through the
        aggregator sealed and is decrypted on our servers. The aggregator manages
        consent and carries the envelope; it is not able to read the contents.
        You approve or refuse the request on the aggregator&rsquo;s own screen,
        not on ours, and approval produces a signed consent artefact — evidence
        of what you agreed to that exists independently of anything we say.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Financial data is held only for the retention period stated in the
        consent you approved, and deletion when that period expires is performed
        by the system rather than by a person remembering to do it. Identity
        verification records are retained for as long as we are required to
        retain them by applicable financial regulation, and no longer.
      </p>
      <p>
        <strong>
          If you revoke a consent, the data collected under it is deleted
          immediately.
        </strong>{" "}
        Revocation is available to you at any time and does not require a reason.
      </p>

      <h2>Who we share it with</h2>
      <p>We share data only where it is necessary to do the thing you asked for:</p>
      <ul>
        <li>
          <strong>Verification providers</strong>, to perform the identity checks
          above. They receive only what their specific check requires.
        </li>
        <li>
          <strong>Account Aggregators</strong>, to broker your consent and carry
          encrypted data. They cannot read it.
        </li>
        <li>
          <strong>Institutions you choose to present a credential to.</strong>{" "}
          They receive the credential you present — not the underlying financial
          data behind it.
        </li>
        <li>
          <strong>Regulators, courts and law enforcement</strong>, where we are
          legally compelled.
        </li>
      </ul>
      <p>
        We do not sell your data, and we do not disclose it to advertisers or
        data brokers. There is no product here that would be improved by doing
        so.
      </p>

      <h2>Your rights</h2>
      <p>You can, at any time:</p>
      <ul>
        <li>See what consents are active and exactly what each one covers.</li>
        <li>Revoke any consent, which deletes the data collected under it.</li>
        <li>Ask for a copy of the personal data we hold about you.</li>
        <li>Ask us to correct data that is wrong.</li>
        <li>
          Ask for deletion, subject only to records we are legally required to
          retain — and we will tell you which those are.
        </li>
        <li>
          Complain to us, and escalate to the relevant data-protection authority
          if our answer does not satisfy you.
        </li>
      </ul>

      <h2>Cross-border transfer</h2>
      <p>
        Pravaah operates across the India&ndash;Singapore corridor, so data may
        be processed in either jurisdiction. Where data crosses a border, it does
        so under the protections required by the law of the jurisdiction it came
        from.
      </p>

      <h2>Automated decisions</h2>
      <p>
        Verification checks are automated, but a partial name mismatch is routed
        to a human reviewer rather than auto-rejected — names transliterate badly
        between scripts and legitimately vary between documents, and treating
        that as fraud would penalise exactly the people this product exists for.
        Scoring is not live yet; when it is, the score will arrive with the
        reasons behind it attached, and you will be told what they are.
      </p>

      <h2>Children</h2>
      <p>
        Pravaah is not for anyone under 18. We do not knowingly collect data
        from minors, and we delete it if we discover we have.
      </p>

      <h2>Changes to this notice</h2>
      <p>
        If we change it in a way that materially affects you, we will tell you
        before the change takes effect rather than quietly updating the date at
        the top.
      </p>

      <h2>Contact</h2>
      <ReplaceBeforeLaunch>
        A named data-protection contact and a grievance officer are required
        before launch. Until they are published here, use the contact route in{" "}
        <Link href={ROUTES.SECURITY}>Security</Link> for anything urgent.
      </ReplaceBeforeLaunch>

      <p>
        Related reading: the{" "}
        <Link href={ROUTES.LEGAL.RULES}>plain-English rules</Link> describe who
        can apply and what happens when a check fails.{" "}
        <Link href={ROUTES.SECURITY}>Security</Link> covers how the data is
        protected in transit and at rest.
      </p>
    </DocumentShell>
  );
}
