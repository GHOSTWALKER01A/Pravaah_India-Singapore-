/**
 * An inline notice: an error, a caution, a confirmation, a sandbox marker.
 *
 * The incumbent app hand-rolled this shape in six files — `(tabs)/kyc.tsx`,
 * `reputation-screen.tsx`, `consent/index.tsx` and others — each with its own
 * `borderColor: `${Brand.danger}55`` string interpolation and its own copy of the
 * "Try again" link. They drifted: some had a retry, some did not, none announced
 * themselves to a screen reader, and the 55-alpha border on a fixed hex meant the
 * caution and the error looked nearly identical in dark mode.
 *
 * One component, four tones, and an error announces itself.
 */
import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Hairline, HitSize, Radius, Space, usePalette } from '@/theme';

import { Icon, type IconName } from './icon';
import { Press } from './pressable';
import { Text } from './text';

export type NoticeTone = 'error' | 'caution' | 'cleared' | 'sandbox';

const TONE_ICON: Record<NoticeTone, IconName> = {
  error: 'alert',
  caution: 'info',
  cleared: 'check',
  sandbox: 'sandbox',
};

export function Notice({
  tone,
  title,
  children,
  /** A single recovery action. Its label names the action, never "OK". */
  action,
  onAction,
}: {
  tone: NoticeTone;
  /** Optional: a one-line notice needs no title, and a title-only notice is noise. */
  title?: string;
  children?: ReactNode;
  action?: string;
  onAction?: () => void;
}) {
  const p = usePalette();

  const ink =
    tone === 'error'
      ? p.carmine
      : tone === 'cleared'
        ? p.cleared
        : tone === 'sandbox'
          ? p.inkDim
          : p.latent;

  const wash =
    tone === 'error'
      ? p.carmineWash
      : tone === 'cleared'
        ? p.fieldWash
        : tone === 'sandbox'
          ? 'transparent'
          : p.latentWash;

  return (
    <View
      style={[
        styles.notice,
        {
          backgroundColor: wash,
          borderColor: ink,
          // A sandbox marker is a label on the workbench, not an alert: it gets a
          // dashed keyline so it never reads as a state the user caused.
          borderStyle: tone === 'sandbox' ? 'dashed' : 'solid',
        },
      ]}
      // Only a genuine error interrupts a screen reader. A caution is read in turn.
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'none'}
    >
      <View style={styles.head}>
        <View style={styles.glyph}>
          <Icon name={TONE_ICON[tone]} size={16} color={ink} weight={1.6} />
        </View>
        <View style={styles.body}>
          {title ? (
            <Text role="title" tone="inherit" style={{ color: ink }}>
              {title}
            </Text>
          ) : null}
          {typeof children === 'string' ? (
            <Text role="bodySm" tone={title ? 'dim' : 'inherit'} style={title ? undefined : { color: ink }}>
              {children}
            </Text>
          ) : (
            children
          )}
        </View>
      </View>

      {action && onAction ? (
        <View style={styles.action}>
          <Press
            onPress={onAction}
            depth="subtle"
            radius={Radius.sm}
            accessibilityRole="button"
            accessibilityLabel={action}
            style={styles.actionPress}
          >
            <View style={styles.actionBody}>
              <Text role="label" tone="inherit" style={{ color: ink }}>
                {action}
              </Text>
              <Icon name="chevronRight" size={14} color={ink} weight={1.8} />
            </View>
          </Press>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    borderRadius: Radius.md,
    borderWidth: Hairline.base,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    gap: Space.xs,
  },
  head: { flexDirection: 'row', gap: Space.md },
  // Nudged down to sit on the first text line's optical centre rather than its box.
  glyph: { paddingTop: 3 },
  body: { flex: 1, gap: 2 },
  action: { alignSelf: 'flex-start', marginLeft: 16 + Space.md },
  actionPress: { alignSelf: 'flex-start' },
  actionBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    // The recovery action on every error in the app. It meets the 48dp floor.
    minHeight: HitSize,
    paddingRight: Space.sm,
  },
});
