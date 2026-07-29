/**
 * The score meter.
 *
 * The incumbent's core decision is kept, and it was the right one: a LINEAR
 * 300–900 axis rather than an arc, so the confidence interval can be shown as a
 * range at the same scale as the score itself. On an arc the band becomes a second
 * ring the eye reads as decoration, and M2's whole position is that thin data must
 * visibly produce a wide band. That reasoning survives intact.
 *
 * What changes is that it is now drawn as an instrument rather than a progress
 * pill: an engraved scale with the band cutoffs as real ticks read from the
 * model's own versioned bands, the value counting up to itself, and the interval
 * growing outward from the value so it is never momentarily narrower than the
 * truth. The number is the note's latent image, so it arrives in the display face.
 */
import { useEffect } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import type { ComputedScore } from '@/api';
import { FieldValue, Legend, Micro, Notice, Text } from '@/components/ui';
import {
  Hairline,
  MaxScale,
  Motion,
  Radius,
  Space,
  Type,
  platformFamily,
  useBand,
  useMotionOk,
  usePalette,
} from '@/theme';
import {
  SCORE_BAND_META,
  SCORE_MAX,
  SCORE_MIN,
  bandMeta,
  scoreFraction,
} from '@/features/score/score-meta';

const TRACK = 10;
const MARKER = 3;

/**
 * The score counting up to itself.
 *
 * Driven through `useAnimatedProps` on a `TextInput` rather than by setting React
 * state on every frame. Two reasons: the interpolation stays on the UI thread, so
 * it does not compete with the scroll on a mid-range Android; and a `value` prop
 * can be written imperatively, which a `<Text>`'s children cannot.
 *
 * The input is `editable={false}` and non-focusable — it is a text renderer here,
 * not a field. It is also hidden from assistive tech, because the meter's own
 * `accessibilityLabel` already states the final value and a screen reader must
 * hear that once, not sixty times.
 */
function CountUp({
  to,
  ink,
  progress,
}: {
  to: number | null;
  ink: string;
  progress: SharedValue<number>;
}) {
  const animatedProps = useAnimatedProps(() => ({
    text: to == null ? '—' : String(Math.round(to * progress.value)),
    // Required by the TextInput prop types on web; harmless on native.
    defaultValue: to == null ? '—' : String(to),
  })) as Partial<{ text: string; defaultValue: string }>;

  return (
    <AnimatedTextInput
      editable={false}
      focusable={false}
      // Inline by necessity: this is the animated target Reanimated writes into.
      style={[
        Type.value,
        { fontFamily: platformFamily(Type.value.fontFamily), color: ink },
        styles.countUp,
      ]}
      maxFontSizeMultiplier={MaxScale.value}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      animatedProps={animatedProps}
      value={to == null ? '—' : String(to)}
    />
  );
}

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

