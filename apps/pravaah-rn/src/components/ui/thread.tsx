/**
 * The security thread.
 *
 * On the web the thread draws down the capture column as the page scrolls. In the
 * app it is the structure of every SEQUENCE: the KYC checks, the consent phases,
 * the steps of a rail. One unbroken line with a seal on it per step — which is
 * what a chain of trust actually looks like, and what a list of six identical
 * cards cannot say.
 *
 * The segment above the live step is gold (drawn, impressed); below it, the
 * hairline rule (drawn, not yet impressed). That single distinction carries the
 * user's progress without a percentage, a counter, or a progress bar.
 */
import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Hairline, Space, toneColor, useIsDark, usePalette } from '@/theme';
import type { SealShape, StatusTone } from '@/theme';

import { Seal } from './seal';

/** Where a step sits relative to the live head of the thread. */
export type StepPosition = 'done' | 'live' | 'ahead';

export interface ThreadStepProps {
  tone: StatusTone;
  shape: SealShape;
  position: StepPosition;
  /** True for the last step, so the thread terminates instead of running on. */
  last?: boolean;
  /** Animate the seal's index. Only when work is genuinely in flight. */
  live?: boolean;
  children: ReactNode;
}

/** The width of the rail column. The seal centres in it. */
const RAIL = 26;
const SEAL = 18;

export function ThreadStep({
  tone,
  shape,
  position,
  last = false,
  live = false,
  children,
}: ThreadStepProps) {
  const p = usePalette();
  const dark = useIsDark();
  const { ink } = toneColor(tone, p);

  // The thread is impressed up to and including the live step, and merely drawn
  // beyond it. `done` and `live` both read as impressed because the user has
  // reached them.
  const impressed = position !== 'ahead';

  /**
   * The un-impressed run needs its own value in dark mode.
   *
   * `rule` is 1.55:1 on the dark ground, so the thread visibly STOPPED at the live
   * step and the steps ahead floated unconnected — against 5.63:1 for the
   * impressed run, a 3.6× gap that read as a broken line rather than a quieter
   * one. `ruleOnFieldStrong` on the dark ground is legible while still clearly
   * subordinate to the gold, which is the distinction the thread is making.
   */
  const drawn = dark ? p.ruleOnFieldStrong : p.rule;

  return (
    <View style={styles.step}>
      <View style={styles.rail}>
        {/* The run above this seal. Absent on the first step by construction:
            the parent renders steps in order and the first has nothing above. */}
        <View
          style={[
            styles.runAbove,
            { backgroundColor: impressed ? p.latentLine : drawn },
          ]}
        />
        <Seal shape={shape} size={SEAL} color={ink} voidColor={p.ground} live={live} />
        {!last ? (
          <View
            style={[
              styles.runBelow,
              // The run BELOW a live step is not yet impressed — the user has not
              // been there. Only a completed step lights its outgoing thread.
              { backgroundColor: position === 'done' ? p.latentLine : drawn },
            ]}
          />
        ) : null}
      </View>

      <View style={[styles.body, last && styles.bodyLast]}>{children}</View>
    </View>
  );
}

/**
 * The container. Clips the first step's incoming run so the thread starts AT the
 * first seal rather than above it — a thread that begins in mid-air reads as a
 * list that got cut off.
 */
export function Thread({ children }: { children: ReactNode }) {
  return <View style={styles.thread}>{children}</View>;
}

const styles = StyleSheet.create({
  thread: { overflow: 'hidden' },
  step: { flexDirection: 'row', gap: Space.md },
  rail: { width: RAIL, alignItems: 'center' },
  runAbove: {
    position: 'absolute',
    top: -Space.xxl,
    height: Space.xxl,
    width: Hairline.thick,
  },
  runBelow: {
    flex: 1,
    width: Hairline.thick,
    marginTop: Space.xs,
    minHeight: Space.lg,
  },
  body: { flex: 1, paddingBottom: Space.xl, gap: Space.xs },
  bodyLast: { paddingBottom: 0 },
});
