/**
 * The note's containers.
 *
 * The incumbent app had exactly one: `<ThemedView type="backgroundElement">` with
 * `borderRadius: 24, padding: 24, gap: 16`, used for the passport, every step row,
 * every notice, every empty state, every consent, and every score factor. Twenty-two
 * screens of identically-sized filled rectangles — the lazy container, as the craft
 * floor calls it, applied as the entire information architecture.
 *
 * These are four containers with four different jobs, chosen by what the content IS:
 *
 *   Panel   — an engraved plate: hairline keyline, corner notch, raised ground.
 *             For a group of related facts or one self-contained block.
 *   Well    — a recess. For inputs, code cells, and read-only values that were
 *             entered rather than issued.
 *   Field   — a drenched intaglio region. The passport, a corridor panel. Owns its
 *             region; carries the reversed-out tone ramp.
 *   Rule    — a hairline. Frequently the right answer where a card was reached for:
 *             a list of facts needs separation, not five nested boxes.
 *
 * Panels never nest. If content inside a Panel wants a Panel, the outer container
 * was the wrong choice — use rules to divide it instead.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import {
  Elevation,
  Hairline,
  Notch,
  Radius,
  Space,
  useIsDark,
  usePalette,
} from '@/theme';

/**
 * Whether the surrounding container's fill is the intaglio FIELD.
 *
 * This exists because of a bug that only appears in dark mode: there, `panel` and
 * `field` are the same colour (#0E3B2E), so a keyline tinted for the rag sheet
 * (`rule`, #1E3A31) sits on it at **1.01:1** — every hairline inside every panel,
 * every `FieldGrid` row divider, and the corner notch all vanish. The notch is the
 * mark DESIGN.md names as the thing distinguishing a plate from a card, so in dark
 * mode the whole composition quietly degraded into the card stack it replaced.
 *
 * `ruleOnField` was authored for exactly this and had no way to reach the call
 * sites, because a `<Rule />` cannot see what it is sitting inside. Now it can.
 */
const OnPlate = createContext(false);

/** The correct keyline for the current container and theme. */
function useLine(strong: boolean, forceOnField = false): string {
  const p = usePalette();
  const onPlate = useContext(OnPlate);
  const onField = forceOnField || onPlate;
  if (onField) return strong ? p.ruleOnFieldStrong : p.ruleOnField;
  return strong ? p.ruleStrong : p.rule;
}

/* ────────────────────────────────────────────────────────────────────────────
   Panel
   ──────────────────────────────────────────────────────────────────────────── */

export interface PanelProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Inner padding. `none` when the panel holds its own full-bleed rows. */
  pad?: 'none' | 'sm' | 'md' | 'lg';
  /** Cut the corner notch. The mark that says "this is a plate, not a card". */
  notch?: boolean;
  /** Override the keyline colour — a toned panel for a warning or a failure. */
  rule?: string;
  /** Lift it off the sheet. Off by default: a plate lies flat. */
  raised?: boolean;
  /** Fill. Defaults to the raised panel tone; `sunk` for a recess. */
  tone?: 'panel' | 'sunk' | 'none';
}

const PAD = { none: 0, sm: Space.md, md: Space.lg, lg: Space.xl } as const;

export function Panel({
  children,
  style,
  pad = 'md',
  notch = true,
  rule,
  raised = false,
  tone = 'panel',
}: PanelProps) {
  const p = usePalette();
  const dark = useIsDark();
  // A panel's fill IS the field in dark mode, so from here down the children are
  // on a plate and must use the field's own keyline. `sunk` is the exception: it
  // fills with `groundSunk`, which stays below the field in both themes.
  const onPlate = dark && tone === 'panel';
  const line = useLine(false, onPlate);
  const border = rule ?? line;

  return (
    <OnPlate.Provider value={onPlate}>
      <View
        style={[
          styles.panel,
          {
            padding: PAD[pad],
            borderColor: border,
            backgroundColor:
              tone === 'none' ? 'transparent' : tone === 'sunk' ? p.groundSunk : p.panel,
          },
          raised && [Elevation.panel, { shadowColor: p.shadow }],
          style,
        ]}
      >
        {children}
        {notch ? <Notch_ color={border} /> : null}
      </View>
    </OnPlate.Provider>
  );
}

