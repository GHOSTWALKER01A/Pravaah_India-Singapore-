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
 *     note tilted to the light resolves its watermark.
 *
 * ── It has two faces ──
 * A passport is a leaf, not a card: a data page you read and a machine-readable face a
 * border reads. Swipe the plate in either direction and it turns over onto its verify code
 * — which is the one thing a holder actually DOES with a passport, and which previously
 * lived three navigations deep inside the physical-card screen. The verso is supplied by
 * the caller (see the `back` prop) so this file keeps no knowledge of M3.
 *
 * Two authored interactions now share one object, and they are separated by axis rather
 * than by timing: HOLD reveals the score, SWIPE turns the plate. The pan only activates
 * after 14dp of horizontal travel and fails outright on vertical travel, so a long press in
 * place can never start a flip, and a scroll can never be eaten by one.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { Country, KycProfileStatus } from '@/api';
import {
  CornerMedallion,
  FieldValue,
  GuillocheBand,
  Icon,
  IconPress,
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

/** Which face is toward the holder. */
export type PlateFace = 'recto' | 'verso';

/**
 * The plate's height floor, and the ONE number both faces are laid out against.
 *
 * 268, not the 250 this had before it gained a second face. The verso has to fit a
 * scannable code — below roughly 110dp a phone-to-phone scan starts failing — plus its
 * head row and two identifiers, and 250 left the code at the edge of that. The recto
 * simply gets the extra 18dp in its name box, which its own note below says was the tight
 * dimension anyway.
 *
 * It is a floor rather than a fixed height: the recto stays in flow so a long name at a
 * large OS font scale can still grow the plate, and the verso — which is absolutely
 * positioned over it — sizes its code to whatever it is given.
 */
const PLATE_MIN_HEIGHT = 268;

/** How much of the plate's width a drag must cover to commit the turn. */
const TURN_THRESHOLD = 0.32;

/** A flick this fast commits regardless of distance. */
const TURN_VELOCITY = 480;

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
  /**
   * The second face.
   *
   * A function of the measured width rather than a plain node, because the verso draws
   * generated geometry that has to be sized to the plate — and a render prop keeps this
   * component free of any import from the module that owns the credential. Omit it and the
   * plate has one face and no gesture, which is the correct behaviour rather than a
   * degraded one.
   */
  back?: (api: { width: number; turn: () => void }) => ReactNode;
  /** Told which way the plate is facing, so a screen can caption it. */
  onFaceChange?: (face: PlateFace) => void;
}

