/**
 * The scanner's side of a peer check.
 *
 * You pointed your camera at somebody's passport code. This screen is what happens next, and
 * its structure IS the privacy guarantee:
 *
 *   waiting   → you know nothing. Not their name, not whether the code was even theirs.
 *   approved  → exactly the claims they ticked, and a list of what they chose to withhold.
 *   declined  → said plainly, as a decision they made rather than an error you hit.
 *   expired   → they never answered.
 *
 * There is no version of this screen that shows anything before the holder approves, because a
 * screen that could would mean the data had already travelled and the approval was theatre.
 *
 * ── On the absent photograph ──
 * There is deliberately no portrait. `portrait` is not in the credential's claim catalogue, so
 * nothing signed ties a face to this credential — and an unsigned photo fetched by user id is a
 * face with no cryptographic binding, which is precisely what an impersonator wants. A monogram
 * drawn from the disclosed initials says exactly as much as we can actually prove. Minting a real
 * portrait claim from the M0 selfie is the fix, and it is a credential change, not a UI one.
 */
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError, passportService } from '@/api';
import type { PeerCheckResult, PeerCheckVerdict } from '@/api';
import {
  Button,
  Header,
  Icon,
  Legend,
  Micro,
  Notice,
  Panel,
  Rule,
  Screen,
  SectionHead,
  Spinner,
  Text,
  haptic,
} from '@/components/ui';
import { Radius, Space, usePalette } from '@/theme';

import { PeerIdentityCard } from './components/peer-identity-card';

/**
 * How often to ask.
 *
 * 2s, and it is a deliberate departure from the wallet's 10s inbox poll. Both people are
 * standing there: the gap between them tapping Approve and this screen changing is the entire
 * felt quality of the feature, and ten seconds of nothing reads as broken. The poll stops the
 * moment the request reaches a terminal state, so the fast interval costs nothing after the
 * handshake completes.
 */
const POLL_MS = 2000;

