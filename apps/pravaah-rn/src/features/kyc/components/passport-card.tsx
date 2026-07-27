/**
 * The passport — the note itself.
 *
 * What it replaces: a flat `Brand.primary` indigo rectangle with a 48pt name, a
 * status pill, and two columns reading "Region: INDIA" and "Trust score: —".
 *
 * The direction contract calls this the first viewport and the thesis: a
 * credential the holder POSSESSES, not a status record we grant them a view of.
 * Everything here serves that:
 *
 *   - it is a fixed-ratio object with its own margins, guilloche, medallion and
 *     serial, not a container that stretches to its content;
 *   - the holder's name is the largest thing on it, in the engraved display face;
 *   - the corridor is stated as a corridor (IN ↔ SG), because the whole product is
 *     that the credential crosses;
 *   - and the score is a LATENT panel: hold the note and it resolves, the way a
 *     note tilted to the light resolves its watermark. That is the one authored
 *     motion in the app, and it is the only interaction that reveals rather than
 *     navigates.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import type { Country, KycProfileStatus } from '@/api';
import {
  CornerMedallion,
  FieldValue,
  GuillocheBand,
  Legend,
  Micro,
  Rule,
  StatusMark,
  Text,
  haptic,
} from '@/components/ui';
import { APP_NAME } from '@/constants/ui.constants';
import {
  Elevation,
  Motion,
  Radius,
  Space,
  useMotionOk,
  usePalette,
} from '@/theme';

/** The corridor legend. The product is the arrow, so the arrow is shown. */
const CORRIDOR: Record<Country, string> = {
  INDIA: 'IN',
  SINGAPORE: 'SG',
  BOTH: 'IN ↔ SG',
};

export interface PassportCardProps {
  status: KycProfileStatus;
  /** The user's permanent public identifier, printed as the note's serial. */
  pravaahId?: string | null;
  /**
   * The M2 reputation score. When present the note carries a latent panel; when
   * absent it does not, because an empty latent panel promising a reveal that
   * shows nothing is worse than no panel at all.
   */
  score?: { value: number | null; label: string; low: number; high: number } | null;
  /** Fired when the latent panel is fully revealed — the passport opens the score. */
  onOpenScore?: () => void;
}

