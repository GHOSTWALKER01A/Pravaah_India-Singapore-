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
    "What MyPravaah collects, why, how long it is kept, who it is shared with, and exactly how you revoke consent and have your data deleted.",
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
        <li>
          Your credential is issued to you and held on your device. We do not
          push it anywhere, and we do not run a directory an institution can
          query about you.
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

      <h3>Your score, and the reasons behind it</h3>
      <p>
        Your financial data is normalised into features &mdash; income
        steadiness, average balance, obligation history and similar &mdash; and a
        score is computed from them. We retain the score, the model version that
        produced it, the confidence and coverage figures, and the ranked reasons,
        because a score without its reasons is not something we are willing to
        serve you. Previous scores are kept so you can see your own history.
      </p>

      <h3>Protected attributes &mdash; only if you offer them</h3>
      <p>
        We cannot check whether the model treats people unfairly without knowing
        who was affected, and holding that information is itself a risk. So it is
        a <strong>separate, optional consent</strong>, never bundled into the
        main one: gender, an age band, and nationality, used only for bias
        auditing and never as an input to your score. The values are not readable
        back out &mdash; the app can learn which attributes are held, never what
        they say. Declining changes nothing about your score or your eligibility.
      </p>

      <h3>Your credential, and who you showed it to</h3>
      <p>
        When your passport is issued, a signing key is generated on your own
        device and never leaves it; we receive only its public half. We retain the
        credential record, its validity window, its revocation status, and a log
        of every presentation &mdash; who checked it, when, whether the check
        passed, and which claims you disclosed. That log exists for you: it is the
        only way to know afterwards what left your wallet.
      </p>

      <h3>Payments</h3>
      <p>
        If you send money we hold the transaction, the amount, the currency, the
        purpose you selected, the beneficiary details you entered, the exchange
        rate you were quoted, and the ledger entries recording what happened to
        your balance. Financial regulation requires payment records to be
        retained, so these are not deleted on request &mdash; a ledger you can
        erase is not a ledger, and it is also the document that answers you when a
        balance is disputed.
      </p>

      <h3>Insurance</h3>
      <p>
        If you request a quote we hold the underwriting inputs and the outcome,
        including the reason for a higher rate or a decline. If you file a claim
        we hold the claim, the documents you upload, and the decision with its
        reasoning.
      </p>

      <h3>Your devices, and security decisions</h3>
      <p>
        We record the devices you use, whether each reported an operating-system
        integrity problem such as being rooted, and when each was last seen. We
        also record every risk decision made about an action of yours &mdash;
        including the ones that let you through &mdash; so that you can read them.
        Where a signal involves an identifier such as a payment address or a
        mobile number, it is stored keyed and irreversible rather than in the
        clear.
      </p>
      <p>
        Confirming whether a SIM has recently been re-issued requires asking a
        mobile network. We ask about the number you gave us, and we receive only
        whether a re-issue occurred and when.
      </p>

      <h3>What we do not collect</h3>
      <ul>
        <li>
          <strong>Your banking password, PIN, or net-banking credentials.</strong>{" "}
          There is no field for them anywhere in the product. Anyone asking you
          for these on our behalf is not us.
        </li>
        <li>
          <strong>Your UPI PIN.</strong> It is entered in your bank&rsquo;s own
          secure component and never reaches us. Where the app asks for a PIN of
          its own, it says so in the same sentence.
        </li>
        <li>Your contacts, photo library, SMS messages, or call logs.</li>
        <li>Data outside the scope of a consent you granted.</li>
        <li>
          Protected attributes, unless you separately and explicitly offer them
          for bias auditing.
        </li>
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
          MyPravaah, which requests it (the Financial Information User).
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
        A score computed from data that has been deleted expires with it, and the
        product will tell you that it has rather than continuing to show a figure
        it can no longer justify.
      </p>
      <p>
        Two categories are deliberately outside that: <strong>payment and
        ledger records</strong>, which financial regulation requires us to retain,
        and <strong>identity verification outcomes</strong>, for the same reason.
        If you ask us to delete everything, we will tell you specifically which
        records we are keeping and under what obligation, rather than refusing in
        general terms.
      </p>
      <p>
        Revoking your <strong>passport</strong> is separate from revoking a
        consent, and stronger in one respect: it stops verifying for everyone,
        everywhere, immediately &mdash; including for anyone already holding a
        copy of it. The device key it was bound to is destroyed at the same time.
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
          They receive only the claims you ticked — not the underlying financial
          data behind them, and not the claims you withheld. What you withhold is
          reported to them as withheld rather than as a negative answer.
        </li>
        <li>
          <strong>Payment rails and their operators</strong>, when you send money.
          They receive what a transfer requires: the amount, the beneficiary
          details, and the purpose code the corridor demands.
        </li>
        <li>
          <strong>An insurance risk carrier</strong>, if and when one is on paper,
          for cover you have asked for. There is none today, which is why no
          policy is currently in force.
        </li>
        <li>
          <strong>A mobile network</strong>, to ask whether the SIM behind your
          number has recently been re-issued. We send the number and receive only
          that answer.
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
        <li>
          See every disclosure of your credential — who checked it, when, and
          which claims they received.
        </li>
        <li>
          Revoke the credential itself, which stops it verifying for everyone at
          once.
        </li>
        <li>
          See every security decision recorded about you, including the ones that
          allowed an action.
        </li>
        <li>
          Withdraw the optional protected-attribute consent, which deletes those
          attributes.
        </li>
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
        MyPravaah operates across the India&ndash;Singapore corridor, so data may
        be processed in either jurisdiction. Where data crosses a border, it does
        so under the protections required by the law of the jurisdiction it came
        from.
      </p>

      <h2>Automated decisions</h2>
      <p>
        Several things here are decided by software, and you are entitled to know
        which, and what recourse each one has.
      </p>
      <ul>
        <li>
          <strong>Verification checks are automated</strong>, but a partial name
          mismatch is routed to a human reviewer rather than auto-rejected — names
          transliterate badly between scripts and legitimately vary between
          documents, and treating that as fraud would penalise exactly the people
          this product exists for.
        </li>
        <li>
          <strong>Your score is computed by a model</strong>, and it is never
          served without its reasons. You are shown the factors driving it, ranked,
          and the specific changes that would raise it. If the data is too thin to
          say anything useful, you are told that instead of being given a number.
          The model version that produced any given score is recorded, so a score
          can always be traced to the thing that made it.
        </li>
        <li>
          <strong>Insurance pricing is automated.</strong> A higher rate arrives
          with the reason and with what would change it. A decline arrives as an
          explained outcome rather than an error.
        </li>
        <li>
          <strong>Risk decisions can delay an action</strong> — a payment, a
          claim, a sign-in, registering a device. Where that happens you may be
          asked to confirm it is you, or the action may be held for a person to
          look at. A hold is a delay and not an accusation: at any threshold worth
          setting, most held actions belong to people who have done nothing wrong,
          which is precisely why it is a delay.
        </li>
        <li>
          <strong>A human decides the consequential ones.</strong> Releasing a
          held payment, adjudicating a claim, and resolving a fraud case are all
          decisions a person makes. You can ask us to explain any of them and to
          reconsider.
        </li>
      </ul>

      <h2>Children</h2>
      <p>
        MyPravaah is not for anyone under 18. We do not knowingly collect data
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
