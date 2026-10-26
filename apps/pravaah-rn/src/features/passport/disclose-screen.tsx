import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError, passportService, sharesService } from '@/api';
import type { ClaimDescriptor, ShareReceipt, VerifierRequestDetail } from '@/api';
import {
  Button,
  Checkbox,
  Header,
  Icon,
  Legend,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Screen,
  Text,
  haptic,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Radius, Space, usePalette } from '@/theme';

import { Counterparty } from '@/features/shares/components/counterparty';
import { DisclosureList } from '@/features/shares/components/disclosure-list';
import { formatDate, isYesNoClaim } from '@/features/shares/share-meta';

import { signKeyBinding } from './holder-key';

/**
 * Why a share did not go through, in the terms the holder needs.
 *
 * `stopped` and `unavailable` are M7/M6 outcomes and are told apart from a generic error
 * on purpose: "a security check stopped this" and "a security check could not run" call
 * for opposite reactions (stop vs. try again), and both must say plainly that NOTHING
 * was shared — the one fact a person in front of a lender most needs to know.
 */
type ShareFailure =
  | { kind: 'stopped'; message: string; reasons: string[] }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string };

/**
 * Consent to disclose — the screen the whole module exists to make possible.
 *
 * A verifier asked for some claims. This is where the holder decides, claim by claim, what
 * actually leaves their phone. Three principles shape it:
 *
 *  1. NOTHING IS PRE-TICKED. A pre-selected list is not a choice, it is a default the user
 *     is asked to notice. Every box starts empty and the holder opts IN to each one.
 *  2. EVERY CLAIM IS EXPLAINED IN CONSEQUENCE TERMS. "Passport number" tells nobody
 *     anything; "your passport number, so a landlord abroad can tie your reputation to the
 *     document they already trust" is a decision a person can make. That copy comes from the
 *     backend catalogue, so it cannot drift from what is actually minted.
 *  3. DECLINING IS A FIRST-CLASS ACTION. It sits beside Share, not buried, and sharing
 *     nothing at all is permitted — an empty presentation still proves Pravaah issued a
 *     live passport to the holder of this device.
 *
 * M7 adds the organisation's VERIFIED identity (domain, type, retention promise) before any
 * checkbox, marks yes/no answers as what they are, and ends a share with the consent
 * receipt the holder can later withdraw.
 */
