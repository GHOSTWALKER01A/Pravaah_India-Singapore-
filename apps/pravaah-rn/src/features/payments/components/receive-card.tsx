import { useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import {
  Button,
  Field,
  Icon,
  Legend,
  Micro,
  Press,
  Spinner,
  Text,
  haptic,
} from '@/components/ui';
import { Gutter, Hairline, Radius, Space, usePalette } from '@/theme';

import { QrMatrix } from './qr-matrix';

/**
 * The holder's own code, as the plate at the foot of the book.
 *
 * **What this replaces and why.** The first version was a 96dp thumbnail with the address beside it,
 * and on a real phone it failed twice. The address rendered as `arjun.sharma@` — `numberOfLines={1}`
 * on the serial face at that measure silently ate the `@pravaah` suffix, so the one string a payer
 * has to read or hear aloud was displayed WRONG rather than merely small. And a 96dp code is a
 * thumbnail: too small for a merchant to scan across a counter, which is the only situation it exists
 * for. A code you cannot scan and an address you cannot read is not a receive surface.
 *
 * So the code is now the object. Large, centred, with the address in full beneath it on two lines if
 * it needs two, and the two actions a person actually reaches for.
 *
 * **Why the code sits on a rag panel rather than engraved into the field.** Every other plate in this
 * app is drenched intaglio, and the first version put light modules directly on the field to stay in
 * that grammar. That was the wrong call for a QR specifically: scanner decoders threshold on local
 * contrast, and while polarity-agnostic decoders exist, a meaningful share of real-world scanners —
 * including older merchant hardware, which is exactly the audience — assume dark-on-light. A code
 * that is beautiful and fails to scan on a shop counter has failed completely. The panel is the quiet
 * zone, in rag, at full contrast; the intaglio frame around it keeps the plate in the world.
 */
interface ReceiveCardProps {
  /** The `upi://pay?...` intent string the server minted. */
  payload: string | null;
  /** The holder's own address. Shown in FULL, never truncated. */
  vpa: string | null;
  /** The bank behind the address, when one is linked. */
  bankName?: string | null;
  /** Masked account tail, e.g. `0405`. */
  accountTail?: string | null;
  loading?: boolean;
  onOpen: () => void;
}

/**
 * The payee name out of the intent string, which is what a payer will literally see.
 *
 * Read from the payload rather than fetched, and that is the better source rather than merely the
 * cheaper one. `GET /kyc/status` would have cost an extra request on every Pay-tab load — on metered
 * mobile data, for one label — and it would have answered a subtly different question: what our KYC
 * profile says the holder is called, not what this code actually carries. If the two ever disagree,
 * the code is the truth, because the code is what the payer's app will render.
 *
 * Hand-parsed instead of `new URL()`: React Native's URL polyfill does not populate
 * `searchParams` for a custom scheme like `upi:`, so it would silently return nothing.
 */
function payeeNameFromPayload(payload: string | null): string | null {
  if (!payload) return null;
  const query = payload.slice(payload.indexOf('?') + 1);
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq) !== 'pn') continue;
    try {
      const name = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' ')).trim();
      return name.length > 0 ? name : null;
    } catch {
      // A malformed percent-escape is not worth failing the whole card over.
      return null;
    }
  }
  return null;
}

