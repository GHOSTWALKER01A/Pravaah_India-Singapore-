/**
 * The passport's verso — the machine-readable face.
 *
 * A real travel document is two faces of one leaf: a data page you read, and a
 * machine-readable zone a border reads. The plate on the home screen had only the first,
 * so the one thing a holder actually does with a passport — turn it toward somebody else —
 * had no answer. This is the other face: the code a verifier scans, and the two numbers
 * they can type if they have no scanner.
 *
 * ── What the code carries, and why that is safe on a face a stranger is looking at ──
 * An opaque reference, never the credential. Scanning it opens a request that THIS device
 * must approve and sign a proof for, so a photographed code — or the plate itself in
 * somebody else's hands — yields nothing. It is the same string the physical card's QR and
 * NFC tag carry, from the same endpoint, so the plate and the plastic are one document
 * rather than two that can disagree.
 *
 * ── Why two identifiers ──
 * They answer different questions and the codebase already treats them as distinct. The
 * PRAVAAH ID is the holder's permanent public identifier — the number read aloud across a
 * counter, and what `POST /verify/request` accepts when a verifier has no scanner. The
 * CREDENTIAL NUMBER identifies this particular credential, and is what a verification
 * result echoes back. Printing only one of them would leave a verifier stuck in exactly
 * one of the two situations.
 *
 * ── What is deliberately NOT here ──
 * The score, the band, the name, the expiry. A verso is photographed more than any other
 * surface in the product, and every one of those facts is selectively disclosable for a
 * reason. The code discloses nothing by itself; the plate should not undo that in print.
 * The sentence explaining the security model is not here either — it lives on the sheet
 * below the plate, because the plate is a document and prose belongs on rag.
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  CornerMedallion,
  FieldValue,
  GuillocheBand,
  Icon,
  IconPress,
  Legend,
  Micro,
  Press,
  Spinner,
  Text,
} from '@/components/ui';
import { QrMatrix } from '@/features/payments/components/qr-matrix';
import { Radius, Space, usePalette } from '@/theme';

import type { PassportCode } from '../use-passport-code';

/**
 * The code's own polarity, pinned rather than themed.
 *
 * `QrMatrix` normally takes its colours from the palette, and under UV those INVERT —
 * `ground` becomes near-black and `ink` near-white, producing a light-on-dark symbol most
 * scanners will not decode. A verify code has to scan in both themes, so it carries fixed
 * paper and fixed ink: `card-face.tsx`'s own QR-window paper, and the design system's
 * deepest field as the dark. Hard-coded hex in a themed app is deliberate here for the same
 * reason it is deliberate in `card-face.tsx` — this is a functional print, not a surface.
 *
 * ── On drawing the code here rather than using the server's `qrSvg` ──
 * The card payload also carries a server-rendered SVG, and it is NOT used, for two reasons
 * the served one cannot satisfy: its colours are baked to the print palette (navy on white,
 * which is a foreign object on the intaglio plate), and its module size is fixed at render
 * time while this window is measured and can be any size.
 *
 * The payload is byte-identical either way, which is the property that actually matters —
 * a scanner reads the STRING. Verified, rather than assumed: the two encoders were compared
 * module-for-module on four realistic verify URLs and they agree on version and size but
 * choose DIFFERENT data masks, so the symbols are not pixel-identical. That is benign and
 * must not be "fixed": the mask is recorded in the BCH-protected format field, so a decoder
 * un-masks with whichever one it is told, and evaluating all eight is a scannability
 * optimisation rather than part of the encoding. Both encoders pass their own
 * specification suites (`scripts/verify-qr.ts`, `qr.util.spec.ts`).
 */
const CODE_PAPER = '#F7F4EA';
const CODE_INK = '#04120D';

/** Bounds on the drawn symbol. Below ~110dp a phone-to-phone scan starts failing. */
const CODE_MIN = 104;
const CODE_MAX = 168;

export interface PassportVersoProps {
  /** The plate's measured width, so the base guilloche is generated to fit it. */
  width: number;
  /** The holder's permanent public identifier. */
  pravaahId?: string | null;
  code: PassportCode;
  creating?: boolean;
  /** Mint the reference behind the code. Offered only in the `NONE` state. */
  onCreate?: () => void;
  /** Retry a failed load. */
  onRetry?: () => void;
  /** Where to go when there is no passport to point a code at. */
  onIssue?: () => void;
  /** Open the full card, where the same code is drawn large. */
  onOpenCard?: () => void;
  /** Turn back to the data face. */
  onTurn: () => void;
}