export function ScoreMeter({ score }: { score: ComputedScore }) {
  const p = usePalette();
  const bandInk = useBand();
  const motionOk = useMotionOk();

  const meta = bandMeta(score.band);
  const ink = bandInk(score.band);
  const value = score.value ?? SCORE_MIN;

  const low = score.bandLow ?? value;
  const high = score.bandHigh ?? value;

  const t = useSharedValue(motionOk ? 0 : 1);
  useEffect(() => {
    t.value = motionOk
      ? withTiming(1, {
          duration: Motion.duration.value,
          easing: Easing.bezier(...Motion.out),
        })
      : 1;
  }, [motionOk, t, value]);

  const centre = scoreFraction(value) * 100;
  const from = scoreFraction(low) * 100;
  const to = scoreFraction(high) * 100;

  // The interval opens OUTWARD from the value rather than sliding in from the
  // left. At no frame is it narrower than the truth, which a left-to-right fill
  // would be for most of its run — and understating uncertainty, even for 900ms,
  // is the one thing this component exists not to do.
  const interval = useAnimatedStyle(() => ({
    left: `${centre - (centre - from) * t.value}%`,
    // No `Math.max(1, …)` floor. A 1% minimum meant the first frames drew an
    // interval NARROWER than the truth, which is the single thing this component
    // exists not to do — an understated uncertainty is a lie even for 900ms. At
    // t=0 the width is genuinely 0 and the marker alone is visible.
    width: `${(to - from) * t.value}%`,
  }));
  const marker = useAnimatedStyle(() => ({
    left: `${centre}%`,
    opacity: t.value,
  }));
  const headline = useAnimatedStyle(() => ({ opacity: t.value }));

  // Cutoffs come from the model version's OWN bands, because they are versioned
  // and travel with the credential to M3.
  const cutoffs = score.model.bands.length
    ? score.model.bands
    : Object.keys(SCORE_BAND_META).map((band, i, all) => ({
        min: SCORE_MIN + (i * (SCORE_MAX - SCORE_MIN)) / all.length,
        max: SCORE_MIN + ((i + 1) * (SCORE_MAX - SCORE_MIN)) / all.length,
        band: band as keyof typeof SCORE_BAND_META,
      }));

  return (
    <View style={styles.wrap}>
      <Animated.View style={[styles.headline, headline]}>
        {/* The value ARRIVING, not being asserted. `Type.value` carries
            `tabular-nums` precisely so the digits hold their column while it
            counts — that comment existed before anything counted. */}
        <CountUp to={score.value} ink={ink} progress={t} />
        <View style={styles.headlineMeta}>
          <Legend tone="inherit" style={{ color: ink }}>
            {meta.label}
          </Legend>
          <Micro tone="faint">of {SCORE_MAX}</Micro>
        </View>
      </Animated.View>

      <Text role="bodySm" tone="dim" style={styles.blurb}>
        {meta.blurb}
      </Text>

      {/* The axis */}
      <View
        style={styles.axis}
        accessibilityRole="progressbar"
        accessibilityLabel={`Reputation score ${score.value ?? 'unavailable'} of ${SCORE_MAX}, band ${meta.label}. Likely between ${low} and ${high}.`}
        accessibilityValue={{ min: SCORE_MIN, max: SCORE_MAX, now: value }}
      >
        <View style={[styles.track, { backgroundColor: p.groundSunk, borderColor: p.rule }]}>
          {cutoffs.map((c) => (
            <View
              key={c.band}
              style={[
                styles.segment,
                { flex: Math.max(1, c.max - c.min), borderRightColor: p.rule },
              ]}
            >
              {/* The band the score sits in is the only one filled; the rest are
                  the scale, not five competing colour blocks. Tinted with a real
                  `opacity` on a solid fill rather than a `${ink}2E` hex-alpha
                  string — an interpolated alpha is invisible to the contrast
                  verifier, and string-building colours is the exact pattern the
                  incumbent palette was replaced for. */}
              {c.band === score.band ? (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: ink, opacity: 0.18 }]} />
              ) : null}
            </View>
          ))}
        </View>

        {/* The confidence interval — the honest width of the estimate. Its fill is
            a child at a real opacity so the band's own ink shows through without
            building a colour out of a string. */}
        <Animated.View style={[styles.interval, { borderColor: ink }, interval]}>
          <View style={[StyleSheet.absoluteFill, { backgroundColor: ink, opacity: 0.34 }]} />
        </Animated.View>

        {/* The value itself: a hairline needle, the way an instrument marks a
            reading. A round dot would sit on top of the interval and hide it. */}
        <Animated.View style={[styles.marker, { backgroundColor: ink }, marker]} />
      </View>

      <View style={styles.scale}>
        <FieldValue role="fieldSm" tone="faint">
          {String(SCORE_MIN)}
        </FieldValue>
        <FieldValue role="fieldSm" tone="faint">
          {String(SCORE_MAX)}
        </FieldValue>
      </View>

      {/* Confidence, in words AND as a range. Never buried. */}
      <View style={[styles.confidence, { borderTopColor: p.rule }]}>
        <Legend small tone="faint">
          Confidence
        </Legend>
        <Text role="bodySm" tone="dim">
          {score.confidenceLabel} — likely between{' '}
          <Text role="bodySmMedium" tone="default">
            {low}
          </Text>{' '}
          and{' '}
          <Text role="bodySmMedium" tone="default">
            {high}
          </Text>
          .
        </Text>
        {score.coverageLabel ? (
          <Micro>
            {score.coverageLabel}
            {score.missingCount > 0
              ? ` · ${score.missingCount} input${score.missingCount === 1 ? '' : 's'} estimated rather than measured`
              : ''}
          </Micro>
        ) : null}
      </View>

      {score.isOverridden && score.override ? (
        <Notice tone="caution" title="Reviewed by a person">
          {`A senior reviewer set this band to ${bandMeta(score.override.band).label}. Reason on file: ${score.override.reason}`}
        </Notice>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Space.lg },
  headline: { flexDirection: 'row', alignItems: 'flex-end', gap: Space.lg },
  // A TextInput brings its own platform padding and a minimum width; strip both
  // so it sets exactly like the Text it stands in for.
  countUp: { padding: 0, margin: 0, minWidth: 132 },
  headlineMeta: { gap: 2, paddingBottom: Space.sm },
  blurb: { maxWidth: 420 },

  axis: { justifyContent: 'center', height: 22, marginTop: Space.xs },
  track: {
    flexDirection: 'row',
    height: TRACK,
    borderRadius: Radius.sm,
    borderWidth: Hairline.base,
    overflow: 'hidden',
  },
  segment: { borderRightWidth: Hairline.base },
  interval: {
    position: 'absolute',
    height: TRACK,
    borderRadius: Radius.sm,
    borderWidth: Hairline.base,
  },
  marker: {
    position: 'absolute',
    width: MARKER,
    height: 22,
    borderRadius: 1,
    marginLeft: -MARKER / 2,
  },
  scale: { flexDirection: 'row', justifyContent: 'space-between' },
  confidence: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.md,
    gap: Space.xs,
  },
});