/**
 * The corner notch: the top-right corner cut away and re-drawn as a diagonal.
 *
 * Drawn in SVG rather than faked with a rotated square, because a rotated square
 * has to be filled with the parent's background — which breaks the moment the
 * panel sits on a different ground than it was written for, and that is exactly
 * what happens when the same panel appears on rag and on the field.
 */
function Notch_({ color }: { color: string }) {
  return (
    <View style={styles.notch} pointerEvents="none">
      <Svg width={Notch} height={Notch} viewBox={`0 0 ${Notch} ${Notch}`} aria-hidden>
        <Path
          d={`M0 0 L${Notch} ${Notch}`}
          stroke={color}
          strokeWidth={Hairline.base}
          fill="none"
        />
      </Svg>
    </View>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Well
   ──────────────────────────────────────────────────────────────────────────── */

/** A recess. Inputs, OTP cells, a quoted value the user typed rather than earned. */
export function Well({
  children,
  style,
  rule,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  rule?: string;
}) {
  const p = usePalette();
  const line = useLine(false);
  return (
    <View
      style={[
        styles.well,
        { backgroundColor: p.groundSunk, borderColor: rule ?? line },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Field
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * A drenched intaglio region.
 *
 * Anything inside must use `surface="field"` on its text, which switches the tone
 * ramp to the reversed-out set. This is the one container that changes what its
 * children's colours mean, which is why it is a component and not a style.
 */
export function Field({
  children,
  style,
  deep = false,
  radius = Radius.lg,
  raised = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** The deepest press impression — for the passport's own base panel. */
  deep?: boolean;
  radius?: number;
  raised?: boolean;
}) {
  const p = usePalette();
  return (
    // Always a plate: this container's fill is the field by definition, in both
    // themes, so every rule and notch inside it takes the field's keyline.
    <OnPlate.Provider value>
      <View
        style={[
          {
            backgroundColor: deep ? p.fieldDeep : p.field,
            borderRadius: radius,
            overflow: 'hidden',
          },
          raised && [Elevation.note, { shadowColor: p.shadow }],
          style,
        ]}
      >
        {children}
      </View>
    </OnPlate.Provider>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Rules
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * A hairline. Often the honest answer where a card was reached for.
 *
 * `onField` picks the keyline that is LIGHTER than the intaglio ground, because a
 * line pressed into a dark plate catches the light. Without it, a rule inside the
 * passport is invisible in dark mode, where the panel and the field are the same
 * colour.
 */
export function Rule({
  onField = false,
  strong = false,
  inset = 0,
  style,
}: {
  /**
   * Force the field keyline. Rarely needed — a `Rule` inside a `Panel` or `Field`
   * already resolves correctly from context. Pass it only for a rule drawn on a
   * hand-rolled field region.
   */
  onField?: boolean;
  strong?: boolean;
  inset?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const color = useLine(strong, onField);
  return (
    <View
      style={[
        { height: Hairline.base, backgroundColor: color, marginHorizontal: inset },
        style,
      ]}
    />
  );
}

/** A vertical hairline, for splitting a row of values. */
export function VRule({ onField = false }: { onField?: boolean }) {
  const color = useLine(false, onField);
  return (
    <View
      style={{ width: Hairline.base, alignSelf: 'stretch', backgroundColor: color }}
    />
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: Radius.md,
    borderWidth: Hairline.base,
    // The notch is drawn at the corner and must not spill outside the plate.
    overflow: 'hidden',
  },
  notch: { position: 'absolute', top: 0, right: 0 },
  well: {
    borderRadius: Radius.md,
    borderWidth: Hairline.base,
  },
});
