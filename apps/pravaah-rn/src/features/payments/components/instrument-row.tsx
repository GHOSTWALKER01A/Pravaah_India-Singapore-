import { StyleSheet, View } from 'react-native';

import { Icon, Press, Text, type IconName } from '@/components/ui';
import { Space, usePalette } from '@/theme';

/**
 * The instruments a holder can write with — the Pay tab's primary action set.
 *
 * This redesign adopts a circular icon grid with centered text,
 * optimising for quick scanning while retaining the Intaglio theme.
 */
export interface Instrument {
  key: string;
  icon: IconName;
  /** The destination, in the user's words. */
  label: string;
  /** What this instrument is for. One short line. */
  detail: string;
  onPress: () => void;
  /** The one instrument drawn on the intaglio field. At most one per set. */
  lead?: boolean;
  /** Dimmed and non-acting, with `detail` explaining what is missing. */
  disabled?: boolean;
}

export function InstrumentRow({ items }: { items: readonly Instrument[] }) {
  return (
    <View style={styles.grid}>
      {items.map((item) => (
        <InstrumentTile key={item.key} {...tileProps(item)} />
      ))}
    </View>
  );
}

function InstrumentTile({
  icon,
  label,
  detail,
  onPress,
  lead = false,
  disabled = false,
}: Omit<Instrument, 'key'>) {
  const p = usePalette();

  /**
   * `p.sheet` does not exist — `sheet` is a `Text` SURFACE name, not a palette key, and reading it
   * off the palette yielded `undefined`, which React Native accepts silently as "no background".
   *
   * A non-lead tile is transparent on purpose rather than filled. `p.panel` would be the obvious
   * substitute and is the wrong one: in dark mode `panel` and `field` are the same colour, so every
   * tile would render identically to the lead tile and the hierarchy this component exists to express
   * would vanish on exactly one of the two themes.
   */
  const ground = lead ? p.field : 'transparent';
  const keyline = lead ? 'transparent' : p.rule;
  const glyph = lead ? p.onField : p.inkDim;

  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      depth="none"
      feedback={disabled ? 'none' : 'select'}
      style={[styles.tile, disabled && styles.tileOff]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={detail}
      accessibilityState={{ disabled }}
    >
      <View
        style={[
          styles.iconBox,
          { backgroundColor: ground, borderColor: keyline, borderWidth: lead ? 0 : 1 },
        ]}
      >
        <Icon name={icon} size={28} color={glyph} />
      </View>

      <View style={styles.text}>
        <Text
          role="bodySm"
          tone={disabled ? 'faint' : 'default'}
          numberOfLines={2}
          center
        >
          {label}
        </Text>
      </View>
    </Press>
  );
}

/** Strip the list key so it is not also spread onto the tile. */
function tileProps({ key: _key, ...rest }: Instrument): Omit<Instrument, 'key'> {
  return rest;
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    rowGap: Space.lg,
    paddingVertical: Space.sm,
  },
  tile: {
    width: '25%', // 4 per row
    alignItems: 'center',
    gap: Space.sm,
  },
  tileOff: { opacity: 0.55 },
  iconBox: {
    width: 60,
    height: 60,
    borderRadius: 30, // Perfect circle
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    paddingHorizontal: 2,
    alignItems: 'center',
  },
});
