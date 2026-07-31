/**
 * The verify code, as a block on the sheet.
 *
 * The plate already carries this code on its verso, and that is the right home for it —
 * turning a passport over is the gesture. But a gesture is also a thing you have to KNOW
 * about: a holder standing at a counter, asked to prove something, should not have to
 * discover a swipe. So the code appears here too, once it exists, at a size that scans
 * across a desk rather than at arm's length.
 *
 * Same string, same encoder, same security model as the verso — see `passport-verso.tsx`
 * for the full argument. An opaque reference, never the credential: a scan opens a request
 * this device must approve and sign, so a photographed code is inert. That is what makes it
 * safe to print on a surface a stranger is looking at.
 *
 * ── Why it is on rag rather than on the field ──
 * The plate owns the intaglio region, and there is exactly one plate. A second dark field
 * on the same screen reads as a second document. This is a panel: the code, the two
 * identifiers a verifier can type when they have no scanner, and nothing else.
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Icon,
  Legend,
  Micro,
  Panel,
  Rule,
  Spinner,
  Text,
} from '@/components/ui';
import { QrMatrix } from '@/features/payments/components/qr-matrix';
import { Radius, Space, usePalette } from '@/theme';

import type { PassportCode } from '../use-passport-code';

/**
 * Fixed polarity, for the same reason `passport-verso.tsx` pins its own: the themed
 * colours INVERT under UV, and a light-on-dark symbol is one most scanners will not
 * decode. A code a stranger points a camera at is a functional print, not a surface.
 */
const CODE_PAPER = '#F7F4EA';
const CODE_INK = '#04120D';

/**
 * Bounds on the drawn symbol. The floor is the same 104dp the verso uses — below roughly
 * 110dp a phone-to-phone scan starts failing — and the ceiling is larger here because this
 * block is not competing with a plate's other four printed regions for height.
 */
const CODE_MIN = 104;
const CODE_MAX = 232;

export interface VerifyCodePanelProps {
  code: PassportCode;
  /** The holder's permanent public identifier — what a verifier types with no scanner. */
  pravaahId?: string | null;
  creating?: boolean;
  /** Mint the reference behind the code. Offered only in the `NONE` state. */
  onCreate?: () => void;
  /** Retry a failed load. */
  onRetry?: () => void;
  /** Where to go when there is no credential for a code to point at. */
  onIssue?: () => void;
}

