import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { CameraView, scanFromURLAsync, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';

import {
  Button,
  Header,
  Icon,
  type IconName,
  Micro,
  Notice,
  Rule,
  Press,
  Screen,
  Spinner,
  Text,
  haptic,
} from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';

import { passportService } from '@/api';
import { paymentQrService, paymentsService } from '@/api/payments/services';
import type { ScannedQrView } from '@/api/payments/schemas';
import { ROUTES } from '@/constants/routes.constants';
import {
  AmountField,
  AmountLine,
  NameConfirmation,
  PayeeLine,
} from '@/features/payments/components';
import {
  amountFromMinor,
  amountToMinor,
  emptyAmount,
  isAmountEmpty,
  type AmountEntry,
} from '@/features/payments/money';
import { useIdempotencyKey } from '@/features/payments/use-idempotency-key';

/**
 * Scan a UPI QR and pay it.
 *
 * Two phases on one screen, because losing the camera context between reading a code and paying it
 * is how somebody pays the wrong shopfront. And one rule that is the whole security posture here:
 * **the payload is parsed by the SERVER, never in this app.**
 *
 * A QR is attacker-supplied input that resolves to a payee. Whoever printed the code chose every
 * byte of it, and two parsers that disagree about a malformed one — ours and the app's — are two
 * different answers to "who gets the money". So the camera's only job is to read pixels into a
 * string and hand it over. Everything the user then sees, including the payee's real name, comes
 * back from the server.
 *
 * The other thing this screen does that most do not: it shows the code's own `pn` name and the
 * PAYEE BANK's name as separate facts, and says which to trust when they disagree.
 */
/**
 * Does this string address the passport reader rather than the payments one?
 *
 * ADDRESSING, not parsing — see `onBarcode`. It matches the one thing a Pravaah passport code
 * always contains: the `/verify/card/<ref>` path. Matching the PATH and not the host is
 * deliberate, because the public URL is an ngrok tunnel in development and a real domain in
 * production, and a host check would make every demo code unscannable.
 *
 * Kept narrow on purpose. A false positive sends a real payment code to a reader that will
 * refuse it, which is a worse failure than the extra round trip a false negative costs — and the
 * bare-reference case a wider pattern would catch is handled as a fallback instead.
 */
function looksLikePassport(payload: string): boolean {
  return /\/verify\/card\/[A-Za-z0-9_-]{16,64}/.test(payload.trim());
}

export function ScanScreen() {
  const router = useRouter();
  const p = usePalette();
  const [permission, requestPermission] = useCameraPermissions();

  const [payload, setPayload] = useState<string | null>(null);
  const [scanned, setScanned] = useState<ScannedQrView | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [entry, setEntry] = useState<AmountEntry>(emptyAmount);
  const [confirmed, setConfirmed] = useState(false);
  const [paying, setPaying] = useState(false);

  /**
   * The torch.
   *
   * Not a nicety. The scene this app was designed for is "a mid-range Android, one hand, often at
   * night" — and the single most common reason a UPI scan fails is a code printed on glossy stock
   * under bad light. `enableTorch` is a prop on `CameraView` in expo-camera 17, so this costs
   * nothing but the control itself.
   */
  const [torch, setTorch] = useState(false);
  const [picking, setPicking] = useState(false);

  const { key: idempotencyKey, reset: resetKey } = useIdempotencyKey();

  /**
   * A latch, not a state flag.
   *
   * `onBarcodeScanned` fires on every frame the code is in view — dozens of times a second. A
   * `useState` guard would not stop the second call, because it fires again before React has
   * re-rendered. The ref closes the camera in the same tick.
   */
  const locked = useRef(false);

  /**
   * One camera, two kinds of code.
   *
   * The user should never have to declare what they are about to scan — the code knows what it
   * is, and asking first ("pay or verify?") is a question nobody can answer while holding a phone
   * up to a stranger's screen. So this reads both and routes.
   *
   * ── How the routing stays honest ──
   * The rule at the top of this file still holds: THE PAYLOAD IS PARSED BY THE SERVER. What
   * happens here is not parsing, it is addressing — picking which server-side parser to hand the
   * string to. Both endpoints fully validate whatever they receive, and neither trusts a single
   * byte of this classification: a crafted string that talks its way into the passport reader
   * simply fails to resolve there, and one that reaches the payment reader is priced and
   * name-checked exactly as before.
   *
   * The order matters for latency, not for safety. Payment is the overwhelmingly common scan and
   * the one where a wasted round trip is felt, so a code that does not LOOK like a passport goes
   * straight to the payments reader. A passport-shaped URL never touches the payments reader at
   * all, because "that is not a UPI payment" would be a confusing thing to tell somebody who
   * correctly scanned a passport we failed to recognise.
   */
  const onBarcode = async ({ data }: { data: string }) => {
    if (locked.current) return;
    locked.current = true;
    haptic.commit();
    setReading(true);
    setError(null);
    try {
      if (looksLikePassport(data)) {
        const outcome = await passportService.scan(data);
        if (outcome.kind === 'PASSPORT') {
          // Nothing about the holder came back and nothing is shown here. The next screen
          // waits for THEM to approve; that is the whole privacy property.
          router.replace(ROUTES.PASSPORT.CHECK(outcome.requestId));
          return;
        }
        setError(
          'That looks like a Pravaah code, but it is not one we recognise. Ask them to show it again from their app.',
        );
        locked.current = false;
        return;
      }

      const result = await paymentQrService.scan(data);
      setPayload(data);
      setScanned(result);
      // A dynamic QR carries its own amount and it is not editable. Seed the keypad from it so
      // the figure the user confirms is the figure the code specified.
      if (result.amount && !result.amountEditable) {
        setEntry(amountFromMinor(result.amount.minor, result.currency));
      }
    } catch (caught) {
      /**
       * No second attempt against the passport reader here, and that is deliberate.
       *
       * An earlier version retried the passport path whenever payments failed, to catch a
       * "bare card reference" an NFC tag might carry. That form does not exist: `CardService`
       * writes the tag with the same verify URL the QR encodes, and accepting a naked token
       * server-side turned out to swallow real EMVCo payment payloads, which the backend spec
       * now pins. Both readers key off the same `/verify/card/` path, so a code the classifier
       * above rejected is a code this reader would reject too — the retry could only ever cost
       * a round trip on a failure the user is already looking at.
       */
      setError(
        caught instanceof Error
          ? caught.message
          : 'That code could not be read as a UPI payment.',
      );
      // Unlock so the user can try another code. The failure is about the code, not the camera.
      locked.current = false;
    } finally {
      setReading(false);
    }
  };

  /**
   * Read a code out of a photo the user already has.
   *
   * The case this exists for is real and common: a code arrives over WhatsApp, or is on a screen the
   * user cannot point a camera at because the camera is *in* that screen. Every major Indian UPI app
   * ships it for that reason.
   *
   * Two things make this safe to add. `scanFromURLAsync` decodes NATIVELY — the same platform
   * decoder the live camera uses — so there is no second QR parser in this codebase to disagree with
   * the first. And the decoded string goes through `onBarcode`, meaning it takes the identical
   * server-side validation path as a live scan: this screen still never interprets a payload.
   *
   * The image itself never leaves the phone. Only the decoded string is sent, exactly as with the
   * camera.
   */
  const pickAndScan = async () => {
    setError(null);
    setPicking(true);
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        // No cropping UI: a QR needs its quiet zone and its three finder patterns intact, and a user
        // cropping tight to the "interesting" part is how a decodable code becomes undecodable.
        allowsEditing: false,
        quality: 1,
      });
      if (picked.canceled) return;

      const uri = picked.assets[0]?.uri;
      if (!uri) {
        setError('That image could not be opened.');
        return;
      }

      const found = await scanFromURLAsync(uri, ['qr']);
      const data = found[0]?.data;
      if (!data) {
        setError(
          'No QR code was found in that picture. Try a clearer or less cropped image.',
        );
        return;
      }

      // Released so a previous failed scan does not block this one, then straight down the same
      // path a live frame takes.
      locked.current = false;
      await onBarcode({ data });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'That image could not be read.',
      );
    } finally {
      setPicking(false);
    }
  };

  const rescan = () => {
    locked.current = false;
    setPayload(null);
    setScanned(null);
    setEntry(emptyAmount);
    setConfirmed(false);
    setError(null);
    // A new scan is a new intent, so it gets a new key. Reusing the old one would let the server
    // replay the previous payment's response for a different shopfront.
    resetKey();
  };

  const minor = amountToMinor(entry);
  const canPay =
    scanned?.payable === true &&
    !isAmountEmpty(entry) &&
    confirmed &&
    !paying;

  const onPay = async () => {
    if (!scanned || !payload) return;
    setPaying(true);
    setError(null);
    try {
      // The amount still comes from a quote: a scanned code PROPOSES a figure, it does not set
      // the price. The server prices it and cross-checks the total we send back.
      const quote = await paymentsService.quote({
        sourceCurrency: scanned.currency,
        destCurrency: scanned.currency,
        mode: 'SOURCE',
        amountMinor: minor,
        type: scanned.merchantCode ? 'P2M' : 'P2P',
        purposeCode: scanned.merchantCode ? 'MERCHANT_PAYMENT' : 'P2P_TRANSFER',
      });

      const created = await paymentQrService.pay(idempotencyKey, {
        payload,
        quoteId: quote.quoteId,
        expectedTotalDebitMinor: quote.totalDebit.minor,
        confirmedRegisteredName: scanned.registeredName ?? '',
        confirmedName: true,
      });
      haptic.commit();
      router.replace(ROUTES.PAY.RECEIPT(created.id));
    } catch (caught) {
      haptic.refused();
      setError(
        caught instanceof Error
          ? caught.message
          : 'That payment could not be sent. Nothing has left your wallet.',
      );
    } finally {
      setPaying(false);
    }
  };

  // ── permission ──────────────────────────────────────────────────────────
  if (!permission) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Scan' }} />
        <View style={styles.centre}>
          <Spinner label="Checking camera access" />
        </View>
      </Screen>
    );
  }

  if (!permission.granted) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Scan' }} />
        <Header
          title="Camera access"
          lede="Pravaah needs the camera to read a UPI QR code. Nothing is recorded or uploaded — the code is read on your phone and only the text inside it is sent to be checked."
        />
        <Button label="Allow camera" onPress={requestPermission} />
        <Micro>
          You can also pay by typing a UPI ID instead, if you would rather not use the
          camera.
        </Micro>
        <Button
          label="Type a UPI ID instead"
          variant="secondary"
          onPress={() => router.replace(ROUTES.PAY.PAYEE_ADD)}
        />
      </Screen>
    );
  }

  // ── phase 2: review and pay ─────────────────────────────────────────────
  if (scanned) {
    return (
      <Screen
        scroll
        footer={
          scanned.payable ? (
            <Button
              label={paying ? 'Sending…' : 'Sign and pay'}
              onPress={onPay}
              disabled={!canPay}
              loading={paying}
              hint={
                !confirmed
                  ? 'Confirm the payee’s name to continue'
                  : isAmountEmpty(entry)
                    ? 'Enter an amount'
                    : undefined
              }
            />
          ) : (
            <Button label="Scan another code" variant="secondary" onPress={rescan} />
          )
        }
      >
        <Stack.Screen options={{ title: 'Confirm payment' }} />

        <Header
          title="Check this before you pay"
          lede="Read the name their bank holds, not the name on the code."
        />

        {scanned.blockedReason ? (
          <Notice tone="error" title="Do not pay this code">
            {scanned.blockedReason}
          </Notice>
        ) : null}

        {/*
          A signature failure on a dynamic QR is its own warning, in carmine, because it means the
          code has been ALTERED since it was created — the `am=1.00` → `am=100.00` attack.
        */}
        {scanned.signatureValid === false ? (
          <Notice tone="error" title="This code has been tampered with">
            The amount or the payee on this code does not match what was originally
            created. Ask the merchant for a new code.
          </Notice>
        ) : null}

        <View style={[styles.plate, { borderColor: p.ruleStrong, backgroundColor: p.panel }]}>
          <PayeeLine
            registeredName={scanned.registeredName}
            handle={scanned.payeeAddress}
            bankName={scanned.bankName}
            printedName={scanned.printedName}
            unreachableReason={!scanned.reachable ? 'Their bank does not recognise this UPI ID.' : null}
          />

          <Rule />

          {scanned.amountEditable ? (
            <AmountField
              entry={entry}
              onChange={setEntry}
              currency={scanned.currency}
              label="Amount — you enter it"
              autoFocus
              hint="This code does not carry an amount, so you decide. That is what makes it reusable — it is a shopfront sticker, not a bill."
            />
          ) : (
            <AmountLine
              minor={minor}
              currency={scanned.currency}
              label="Amount on the code"
            />
          )}
        </View>

        {scanned.isPravaahQr ? (
          <Micro>
            This is a Pravaah code, so we can vouch for what is on it.
            {scanned.kind === 'DYNAMIC'
              ? ' It is a one-time code and can only be paid once.'
              : ''}
          </Micro>
        ) : (
          <Notice tone="caution" title="Not a Pravaah code">
            We cannot vouch for what is printed on this code, only for the name its bank
            gave us. If the name is not who you expect, stop.
          </Notice>
        )}

        {scanned.payable ? (
          <NameConfirmation
            registeredName={scanned.registeredName}
            checked={confirmed}
            onChange={setConfirmed}
            nameShownAbove
          />
        ) : null}

        {error ? (
          <Notice tone="error" title="Not sent">
            {error}
          </Notice>
        ) : null}

        <Button label="Scan a different code" variant="quiet" onPress={rescan} />
      </Screen>
    );
  }

  // ── phase 1: the camera ─────────────────────────────────────────────────
  return (
    <Screen scroll={false} bleed>
      <Stack.Screen options={{ title: 'Scan a code' }} />

      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          // Only QR. Widening this to every symbology would have the camera fire on a barcode on
          // a cereal box, and every one of those is a server round trip.
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={locked.current ? undefined : onBarcode}
        />

        {/* The reticle, in the note's own grammar: engraved corner marks, no rounded overlay. */}
        <View style={styles.reticleWrap} pointerEvents="none">
          <View style={[styles.reticle, { borderColor: p.onFieldLatent }]} />
        </View>

        {/*
          The two instruments, over the camera rather than below it.

          Placement is the whole point: the phone is held UP at a code, so these have to be within a
          thumb's reach of where the hand already is. A control row under the viewport would mean
          lowering the phone, losing the code, and re-aiming.
        */}
        <View style={styles.instruments}>
          <Instrument
            icon="torch"
            label={torch ? 'Torch on' : 'Torch'}
            active={torch}
            onPress={() => {
              haptic.select();
              setTorch((on) => !on);
            }}
          />
          <Instrument
            icon="image"
            label="From a photo"
            busy={picking}
            onPress={pickAndScan}
          />
        </View>

        {reading ? (
          <View style={[styles.reading, { backgroundColor: p.fieldDeep }]}>
            <Spinner />
            <Text role="bodySm" surface="field">
              Checking this code…
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.cameraFoot}>
        {error ? (
          <Notice tone="error" title="Could not read that code">
            {error}
          </Notice>
        ) : (
          <Micro center>
            Point the camera at a UPI QR code. We read it on your phone and check the payee
            with their bank before anything can be paid.
          </Micro>
        )}
        <Button
          label="Type a UPI ID instead"
          variant="secondary"
          onPress={() => router.replace(ROUTES.PAY.PAYEE_ADD)}
        />
      </View>
    </Screen>
  );
}

