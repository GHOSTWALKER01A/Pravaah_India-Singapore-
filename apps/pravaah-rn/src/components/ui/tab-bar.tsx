/**
 * The tab bar.
 *
 * What it replaces: the stock Expo tab bar with `🪪 ✅ 📊 👤` rendered as 20pt
 * emoji through a `<Text>`, tinted `Brand.primary` — a colour that emoji ignore.
 * So the "active tint" did nothing at all, and the only thing distinguishing the
 * current tab was the label's colour.
 *
 * This is the bottom edge of the note: a drenched intaglio field with a guilloche
 * band along its top rule, four destinations, and a gold thread mark that slides
 * between them on a spring. The active icon thickens its line weight rather than
 * changing glyph, which is how engraved marks show emphasis.
 *
 * Kept honest on both platforms: real bottom inset, Android ripple, 48dp targets,
 * `tab`/`tablist` roles with selected state, and a light haptic on change.
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

import {
  Elevation,
  Hairline,
  Motion,
  Space,
  useMotionOk,
  usePalette,
} from '@/theme';

import { GuillocheBand } from './guilloche';
import { haptic } from './haptics';
import { Icon, type IconName } from './icon';
import { Press } from './pressable';
import { Text } from './text';

/** Route name → engraved glyph. Keyed by the file name under `(tabs)/`. */
const TAB_ICON: Record<string, IconName> = {
  index: 'passport',
  kyc: 'verify',
  score: 'reputation',
  profile: 'bearer',
};

/**
 * The bar's own height, above the safe-area inset. Screens reserve this.
 *
 * 68, not 58. At 58 the engraved glyphs had to stay small to leave the label any
 * room, and on a real phone a 23dp single-weight line icon in the dim tone simply
 * did not read — the bar looked like an empty green strip. Height is what buys
 * icon size, so the height went up first.
 */
export const BAR_HEIGHT = 68;

/** Icon size. Large enough that engraved line work survives a real screen. */
const ICON = 27;

/** The length of the gold thread mark over the active destination. */
const MARK_WIDTH = 26;

export function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const motionOk = useMotionOk();
  const [width, setWidth] = useState(0);

  const count = state.routes.length;
  const slot = width > 0 ? width / count : 0;
  const x = useSharedValue(0);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  }, []);

  const target = slot > 0 ? state.index * slot + (slot - MARK_WIDTH) / 2 : 0;
  useEffect(() => {
    if (slot <= 0) return;
    x.value = motionOk ? withSpring(target, Motion.slide) : withTiming(target, { duration: 0 });
  }, [target, slot, motionOk, x]);

  const mark = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: p.field,
          paddingBottom: insets.bottom,
          shadowColor: p.shadow,
        },
        Elevation.bar,
      ]}
    >
      {/* The top rule, and the guilloche running along it. Decorative geometry,
          so it draws in latentLine and is hidden from assistive tech. */}
      <View style={[styles.topRule, { backgroundColor: p.ruleOnFieldStrong }]} />
      {width > 0 ? (
        <View style={styles.band} pointerEvents="none">
          <GuillocheBand width={width} height={14} lines={5} opacity={0.3} />
        </View>
      ) : null}

      <View style={styles.row} onLayout={onLayout} accessibilityRole="tablist">
        {slot > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.mark, { backgroundColor: p.onFieldLatent }, mark]}
          />
        ) : null}

        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const label =
            typeof options.tabBarLabel === 'string'
              ? options.tabBarLabel
              : (options.title ?? route.name);
          const focused = state.index === index;

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (focused || event.defaultPrevented) return;
            haptic.select();
            navigation.navigate(route.name);
          };

          return (
            <Press
              key={route.key}
              onPress={onPress}
              onLongPress={() =>
                navigation.emit({ type: 'tabLongPress', target: route.key })
              }
              depth="none"
              ink={false}
              style={styles.tab}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={label}
            >
              <View style={styles.tabBody}>
                <Icon
                  name={TAB_ICON[route.name] ?? 'passport'}
                  size={ICON}
                  color={focused ? p.onField : p.onFieldDim}
                  // Emphasis by line weight, the way an engraved mark does it.
                  // Both values are up: at 1.4 the inactive glyphs were nearly
                  // invisible against the field on a real screen.
                  weight={focused ? 2.2 : 1.7}
                />
                <Text
                  role="legendSm"
                  tone="inherit"
                  surface="field"
                  numberOfLines={1}
                  // The one place a label legitimately cannot grow: four
                  // destinations share one screen width, so the bar caps the
                  // legend's scale rather than letting it wrap or clip. The labels
                  // are single short words chosen to survive it.
                  maxFontSizeMultiplier={1.2}
                  style={{ color: focused ? p.onField : p.onFieldDim }}
                >
                  {label.toUpperCase()}
                </Text>
              </View>
            </Press>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  topRule: { height: Hairline.base, width: '100%' },
  band: { position: 'absolute', top: 0, left: 0, right: 0, opacity: 0.9 },
  row: { flexDirection: 'row', height: BAR_HEIGHT },
  mark: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: MARK_WIDTH,
    // 3, not 2. A 2dp gold thread over a dark field is a hairline the eye skips;
    // this is the only thing marking which destination you are on.
    height: 3,
    borderBottomLeftRadius: 1.5,
    borderBottomRightRadius: 1.5,
  },
  tab: { flex: 1 },
  tabBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.xs,
    // Clears the gold mark and the guilloche band along the bar's top rule, so
    // the glyph is not sitting on top of the ornament.
    paddingTop: Space.md,
    paddingBottom: Space.xs,
  },
});
