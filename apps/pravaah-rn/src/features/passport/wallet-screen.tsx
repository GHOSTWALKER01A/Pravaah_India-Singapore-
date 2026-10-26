import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { isActivePassport } from '@/api';
import {
  Button,
  Icon,
  Micro,
  Notice,
  PassportSkeleton,
  Press,
  Screen,
  SectionHead,
  Text,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Radius, Space, usePalette } from '@/theme';

import { useActiveShareCount } from '@/features/shares/use-active-share-count';

import { CredentialNote } from './components/credential-note';
import { usePassport } from './use-passport';

/**
 * The wallet — the passport, and the one thing to do with it next.
 *
 * Structured the way the Passport tab is: exactly ONE primary action at any moment, derived
 * from state rather than every possible action rendered at once. A screen that offers
 * "issue", "share", "get a card" and "revoke" simultaneously answers none of them.
 *
 * The inbox comes first when a verifier is waiting, because somebody is standing at a
 * counter expecting an answer, and nothing else on this screen is more urgent than that.
 *
 * `tabBar` is a prop rather than a constant because this screen has two homes: pushed on top
 * of the Passport tab today, and a candidate to BE that tab once the credential is the
 * primary story. Hard-coding it would make that promotion a rewrite instead of a flag.
 */
export function WalletScreen({ tabBar = false }: { tabBar?: boolean }) {
  // Polled: a verifier request can arrive while this screen is open, from a card tap that
  // happened on somebody else's terminal.
  const {
    wallet,
    requests,
    loading,
    issuing,
    revoking,
    keyMissing,
    error,
    retryable,
    refetch,
    retry,
    issue,
    revoke,
  } = usePassport({ pollMs: 10_000 });
  const [refreshing, setRefreshing] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const activeShares = useActiveShareCount();
  const p = usePalette();

  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  const onIssue = async (bindPassportNumber: boolean) => {
    const issued = await issue({ bindPassportNumber });
    // Surfaced, not swallowed: a user who opted into the international tier and did not
    // get it must be told, or they will believe they carry a binding they do not.
    setNotes(issued?.notes ?? []);
  };

  if (loading && !wallet) {
    return (
      <Screen tabBar={tabBar}>
        <PassportSkeleton />
      </Screen>
    );
  }

  const active = wallet && isActivePassport(wallet) ? wallet : null;

  return (
    <Screen tabBar={tabBar} onRefresh={onRefresh} refreshing={refreshing}>
      <View style={styles.sheet}>
        {/* "Try again" re-runs the action that FAILED, not a refetch — a refetch left the
            error on screen and made the button look inert. And it is withheld entirely when
            the failure needs a new app build, because tapping could never fix that. */}
        {error ? (
          <Notice
            tone="error"
            action={retryable ? 'Try again' : undefined}
            onAction={retryable ? () => void retry() : undefined}
          >
            {error}
          </Notice>
        ) : null}

        {/* A reinstall leaves a live credential bound to a key this phone no longer has.
            Told before anything else, because every share below would fail. */}
        {keyMissing ? (
          <Notice
            tone="error"
            title="This passport belongs to another device"
            action="Issue a new one"
            onAction={() => void onIssue(false)}
          >
            The key that proves it is yours was made on a different phone, or was cleared when
            you reinstalled. Issue a new passport to use it here — your old one stops working.
          </Notice>
        ) : null}

        {/* Somebody is waiting. This outranks everything else on the screen. */}
        {requests.length > 0 ? (
          <View style={styles.inbox}>
            {requests.map((request) => (
              <Press
                key={request.requestId}
                onPress={() => router.push(ROUTES.PASSPORT.REQUEST(request.requestId))}
                depth="subtle"
                radius={Radius.md}
                accessibilityRole="button"
                accessibilityLabel={`${request.verifier} is asking to see ${request.claimCount} ${request.claimCount === 1 ? 'thing' : 'things'}. ${request.purpose}`}
              >
                {/* An unverified PERSON asking is the one case this row changes colour for.
                    It is the strongest reason to decline, the holder sees this list before
                    they see the consent sheet, and burying it one screen deeper would mean
                    the warning arrives after they have already decided to open it. */}
                <View
                  style={[
                    styles.request,
                    request.isPeer && !request.peerVerified
                      ? { borderColor: p.carmine, backgroundColor: p.carmineWash }
                      : { borderColor: p.latent, backgroundColor: p.latentWash },
                  ]}
                >
                  <Icon
                    name={
                      request.isPeer
                        ? request.peerVerified
                          ? 'verify'
                          : 'alert'
                        : 'consent'
                    }
                    size={20}
                    color={
                      request.isPeer && !request.peerVerified ? p.carmine : p.latent
                    }
                  />
                  <View style={styles.requestText}>
                    <Text role="title">{request.verifier} wants to check you</Text>
                    <Micro tone={request.isPeer && !request.peerVerified ? 'carmine' : 'dim'}>
                      {request.isPeer && !request.peerVerified
                        ? 'Their identity is NOT verified · '
                        : ''}
                      {request.purpose} · asking for {request.claimCount}{' '}
                      {request.claimCount === 1 ? 'thing' : 'things'}
                    </Micro>
                  </View>
                  <Icon name="chevronRight" size={16} color={p.inkFaint} weight={1.6} />
                </View>
              </Press>
            ))}
          </View>
        ) : null}

        {active ? <CredentialNote passport={active} /> : null}

        {notes.length > 0 ? (
          <Notice tone="caution" onAction={() => setNotes([])} action="Got it">
            {notes.join(' ')}
          </Notice>
        ) : null}

        {/* The single next action, chosen by state. */}
        {!active ? (
          <View style={styles.action}>
            <Button
              label={
                wallet?.state === 'NEEDS_REISSUE'
                  ? 'Issue a new passport'
                  : 'Issue my passport'
              }
              icon="passport"
              loading={issuing}
              onPress={() => void onIssue(false)}
            />
            <Micro center>
              {/* The server's own words when it has them: "expired" and "revoked" are
                  different situations and it knows which one this is. */}
              {wallet && !isActivePassport(wallet)
                ? wallet.message
                : 'Your reputation becomes a credential you own — signed by Pravaah, held on this device, and shown only on your terms.'}
            </Micro>
            <Button
              label="Issue with my passport number"
              variant="quiet"
              inline
              disabled={issuing}
              hint="Adds a cross-border binding so a lender or landlord abroad can tie your reputation to the passport they already trust."
              onPress={() => void onIssue(true)}
            />
          </View>
        ) : (
          <View style={styles.links}>
            {/* Showing the card IS how a holder starts a check. There is deliberately no
                separate "share" flow with no verifier in it: a presentation is made out to
                ONE audience, so a share with nobody on the other end could not be bound to
                anyone — and an unbound presentation is the replayable kind. */}
            <LinkRow
              icon="card"
              title={active.card ? 'Show my passport' : 'Get a physical card'}
              detail={
                active.card
                  ? `${active.card.cardSerial} · they scan, you approve here`
                  : 'Card-sized, tap-to-verify, works with your phone'
              }
              onPress={() => router.push(ROUTES.PASSPORT.CARD)}
            />
            <LinkRow
              icon="history"
              title="Who has seen it"
              detail={
                active.presentationCount === 0
                  ? 'Nothing shared yet'
                  : `${active.presentationCount} ${active.presentationCount === 1 ? 'share' : 'shares'} on record`
              }
              onPress={() => router.push(ROUTES.PASSPORT.HISTORY)}
            />
            {/* M7: the standing permissions, as opposed to the event log above. Its count is
                "who holds my data right now" — the number worth putting on the wallet. */}
            <LinkRow
              icon="receipt"
              title="Shared with organisations"
              detail={
                activeShares === null
                  ? 'Consent receipts — withdraw a share at any time'
                  : activeShares === 0
                    ? 'No organisation holds your data'
                    : `${activeShares} ${activeShares === 1 ? 'organisation holds' : 'organisations hold'} your data · withdraw any time`
              }
              onPress={() => router.push(ROUTES.PASSPORT.SHARES)}
            />
          </View>
        )}

        {active ? (
          <View style={styles.provenance}>
            <SectionHead
              title="What this proves"
              detail="And, just as deliberately, what it does not carry"
            />
            <Text role="bodySm" tone="dim">
              Anyone you show this to can check three things without contacting us: that
              Pravaah issued it, that it has not been revoked, and that it belongs to this
              device. They see only the details you tick — everything else stays
              mathematically hidden, not merely withheld.
            </Text>
            <View style={[styles.fine, { borderTopColor: p.rule }]}>
              <Icon name="lock" size={13} color={p.inkFaint} weight={1.3} />
              <Micro style={styles.fineText}>
                Your passport contains a reputation band and where the data came from. It
                contains no transactions, no balances and no account numbers — those never
                leave India. The key that proves it is yours was made on this phone and
                never leaves it.
              </Micro>
            </View>

            {/* Last on the screen, and the only carmine thing on it. Revoking is the holder's
                ultimate control over their own credential — it belongs here, reachable and
                unmistakable, not hidden in a settings menu. */}
            <Button
              label="Revoke my passport"
              variant="destructive"
              icon="revoke"
              loading={revoking}
              onPress={() => void revoke(active.id)}
              hint="Every verifier will immediately reject it, including anyone you have already shared it with. This cannot be undone — you would issue a new one."
            />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

function LinkRow({
  icon,
  title,
  detail,
  onPress,
}: {
  icon: 'consent' | 'card' | 'history' | 'receipt';
  title: string;
  detail: string;
  onPress: () => void;
}) {
  const p = usePalette();
  return (
    <Press
      onPress={onPress}
      depth="subtle"
      radius={Radius.md}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}`}
      style={styles.linkOuter}
    >
      <View style={[styles.link, { borderColor: p.rule, backgroundColor: p.panel }]}>
        <Icon name={icon} size={20} color={p.latent} />
        <View style={styles.linkText}>
          <Text role="title">{title}</Text>
          <Micro tone="dim">{detail}</Micro>
        </View>
        <Icon name="chevronRight" size={16} color={p.inkFaint} weight={1.6} />
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl, paddingTop: Space.sm },
  inbox: { gap: Space.sm },
  request: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.lg,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.lg,
  },
  requestText: { flex: 1, gap: 1 },
  action: { gap: Space.md, marginTop: -Space.sm, alignItems: 'stretch' },
  links: { gap: Space.sm, marginTop: -Space.sm },
  linkOuter: { alignSelf: 'stretch' },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.lg,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.lg,
  },
  linkText: { flex: 1, gap: 1 },
  provenance: { gap: Space.lg },
  fine: {
    flexDirection: 'row',
    gap: Space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.lg,
  },
  fineText: { flex: 1 },
});