export function PassportCard({
  status,
  pravaahId,
  score,
  onOpenScore,
  back,
  onFaceChange,
}: PassportCardProps) {
  const p = usePalette();
  const motionOk = useMotionOk();
  // The note's measured width, so the base guilloche is generated to fit it.
  const [width, setWidth] = useState(0);

  const hasLatent = score != null && score.value != null;
  const reveal = useSharedValue(0);

  const canTurn = back != null;
  const [face, setFace] = useState<PlateFace>('recto');
  /** 0 = recto square to the viewer, 1 = verso square to the viewer. */
  const turn = useSharedValue(0);
  /**
   * Which way round the plate rotates: +1 turns to the left, -1 to the right.
   *
   * Held in its own value so a drag in EITHER direction turns the plate the way the finger
   * went, instead of one direction working and the other refusing to move. It is only ever
   * reassigned while `turn` sits at an endpoint — where both faces are square to the
   * viewer and the sign therefore has no visible effect — which is what makes changing the
   * axis mid-session free of any jump.
   */
  const dir = useSharedValue(1);
  /** The value `turn` had when the current drag began. */
  const from = useSharedValue(0);

  // Under Reduce Motion the latent panel is simply always resolved. The content
  // is never hidden waiting for an interaction the user cannot perform.
  /*
   * Shared values are written through `.set()` / read through `.get()` everywhere OUTSIDE an
   * animated style. Assigning `.value` on a hook's return value is, to the React Compiler, a
   * mutation of something it must treat as immutable — so it bails out of this whole
   * component, and a component the compiler skips gets no memoization at all. Reanimated 4
   * added the accessor pair precisely so shared values survive compilation.
   */
  useEffect(() => {
    if (!motionOk) reveal.set(1);
  }, [motionOk, reveal]);

  useEffect(() => {
    onFaceChange?.(face);
  }, [face, onFaceChange]);

  /**
   * Come back to the data face if the second one goes away.
   *
   * Not defensive padding — this is reachable. A score expiring, or a credential being
   * revoked from another screen, withdraws `back` while the plate may be turned over. The
   * verso would simply stop rendering and leave the recto rotated 180° at zero opacity: a
   * BLANK hero object with no gesture left to recover it. No haptic, because nothing the
   * holder did caused this.
   */
  useEffect(() => {
    if (canTurn) return;
    turn.set(0);
    setFace('recto');
  }, [canTurn, turn]);

  const hold = () => {
    if (!hasLatent || !motionOk) return;
    haptic.commit();
    reveal.set(
      withTiming(1, {
        duration: Motion.duration.reveal,
        easing: Easing.bezier(...Motion.out),
      }),
    );
  };

  const release = () => {
    if (!hasLatent || !motionOk) return;
    reveal.set(withTiming(0, { duration: Motion.duration.base }));
  };

  /**
   * Commit the face, on the JS thread.
   *
   * Shared by the control and the gesture, and `scheduleOnRN`-able because it closes over
   * nothing but a state setter and the haptic module. The tick fires here rather than at
   * the start of the motion, so it marks the plate having TURNED rather than a finger
   * having moved — a buzz on every aborted half-drag is exactly the noise the haptics
   * rule exists to prevent.
   */
  const commit = useCallback((next: PlateFace) => {
    haptic.select();
    setFace(next);
  }, []);

  /**
   * Turn the plate from a control rather than a drag.
   *
   * Not optional politeness: a screen reader cannot perform a pan, so the gesture can
   * never be the only way to reach the second face. `dir` is deliberately left alone here —
   * the plate turns back along whatever axis it last turned on, which reads as reversing
   * the same motion and cannot jump mid-settle.
   */
  const flip = useCallback(() => {
    if (!canTurn) return;
    const next = turn.get() < 0.5 ? 1 : 0;
    turn.set(
      motionOk ? withSpring(next, Motion.slide) : withTiming(next, { duration: 0 }),
    );
    commit(next === 1 ? 'verso' : 'recto');
  }, [canTurn, commit, motionOk, turn]);

  /**
   * The turn gesture.
   *
   * `activeOffsetX` and `failOffsetY` are the whole reason this can live on an object that
   * is already a long-press target inside a vertical scroll view: the pan does not exist
   * until the finger has moved 14dp sideways, and it is dead the moment it moves 18dp
   * vertically. So a hold stays a hold and a scroll stays a scroll.
   *
   * Commitment is measured from `translationX` rather than from the animated value, so the
   * gesture behaves identically under Reduce Motion — where there is no live preview to
   * measure at all.
   */
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(canTurn && width > 0)
        .activeOffsetX([-14, 14])
        .failOffsetY([-18, 18])
        .onStart((event) => {
          const start = turn.get() < 0.5 ? 0 : 1;
          from.set(start);
          dir.set(
            start === 0
              ? event.translationX < 0
                ? 1
                : -1
              : event.translationX > 0
                ? 1
                : -1,
          );
        })
        .onUpdate((event) => {
          if (!motionOk) return;
          const progress = Math.abs(event.translationX) / width;
          turn.set(
            from.get() === 0 ? Math.min(1, progress) : Math.max(0, 1 - progress),
          );
        })
        .onEnd((event) => {
          const started = from.get();
          const progress = Math.abs(event.translationX) / width;
          const carried =
            progress > TURN_THRESHOLD || Math.abs(event.velocityX) > TURN_VELOCITY;
          const target = carried ? (started === 0 ? 1 : 0) : started;

          turn.set(
            motionOk
              ? withSpring(target, Motion.slide)
              : withTiming(target, { duration: 0 }),
          );
          // The face is committed at the DECISION, not when the spring lands: the code has
          // to be selectable and the buttons live the instant the plate is on its way over.
          if (target !== started) {
            scheduleOnRN(commit, target === 1 ? 'verso' : 'recto');
          }
        }),
    [canTurn, commit, motionOk, width, dir, from, turn],
  );

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

  /**
   * The two faces, rotated about the plate's vertical axis.
   *
   * `backfaceVisibility` alone is not trusted. It is honoured inconsistently on Android
   * depending on how a view gets layerised, and a leaked back face on the app's hero object
   * would be a mirror-image of the holder's name — so opacity is STEPPED at the halfway
   * point as well. The step is invisible because at exactly half a turn both faces are
   * edge-on, and it means only one face is ever painted whatever the platform does with
   * backface culling.
   */
  const rectoTurn = useAnimatedStyle(() => ({
    opacity: turn.value < 0.5 ? 1 : 0,
    transform: [
      { perspective: 1000 },
      { rotateY: `${dir.value * turn.value * 180}deg` },
    ],
  }));
  const versoTurn = useAnimatedStyle(() => ({
    opacity: turn.value < 0.5 ? 0 : 1,
    transform: [
      { perspective: 1000 },
      { rotateY: `${dir.value * (turn.value - 1) * 180}deg` },
    ],
  }));

  return (
    // The shadow lives on an OUTER wrapper, because each face needs `overflow: hidden`
    // to clip its medallion and base band — and on iOS `overflow: hidden` sets
    // `masksToBounds`, which clips the shadow layer too. Without the split the note has
    // depth on Android and none on iOS, on the one object the design calls "the note in
    // the hand". It also carries the measurement, since both faces are this wide.
    <View
      style={[styles.lift, { shadowColor: p.shadow }, Elevation.note]}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      <GestureDetector gesture={pan}>
        {/* The stage deliberately does NOT clip. An ancestor with `overflow: hidden`
            flattens a child's 3D transform on Android, which would turn the flip into a
            horizontal squash. Clipping belongs to each face. */}
        <View style={styles.stage}>
          <Animated.View
            style={[styles.face, { backgroundColor: p.field }, rectoTurn]}
            pointerEvents={face === 'recto' ? 'auto' : 'none'}
            // The hidden face is hidden from assistive tech too, or a screen reader reads
            // both sides of the document as one run of text.
            accessibilityElementsHidden={face !== 'recto'}
            importantForAccessibility={
              face === 'recto' ? 'auto' : 'no-hide-descendants'
            }
          >
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
              style={styles.body}
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

                {/* The way to the code. A glyph rather than a caption, because it is the
                    universal mark for "the code is here" and the plate has no room for a
                    sentence — and a real control rather than a hint, because the swipe
                    cannot be the only route to a face somebody may need at a counter. */}
                {canTurn ? (
                  <IconPress
                    size={36}
                    label="Turn the passport over to your verification code"
                    onPress={flip}
                    depth="subtle"
                  >
                    <View style={[styles.disc, { borderColor: p.ruleOnFieldStrong }]}>
                      <Icon name="qr" size={17} color={p.onFieldLatent} weight={1.6} />
                    </View>
                  </IconPress>
                ) : null}

                <StatusMark status={status.overallStatus} surface="field" size={15} />
              </View>

              <View style={styles.name}>
                <Text
                  role="denomination"
                  surface="field"
                  numberOfLines={2}
                  // iOS-only, and defeated by an explicit lineHeight, so it is a bonus
                  // rather than the mechanism. What actually protects the layout is
                  // `flexGrow` on the box plus the plate's own minHeight above.
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

                  <Animated.View
                    style={[styles.latentLayer, styles.latentValue, latentValue]}
                  >
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
          </Animated.View>

          {/* The verso, laid exactly over the recto. Absolute rather than in flow so the
              plate has ONE height — the recto's — and the two faces cannot disagree about
              how tall the document is. */}
          {back ? (
            <Animated.View
              style={[
                styles.face,
                styles.overlay,
                { backgroundColor: p.field },
                versoTurn,
              ]}
              pointerEvents={face === 'verso' ? 'auto' : 'none'}
              accessibilityElementsHidden={face !== 'verso'}
              importantForAccessibility={
                face === 'verso' ? 'auto' : 'no-hide-descendants'
              }
            >
              <View style={styles.body}>{back({ width, turn: flip })}</View>
            </Animated.View>
          ) : null}
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  // Carries only the shadow, so the faces below can clip their own ornament.
  lift: { borderRadius: Radius.lg },
  stage: { borderRadius: Radius.lg },
  /**
   * One face of the plate.
   *
   * `overflow: hidden` is what clips the medallion and the base band to the document's
   * edge; it sits on the same node as the rotation rather than on an ancestor, which is
   * the arrangement that keeps the 3D transform from being flattened on Android.
   */
  face: {
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backfaceVisibility: 'hidden',
    // A note has proportions, and this floor is load-bearing rather than decorative — see
    // PLATE_MIN_HEIGHT.
    minHeight: PLATE_MIN_HEIGHT,
  },
  overlay: { ...StyleSheet.absoluteFill },
  /**
   * The printed area inside a face.
   *
   * `flexGrow`, never `flex`. `flex: 1` is shorthand for `flexBasis: 0`, so the body would
   * collapse to nothing rather than fill a face whose height comes from `minHeight`.
   * `flexGrow: 1` keeps `flexBasis: auto`: at least as tall as its content, and absorbing
   * whatever slack the floor provides — which is also what makes the whole face a
   * long-press target rather than just its top 200dp.
   */
  body: { flexGrow: 1, padding: Space.xl, gap: Space.lg },
  sheen: { ...StyleSheet.absoluteFill },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  /**
   * `flexShrink: 1` on the issuing lines and nothing on the seal or the turn control, so
   * when space runs out the LEGEND gives way — never the status, and never the only route
   * to the verify code.
   */
  issuer: { flexShrink: 1, gap: 1 },
  /** The ringed disc a control glyph sits in — the plate's seal language, at control size. */
  disc: {
    width: 30,
    height: 30,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /**
   * `flexGrow`, for the same reason as `body` above: with the latent panel present, a
   * `flex: 1` name box computed to about 16dp for a 38dp line and was clipped by the
   * face's own `overflow: hidden` — and only in the fully-verified state, which is the one
   * state that matters most.
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
  latentLayer: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    paddingHorizontal: Space.md,
  },
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