export function VerifyCodePanel({
  code,
  pravaahId,
  creating = false,
  onCreate,
  onRetry,
  onIssue,
}: VerifyCodePanelProps) {
  const p = usePalette();
  // Measured, so the symbol is sized to the panel it actually got rather than to a
  // guessed screen width.
  const [width, setWidth] = useState(0);
  const size = Math.round(Math.min(CODE_MAX, Math.max(CODE_MIN, width)));

  return (
    <Panel pad="lg">
      <View style={styles.body} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {/* Nothing is drawn until the panel has been measured. Without this the
            first frame paints the code at the CODE_MIN floor and it visibly jumps
            to full size once `onLayout` reports — on the one element here whose
            whole job is to look like a stable printed symbol. */}
        {width <= 0 ? null : code.state === 'READY' ? (
          <>
            <View style={[styles.paper, { width: size, height: size }]}>
              <QrMatrix
                payload={code.payload}
                size={size}
                light={CODE_PAPER}
                dark={CODE_INK}
                label="Your Pravaah verification code. Your Pravaah ID is written beneath it as text."
              />
            </View>

            <Rule style={styles.rule} />

            {/* The typed route. A counter with no scanner is not an edge case, and the
                two identifiers answer different questions — see `passport-verso.tsx`. */}
            <View style={styles.ids}>
              <View style={styles.idRow}>
                <Legend small tone="faint">
                  Pravaah ID
                </Legend>
                {code.credentialNumber ? (
                  <Micro tone="dim" numberOfLines={1} maxFontSizeMultiplier={1.2}>
                    {code.credentialNumber}
                  </Micro>
                ) : null}
              </View>
              {/* Selectable so a long-press copies it — the app's convention for a
                  quotable identifier, and this is the one string read aloud. */}
              <Text
                role="serial"
                selectable
                maxFontSizeMultiplier={1.15}
                style={styles.serial}
              >
                {pravaahId ?? '—'}
              </Text>
            </View>

            <View style={styles.note}>
              <Icon name="lock" size={13} color={p.latent} weight={1.3} />
              <Micro style={styles.noteText}>
                A scan starts a request — it reveals nothing on its own. You approve what
                is shared, on this phone, every time.
              </Micro>
            </View>
          </>
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
    </Panel>
  );
}

/**
 * The reason there is no code, and the one press that fixes it.
 *
 * Never a bare message. This block exists for the moment somebody asked the holder to
 * prove something, and an empty window with an explanation but no action is a dead end at
 * exactly the wrong time.
 */
function Absence({
  code,
  creating,
  size,
  onCreate,
  onRetry,
  onIssue,
}: {
  code: Exclude<PassportCode, { state: 'READY' }>;
  creating: boolean;
  size: number;
  onCreate?: () => void;
  onRetry?: () => void;
  onIssue?: () => void;
}) {
  const p = usePalette();

  if (code.state === 'LOADING' || creating) {
    return (
      <View style={[styles.empty, { height: size, borderColor: p.rule }]}>
        <Spinner
          size={22}
          label={creating ? 'Creating your code' : 'Loading your code'}
        />
      </View>
    );
  }

  const detail = ABSENCE[code.state];
  const action =
    code.state === 'NONE'
      ? onCreate
      : code.state === 'ERROR'
        ? // A failed MINT means there is no credential to point at — a trip to the
          // wallet, not a retry. A failed LOAD is worth another tap.
          code.recover === 'issue'
          ? onIssue
          : onRetry
        : code.state === 'UNAVAILABLE'
          ? onIssue
          : undefined;

  return (
    <>
      <View
        style={[
          styles.empty,
          {
            height: size,
            borderColor: code.state === 'DISABLED' ? p.carmine : p.rule,
          },
        ]}
      >
        <Icon
          name={detail.icon}
          size={26}
          color={code.state === 'DISABLED' ? p.carmine : p.latent}
          weight={1.5}
        />
        <Text
          role="bodySm"
          tone={code.state === 'DISABLED' ? 'carmine' : 'dim'}
          center
        >
          {code.state === 'ERROR' ? code.message : detail.detail}
        </Text>
      </View>

      {action ? (
        <Button
          label={detail.label}
          icon={code.state === 'NONE' ? 'qr' : 'passport'}
          variant={code.state === 'NONE' ? 'primary' : 'secondary'}
          onPress={action}
        />
      ) : null}
    </>
  );
}

/** What each absence says, in the fewest words that still name the next step. */
const ABSENCE: Record<
  Exclude<PassportCode['state'], 'READY'>,
  { icon: 'qr' | 'lock' | 'alert' | 'refresh'; label: string; detail: string }
> = {
  LOADING: { icon: 'qr', label: 'Loading', detail: 'Loading your code' },
  UNAVAILABLE: {
    icon: 'lock',
    label: 'Open your wallet',
    detail:
      'Issue your passport first — the code points at the credential you hold.',
  },
  NONE: {
    icon: 'qr',
    label: 'Create my code',
    detail:
      'You have no scan code yet. It is the same code your physical card carries.',
  },
  DISABLED: {
    icon: 'alert',
    label: 'Open your card',
    detail:
      'This code was switched off when you reported your card lost. Nobody who finds it can use it.',
  },
  ERROR: { icon: 'refresh', label: 'Try again', detail: 'Could not load your code' },
};

const styles = StyleSheet.create({
  body: { gap: Space.lg, alignItems: 'stretch' },
  /**
   * The paper the code is printed on. `QrMatrix` fills its own light ground including the
   * four-module quiet zone, so this is a backstop: it guarantees opaque paper for the frame
   * before the symbol paints, and gives the corner radius something to clip.
   */
  paper: {
    alignSelf: 'center',
    backgroundColor: CODE_PAPER,
    borderRadius: Radius.sm,
    overflow: 'hidden',
  },
  rule: { marginTop: -Space.xs },
  ids: { gap: 1 },
  idRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  serial: { letterSpacing: 1.2 },
  note: { flexDirection: 'row', gap: Space.sm },
  noteText: { flex: 1 },
  empty: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
  },
});
