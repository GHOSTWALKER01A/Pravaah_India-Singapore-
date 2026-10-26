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
import { Fragment, useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// From expo-router's vendored React Navigation — it no longer depends on the upstream
// `@react-navigation/bottom-tabs`, so that package is not guaranteed to be installed.
import type { BottomTabBarProps } from 'expo-router/tabs';

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
  pay: 'pay',
  insurance: 'shield',
};

/**
 * Where the raised scan control sits: after this many destinations.
 *
 * Two, so the bar reads `Passport · Verify · ⟨SCAN⟩ · Pay · Bearer` with the action at the true
 * centre — the position a right thumb reaches without moving the hand, and where every Indian
 * payments app has trained this gesture.
 */
const SCAN_AFTER = 2;

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

export function TabBar({
  state,
  descriptors,
  navigation,
  onScan,
}: BottomTabBarProps & { onScan?: () => void }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const motionOk = useMotionOk();
  const [width, setWidth] = useState(0);

  /**
   * The scan control occupies a slot in the row, so the thread mark's arithmetic has to account for
   * it or the mark drifts off the destination it is marking.
   *
   * `slots` is destinations + 1; a destination at or past `SCAN_AFTER` is pushed one slot right.
   */
  const count = state.routes.length;
  const slots = count + (onScan ? 1 : 0);
  const slot = width > 0 ? width / slots : 0;
  const x = useSharedValue(0);

  const onLayout = (e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  };

  const markSlot =
    onScan && state.index >= SCAN_AFTER ? state.index + 1 : state.index;
  const target = slot > 0 ? markSlot * slot + (slot - MARK_WIDTH) / 2 : 0;
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
          const scanHere = onScan && index === SCAN_AFTER;
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
            <Fragment key={route.key}>
              {scanHere ? <ScanControl onPress={onScan} /> : null}
              <TabItem 
                route={route} 
                focused={focused} 
                label={label} 
                onPress={onPress} 
                onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
              />
            </Fragment>
          );
        })}
      </View>
    </View>
  );
}

function TabItem({ route, focused, label, onPress, onLongPress }: any) {
  const p = usePalette();
  
  // Spring animation for focused tab
  const scale = useSharedValue(focused ? 1.15 : 1);
  useEffect(() => {
    scale.value = withSpring(focused ? 1.15 : 1, { damping: 12, stiffness: 200 });
  }, [focused, scale]);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Press
      onPress={onPress}
      onLongPress={onLongPress}
      depth="none"
      ink={false}
      style={styles.tab}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
    >
      <Animated.View style={[styles.tabBody, animatedStyle]}>
        <Icon
          name={TAB_ICON[route.name] ?? 'passport'}
          size={ICON}
          color={focused ? p.onField : p.onFieldDim}
          weight={focused ? 2.2 : 1.7}
        />
        <Text
          role="legendSm"
          tone="inherit"
          surface="field"
          numberOfLines={1}
          maxFontSizeMultiplier={1.2}
          style={{ color: focused ? p.onField : p.onFieldDim }}
        >
          {label.toUpperCase()}
        </Text>
      </Animated.View>
    </Press>
  );
}

/**
 * The raised scan control.
 *
 * **It is an ACTION, not a destination, and it is built to read as one.** iOS HIG is explicit that
 * tab bar items are sections and never actions, and Material reserves the single primary action for a
 * FAB. Both rules exist to stop a user believing a button will take them somewhere they can come back
 * from. So this deliberately breaks every visual convention the four tabs share: it is raised above
 * the bar's own line, it is a filled gold disc rather than a stroked glyph, it carries no legend in
 * the tab labels' row, and its accessibility role is `button` inside a `tablist` that never claims it
 * as selected. A screen reader announces four tabs and one button, which is the truth.
 *
 * It is here rather than as a corner FAB because the scan is the most-reached-for action in this
 * market and the centre-bottom position is where a right thumb rests — and because a floating corner
 * button would sit over the counterfoil list it is meant to sit beside.
 *
 * The 56dp disc plus its 8dp lift clears the 48dp floor with room to spare, and the lift is what keeps
 * ≥8dp of separation from the two destinations it sits between.
 */
function ScanControl({ onPress }: { onPress: () => void }) {
  const p = usePalette();

  return (
    <View style={styles.scanSlot}>
      <Press
        onPress={onPress}
        feedback="select"
        depth="full"
        radius={28}
        ink={false}
        style={[
          styles.scanDisc,
          { backgroundColor: p.onFieldLatent, borderColor: p.fieldDeep },
        ]}
        accessibilityRole="button"
        accessibilityLabel="Scan a code to pay"
        accessibilityHint="Opens the camera"
      >
        {/* On the gold disc the glyph takes the deepest field colour.
            Size 28 and weight 2.4 so the viewfinder brackets read
            cleanly against the filled background at any screen density. */}
        <Icon name="scan" size={28} color={p.fieldDeep} weight={2.4} />
      </Press>
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
  scanSlot: {
    flex: 1,
    alignItems: 'center',
    // Lifted so the disc breaks the bar's top rule — the visual statement that it is not one of the
    // four marks along that rule.
    justifyContent: 'flex-start',
    paddingTop: 0,
  },
  scanDisc: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    // Rises above the bar. The ring in the deepest field colour is what separates the gold from the
    // field behind it so the disc has an edge in both themes.
    marginTop: -18,
    borderWidth: 3,
  },
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