export function ReceiveCard({
  payload,
  vpa,
  bankName,
  accountTail,
  loading = false,
  onOpen,
}: ReceiveCardProps) {
  const p = usePalette();
  const [copied, setCopied] = useState(false);
  const registeredName = payeeNameFromPayload(payload);

  const copy = async () => {
    if (!vpa) return;
    await Clipboard.setStringAsync(vpa);
    haptic.select();
    setCopied(true);
    // Reverts on its own. A "Copied" state that stuck would still be claiming it on the next visit.
    setTimeout(() => setCopied(false), 2_000);
  };

  /**
   * Share the ADDRESS and the intent link, not an image.
   *
   * `Share` is React Native's own module, so this costs no dependency. Saving a PNG to the gallery
   * would need both a rasteriser and a media-library permission, and it is the weaker feature: a
   * payer who receives `upi://pay?pa=…` as a link can tap it and land in their own UPI app with the
   * payee already filled, which no screenshot can do.
   */
  const share = async () => {
    if (!vpa) return;
    const name = registeredName ? ` (${registeredName})` : '';
    await Share.share({
      message: payload
        ? `Pay me on UPI at ${vpa}${name}\n${payload}`
        : `Pay me on UPI at ${vpa}${name}`,
    });
  };

  return (
    <View style={styles.bleed}>
      <Field radius={0} style={styles.plate}>
        <View style={styles.body}>
          <View style={styles.head}>
            <Legend small surface="field">
              To be paid
            </Legend>
            {bankName ? (
              <Micro surface="field" numberOfLines={1}>
                {bankName}
                {accountTail ? ` · ${accountTail}` : ''}
              </Micro>
            ) : null}
          </View>

          {/* The code, on rag at full contrast. See the component comment. */}
          <Press
            onPress={onOpen}
            depth="subtle"
            radius={Radius.md}
            style={[
              styles.quiet,
              { backgroundColor: p.ground, borderColor: p.ruleOnFieldStrong },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Your code for being paid"
            accessibilityHint="Opens it full screen, larger"
          >
            {loading ? (
              <View style={styles.pending}>
                <Spinner />
                <Micro center>Minting your code…</Micro>
              </View>
            ) : payload ? (
              <QrMatrix payload={payload} size={QR} />
            ) : (
              /*
                No code. Which is only ever one of two situations, and they are said differently.

                "No code yet" was the whole message, and it was wrong in both: it reads as a state
                that will resolve on its own, so a holder whose code genuinely failed would sit
                waiting for it. A holder who HAS an address can still be paid — that is the load
                bearing fact, so it is stated rather than left to be inferred from a blank square.
              */
              <View style={styles.pending}>
                <Icon name="qr" size={28} color={p.inkFaint} />
                {vpa ? (
                  <>
                    <Micro center>Code unavailable</Micro>
                    <Micro center>People can still pay you at the address below.</Micro>
                  </>
                ) : (
                  <Micro center>Setting up your address…</Micro>
                )}
              </View>
            )}
          </Press>

          {/*
            The address, in full and on as many lines as it needs.

            Plain selectable text, not a button. It was a `Press` with a `receipt` glyph beside it —
            which gave the card TWO copy affordances for one action, and used a document icon to mean
            "copy", so the glyph read as an unexplained page. Long-press-to-select is the app's own
            convention for the Pravaah ID and it stays; the explicit control is the button below,
            where a person scanning for an action will look.
          */}
          <View style={styles.addressText}>
            <Text
              role="field"
              surface="field"
              tone="latent"
              selectable
              // NO numberOfLines. Truncating this string is how the first version displayed
              // `arjun.sharma@` — an address that is wrong rather than merely short.
            >
              {vpa ?? 'setting up your UPI ID…'}
            </Text>
            {registeredName ? (
              <Micro surface="field">Payers see {registeredName}</Micro>
            ) : null}
          </View>

          <View style={styles.actions}>
            <Button
              label={copied ? 'Copied' : 'Copy UPI ID'}
              icon={copied ? 'check' : 'copy'}
              variant="secondary"
              onField
              inline
              disabled={!vpa}
              onPress={copy}
            />
            <Button
              label="Share"
              icon="external"
              variant="secondary"
              onField
              inline
              disabled={!vpa}
              onPress={share}
            />
          </View>
        </View>
      </Field>
    </View>
  );
}

/**
 * 208dp.
 *
 * A UPI intent lands at version 6–8, so 45–57 modules across; at 208dp that is ~3.6dp per module,
 * comfortably above the ~2dp floor where phone cameras start failing at arm's length across a
 * counter. The full-screen view behind the code goes larger still.
 */
const QR = 208;

const styles = StyleSheet.create({
  // Full-bleed, like the leaf. The book opens on a plate and closes on one.
  bleed: { marginHorizontal: -Gutter },
  plate: { borderRadius: 0 },
  body: { paddingHorizontal: Gutter, paddingVertical: Space.lg, gap: Space.lg },
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  quiet: {
    alignSelf: 'center',
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    padding: Space.md,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: QR + Space.md * 2,
    minHeight: QR + Space.md * 2,
  },
  pending: {
    width: QR,
    height: QR,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.sm,
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    minHeight: 44,
  },
  addressText: { flexGrow: 1, flexShrink: 1, gap: 2 },
  actions: { flexDirection: 'row', gap: Space.sm },
});
