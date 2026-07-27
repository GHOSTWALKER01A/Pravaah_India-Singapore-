/**
 * A selectable chip.
 *
 * The incumbent's version (in `score/fairness.tsx`) had two accessibility bugs
 * that mattered on that screen specifically, since it is a consent form:
 *
 *   - no role and no selected state, so a screen-reader user could not tell which
 *     option they had picked, on a screen recording protected attributes;
 *   - the toggle-off behaviour (tapping the selected chip clears it) was real but
 *     completely undiscoverable and unannounced.
 *
 * Both are fixed here, and the chip is now an engraved tab rather than a filled
 * pill: selected takes the field, unselected keeps a keyline.
 */
import { StyleSheet, View } from 'react-native';

import { Hairline, HitSize, Radius, Space, usePalette } from '@/theme';

import { haptic } from './haptics';
import { Icon } from './icon';
import { Press } from './pressable';
import { Text } from './text';

export function Chip({
  label,
  selected,
  onPress,
  /** True when tapping the selected chip clears it, so the hint can say so. */
  clearable = false,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  clearable?: boolean;
}) {
  const p = usePalette();

  return (
    <Press
      onPress={() => {
        haptic.select();
        onPress();
      }}
      depth="subtle"
      radius={Radius.sm}
      ink={false}
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected }}
      accessibilityLabel={label}
      accessibilityHint={
        selected && clearable ? 'Selected. Activate to clear this choice.' : undefined
      }
      style={styles.outer}
    >
      <View
        style={[
          styles.chip,
          {
            backgroundColor: selected ? p.field : 'transparent',
            borderColor: selected ? p.field : p.ruleStrong,
          },
        ]}
      >
        {selected ? <Icon name="check" size={13} color={p.onField} weight={2.2} /> : null}
        <Text
          role="bodySmMedium"
          tone="inherit"
          style={{ color: selected ? p.onField : p.ink }}
        >
          {label}
        </Text>
      </View>
    </Press>
  );
}

/** A row of chips that wraps, with the 8dp separation the touch guidance needs. */
export function ChipRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

const styles = StyleSheet.create({
  outer: { alignSelf: 'flex-start' },
  chip: {
    // The full 48dp floor, not `HitSize - 10`. These are the controls on the
    // protected-attribute consent form, and `hitSlop` does not close the gap
    // because adjacent chips' slop overlaps and an accessibility scanner measures
    // the view, not the slop.
    minHeight: HitSize,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    borderRadius: Radius.sm,
    borderWidth: Hairline.base,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
});
