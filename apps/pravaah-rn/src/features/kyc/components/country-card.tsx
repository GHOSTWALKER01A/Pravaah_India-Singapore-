/**
 * The corridor picker — choosing which rail to verify on.
 *
 * Was: a card with a 30pt 🇮🇳 / 🇸🇬 emoji in a tile, a tracked "INDIA RAIL"
 * eyebrow, the country name, a tagline, a list of ticked steps, and a "Start ›"
 * row. Beyond the emoji (which renders as the letters "IN" on several Android
 * builds, since flag sequences are not in the platform font), it was the same card
 * shape as everything else on the screen.
 *
 * This is the multi-language panel from the note: the corridor stated as a
 * two-letter code in the measured face, the checks listed as the thread they will
 * become, and the whole plate a single target.
 */
import { StyleSheet, View } from 'react-native';

import type { Country } from '@/api';
import {
  FieldValue,
  Icon,
  Legend,
  Press,
  Rule,
  Spinner,
  Text,
} from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';

export interface CorridorPlateProps {
  country: Extract<Country, 'INDIA' | 'SINGAPORE'>;
  /** Two-letter corridor code, set in the measured face. */
  code: string;
  title: string;
  tagline: string;
  steps: string[];
  estimate: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}

export function CorridorPlate({
  code,
  title,
  tagline,
  steps,
  estimate,
  onPress,
  busy = false,
  disabled = false,
}: CorridorPlateProps) {
  const p = usePalette();
  const locked = busy || disabled;

  return (
    <Press
      onPress={onPress}
      disabled={locked}
      depth="subtle"
      radius={Radius.md}
      feedback="select"
      accessibilityRole="button"
      accessibilityLabel={`Verify on the ${title} corridor. ${steps.length} steps, about ${estimate}.`}
      accessibilityState={{ disabled: locked, busy }}
      style={[styles.outer, disabled && styles.dim]}
    >
      <View style={[styles.plate, { backgroundColor: p.panel, borderColor: p.rule }]}>
        <View style={styles.head}>
          {/* The corridor code as a stamped block — the note's country panel. */}
          <View style={[styles.code, { backgroundColor: p.field }]}>
            <FieldValue role="field" surface="field" tone="cleared">
              {code}
            </FieldValue>
          </View>

          <View style={styles.headText}>
            <Text role="heading">{title}</Text>
            <Text role="bodySm" tone="dim">
              {tagline}
            </Text>
          </View>

          {busy ? (
            <Spinner size={18} label={`Starting ${title} verification`} />
          ) : (
            <Icon name="chevronRight" size={18} color={p.latent} weight={1.8} />
          )}
        </View>

        <Rule />

        {/* The sequence, listed before it is entered. This is what makes the
            choice informed rather than a coin-flip between two flags. */}
        <View style={styles.steps}>
          {steps.map((step, i) => (
            <View key={step} style={styles.step}>
              <FieldValue role="fieldSm" tone="faint" style={styles.stepIndex}>
                {String(i + 1).padStart(2, '0')}
              </FieldValue>
              <Text role="bodySm" tone="dim" style={styles.flex}>
                {step}
              </Text>
            </View>
          ))}
        </View>

        <View style={[styles.foot, { borderTopColor: p.rule }]}>
          <Legend small tone="faint">
            {`${steps.length} steps · about ${estimate}`}
          </Legend>
        </View>
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  outer: { alignSelf: 'stretch' },
  dim: { opacity: 0.45 },
  plate: {
    borderRadius: Radius.md,
    borderWidth: Hairline.base,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.lg,
    padding: Space.lg,
  },
  code: {
    width: 44,
    height: 44,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: { flex: 1, gap: 2 },
  steps: { paddingHorizontal: Space.lg, paddingVertical: Space.md, gap: Space.sm },
  step: { flexDirection: 'row', alignItems: 'baseline', gap: Space.md },
  // Ordered numbering is earned here: the sequence IS the information — each
  // check is only possible once the previous one has cleared.
  stepIndex: { width: 20 },
  flex: { flex: 1 },
  foot: {
    borderTopWidth: Hairline.base,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
  },
});
