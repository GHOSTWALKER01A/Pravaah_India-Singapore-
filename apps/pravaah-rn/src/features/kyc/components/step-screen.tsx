/**
 * The frame every verification step shares.
 *
 * All seven step screens repeated the same four things by hand: a
 * `<Stack.Screen options={{title}}/>`, a `<FlowProgress>`, a `type="title"`
 * heading with a `type="small"` explanation, and an ad-hoc red error line. They
 * drifted — some had the explanation, some did not; the error was `<ThemedText
 * style={{color: Brand.danger}}>` in six files and a bordered notice in one.
 *
 * Consolidating them also lets one decision apply everywhere: the step's PURPOSE
 * is stated above the fold, before anything is asked for, and the reassurance that
 * a borderline result goes to a person rather than an auto-rejection is attached
 * to the steps where that is true.
 */
import { Stack } from 'expo-router';
import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { CheckType, KycProfileStatus } from '@/api';
import { Header, Icon, Micro, Notice, Screen, Text } from '@/components/ui';
import { Space, usePalette } from '@/theme';

import { CHECK_META } from '../check-labels';
import { FlowProgress } from './flow-progress';

export function StepScreen({
  check,
  status,
  title,
  lede,
  error,
  onRetry,
  /** The one-line promise about what happens if this check is borderline. */
  assurance,
  /** Pinned above the safe-area inset, for the step's primary action. */
  footer,
  children,
}: {
  check: CheckType;
  status: KycProfileStatus | null;
  title: string;
  lede: string;
  error?: string | null;
  onRetry?: () => void;
  assurance?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const p = usePalette();

  return (
    <Screen footer={footer}>
      <Stack.Screen options={{ title: CHECK_META[check]?.label ?? title }} />

      <View style={styles.sheet}>
        {/* The tracker is the first thing on the screen: someone six steps into a
            flow needs to know where they are before they read anything else. */}
        {status ? <FlowProgress status={status} current={check} /> : null}

        <Header title={title} lede={lede} />

        {error ? (
          <Notice
            tone="error"
            action={onRetry ? 'Try again' : undefined}
            onAction={onRetry}
          >
            {error}
          </Notice>
        ) : null}

        <View style={styles.body}>{children}</View>

        {assurance ? (
          <View style={[styles.assurance, { borderTopColor: p.rule }]}>
            <Icon name="lock" size={13} color={p.inkFaint} weight={1.3} />
            <Micro style={styles.flex}>{assurance}</Micro>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

/**
 * A "what this actually does" block, for steps where the mechanism is the
 * reassurance — which, for this audience, is most of them.
 */
export function Mechanism({ lines }: { lines: string[] }) {
  const p = usePalette();
  return (
    <View style={styles.mechanism}>
      {lines.map((line, i) => (
        <View key={line} style={styles.mechanismRow}>
          <Text role="fieldSm" tone="faint" style={styles.mechanismIndex}>
            {String(i + 1).padStart(2, '0')}
          </Text>
          <Text role="bodySm" tone="dim" style={styles.flex}>
            {line}
          </Text>
        </View>
      ))}
      <View style={[styles.mechanismRule, { backgroundColor: p.rule }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl, paddingTop: Space.sm },
  body: { gap: Space.lg },
  // Follows the step's content rather than being pinned to the bottom. See the
  // note on send-otp's `assurance` style.
  assurance: {
    flexDirection: 'row',
    gap: Space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.lg,
  },
  flex: { flex: 1 },
  mechanism: { gap: Space.md },
  mechanismRow: { flexDirection: 'row', gap: Space.md, alignItems: 'flex-start' },
  // Ordered numbering earned: these are the steps of a mechanism in sequence.
  mechanismIndex: { width: 22, paddingTop: 2 },
  mechanismRule: { height: StyleSheet.hairlineWidth, marginTop: Space.xs },
});
