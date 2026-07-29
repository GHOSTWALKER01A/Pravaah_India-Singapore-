/**
 * The screen frame.
 *
 * The incumbent `Screen` was a `SafeAreaView edges={['top','bottom']}` wrapping a
 * `ScrollView` with `paddingHorizontal: 24, paddingVertical: 24, gap: 24`. Four
 * problems, all of which the user feels:
 *
 *   1. `edges={['bottom']}` inset the content AND the tab bar drew over it, so the
 *      last control on every long screen sat under the tab bar.
 *   2. No keyboard handling at all. On the bank screen (three fields) the keyboard
 *      covered the submit button with no way to scroll to it.
 *   3. No pull-to-refresh, on an app whose primary screens poll a status the user
 *      is waiting on — so the only way to force a check was to switch tabs.
 *   4. `gap: 24` on the container forced every screen into the same undifferentiated
 *      rhythm; a heading could not sit closer to its own content than to the next
 *      section.
 *
 * This frame handles insets per edge, avoids the keyboard, offers refresh, and
 * deliberately sets NO gap — spacing is the screen's own composition.
 */
import { type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Gutter, MaxSheetWidth, Space, usePalette } from '@/theme';
import { useAuth } from '@/context/auth-context';

import { BAR_HEIGHT } from './tab-bar';
import { ProfileAvatar } from './profile-avatar';

export interface ScreenProps {
  children: ReactNode;
  scroll?: boolean;
  /** Pull-to-refresh. Omit on screens with nothing to re-fetch. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /**
   * Leave room for the custom tab bar. True on the four tab screens; false on a
   * pushed stack screen, which has no tab bar over it.
   */
  tabBar?: boolean;
  /** Remove the horizontal gutter, for a full-bleed field region. */
  bleed?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  /** Pinned to the bottom above the inset — a primary action that must stay put. */
  footer?: ReactNode;
  /** Show the global profile avatar at the top right. Defaults to true. */
  showProfile?: boolean;
}

/**
 * Re-exported from the tab bar rather than duplicated, so the value a screen
 * reserves and the value the bar occupies cannot drift apart.
 */
export { BAR_HEIGHT as TAB_BAR_HEIGHT } from './tab-bar';

export function Screen({
  children,
  scroll = true,
  onRefresh,
  refreshing = false,
  tabBar = false,
  bleed = false,
  contentStyle,
  footer,
  showProfile = false,
}: ScreenProps) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useAuth();
  
  const shouldRenderProfile = showProfile && isAuthenticated;

  // Bottom room = the system inset, plus the tab bar when one is over this screen,
  // plus a breath so the last element is not flush against either.
  const bottomPad = (tabBar ? BAR_HEIGHT : 0) + (footer ? 0 : insets.bottom) + Space.xxl;

  const body = (
    <View
      style={[
        styles.sheet,
        !bleed && { paddingHorizontal: Gutter },
        contentStyle,
      ]}
    >
      {shouldRenderProfile ? (
        <View style={styles.profileRow}>
          <ProfileAvatar />
        </View>
      ) : null}
      {children}
    </View>
  );

  return (
    <View style={[styles.fill, { backgroundColor: p.ground }]}>
      <KeyboardAvoidingView
        style={styles.fill}
        // iOS moves the whole view; Android's windowSoftInputMode already resizes
        // it, and doubling that up pushes content off the top of the screen.
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {scroll ? (
          <ScrollView
            style={styles.fill}
            contentContainerStyle={[
              styles.scroll,
              { paddingTop: insets.top + Space.sm, paddingBottom: bottomPad },
            ]}
            keyboardShouldPersistTaps="handled"
            // So a tap on the submit button dismisses the keyboard and presses it,
            // rather than only dismissing.
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
            refreshControl={
              onRefresh ? (
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  tintColor={p.latent}
                  colors={[p.latent]}
                  progressBackgroundColor={p.panel}
                />
              ) : undefined
            }
          >
            {body}
          </ScrollView>
        ) : (
          <View
            style={[
              styles.fill,
              { paddingTop: insets.top + Space.sm, paddingBottom: bottomPad },
            ]}
          >
            {body}
          </View>
        )}

        {/**
         * The status-bar scrim.
         *
         * Edge-to-edge means the sheet scrolls UNDER the system bar, so a Bodoni
         * title riding up collided with the clock and the signal icons — two sets
         * of text overlapping, which reads as a rendering fault rather than as
         * depth. An opaque band of the sheet's own ground sits between them: the
         * content passes behind the bar instead of through it, and the bar's icons
         * keep the contrast `StatusBar` was told to give them.
         *
         * Drawn last so it stacks above the ScrollView, and non-interactive so it
         * never eats a touch meant for the content beneath.
         */}
        {scroll && insets.top > 0 ? (
          <View
            pointerEvents="none"
            style={[styles.statusScrim, { height: insets.top, backgroundColor: p.ground }]}
          />
        ) : null}

        {footer ? (
          <View
            style={[
              styles.footer,
              {
                backgroundColor: p.ground,
                borderTopColor: p.rule,
                // Clears the tab bar too when a screen has both. No screen does
                // today, but the absolute tab bar would otherwise draw straight
                // over a pinned primary action.
                paddingBottom: insets.bottom + Space.md + (tabBar ? BAR_HEIGHT : 0),
              },
            ]}
          >
            <View style={styles.footerInner}>{footer}</View>
          </View>
        ) : null}

      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scroll: { flexGrow: 1, alignItems: 'center' },
  statusScrim: { position: 'absolute', top: 0, left: 0, right: 0 },
  /**
   * `flexGrow: 1`, never `flex: 1`.
   *
   * `flex: 1` is `flexBasis: 0`, which inside a `flexGrow: 1` contentContainer
   * sizes the sheet purely from the viewport's free space. Content taller than the
   * viewport then overflowed a box whose height WAS the viewport, so `contentSize`
   * never grew and the ScrollView had nothing to scroll — on a small screen or at
   * a large OS font size that put the primary action out of reach, including on
   * the sign-in screen. `flexGrow` keeps `flexBasis: auto`: still fills when the
   * content is short, no longer caps it when the content is long.
   *
   * `maxWidth` so a tablet gets a centred sheet, not a 1000dp line of text.
   */
  sheet: { width: '100%', maxWidth: MaxSheetWidth, flexGrow: 1 },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Gutter,
    paddingTop: Space.md,
    alignItems: 'center',
  },
  footerInner: { width: '100%', maxWidth: MaxSheetWidth },
  profileRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: Space.sm,
  },
});