export function PassportVerso({
  width,
  pravaahId,
  code,
  creating = false,
  onCreate,
  onRetry,
  onIssue,
  onOpenCard,
  onTurn,
}: PassportVersoProps) {
  const p = usePalette();

  return (
    <>
      {/* The same engraved ground as the data face, because it is the same object.
          Kept OUTSIDE the composed block below, and absolutely positioned: an abspos child
          is laid out against its parent's padding box, so the medallion and the base band
          bleed to the plate's real edge instead of being inset by the printed margin. */}
      <CornerMedallion size={148} top={-34} right={-42} opacity={0.28} />

      {/*
        One wrapper, with its own tighter rhythm.
        The plate's printed area sets `gap: Space.lg` for the data face, whose blocks are
        text. This face has to fit a SCANNABLE symbol in the same height, and 16dp between
        four blocks was 12dp taken straight off the code's edge length. One in-flow child
        means the outer gap never applies, and this rhythm governs instead.
      */}
      <View style={styles.verso}>
        <View style={styles.head}>
          <Legend small surface="field" tone="latent" numberOfLines={1}>
            {code.state === 'READY' ? 'Scan to verify' : 'Verify code'}
          </Legend>
          {/* The way back. The swipe works in either direction, but a screen reader cannot
              perform a pan, so the gesture is never the only route. */}
          <IconPress
            size={36}
            label="Turn the passport back to your details"
            onPress={onTurn}
            feedback="select"
            depth="subtle"
          >
            <View style={[styles.disc, { borderColor: p.ruleOnFieldStrong }]}>
              <Icon name="passport" size={17} color={p.onFieldLatent} weight={1.6} />
            </View>
          </IconPress>
        </View>

        {/* `flex: 1` and measured: the window takes whatever the plate has left and the
            symbol is sized to the SMALLER of the two axes. That is what keeps this face
            intact at a large OS font scale — the identifiers below grow, the code yields,
            and nothing is clipped by the plate's own `overflow: hidden`. */}
        <CodeWindow
          code={code}
          creating={creating}
          onCreate={onCreate}
          onRetry={onRetry}
          onIssue={onIssue}
          onOpenCard={onOpenCard}
        />

        <View style={styles.ids}>
          <View style={styles.idHead}>
            <Legend small surface="field" tone="dim">
              Pravaah ID
            </Legend>
            {/* The credential number rides the label's line rather than taking a row of
                its own: at any real phone width the two identifiers cannot sit side by side
                at a readable size, and the ID is the one that has to be read aloud. */}
            {code.state === 'READY' && code.credentialNumber ? (
              <Micro
                surface="field"
                tone="dim"
                numberOfLines={1}
                maxFontSizeMultiplier={1.2}
              >
                {code.credentialNumber}
              </Micro>
            ) : null}
          </View>
          {/* `serial`, and selectable so a long-press copies it — the app's convention for
              a quotable identifier. Allowed to take a second line at a large font scale
              rather than ellipsing: an ID with a character missing is worse than one on
              two lines. */}
          <Text
            role="serial"
            surface="field"
            selectable
            maxFontSizeMultiplier={1.15}
            style={styles.serial}
          >
            {pravaahId ?? '—'}
          </Text>
        </View>
      </View>

      {width > 0 ? (
        <View style={styles.band} pointerEvents="none">
          <GuillocheBand width={width} height={22} lines={7} opacity={0.28} />
        </View>
      ) : null}
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   The window
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The code, or the reason there isn't one — with the action that fixes it.
 *
 * Every non-READY state is a PRESS, not a message. An empty window on the one face a
 * holder turned over because somebody asked them to prove something is a dead end, and
 * "issue your passport" three screens away is not an answer at a counter.
 */
function CodeWindow({
  code,
  creating,
  onCreate,
  onRetry,
  onIssue,
  onOpenCard,
}: {
  code: PassportCode;
  creating: boolean;
  onCreate?: () => void;
  onRetry?: () => void;
  onIssue?: () => void;
  onOpenCard?: () => void;
}) {
  const p = usePalette();
  // One state object rather than two, so a single `onLayout` is a single render.
  const [box, setBox] = useState({ width: 0, height: 0 });
  const size = Math.round(
    Math.min(CODE_MAX, Math.max(CODE_MIN, Math.min(box.width, box.height))),
  );

  return (
    <View
      style={styles.window}
      onLayout={(event) =>
        setBox({
          width: event.nativeEvent.layout.width,
          height: event.nativeEvent.layout.height,
        })
      }
    >
      {box.height <= 0 ? null : code.state === 'READY' ? (
        // Tapping the code opens the full card, where the same symbol is drawn large
        // enough to scan across a desk. The plate's copy is for arm's length.
        <Press
          onPress={onOpenCard}
          disabled={!onOpenCard}
          depth="subtle"
          radius={Radius.sm}
          ink={false}
          accessibilityRole="button"
          accessibilityLabel="Your verification code. Double tap to open your card, where the code is larger."
          accessibilityHint="A verifier scans this and you approve on this phone"
        >
          <View style={[styles.paper, { width: size, height: size }]}>
            <QrMatrix
              payload={code.payload}
              size={size}
              light={CODE_PAPER}
              dark={CODE_INK}
              label="Your Pravaah verification code. Your Pravaah ID is written beneath it as text."
            />
          </View>
        </Press>
      ) : (
        <Absence
          code={code}
          creating={creating}
          size={size}
          onCreate={onCreate}
          onRetry={onRetry}
          onIssue={onIssue}
        />
      )}
    </View>
  );
}

/** A stated absence at the code's own size, so the face never changes shape. */
function Absence({
  code,
  creating,
  size,
  onCreate,
  onRetry,
  onIssue,
}: {
  /** Narrowed by the caller: a READY code is drawn, never described. */
  code: Exclude<PassportCode, { state: 'READY' }>;
  creating: boolean;
  size: number;
  onCreate?: () => void;
  onRetry?: () => void;
  onIssue?: () => void;
}) {
  const p = usePalette();
  const detail = ABSENCE[code.state];
  const action =
    code.state === 'NONE'
      ? onCreate
      : code.state === 'ERROR'
        ? // A failed mint sends them where issuance actually lives; a failed load is worth
          // another tap. See the `recover` field's note.
          code.recover === 'issue'
          ? onIssue
          : onRetry
        : code.state === 'UNAVAILABLE'
          ? onIssue
          : undefined;
  const label =
    code.state === 'ERROR' && code.recover === 'issue'
      ? 'Open your wallet'
      : detail.label;

  return (
    <Press
      onPress={action}
      disabled={!action || creating}
      depth="subtle"
      radius={Radius.sm}
      feedback={code.state === 'NONE' ? 'commit' : 'none'}
      accessibilityRole={action ? 'button' : 'summary'}
      accessibilityLabel={
        code.state === 'ERROR' ? code.message : detail.announce
      }
    >
      <View
        style={[styles.empty, { width: size, height: size, borderColor: p.ruleOnField }]}
      >
        {code.state === 'LOADING' || creating ? (
          <Spinner
            size={22}
            color={p.onFieldLatent}
            label={creating ? 'Creating your code' : 'Loading your code'}
          />
        ) : (
          <>
            <Icon
              name={detail.icon}
              size={22}
              color={code.state === 'DISABLED' ? p.onFieldCarmine : p.onFieldLatent}
              weight={1.5}
            />
            <Legend
              small
              surface="field"
              tone={code.state === 'DISABLED' ? 'carmine' : 'latent'}
              center
              numberOfLines={2}
            >
              {label}
            </Legend>
          </>
        )}
      </View>
    </Press>
  );
}

/**
 * What each absence says, in the fewest words that still name the next step.
 *
 * `ERROR` gets the server's own sentence as its announcement — see `Absence` — because
 * "Issue your passport before requesting a card" is actionable and a generic failure
 * string would throw it away.
 */
const ABSENCE: Record<
  Exclude<PassportCode['state'], 'READY'>,
  { icon: 'qr' | 'lock' | 'alert' | 'refresh'; label: string; announce: string }
> = {
  LOADING: { icon: 'qr', label: 'Loading', announce: 'Loading your code' },
  UNAVAILABLE: {
    icon: 'lock',
    label: 'Issue your passport',
    announce:
      'No code yet. Issue your passport first — double tap to open your wallet.',
  },
  NONE: {
    icon: 'qr',
    label: 'Tap to create',
    announce:
      'You have no scan code yet. Double tap to create one — it is the same code your card carries.',
  },
  DISABLED: {
    icon: 'alert',
    label: 'Code disabled',
    announce:
      'This code was switched off when you reported your card lost. Nobody who finds it can use it.',
  },
  ERROR: { icon: 'refresh', label: 'Tap to retry', announce: 'Could not load your code' },
};

const styles = StyleSheet.create({
  /** The printed block. `flex: 1` so the window between the head and the identifiers gets
      every dp the plate is not already using. */
  verso: { flex: 1, gap: Space.md },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  /** The ringed disc the glyph sits in — the plate's own seal language, at control size. */
  disc: {
    width: 30,
    height: 30,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  window: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /**
   * The paper the code is printed on.
   *
   * `QrMatrix` already fills its own light ground including the four-module quiet zone the
   * specification requires, so this is a backstop rather than the mechanism: it guarantees
   * the window is opaque paper even for the frame before the symbol paints, and gives the
   * press overlay a corner radius to clip to.
   */
  paper: {
    backgroundColor: CODE_PAPER,
    borderRadius: Radius.sm,
    overflow: 'hidden',
  },
  empty: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.sm,
    paddingHorizontal: Space.md,
  },

  ids: { gap: 1 },
  idHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  serial: { letterSpacing: 1.2 },

  band: { position: 'absolute', left: 0, right: 0, bottom: -4 },
});
