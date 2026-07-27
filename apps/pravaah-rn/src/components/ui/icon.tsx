/**
 * The engraved icon set.
 *
 * This file exists to delete the emoji. The incumbent app used 🪪 ✅ 📊 👤 as its
 * tab bar, 🇮🇳 🇸🇬 for the corridors, and 🛡️ 🌏 🔒 📷 🔓 📭 ⏳ 🕓 ⚠️ 📈 ⚖️ 🗑 ⌛ ✕
 * throughout — which renders as a different picture on every OS version, cannot
 * take a colour, cannot take a weight, ignores the text tone, and reads as a
 * chat message rather than a security document.
 *
 * Drawn in the note's own grammar: single-weight engraved line work on a 24-unit
 * grid, geometric construction, no filled blobs, no rounded cartoon corners.
 * Every glyph is stroked so one `color` prop can tint the whole set, and every
 * one keeps a 1.5-unit visual margin so mixed icons align optically on a row.
 */
import { memo } from 'react';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';

import { usePalette } from '@/theme';

export type IconName =
  // Navigation
  | 'passport'
  | 'verify'
  | 'reputation'
  | 'bearer'
  // Verification steps
  | 'card'
  | 'fingerprint'
  | 'bank'
  | 'face'
  | 'faceMatch'
  | 'screening'
  // Liveness gestures — one per LivenessGesture the backend can challenge with
  | 'blink'
  | 'turnLeft'
  | 'turnRight'
  | 'smile'
  | 'nod'
  // Consent
  | 'consent'
  | 'receipt'
  | 'revoke'
  | 'refresh'
  // Score
  | 'dial'
  | 'factors'
  | 'improve'
  | 'history'
  | 'scales'
  // Chrome
  | 'check'
  | 'cross'
  | 'dash'
  | 'chevronRight'
  | 'chevronDown'
  | 'alert'
  | 'info'
  | 'lock'
  | 'thread'
  | 'camera'
  | 'external'
  | 'corridor'
  | 'sandbox'
  | 'logout'
  | 'clock'
  | 'plus';

export interface IconProps {
  name: IconName;
  /** Rendered box, in dp. The grid scales; the stroke does not thicken. */
  size?: number;
  color?: string;
  /**
   * Engraved line work is one weight. Only the tab bar varies it, to mark the
   * active destination without changing the glyph.
   */
  weight?: number;
  /**
   * Icons are decorative by default and hidden from the accessibility tree —
   * the label beside them already carries the meaning. Pass a label only when
   * the icon is genuinely the only content of a control.
   */
  label?: string;
}

/** 24-unit grid. Anything drawn outside 1.5..22.5 will clip on small sizes. */
const G_SIZE = 24;

