import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError, passportService } from '@/api';
import type { ClaimDescriptor, VerifierRequestDetail } from '@/api';
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
import { Radius, Space, usePalette } from '@/theme';

import { signKeyBinding } from './holder-key';

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
 */
export function DiscloseScreen({ requestId }: { requestId: string }) {
  const p = usePalette();

  const [request, setRequest] = useState<VerifierRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'share' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ shared: string[]; withheld: string[] } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const detail = await passportService.request(requestId);
        if (alive) setRequest(detail);
      } catch (caught) {
        if (alive) {
          setError(
            caught instanceof ApiError
              ? caught.message
              : 'Could not load this request.',
          );
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [requestId]);

  const claims = request?.claims ?? [];
  const held = claims.filter((claim) => claim.held);
  const notHeld = claims.filter((claim) => !claim.held);

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
    try {
      const revealClaims = [...selected];

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

      haptic.commit();
      setDone({ shared: result.disclosedClaims, withheld: result.withheldClaims });
    } catch (caught) {
      haptic.refused();
      setError(
        caught instanceof ApiError ? caught.message : 'Could not share your passport.',
      );
    } finally {
      setBusy(null);
    }
  };

  const decline = async () => {
    setBusy('decline');
    setError(null);
    try {
      await passportService.decline(requestId);
      // `refused`, not `destroy`: declining is saying no, not destroying anything. The heavy
      // haptic is reserved for revoking a passport.
      haptic.refused();
      router.back();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not decline this request.',
      );
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
        <Notice tone="error">{error ?? 'This request could not be found.'}</Notice>
      </Screen>
    );
  }

  // ── the receipt ──────────────────────────────────────────────────────────
  if (done) {
    return (
      <Screen footer={<Button label="Done" onPress={() => router.back()} />}>
        <Header title="Shared" />
        <View style={styles.sheet}>
          <Notice tone="cleared" title={`${request.verifier} has your answer`}>
            They can verify it came from Pravaah and belongs to this device, and they can
            see nothing beyond what you ticked.
          </Notice>

          <Panel>
            <Legend>Shared</Legend>
            {done.shared.length === 0 ? (
              <Text role="bodySm" tone="dim">
                Nothing — you proved only that you hold a live Pravaah passport.
              </Text>
            ) : (
              done.shared.map((claim) => (
                <View key={claim} style={styles.receiptRow}>
                  <Icon name="check" size={14} color={p.cleared} weight={1.8} />
                  <Text role="bodySm">{labelFor(request.claims, claim)}</Text>
                </View>
              ))
            )}
          </Panel>

          {done.withheld.length > 0 ? (
            <Panel tone="sunk">
              <Legend>Kept private</Legend>
              {done.withheld.map((claim) => (
                <View key={claim} style={styles.receiptRow}>
                  <Icon name="dash" size={14} color={p.inkFaint} weight={1.8} />
                  <Text role="bodySm" tone="dim">
                    {labelFor(request.claims, claim)}
                  </Text>
                </View>
              ))}
              <Micro>
                They were told you declined these, not that the answer was no.
              </Micro>
            </Panel>
          ) : null}
        </View>
      </Screen>
    );
  }

  // ── the ask ──────────────────────────────────────────────────────────────
  const expired = !request.open;

  return (
    <Screen
      footer={
        expired ? (
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
              disabled={busy !== null || !request.credentialId}
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

        {expired ? (
          <Notice tone="caution" title="This request has closed">
            Ask {request.verifier} to start a new one. Requests expire quickly on purpose —
            an open challenge is a window somebody else could use.
          </Notice>
        ) : null}

        {!request.credentialId ? (
          <Notice tone="caution" title="You have no live passport">
            Issue your passport first, then ask {request.verifier} to try again.
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
              disabled={expired || busy !== null}
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
            Anything you do not tick stays mathematically hidden — {request.verifier} receives
            a one-way fingerprint of it, not the value. This share is signed for them alone
            and expires, so it cannot be replayed anywhere else.
          </Micro>
        </View>
      </View>
    </Screen>
  );
}

/**
 * One claim, as a decision rather than a field name.
 *
 * `whyAsked` sits under the label because it is the only thing that makes a tick
 * meaningful, and HIGH-sensitivity claims are marked so the eye reaches them first — a
 * passport number and a "Good or better" boolean should not read as equivalent asks.
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
        label={`${claim.label}. ${claim.detail} ${claim.whyAsked}`}
      >
        <View style={styles.claimText}>
          <View style={styles.claimHead}>
            <Text role="bodyMedium">{claim.label}</Text>
            {sensitive ? (
              <Micro tone="carmine" style={styles.flag}>
                Sensitive
              </Micro>
            ) : null}
          </View>
          <Micro tone="dim">{claim.detail}</Micro>
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
  receiptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    marginTop: Space.xs,
  },
  footer: { gap: Space.sm },
  fine: {
    flexDirection: 'row',
    gap: Space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.lg,
  },
  fineText: { flex: 1 },
});
