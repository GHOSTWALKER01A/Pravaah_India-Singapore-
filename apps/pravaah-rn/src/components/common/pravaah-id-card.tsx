/**
 * The Pravaah ID — the credential's serial number.
 *
 * The incumbent's three reasons for its shape were right and are kept: monospaced
 * and wide-tracked so it can be dictated a character at a time, `selectable` so a
 * long-press copies it without a clipboard dependency, and a line stating what it
 * is FOR, because an unexplained identifier invites "is this safe to share?" at
 * exactly the wrong moment.
 *
 * What it becomes here is the thing it always was: a serial panel off a banknote —
 * the number set on its own recessed field, under an issuing legend, with the
 * microtext line beneath. The raw row UUID is still never shown; it is an internal
 * database key, unreadable and undictatable.
 */
import { StyleSheet, View } from 'react-native';

import { FieldValue, Legend, Micro, Panel, Rule } from '@/components/ui';
import { APP_NAME } from '@/constants/ui.constants';
import { Radius, Space, usePalette } from '@/theme';

export function PravaahIdCard({ pravaahId }: { pravaahId: string }) {
  const p = usePalette();

  return (
    <Panel pad="none">
      <View style={styles.head}>
        <Legend small tone="faint">
          {`${APP_NAME} ID`}
        </Legend>
      </View>

      <View style={[styles.serial, { backgroundColor: p.groundSunk }]}>
        <FieldValue
          role="serial"
          selectable
          // iOS-only, so it cannot be the mechanism.
          adjustsFontSizeToFit
          numberOfLines={1}
          // Android has no `adjustsFontSizeToFit`: at a large OS text size the
          // serial exceeded the sheet width and ellipsised — on the one string in
          // the product that exists to be read aloud to a lender. A truncated
          // identifier is worse than a slightly smaller one.
          maxFontSizeMultiplier={1.1}
          // Spaced out so a screen reader dictates it character by character
          // rather than as one unpronounceable token.
          accessibilityLabel={`Your Pravaah ID is ${pravaahId.split('').join(' ')}`}
        >
          {pravaahId}
        </FieldValue>
      </View>

      <Rule />

      <View style={styles.foot}>
        <Micro>
          Your permanent identity in the Pravaah network. Quote this instead of any
          personal detail — long-press to copy. It reveals nothing about you on its
          own.
        </Micro>
      </View>
    </Panel>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: Space.lg, paddingTop: Space.lg, paddingBottom: Space.sm },
  serial: {
    marginHorizontal: Space.lg,
    marginBottom: Space.lg,
    borderRadius: Radius.sm,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
  },
  foot: { padding: Space.lg },
});