export function DiscloseScreen({ requestId }: { requestId: string }) {
  const p = usePalette();

  const [request, setRequest] = useState<VerifierRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'share' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<ShareFailure | null>(null);
  const [done, setDone] = useState<{
    shared: string[];
    withheld: string[];
    receipt: ShareReceipt | null;
  } | null>(null);

  const load = useCallback(async (): Promise<VerifierRequestDetail | null> => {
    try {
      const detail = await passportService.request(requestId);
      setRequest(detail);
      return detail;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this request.');
      return null;
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  const claims = request?.claims ?? [];
  const held = claims.filter((claim) => claim.held);
  const notHeld = claims.filter((claim) => !claim.held);
  const profile = request?.verifierProfile ?? null;
  // A registered organisation is asking (as opposed to a person scanning a code). Only
  // these shares produce a consent receipt.
  const institution = !!request && !request.requester;

  const toggle = (claim: string) => {
    haptic.select();
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(claim)) next.delete(claim);
      else next.add(claim);
      return next;
    });
  };

  /**
   * The receipt for a share that just happened.
   *
   * The server issues it inside the approval, so it normally exists immediately; one short
   * retry covers the case where issuance fell to the backend's reconciliation sweep. A
   * missing receipt never blocks the "shared" screen — it only changes one line on it.
   */
  const fetchReceipt = async (): Promise<ShareReceipt | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await sharesService.byRequest(requestId);
      } catch (caught) {
        if (!(caught instanceof ApiError) || caught.status !== 404) return null;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    return null;
  };

  const finish = async (shared: string[], withheld: string[]) => {
    haptic.commit();
    setDone({ shared, withheld, receipt: institution ? await fetchReceipt() : null });
  };

  /**
   * Share.
   *
   * Two steps, in this order and no other: ask the server for the exact bytes that will be
   * sent (`sd_hash`), then sign THOSE bytes on this device. Signing anything else would
   * produce a proof that fails at the verifier — the key binding commits to the precise
   * disclosure set, which is what stops the claims being swapped after the holder agreed.
   */
  const share = async () => {
    if (!request?.credentialId) return;
    setBusy('share');
    setError(null);
    setFailure(null);
    const revealClaims = [...selected];
    try {
      const material = await passportService.signingMaterial({
        credentialId: request.credentialId,
        audience: request.audience,
        nonce: request.nonce,
        revealClaims,
      });

      const kbJwt = await signKeyBinding({
        audience: request.audience,
        nonce: request.nonce,
        sdHash: material.sdHash,
      });

      const result = await passportService.approve(requestId, {
        credentialId: request.credentialId,
        revealClaims,
        kbJwt,
      });

      await finish(result.disclosedClaims, result.withheldClaims);
    } catch (caught) {
      haptic.refused();
      await handleShareFailure(caught, revealClaims);
    } finally {
      setBusy(null);
    }
  };

  const handleShareFailure = async (caught: unknown, revealClaims: string[]) => {
    if (!(caught instanceof ApiError)) {
      setFailure({ kind: 'error', message: 'Could not share your passport. Nothing was shared.' });
      return;
    }

    // Refused by a check in front of the share (M7's partner gate, M6's risk engine).
    if (caught.status === 403) {
      setFailure({ kind: 'stopped', message: caught.message, reasons: caught.reasons });
      return;
    }
    if (caught.status === 503) {
      setFailure({ kind: 'unavailable', message: caught.message });
      return;
    }

    /**
     * The request closed (410), or the answer never came back (network drop / 5xx).
     *
     * For the second case the share MAY have gone through — the phone just never heard.
     * Re-reading the request is the only honest way to know, and it turns "an error
     * occurred" into either the receipt the holder earned or a clear "nothing was sent".
     */
    const uncertain = caught.status === 0 || (caught.status ?? 0) >= 500;
    if (caught.status === 410 || uncertain) {
      const fresh = await load();
      if (fresh && (fresh.status === 'APPROVED' || fresh.status === 'CONSUMED')) {
        const withheld = fresh.claims
          .map((claim) => claim.claim)
          .filter((claim) => !revealClaims.includes(claim));
        await finish(revealClaims, withheld);
        return;
      }
      if (fresh && !fresh.open) return; // the closed-state notice explains it
      if (fresh && fresh.status === 'PENDING') {
        // Re-read confirms it: still unanswered, so nothing left the phone.
        setFailure({
          kind: 'unavailable',
          message: `${caught.message} Nothing was shared — the request is still open.`,
        });
        return;
      }
    }

    setFailure({
      kind: 'error',
      message: `${caught.message}${uncertain ? '' : ' Nothing was shared.'}`,
    });
  };

  const decline = async () => {
    setBusy('decline');
    setError(null);
    setFailure(null);
    try {
      await passportService.decline(requestId);
      // `refused`, not `destroy`: declining is saying no, not destroying anything. The heavy
      // haptic is reserved for revoking a passport.
      haptic.refused();
      router.back();
    } catch (caught) {
      // A request that closed underneath the holder needs no "decline" — show why it closed.
      if (caught instanceof ApiError && caught.status === 410) {
        await load();
      } else {
        setError(
          caught instanceof ApiError ? caught.message : 'Could not decline this request.',
        );
      }
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <Screen>
        <Header title="Verification request" />
        <ListSkeleton rows={5} label="Loading this request" />
      </Screen>
    );
  }

  if (!request) {
    return (
      <Screen>
        <Header title="Verification request" />
        <Notice tone="error" action="Try again" onAction={() => void load()}>
          {error ?? 'This request could not be found.'}
        </Notice>
      </Screen>
    );
  }

  const verifierName = profile?.name ?? request.verifier;

  // ── the receipt ──────────────────────────────────────────────────────────
  if (done) {
    const receipt = done.receipt;
    return (
      <Screen
        footer={
          <View style={styles.footer}>
            {receipt ? (
              <Button
                label="View consent receipt"
                variant="secondary"
                icon="receipt"
                onPress={() => router.replace(ROUTES.PASSPORT.SHARE(receipt.id))}
              />
            ) : null}
            <Button label="Done" onPress={() => router.back()} />
          </View>
        }
      >
        <Header title="Shared" />
        <View style={styles.sheet}>
          <Notice tone="cleared" title={`${verifierName} has your answer`}>
            They can verify it came from Pravaah and belongs to this device, and they can
            see nothing beyond what you ticked.
          </Notice>

          <DisclosureList
            shared={done.shared.map((claim) => ({
              claim,
              label: labelFor(request.claims, claim),
            }))}
            questions={receipt?.predicatesAnswered ?? []}
            withheld={done.withheld.map((claim) => ({
              claim,
              label: labelFor(request.claims, claim),
            }))}
          />

          {institution ? (
            <View style={[styles.fine, { borderTopColor: p.rule }]}>
              <Icon name="receipt" size={13} color={p.inkFaint} weight={1.3} />
              <Micro style={styles.fineText}>
                {receipt
                  ? `A consent receipt is saved in “Shared with organisations”. ${verifierName} may keep this until ${formatDate(receipt.deletesOn)}, and you can withdraw it there at any time.`
                  : `Your consent receipt will appear in “Shared with organisations” shortly. You can withdraw this share there at any time.`}
              </Micro>
            </View>
          ) : null}
        </View>
      </Screen>
    );
  }

  // ── the ask ──────────────────────────────────────────────────────────────
  const closed = !request.open;
  const closedCopy = closedNotice(request, verifierName);

  return (
    <Screen
      footer={
        closed ? (
          <Button label="Close" onPress={() => router.back()} />
        ) : (
          <View style={styles.footer}>
            {/* "Approve" for a person, "Share" for an institution — the same action, named
                the way each situation is actually spoken about. Both still say the COUNT,
                because the number of things leaving is the fact the button must not hide. */}
            <Button
              label={
                selected.size === 0
                  ? request.requester
                    ? 'Approve — show them nothing but my passport'
                    : 'Share nothing but proof of my passport'
                  : `${request.requester ? 'Approve' : 'Share'} ${selected.size} ${selected.size === 1 ? 'detail' : 'details'}`
              }
              loading={busy === 'share'}
              disabled={busy !== null || !request.credentialId || failure?.kind === 'stopped'}
              onPress={() => void share()}
              hint="Your device signs this share. It cannot be reused by anyone else or at any other verifier."
            />
            <Button
              label={request.requester ? 'Reject' : 'Decline'}
              variant="destructive"
              loading={busy === 'decline'}
              disabled={busy !== null}
              onPress={() => void decline()}
            />
          </View>
        )
      }
    >
      <Header title="Verification request" />

      <View style={styles.sheet}>
        {error ? <Notice tone="error">{error}</Notice> : null}

        {failure ? <FailureNotice failure={failure} onRetry={() => void share()} /> : null}

        {closedCopy ? (
          <Notice tone="caution" title={closedCopy.title}>
            {closedCopy.body}
          </Notice>
        ) : null}

        {!request.credentialId && !closed ? (
          <Notice tone="caution" title="You have no live passport">
            Issue your passport first, then ask {verifierName} to try again.
          </Notice>
        ) : null}

        {/* Who is asking, and why — in their words, before any checkbox. */}
        <Panel>
          <Legend>Who is asking</Legend>
          {request.requester ? (
            /*
              A PERSON scanned your code.

              Rendered differently from an institution, and the difference is not cosmetic. A
              registered partner is accountable — it has a contract, an audit trail and a name
              it cannot change. The person holding a phone in front of you is whoever they
              appear to be, and the honest way to present that is to lead with whether their
              identity was ever checked at all.
            */
            <>
              <View style={styles.asker}>
                <Icon
                  name={request.requester.identityVerified ? 'verify' : 'alert'}
                  size={20}
                  color={request.requester.identityVerified ? p.cleared : p.carmine}
                  weight={1.6}
                />
                <View style={styles.askerText}>
                  <Text role="title">
                    {request.requester.name ?? 'An unverified Pravaah user'}
                  </Text>
                  <Micro tone="dim">
                    {request.requester.identityVerified
                      ? `Identity verified · ${countryName(request.requester.country)}`
                      : `Identity NOT verified · ${countryName(request.requester.country)}`}
                  </Micro>
                </View>
              </View>
              {!request.requester.identityVerified ? (
                <Micro tone="carmine">
                  They have not completed verification, so Pravaah cannot vouch for who they
                  are. Only continue if you know the person in front of you.
                </Micro>
              ) : (
                <Micro tone="dim">
                  This is the name on their own verified identity documents, not one they
                  typed.
                </Micro>
              )}
              <Text role="bodySm" style={styles.purpose}>
                {request.purpose}
              </Text>
            </>
          ) : profile ? (
            /*
              A registered ORGANISATION, as PRAVAAH vetted it (M7). The verified domain and the
              retention promise are shown BEFORE the claim list, because they are what the
              holder should check against the letter or website in front of them — a
              lookalike can copy a name, not the domain an admin approved.
            */
            <View style={styles.org}>
              <Counterparty
                name={profile.name}
                domain={profile.domain}
                type={profile.type}
                country={profile.country}
                approved={profile.approved}
                trustLevel={profile.trustLevel}
                retentionDays={profile.retentionDays}
              />
              <Text role="bodySm" style={styles.purpose}>
                {request.purpose}
              </Text>
            </View>
          ) : (
            <>
              <Text role="title">{request.verifier}</Text>
              {request.verifierCountry ? (
                <Micro tone="dim">Operating in {request.verifierCountry}</Micro>
              ) : null}
              <Text role="bodySm" style={styles.purpose}>
                {request.purpose}
              </Text>
            </>
          )}
        </Panel>

        <View style={styles.claims}>
          <Legend>What they asked for</Legend>
          <Micro>
            Nothing is shared until you tick it. You may share less than they asked, or
            nothing at all.
          </Micro>

          {held.map((claim) => (
            <ClaimChoice
              key={claim.claim}
              claim={claim}
              checked={selected.has(claim.claim)}
              disabled={closed || busy !== null}
              onToggle={() => toggle(claim.claim)}
            />
          ))}

          {/* Requested but absent from this credential. Shown greyed rather than hidden:
              "your passport does not carry this" is actionable, a missing row is a mystery. */}
          {notHeld.map((claim) => (
            <View
              key={claim.claim}
              style={[styles.absent, { borderColor: p.rule, backgroundColor: p.groundSunk }]}
            >
              <Icon name="dash" size={14} color={p.inkFaint} weight={1.6} />
              <View style={styles.absentText}>
                <Text role="bodySmMedium" tone="dim">
                  {claim.label}
                </Text>
                <Micro>Your passport does not carry this, so it cannot be shared.</Micro>
              </View>
            </View>
          ))}
        </View>

        <View style={[styles.fine, { borderTopColor: p.rule }]}>
          <Icon name="lock" size={13} color={p.inkFaint} weight={1.3} />
          <Micro style={styles.fineText}>
            Anything you do not tick stays mathematically hidden — {verifierName} receives a
            one-way fingerprint of it, not the value. This share is signed for them alone and
            expires, so it cannot be replayed anywhere else.
          </Micro>
        </View>
      </View>
    </Screen>
  );
}

