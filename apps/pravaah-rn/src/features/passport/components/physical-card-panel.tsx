/**
 * The physical passport, on the passport screen.
 *
 * The plastic already has a whole screen of its own — both faces at true ID-1 proportions,
 * the NFC state, and "report this lost". What it did NOT have was any presence on the
 * screen named Passport: the card lived behind a row of text two navigations away, so a
 * holder had no way to know the artefact existed, let alone what it looked like.
 *
 * So this draws the front face at the width it is given and nothing else. Tapping it opens
 * the real card screen. It is deliberately NOT a second copy of that screen's controls:
 * issuing, the back face, and reporting a loss are consequential actions and they belong in
 * one place, not two.
 *
 * The artwork comes from the server's card payload — the same one the printed card and the
 * partner console are rendered from — so what a holder sees here is the object they will be
 * posted, rather than a mock-up of it.
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { PassportCardPayload } from '@/api';
import { Icon, Legend, Micro, Press, Text } from '@/components/ui';
import { Radius, Space, usePalette } from '@/theme';

import { CardFront } from './card-face';

export interface PhysicalCardPanelProps {
  card: PassportCardPayload;
  onPress: () => void;
}

export function PhysicalCardPanel({ card, onPress }: PhysicalCardPanelProps) {
  const p = usePalette();
  // Measured, so the SVG viewBox maps to real millimetres at any screen width.
  const [width, setWidth] = useState(0);

  /**
   * A LOST card points at no credential, so there is nothing to print on its face — the
   * server sends `credentialNumber: null` for exactly that reason. The row below still
   * says what state it is in; it is the artwork that goes away, not the information.
   */
  const printable =
    card.credentialNumber !== null && card.expiresAt !== null
      ? { credentialNumber: card.credentialNumber, expiresAt: card.expiresAt }
      : null;
  const usable = card.status === 'ACTIVE';

  return (
    <Press
      onPress={onPress}
      depth="subtle"
      radius={Radius.md}
      accessibilityRole="button"
      accessibilityLabel={`Your physical card, ${card.cardSerial}. ${
        usable ? 'Active.' : 'No longer usable.'
      } Double tap to open it.`}
      style={styles.outer}
    >
      <View style={styles.stack} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 && printable ? (
          <CardFront
            width={width}
            credentialNumber={printable.credentialNumber}
            artwork={card.artwork}
            mrz={card.mrz}
            issuedAt={card.issuedAt}
            expiresAt={printable.expiresAt}
          />
        ) : null}

        <View style={styles.row}>
          <View style={styles.text}>
            <Legend small tone="faint">
              {usable ? 'Card' : 'Card disabled'}
            </Legend>
            <Text role="serial" numberOfLines={1} maxFontSizeMultiplier={1.1}>
              {card.cardSerial}
            </Text>
            <Micro tone={usable ? 'dim' : 'carmine'}>
              {usable
                ? `${card.nfcWritten ? 'Tag written' : 'Tag not written yet'} · they scan or tap, you approve here`
                : 'Reported lost — its reference no longer resolves'}
            </Micro>
          </View>
          <Icon name="chevronRight" size={16} color={p.inkFaint} weight={1.6} />
        </View>
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  outer: { alignSelf: 'stretch' },
  stack: { gap: Space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.lg },
  text: { flex: 1, gap: 1 },
});
