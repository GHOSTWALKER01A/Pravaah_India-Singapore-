import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError, passportService } from '@/api';
import type { PassportCardPayload } from '@/api';
import {
  Button,
  Header,
  Icon,
  Legend,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Screen,
  SectionHead,
  Text,
  haptic,
} from '@/components/ui';
import { Space, usePalette } from '@/theme';

import { CardBack, CardFront } from './components/card-face';

/**
 * The physical companion card.
 *
 * ISO/IEC 7810 ID-1 — bank-card size, which is also ICAO's TD1 travel-document format. The
 * QR is rendered from an SVG the SERVER produced, so the symbol on this screen, the one on
 * the printed card, and the one in the partner console come from a single encoder; three
 * independent QR implementations is three chances for a card that scans in one place and
 * not another.
 *
 * The security model is the thing to keep in view while reading this screen: the card
 * carries a REFERENCE, never the credential. Scanning it opens a request that this phone
 * must approve and sign, so a photographed QR or a stolen card is inert. That is what makes
 * printing a card safe at all, and it is why "report lost" is a calm action rather than an
 * emergency.
 */
export function CardScreen() {
  const [card, setCard] = useState<PassportCardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'issue' | 'lost' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lostResult, setLostResult] = useState<string | null>(null);
  // Measured, so the SVG viewBox maps to real millimetres at any screen width.
  const [faceWidth, setFaceWidth] = useState(0);
  const p = usePalette();

  const load = useCallback(async () => {
    try {
      setCard(await passportService.card());
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not load your card.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const issue = async () => {
    setBusy('issue');
    setError(null);
    try {
      setCard(await passportService.issueCard());
      haptic.commit();
    } catch (caught) {
      haptic.refused();
      setError(
        caught instanceof ApiError ? caught.message : 'Could not issue your card.',
      );
    } finally {
      setBusy(null);
    }
  };

  const reportLost = async () => {
    setBusy('lost');
    setError(null);
    try {
      const result = await passportService.reportCardLost();
      haptic.destroy();
      setLostResult(result.message);
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not disable your card.',
      );
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <Screen>
        <Header title="Your card" />
        <ListSkeleton rows={4} label="Loading your card" />
      </Screen>
    );
  }

  if (!card) {
    return (
      <Screen
        footer={
          <Button
            label="Get my card"
            icon="card"
            loading={busy === 'issue'}
            onPress={() => void issue()}
          />
        }
      >
        <Header title="Your card" />
        <View style={styles.sheet}>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Text role="body">
            A card-sized version of your passport, for the times a phone is not the natural
            thing to hand over — a counter, a landlord’s desk, a border of any kind.
          </Text>
          <Panel tone="sunk">
            <Legend>How it stays safe</Legend>
            <Text role="bodySm" tone="dim">
              The card carries only a reference — never your score, and never the credential
              itself. Tapping or scanning it asks THIS phone for approval, so a lost card
              cannot be used by whoever finds it.
            </Text>
          </Panel>
        </View>
      </Screen>
    );
  }

  const usable = card.status === 'ACTIVE';
  // A lost card points at no credential, so there is nothing to print on its face. The panels
  // below still explain its state — the artwork is what goes away, not the information.
  const printable =
    card.credentialNumber !== null && card.expiresAt !== null
      ? { credentialNumber: card.credentialNumber, expiresAt: card.expiresAt }
      : null;

  return (
    <Screen>
      <Header title="Your card" />
      <View style={styles.sheet}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {lostResult ? (
          <Notice tone="caution" title="Card disabled">
            {lostResult}
          </Notice>
        ) : null}

        {!usable ? (
          <Notice tone="error" title="This card no longer works">
            It was reported lost, so its reference has been switched off. Nobody who finds it
            can use it.
          </Notice>
        ) : null}

        {/* The card, both faces, at true ID-1 proportions.

            Shown stacked rather than behind a flip toggle: everything the holder or a
            verifier needs is visible without an interaction to discover, and there is no
            state to get wrong. The measured width feeds the SVG viewBox, so the geometry is
            physical millimetres at any screen size. */}
        <View
          onLayout={(event) => setFaceWidth(event.nativeEvent.layout.width)}
          style={styles.faces}
        >
          {faceWidth > 0 && printable ? (
            <>
              <View style={styles.faceBlock}>
                <CardFront
                  width={faceWidth}
                  credentialNumber={printable.credentialNumber}
                  artwork={card.artwork}
                  mrz={card.mrz}
                  issuedAt={card.issuedAt}
                  expiresAt={printable.expiresAt}
                />
                <Micro center>Front</Micro>
              </View>

              <View style={styles.faceBlock}>
                <CardBack
                  width={faceWidth}
                  credentialNumber={printable.credentialNumber}
                  artwork={card.artwork}
                  mrz={card.mrz}
                  issuedAt={card.issuedAt}
                  expiresAt={printable.expiresAt}
                  // Withheld on a disabled card: a dead card must not present a working
                  // code, whatever the client does with it.
                  qrSvg={usable ? card.qrSvg : null}
                  verifyUrl={card.verifyUrl}
                />
                <Micro center>Back</Micro>
              </View>
            </>
          ) : null}
        </View>

        {usable ? (
          <View style={styles.explain}>
            <SectionHead
              title="Show this to a verifier"
              detail="They scan or tap it, you approve on this phone"
            />
            <Micro>
              Scanning it reveals nothing on its own. The card carries a reference, never your
              score and never the credential — so a photographed code, or the card itself in
              someone else&apos;s hands, opens a request only you can answer.
            </Micro>
          </View>
        ) : null}

        <Panel>
          <Legend>Card</Legend>
          <Text role="serial">{card.cardSerial}</Text>
          <Micro tone="dim">
            {card.nfcWritten ? 'Tag written' : 'Tag not written yet'}
            {card.lastVerifiedAt
              ? ` · last used ${new Date(card.lastVerifiedAt).toLocaleDateString('en-IN')}`
              : ' · never used'}
          </Micro>
        </Panel>

        {usable ? (
          <View style={styles.danger}>
            <View style={[styles.fine, { borderTopColor: p.rule }]}>
              <Icon name="alert" size={13} color={p.carmine} weight={1.4} />
              <Micro style={styles.fineText}>
                Reporting the card lost also revokes your passport. A lost card usually means
                a lost wallet, and your phone may have gone with it — so we assume the worst
                and you re-issue in one tap.
              </Micro>
            </View>
            <Button
              label="Report this card lost"
              variant="destructive"
              icon="revoke"
              loading={busy === 'lost'}
              onPress={() => void reportLost()}
              hint="Disables the card and revokes your passport. You can issue a new one afterwards."
            />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl, paddingTop: Space.sm },
  faces: { gap: Space.xl },
  faceBlock: { gap: Space.sm },
  explain: { gap: Space.md },
  danger: { gap: Space.lg },
  fine: {
    flexDirection: 'row',
    gap: Space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.lg,
  },
  fineText: { flex: 1 },
});