export function PassportCard({
  status,
  pravaahId,
  score,
  onOpenScore,
}: PassportCardProps) {
  const p = usePalette();
  const motionOk = useMotionOk();
  // The note's measured width, so the base guilloche is generated to fit it.
  const [width, setWidth] = useState(0);

  const hasLatent = score != null && score.value != null;
  const reveal = useSharedValue(0);

  // Under Reduce Motion the latent panel is simply always resolved. The content
  // is never hidden waiting for an interaction the user cannot perform.
  useEffect(() => {
    if (!motionOk) reveal.value = 1;
  }, [motionOk, reveal]);

  const hold = useCallback(() => {
    if (!hasLatent || !motionOk) return;
    haptic.commit();
    reveal.value = withTiming(1, {
      duration: Motion.duration.reveal,
      easing: Easing.bezier(...Motion.out),
    });
  }, [hasLatent, motionOk, reveal]);

  const release = useCallback(() => {
    if (!hasLatent || !motionOk) return;
    reveal.value = withTiming(0, { duration: Motion.duration.base });
  }, [hasLatent, motionOk, reveal]);

  // The latent image resolving: the value fades up and settles, while the prompt
  // beneath it fades away. Two layers crossfading in place — the panel never
  // changes height, so the note does not reflow as it is held.
  const latentValue = useAnimatedStyle(() => ({
    opacity: reveal.value,
    transform: [{ translateY: (1 - reveal.value) * 6 }],
  }));
  const latentPrompt = useAnimatedStyle(() => ({ opacity: 1 - reveal.value }));
  // The whole note brightens very slightly under the hold, as a note catching
  // the light does.
  const sheen = useAnimatedStyle(() => ({ opacity: reveal.value * 0.5 }));

  return (
    // The shadow lives on an OUTER wrapper, because the note itself needs
    // `overflow: hidden` to clip the medallion and the base band — and on iOS
    // `overflow: hidden` sets `masksToBounds`, which clips the shadow layer too.
    // Without the split the note has depth on Android and none on iOS, on the one
    // object the design calls "the note in the hand".
    <View style={[styles.lift, { shadowColor: p.shadow }, Elevation.note]}>
      <Pressable
        onLongPress={hold}
        onPressOut={release}
        // 300ms, not 140. At 140 a normal tap (typically 100–200ms) was a coin
        // flip between "navigate to the score" and "start a reveal that
        // immediately reverses" — the app's one authored interaction behaving
        // differently on nominally identical taps.
        delayLongPress={300}
        disabled={!hasLatent}
        accessibilityRole={hasLatent ? 'button' : 'summary'}
        accessibilityLabel={
          hasLatent
            ? `Reputation passport for ${status.verifiedName ?? 'unverified holder'}. Score ${score?.value}, ${score?.label}. Double tap to open your score.`
            : `Reputation passport for ${status.verifiedName ?? 'unverified holder'}`
        }
        // A screen reader cannot press-and-hold, so it gets the destination directly.
        onPress={hasLatent ? onOpenScore : undefined}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={[styles.note, { backgroundColor: p.field }]}
      >
        {/* Engraved ground: the medallion behind the content, band along the base. */}
        <CornerMedallion size={168} top={-38} right={-46} opacity={0.34} />
        <Animated.View
          pointerEvents="none"
          style={[styles.sheen, { backgroundColor: p.fieldMid }, sheen]}
        />

        {/* The issuing line, stacked, with the seal beside it.
            It used to be one long row — "PRAVAAH · REPUTATION PASSPORT" plus the
            status mark — which at any real device width pushed "VERIFIED" past the
            plate's right edge, where `overflow: hidden` cut it in half. A note
            prints its issuing authority as short stacked lines for exactly this
            reason, and the seal never shares their line box. */}
        <View style={styles.head}>
          <View style={styles.issuer}>
            <Legend small surface="field" tone="dim" numberOfLines={1}>
              {APP_NAME}
            </Legend>
            <Legend small surface="field" tone="dim" numberOfLines={1}>
              Reputation passport
            </Legend>
          </View>
          <StatusMark status={status.overallStatus} surface="field" size={15} />
        </View>

        <View style={styles.name}>
          <Text
            role="denomination"
            surface="field"
            numberOfLines={2}
            // iOS-only, and defeated by an explicit lineHeight, so it is a bonus
            // rather than the mechanism. What actually protects the layout is
            // `flexGrow` on the box plus the note's minHeight below.
            adjustsFontSizeToFit
            minimumFontScale={0.72}
          >
            {status.verifiedName ?? 'Not yet verified'}
          </Text>
        </View>

        {/* The latent panel. Present only when there is genuinely something to
            reveal — see the prop's note. */}
        {hasLatent ? (
          <View style={[styles.latent, { borderColor: p.ruleOnField }]}>
            <Animated.View style={[styles.latentLayer, latentPrompt]}>
              <Legend small surface="field" tone="latent">
                Hold to reveal
              </Legend>
            </Animated.View>

            <Animated.View style={[styles.latentLayer, styles.latentValue, latentValue]}>
              <Text role="valueSm" surface="field" tone="latent">
                {String(score?.value)}
              </Text>
              <View style={styles.latentMeta}>
                <Legend small surface="field" tone="latent">
                  {score!.label}
                </Legend>
                <Micro surface="field" tone="dim">
                  likely {score!.low}–{score!.high}
                </Micro>
              </View>
            </Animated.View>
          </View>
        ) : null}

        <View style={styles.foot}>
          <Rule onField />
          <View style={styles.footRow}>
            <View>
              <Legend small surface="field" tone="dim">
                Corridor
              </Legend>
              <FieldValue role="fieldSm" surface="field">
                {CORRIDOR[status.country]}
              </FieldValue>
            </View>

            <View style={styles.serial}>
              <Legend small surface="field" tone="dim">
                Serial
              </Legend>
              {/* Selectable so a long-press copies it — the number a holder reads
                  out to a lender. Not a copy button: the platform's own selection
                  is the interaction people already reach for. */}
              <FieldValue
                role="fieldSm"
                surface="field"
                selectable
                numberOfLines={1}
                // Android has no `adjustsFontSizeToFit`, so at a large OS text
                // size the serial would ellipsise — on the one string in the
                // product designed to be read aloud to a lender.
                maxFontSizeMultiplier={1.1}
              >
                {pravaahId ?? '—'}
              </FieldValue>
            </View>
          </View>
        </View>

        {/* Measured, not guessed. A hard-coded 520 threw away 38% of the generated
            geometry on a 360dp phone and left a tablet sheet's edge bare. */}
        {width > 0 ? (
          <View style={styles.band} pointerEvents="none">
            <GuillocheBand width={width} height={22} lines={7} opacity={0.28} />
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Carries only the shadow, so the note below can clip its own ornament.
  lift: { borderRadius: Radius.lg },
  note: {
    borderRadius: Radius.lg,
    padding: Space.xl,
    gap: Space.lg,
    overflow: 'hidden',
    // A note has proportions, and this floor is load-bearing rather than
    // decorative: the name box is a flex child, so the note's own height is what
    // gives the 34/38 Bodoni line room to sit. 250 leaves the name ~56dp with the
    // latent panel present, which is the fully-earned state.
    minHeight: 250,
  },
  sheen: { ...StyleSheet.absoluteFillObject },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  /**
   * `flexShrink: 1` on the issuing lines and nothing on the seal, so when space
   * runs out the LEGEND gives way — never the status. The status is the one thing
   * on this plate a holder must be able to read at a glance.
   */
  issuer: { flexShrink: 1, gap: 1 },
  /**
   * `flexGrow`, never `flex`.
   *
   * `flex: 1` is shorthand for `flexBasis: 0`, and Yoga has no `min-height: auto`
   * for flex items — so with the latent panel present the in-flow siblings ate the
   * note's height and this box computed to about 16dp for a 38dp line, clipped by
   * the note's own `overflow: hidden`. It only broke in the fully-verified state,
   * which is the one state that matters most. `flexGrow: 1` keeps `flexBasis:
   * auto`, so the box is at least as tall as the text and still absorbs slack.
   */
  name: { flexGrow: 1, justifyContent: 'center' },

  latent: {
    borderWidth: 1,
    borderRadius: Radius.sm,
    borderStyle: 'dashed',
    paddingHorizontal: Space.md,
    // Fixed height: the two layers crossfade in place, so the note never reflows
    // while it is being held.
    height: 52,
    justifyContent: 'center',
  },
  latentLayer: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', paddingHorizontal: Space.md },
  latentValue: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  latentMeta: { flex: 1, gap: 1 },

  foot: { gap: Space.sm },
  footRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: Space.lg,
  },
  serial: { alignItems: 'flex-end', flexShrink: 1 },

  band: { position: 'absolute', left: 0, right: 0, bottom: -4 },
});