export const Icon = memo(function Icon({
  name,
  size = 22,
  color,
  weight = 1.5,
  label,
}: IconProps) {
  const p = usePalette();
  const stroke = color ?? p.ink;
  // Engraved lines meet at hard joints; a burin does not round its corners.
  const s = {
    stroke,
    strokeWidth: weight,
    strokeLinecap: 'square' as const,
    strokeLinejoin: 'miter' as const,
    fill: 'none',
  };

  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${G_SIZE} ${G_SIZE}`}
      accessible={label != null}
      accessibilityRole={label != null ? 'image' : undefined}
      accessibilityLabel={label}
      // Decorative geometry must not be announced or focused.
      aria-hidden={label == null}
      importantForAccessibility={label == null ? 'no-hide-descendants' : 'yes'}
    >
      <G {...s}>{glyph(name, stroke, weight)}</G>
    </Svg>
  );
});

function glyph(name: IconName, stroke: string, weight: number) {
  switch (name) {
    /* ── Navigation ─────────────────────────────────────────────────────── */

    /** The note itself: a panel with a security thread and a serial rule. */
    case 'passport':
      return (
        <>
          <Rect x={2.5} y={5} width={19} height={14} rx={1} />
          <Line x1={7.5} y1={5} x2={7.5} y2={19} />
          <Line x1={11} y1={9.5} x2={18} y2={9.5} />
          <Line x1={11} y1={13} x2={18} y2={13} />
          <Line x1={11} y1={16} x2={15} y2={16} />
        </>
      );

    /** A struck seal: the mark a cleared check leaves. */
    case 'verify':
      return (
        <>
          <Path d="M12 2.5 L20 5.5 V12 C20 16.5 16.6 20.2 12 21.5 C7.4 20.2 4 16.5 4 12 V5.5 Z" />
          <Path d="M8.5 12 L11 14.5 L15.5 9.5" />
        </>
      );

    /** The score dial — a gauge, not a pie chart. */
    case 'reputation':
      return (
        <>
          <Path d="M3 17.5 A9.5 9.5 0 0 1 21 17.5" />
          <Line x1={12} y1={17} x2={16.5} y2={10.5} />
          <Circle cx={12} cy={17.5} r={1.4} fill={stroke} strokeWidth={0} />
          <Line x1={3} y1={20.5} x2={21} y2={20.5} />
        </>
      );

    /** The bearer. A portrait panel, as a note carries one. */
    case 'bearer':
      return (
        <>
          <Circle cx={12} cy={8.5} r={3.8} />
          <Path d="M4.5 20.5 C4.5 16.4 7.9 14 12 14 C16.1 14 19.5 16.4 19.5 20.5" />
        </>
      );

    /* ── Verification steps ─────────────────────────────────────────────── */

    /** PAN: an identity card with a portrait box and data lines. */
    case 'card':
      return (
        <>
          <Rect x={2.5} y={5.5} width={19} height={13} rx={1} />
          <Rect x={5.5} y={8.5} width={5} height={6} />
          <Line x1={13} y1={9.5} x2={18.5} y2={9.5} />
          <Line x1={13} y1={12.5} x2={18.5} y2={12.5} />
          <Line x1={13} y1={15.5} x2={16} y2={15.5} />
        </>
      );

    /** Aadhaar OKYC: a fingerprint, drawn as engraved concentric arcs. */
    case 'fingerprint':
      return (
        <>
          <Path d="M12 21 C12 21 12 15 12 12 C12 9.8 12 8 12 8" />
          <Path d="M8.5 20.2 C8.5 20.2 8.5 14.5 9 12 C9.4 9.8 10.4 8.6 12 8.6 C13.6 8.6 14.6 9.8 15 12 C15.5 14.5 15.5 20.2 15.5 20.2" />
          <Path d="M5.5 18.5 C5.5 18.5 5.5 12.5 6.4 10 C7.5 7 9.3 5.5 12 5.5 C14.7 5.5 16.5 7 17.6 10 C18.5 12.5 18.5 18.5 18.5 18.5" />
          <Path d="M3 14.5 C3 10.5 4.2 7 6.5 4.8" />
          <Path d="M21 14.5 C21 10.5 19.8 7 17.5 4.8" />
        </>
      );

    /** Penny-drop: a bank front — pediment, columns, plinth. */
    case 'bank':
      return (
        <>
          <Path d="M2.5 9 L12 3.5 L21.5 9" />
          <Line x1={2.5} y1={20.5} x2={21.5} y2={20.5} />
          <Line x1={4.5} y1={17.5} x2={4.5} y2={11} />
          <Line x1={9.5} y1={17.5} x2={9.5} y2={11} />
          <Line x1={14.5} y1={17.5} x2={14.5} y2={11} />
          <Line x1={19.5} y1={17.5} x2={19.5} y2={11} />
          <Line x1={3} y1={17.5} x2={21} y2={17.5} />
        </>
      );

    /** Liveness: a face inside the capture reticle. */
    case 'face':
      return (
        <>
          <Path d="M3 8.5 V4 H7.5" />
          <Path d="M16.5 4 H21 V8.5" />
          <Path d="M21 15.5 V20 H16.5" />
          <Path d="M7.5 20 H3 V15.5" />
          <Circle cx={12} cy={10.5} r={2.6} />
          <Path d="M7.5 17 C8.4 15 10 14 12 14 C14 14 15.6 15 16.5 17" />
        </>
      );

    /** Face match: two portraits with the comparison rule between them. */
    case 'faceMatch':
      return (
        <>
          <Circle cx={7} cy={9} r={2.6} />
          <Path d="M3 16.5 C3 14 4.8 12.5 7 12.5 C9.2 12.5 11 14 11 16.5" />
          <Circle cx={17} cy={9} r={2.6} />
          <Path d="M13 16.5 C13 14 14.8 12.5 17 12.5 C19.2 12.5 21 14 21 16.5" />
          <Line x1={12} y1={4} x2={12} y2={20} />
        </>
      );

    /** Sanctions / PEP screening: a list under a lens. */
    case 'screening':
      return (
        <>
          <Path d="M4 3.5 H15 L19.5 8 V12" />
          <Path d="M4 3.5 V20.5 H11" />
          <Line x1={7} y1={8} x2={13} y2={8} />
          <Line x1={7} y1={11.5} x2={11} y2={11.5} />
          <Circle cx={16} cy={16} r={4} />
          <Line x1={19} y1={19} x2={21.5} y2={21.5} />
        </>
      );

    /* ── Liveness gestures ──────────────────────────────────────────────── */
    /* Each one draws the MOTION being asked for, not a cartoon of a face. The
       user is holding the phone at arm's length and has a second to read it. */

    /** Blink: a closed lid with lashes. */
    case 'blink':
      return (
        <>
          <Path d="M2.5 12 C5.5 15.5 8.6 17.2 12 17.2 C15.4 17.2 18.5 15.5 21.5 12" />
          <Line x1={12} y1={17.2} x2={12} y2={20.5} />
          <Line x1={6.2} y1={15.8} x2={4.8} y2={18.8} />
          <Line x1={17.8} y1={15.8} x2={19.2} y2={18.8} />
          <Path d="M2.5 12 C5.5 8.5 8.6 6.8 12 6.8 C15.4 6.8 18.5 8.5 21.5 12" />
        </>
      );

    /** Turn left: the head arc, with the direction it travels. */
    case 'turnLeft':
      return (
        <>
          <Circle cx={14} cy={9} r={3.4} />
          <Path d="M8 20.5 C8 16.8 10.7 14.6 14 14.6 C17.3 14.6 20 16.8 20 20.5" />
          <Path d="M7.5 6.5 L3.5 10.5 L7.5 14.5" />
        </>
      );

    case 'turnRight':
      return (
        <>
          <Circle cx={10} cy={9} r={3.4} />
          <Path d="M4 20.5 C4 16.8 6.7 14.6 10 14.6 C13.3 14.6 16 16.8 16 20.5" />
          <Path d="M16.5 6.5 L20.5 10.5 L16.5 14.5" />
        </>
      );

    /** Smile: the mouth curve alone. A whole face at this size is mud. */
    case 'smile':
      return (
        <>
          <Circle cx={12} cy={12} r={9} />
          <Path d="M7.5 13.5 C8.8 16 10.3 17.2 12 17.2 C13.7 17.2 15.2 16 16.5 13.5" />
          <Circle cx={8.8} cy={9.5} r={1} fill={stroke} strokeWidth={0} />
          <Circle cx={15.2} cy={9.5} r={1} fill={stroke} strokeWidth={0} />
        </>
      );

    /** Nod: the head, and the axis it moves on. */
    case 'nod':
      return (
        <>
          <Circle cx={12} cy={10.5} r={3.4} />
          <Path d="M6 21 C6 17.3 8.7 15.1 12 15.1 C15.3 15.1 18 17.3 18 21" />
          <Path d="M20.5 6 L20.5 18" strokeWidth={weight * 0.9} />
          <Path d="M18 8 L20.5 5.5 L23 8" strokeWidth={weight * 0.9} />
          <Path d="M18 16 L20.5 18.5 L23 16" strokeWidth={weight * 0.9} />
        </>
      );

    /* ── Consent ────────────────────────────────────────────────────────── */

    /** Consent: data leaving a source under a key. Not a handshake. */
    case 'consent':
      return (
        <>
          <Rect x={2.5} y={4} width={9} height={16} rx={1} />
          <Line x1={5.5} y1={8} x2={8.5} y2={8} />
          <Line x1={5.5} y1={12} x2={8.5} y2={12} />
          <Path d="M14 12 H21.5" />
          <Path d="M18.5 8.5 L21.5 12 L18.5 15.5" />
        </>
      );

    /** GST returns: a receipt with a torn foot. */
    case 'receipt':
      return (
        <>
          <Path d="M5 3.5 H19 V20.5 L16.5 19 L14 20.5 L11.5 19 L9 20.5 L6.5 19 L5 20.5 Z" />
          <Line x1={8.5} y1={8} x2={15.5} y2={8} />
          <Line x1={8.5} y1={11.5} x2={15.5} y2={11.5} />
          <Line x1={8.5} y1={15} x2={13} y2={15} />
        </>
      );

    /** Revoke: the data destroyed. Carmine at every call site. */
    case 'revoke':
      return (
        <>
          <Line x1={3.5} y1={6.5} x2={20.5} y2={6.5} />
          <Path d="M9 6.5 V4 H15 V6.5" />
          <Path d="M5.5 6.5 L6.8 20.5 H17.2 L18.5 6.5" />
          <Line x1={10} y1={10.5} x2={10} y2={17} />
          <Line x1={14} y1={10.5} x2={14} y2={17} />
        </>
      );

    case 'refresh':
      return (
        <>
          <Path d="M20 12 A8 8 0 1 1 12 4 C15 4 17.6 5.6 19 8" />
          <Path d="M19.5 3.5 V8.5 H14.5" />
        </>
      );

    /* ── Score ──────────────────────────────────────────────────────────── */

    case 'dial':
      return (
        <>
          <Circle cx={12} cy={12} r={8.5} />
          <Line x1={12} y1={12} x2={16} y2={7.5} />
          <Line x1={12} y1={3.5} x2={12} y2={5.5} />
          <Line x1={20.5} y1={12} x2={18.5} y2={12} />
          <Line x1={3.5} y1={12} x2={5.5} y2={12} />
        </>
      );

    /** Why this score: contribution bars, largest first. */
    case 'factors':
      return (
        <>
          <Line x1={3.5} y1={20.5} x2={3.5} y2={3.5} />
          <Rect x={6} y={5.5} width={14} height={3.5} />
          <Rect x={6} y={11} width={9.5} height={3.5} />
          <Rect x={6} y={16.5} width={5} height={3.5} />
        </>
      );

    /** How to improve: the trend, rising. */
    case 'improve':
      return (
        <>
          <Path d="M3.5 17 L9 11.5 L12.5 15 L20.5 7" />
          <Path d="M15 6.5 H21 V12.5" />
        </>
      );

    case 'history':
      return (
        <>
          <Path d="M3.5 12 A8.5 8.5 0 1 0 12 3.5 C9 3.5 6.4 5 5 7.5" />
          <Path d="M4.5 3.5 V8 H9" />
          <Path d="M12 8 V12.5 L15.5 14.5" />
        </>
      );

    /** Fairness: a balance. Level, because the claim is that it is level. */
    case 'scales':
      return (
        <>
          <Line x1={12} y1={4} x2={12} y2={20.5} />
          <Line x1={7} y1={20.5} x2={17} y2={20.5} />
          <Line x1={4} y1={7.5} x2={20} y2={7.5} />
          <Path d="M4 7.5 L1.5 13 H6.5 Z" />
          <Path d="M20 7.5 L17.5 13 H22.5 Z" />
        </>
      );

    /* ── Chrome ─────────────────────────────────────────────────────────── */

    case 'check':
      return <Path d="M4.5 12.5 L9.5 17.5 L19.5 6.5" />;

    case 'cross':
      return (
        <>
          <Line x1={5.5} y1={5.5} x2={18.5} y2={18.5} />
          <Line x1={18.5} y1={5.5} x2={5.5} y2={18.5} />
        </>
      );

    case 'dash':
      return <Line x1={5} y1={12} x2={19} y2={12} />;

    case 'chevronRight':
      return <Path d="M9 4.5 L16.5 12 L9 19.5" />;

    case 'chevronDown':
      return <Path d="M4.5 9 L12 16.5 L19.5 9" />;

    case 'alert':
      return (
        <>
          <Path d="M12 3.5 L21.5 20.5 H2.5 Z" />
          <Line x1={12} y1={9} x2={12} y2={14.5} />
          <Circle cx={12} cy={17.5} r={0.9} fill={stroke} strokeWidth={0} />
        </>
      );

    case 'info':
      return (
        <>
          <Circle cx={12} cy={12} r={8.5} />
          <Line x1={12} y1={11} x2={12} y2={16.5} />
          <Circle cx={12} cy={7.8} r={0.9} fill={stroke} strokeWidth={0} />
        </>
      );

    case 'lock':
      return (
        <>
          <Rect x={4.5} y={10.5} width={15} height={10} rx={1} />
          <Path d="M8 10.5 V7.5 A4 4 0 0 1 16 7.5 V10.5" />
          <Line x1={12} y1={14} x2={12} y2={17} />
        </>
      );

    /** The security thread: one unbroken line with its marks. */
    case 'thread':
      return (
        <>
          <Line x1={12} y1={2.5} x2={12} y2={21.5} />
          <Circle cx={12} cy={6.5} r={2.2} />
          <Circle cx={12} cy={12} r={2.2} />
          <Circle cx={12} cy={17.5} r={2.2} />
        </>
      );

    case 'camera':
      return (
        <>
          <Path d="M2.5 7.5 H7 L8.5 5 H15.5 L17 7.5 H21.5 V19.5 H2.5 Z" />
          <Circle cx={12} cy={13.2} r={4} />
        </>
      );

    case 'external':
      return (
        <>
          <Path d="M13 4.5 H19.5 V11" />
          <Line x1={19.5} y1={4.5} x2={11} y2={13} />
          <Path d="M16 14.5 V19.5 H4.5 V8 H9.5" />
        </>
      );

    /** The corridor: IN <-> SG, both directions, because it travels both ways. */
    case 'corridor':
      return (
        <>
          <Path d="M3.5 8.5 H20.5" />
          <Path d="M17 5 L20.5 8.5 L17 12" />
          <Path d="M20.5 15.5 H3.5" />
          <Path d="M7 12 L3.5 15.5 L7 19" />
        </>
      );

    /** Sandbox: a test flask. Marks a dev affordance as a dev affordance. */
    case 'sandbox':
      return (
        <>
          <Path d="M9 3.5 V9 L4.5 18 A2 2 0 0 0 6.3 20.5 H17.7 A2 2 0 0 0 19.5 18 L15 9 V3.5" />
          <Line x1={7.5} y1={3.5} x2={16.5} y2={3.5} />
          <Line x1={6.6} y1={14} x2={17.4} y2={14} />
        </>
      );

    case 'logout':
      return (
        <>
          <Path d="M14 4.5 H4.5 V19.5 H14" />
          <Line x1={9.5} y1={12} x2={20.5} y2={12} />
          <Path d="M17 8.5 L20.5 12 L17 15.5" />
        </>
      );

    case 'clock':
      return (
        <>
          <Circle cx={12} cy={12} r={8.5} />
          <Path d="M12 7 V12.5 L16 14.5" />
        </>
      );

    case 'plus':
      return (
        <>
          <Line x1={12} y1={5} x2={12} y2={19} />
          <Line x1={5} y1={12} x2={19} y2={12} />
        </>
      );
  }
}