export function PeerCheckScreen({ requestId }: { requestId: string }) {
  const p = usePalette();

  const [result, setResult] = useState<PeerCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const alive = useRef(true);
  /** Latched so the completion haptic fires once, not on every poll after approval. */
  const announced = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const poll = useCallback(async () => {
    try {
      const next = await passportService.scanResult(requestId);
      if (!alive.current) return next;
      setResult(next);
      setError(null);
      if (!announced.current && next.status !== 'PENDING') {
        announced.current = true;
        if (next.status === 'CONSUMED') haptic.cleared();
        else haptic.refused();
      }
      return next;
    } catch (caught) {
      if (alive.current) {
        setError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not check whether they have answered.',
        );
      }
      return null;
    }
  }, [requestId]);

  useEffect(() => {
    void poll();
  }, [poll]);

  /**
   * Poll only while there is something to wait for.
   *
   * The interval is cleared on any terminal status rather than left running — a screen that
   * keeps asking after the answer arrived is a battery cost and a stream of pointless requests,
   * and this one is reached from a camera that has just been using the GPU hard.
   */
  useEffect(() => {
    if (result && result.status !== 'PENDING') return;
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [poll, result]);

  const withdraw = async () => {
    setCancelling(true);
    try {
      await passportService.cancelScan(requestId);
      haptic.select();
      router.back();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not withdraw the request.',
      );
      setCancelling(false);
    }
  };

  // ── waiting ───────────────────────────────────────────────────────────────
  if (!result || result.status === 'PENDING') {
    return (
      <Screen
        footer={
          <Button
            label="Never mind"
            variant="quiet"
            loading={cancelling}
            onPress={() => void withdraw()}
            hint="Withdraws the request so they stop being asked."
          />
        }
      >
        <Header
          title="Waiting for them"
          lede="They have been asked on their phone. Nothing about them reaches you until they approve it — not their name, not their score, nothing."
        />

        {error ? (
          <Notice tone="caution" action="Try again" onAction={() => void poll()}>
            {error}
          </Notice>
        ) : null}

        <Panel tone="sunk">
          <View style={styles.waiting}>
            <Spinner size={26} label="Waiting for them to approve" />
            <View style={styles.waitingText}>
              <Text role="title">Ask them to check their phone</Text>
              <Micro tone="dim">
                A notification is on its way, and the request is also sitting in their
                Pravaah wallet.
              </Micro>
            </View>
          </View>
        </Panel>

        <View style={[styles.fine, { borderTopColor: p.rule }]}>
          <Icon name="lock" size={13} color={p.inkFaint} weight={1.3} />
          <Micro style={styles.fineText}>
            They choose what to share, item by item. You will see what they sent and what
            they held back — never a blank where a withheld detail was.
          </Micro>
        </View>
      </Screen>
    );
  }

  // ── they said no, or never answered ───────────────────────────────────────
  if (result.status !== 'CONSUMED') {
    const declined = result.status === 'DECLINED';
    return (
      <Screen footer={<Button label="Done" onPress={() => router.back()} />}>
        <Header title={declined ? 'They declined' : 'No answer'} />
        <Notice
          tone={declined ? 'caution' : 'error'}
          title={declined ? 'They chose not to share' : 'The request timed out'}
        >
          {result.message}
        </Notice>
        <Micro>
          {declined
            ? 'Declining is a normal answer, and Pravaah does not tell you why. If you still need the check, ask them directly and scan again.'
            : 'The code stays valid — ask them to show it again when they are ready.'}
        </Micro>
      </Screen>
    );
  }

  // ── approved ──────────────────────────────────────────────────────────────
  return (
    <Screen footer={<Button label="Done" onPress={() => router.back()} />}>
      <Header title="Verified" />
      <View style={styles.sheet}>
        <PeerIdentityCard verdict={result.result} />
        <Trust verdict={result.result} />
        <Withheld verdict={result.result} />

        <View style={[styles.fine, { borderTopColor: p.rule }]}>
          <Icon name="lock" size={13} color={p.inkFaint} weight={1.3} />
          <Micro style={styles.fineText}>
            Checked against Pravaah&apos;s published signing key and its revocation list.
            This is a snapshot of what they shared at{' '}
            {formatTime(result.result.verifiedAt)} — it is not a standing permission, and
            they can revoke the credential behind it at any time.
          </Micro>
        </View>
      </View>
    </Screen>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   What the cryptography actually established
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The three questions a verifier has, answered separately.
 *
 * Not collapsed into one green tick, because they fail independently and mean different
 * things. A credential can be genuinely issued by Pravaah and still be presented by somebody
 * who stole it — that is exactly what `holderVerified` is for, and burying it inside a
 * summary badge would hide the single most important fact on this screen.
 */
function Trust({ verdict }: { verdict: PeerCheckVerdict }) {
  const p = usePalette();
  const rows: { ok: boolean; label: string; detail: string }[] = [
    {
      ok: verdict.valid,
      label: 'Issued by Pravaah',
      detail: verdict.valid
        ? 'The signature checks out and the credential is not revoked or expired.'
        : 'The signature or the revocation check did not pass.',
    },
    {
      ok: verdict.holderVerified,
      label: 'Belongs to their device',
      detail: verdict.holderVerified
        ? 'They proved possession of the private key this credential was issued to.'
        : 'No proof of possession — treat this as unverified.',
    },
    {
      ok: verdict.replayProtected,
      label: 'Fresh, not a replay',
      detail: verdict.replayProtected
        ? 'Answered against a one-time challenge created for this scan.'
        : 'Could not confirm this was answered for your scan specifically.',
    },
  ];

  return (
    <View style={styles.block}>
      <SectionHead title="What this proves" detail="Checked, not claimed" />
      <Panel pad="none">
        {rows.map((row, index) => (
          <View key={row.label}>
            {index > 0 ? <Rule /> : null}
            <View style={styles.trustRow}>
              <Icon
                name={row.ok ? 'check' : 'alert'}
                size={17}
                color={row.ok ? p.cleared : p.carmine}
                weight={1.9}
              />
              <View style={styles.trustText}>
                <Text role="bodySmMedium">{row.label}</Text>
                <Micro tone="dim">{row.detail}</Micro>
              </View>
            </View>
          </View>
        ))}
      </Panel>
    </View>
  );
}

/**
 * What they were asked for and chose not to send.
 *
 * Stated rather than omitted, and that is a correctness requirement rather than a courtesy: an
 * absent claim rendered as nothing is indistinguishable from a claim whose value is "no", and a
 * verifier reading a withheld `score_band` as "bad" would be drawing a conclusion the holder
 * never offered.
 */
function Withheld({ verdict }: { verdict: PeerCheckVerdict }) {
  if (!verdict.withheldClaims.length) return null;
  const names = verdict.withheldClaims
    .map((claim) => verdict.claimLabels[claim] ?? claim)
    .join(', ');

  return (
    <Notice tone="caution" title="They held some things back">
      {`Not shared: ${names}. That is their choice to make, and it says nothing about the values — a withheld detail is not a bad one.`}
    </Notice>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'the time of the check';
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: Space.lg },
  waitingText: { flex: 1, gap: 2 },
  block: { gap: Space.lg },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.md,
    padding: Space.lg,
  },
  trustText: { flex: 1, gap: 2 },
  fine: {
    flexDirection: 'row',
    gap: Space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.lg,
  },
  fineText: { flex: 1 },
  centre: { alignItems: 'center' },
});

export { styles as peerCheckStyles };