/**
 * One camera instrument: an engraved disc with its label beneath.
 *
 * The reference apps draw these as flat grey circles on a scrim. That would be a foreign object
 * here, so the disc is struck into the plate instead — a hairline ring in `onFieldLatent`, filling
 * with the gold when it is engaged. The active state is carried by BOTH the fill and the label text
 * ("Torch" → "Torch on"), never by colour alone, because the palette rule and the accessibility
 * floor both require it.
 *
 * The disc fill is OPAQUE `fieldDeep`, not a translucent scrim, and that is a contrast decision
 * rather than an aesthetic one. Behind this control is a live camera feed, so the pixels underneath
 * can be anything from a white wall to a night street — a semi-transparent fill has no defined
 * contrast ratio at all, and `verify-contrast.mjs` could not check it even in principle. Opaque
 * `fieldDeep` under `onFieldLatent` is a pair the harness already verifies, so the icon is legible
 * over any scene by construction.
 */
function Instrument({
  icon,
  label,
  onPress,
  active = false,
  busy = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  active?: boolean;
  busy?: boolean;
}) {
  const p = usePalette();
  return (
    <Press
      onPress={onPress}
      disabled={busy}
      depth="subtle"
      radius={Radius.pill}
      style={styles.instrument}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, busy, disabled: busy }}
    >
      <View
        style={[
          styles.disc,
          {
            borderColor: p.onFieldLatent,
            backgroundColor: active ? p.onFieldLatent : p.fieldDeep,
          },
        ]}
      >
        {busy ? (
          <Spinner size={18} />
        ) : (
          <Icon
            name={icon}
            size={20}
            color={active ? p.fieldDeep : p.onFieldLatent}
          />
        )}
      </View>
      <Micro surface="field" center numberOfLines={1}>
        {label}
      </Micro>
    </Press>
  );
}

const styles = StyleSheet.create({
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  cameraWrap: {
    flexGrow: 1,
    minHeight: 320,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  instruments: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: Space.xl,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Space.xxl,
  },
  // 48dp target comes from the disc plus the label; the padding carries it so the control grows
  // with the OS font setting instead of clipping.
  instrument: { alignItems: 'center', gap: Space.xs, minWidth: 64, paddingVertical: Space.xs },
  disc: {
    width: 48,
    height: 48,
    borderRadius: Radius.pill,
    borderWidth: Hairline.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticleWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  reticle: {
    width: '68%',
    aspectRatio: 1,
    borderWidth: Hairline.thick,
    borderRadius: Radius.lg,
  },
  reading: {
    position: 'absolute',
    bottom: Space.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    borderRadius: Radius.md,
  },
  cameraFoot: { padding: Space.xl, gap: Space.md },
  plate: {
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    padding: Space.lg,
    gap: Space.md,
  },
  confirm: {
    borderTopWidth: Hairline.base,
    borderBottomWidth: Hairline.base,
    paddingVertical: Space.lg,
  },
});