/**
 * Why a request can no longer be answered — each cause worded as what actually happened.
 * Null while the request is open.
 */
function closedNotice(
  request: VerifierRequestDetail,
  verifierName: string,
): { title: string; body: string } | null {
  if (request.verifierProfile && !request.verifierProfile.approved) {
    return {
      title: 'This organisation can no longer ask',
      body: `Pravaah has suspended ${verifierName}, so this request cannot be answered and nothing will be shared with them.`,
    };
  }
  if (request.open) return null;
  switch (request.status) {
    case 'CANCELLED':
      return {
        title: `${verifierName} cancelled this request`,
        body: 'Nothing was shared. If you still need to prove your reputation to them, ask them to start again.',
      };
    case 'DECLINED':
      return { title: 'You declined this request', body: 'Nothing was shared.' };
    case 'APPROVED':
    case 'CONSUMED':
      return {
        title: 'You already answered this request',
        body: 'What you shared is in your history. A request can only be answered once.',
      };
    default:
      return {
        title: 'This request has closed',
        body: `Ask ${verifierName} to start a new one. Requests expire quickly on purpose — an open challenge is a window somebody else could use.`,
      };
  }
}

function FailureNotice({ failure, onRetry }: { failure: ShareFailure; onRetry: () => void }) {
  if (failure.kind === 'stopped') {
    return (
      <Notice tone="error" title="This share was stopped">
        {failure.message}
        {failure.reasons.length ? `\n\n${failure.reasons.map((r) => `• ${r}`).join('\n')}` : ''}
        {'\n\nIf this was not you, revoke your passport from the wallet.'}
      </Notice>
    );
  }
  if (failure.kind === 'unavailable') {
    return (
      <Notice tone="caution" title="Nothing was shared" action="Try again" onAction={onRetry}>
        {failure.message}
      </Notice>
    );
  }
  return <Notice tone="error">{failure.message}</Notice>;
}

/**
 * One claim, as a decision rather than a field name.
 *
 * `whyAsked` sits under the label because it is the only thing that makes a tick
 * meaningful, and HIGH-sensitivity claims are marked so the eye reaches them first — a
 * passport number and a "Good or better" boolean should not read as equivalent asks.
 * Yes/no claims are marked too, from the other side: the most reassuring fact about them
 * is how little they reveal.
 */
function ClaimChoice({
  claim,
  checked,
  disabled,
  onToggle,
}: {
  claim: ClaimDescriptor;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const p = usePalette();
  const sensitive = claim.sensitivity === 'HIGH';
  const yesNo = isYesNoClaim(claim.claim);

  return (
    <View
      style={[
        styles.claim,
        {
          borderColor: checked ? p.field : sensitive ? p.carmine : p.rule,
          backgroundColor: checked ? p.fieldWash : p.panel,
        },
      ]}
    >
      <Checkbox
        checked={checked}
        onChange={disabled ? () => undefined : onToggle}
        label={`${claim.label}. ${yesNo ? 'A yes or no answer only. ' : ''}${claim.detail} ${claim.whyAsked}`}
      >
        <View style={styles.claimText}>
          <View style={styles.claimHead}>
            <Text role="bodyMedium">{claim.label}</Text>
            {sensitive ? (
              <Micro tone="carmine" style={styles.flag}>
                Sensitive
              </Micro>
            ) : yesNo ? (
              <Micro tone="latent" style={styles.flag}>
                Yes / no
              </Micro>
            ) : null}
          </View>
          <Micro tone="dim">
            {yesNo
              ? 'They learn only yes or no — never your score, never your band.'
              : claim.detail}
          </Micro>
          <Micro>{claim.whyAsked}</Micro>
        </View>
      </Checkbox>
    </View>
  );
}

/** `INDIA` → `India`. The credential's enum is not a word anybody says. */
function countryName(country: string): string {
  if (country === 'INDIA') return 'India';
  if (country === 'SINGAPORE') return 'Singapore';
  if (country === 'BOTH') return 'India and Singapore';
  return country;
}

function labelFor(claims: ClaimDescriptor[], claim: string): string {
  return claims.find((candidate) => candidate.claim === claim)?.label ?? claim;
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl, paddingTop: Space.sm },
  purpose: { marginTop: Space.xs },
  org: { gap: Space.xs, marginTop: Space.sm },
  asker: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  askerText: { flex: 1, gap: 1 },
  claims: { gap: Space.sm },
  claim: {
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.lg,
  },
  claimText: { flex: 1, gap: 2 },
  claimHead: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  flag: { textTransform: 'uppercase', letterSpacing: 0.6 },
  absent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
  },
  absentText: { flex: 1, gap: 1 },
  footer: { gap: Space.sm },
  fine: {
    flexDirection: 'row',
    gap: Space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.lg,
  },
  fineText: { flex: 1 },
});
