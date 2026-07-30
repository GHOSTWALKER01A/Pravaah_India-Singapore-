import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View, type TextInput } from 'react-native';

import { ApiError, kycService } from '@/api';
import { Button, Notice, TextField, haptic } from '@/components/ui';
import { Mechanism, StepScreen } from '@/features/kyc/components/step-screen';
import { checkStatusOf, nextRoute } from '@/features/kyc/flow';
import { useKycStatus } from '@/features/kyc/use-kyc-status';
import { Space } from '@/theme';

/**
 * Aadhaar OKYC — the step that leaves the app.
 *
 * The incumbent's failure here was a flow problem, not a visual one. It rendered
 * "Continue with DigiLocker" and then, only after the user returned, a second
 * button labelled "I've finished — verify". Someone who had never seen the screen
 * before had no idea a second step existed, and someone who force-quit on the
 * DigiLocker side came back to a screen with no memory that they had started.
 *
 * The two phases are now explicit, the second one is stated BEFORE the user
 * leaves, and returning lands on a screen that says what to do.
 *
 * Two further failures, both found against the live provider:
 *
 *   - DigiLocker ends on a page that prints an access code and says to copy it.
 *     There was nowhere to put it. The screen described a three-step mechanism
 *     that did not match what the user was actually looking at, and the flow
 *     dead-ended with the user holding a code and no field.
 *   - The session reference lived in component state only. Consent happens in
 *     another app, which is exactly when this one gets backgrounded and torn
 *     down — returning to a reloaded screen lost the session and the
 *     "your place here is saved" promise was false. It now resumes from the
 *     PENDING check the server already recorded.
 */

/**
 * Pull the access code out of whatever the user actually pasted.
 *
 * People paste more than the token: the surrounding label from the page, or —
 * once a redirect URL is configured — the whole return URL. Both are the user
 * doing the right thing, so neither should read as a format error.
 */
export function normalizeOkycCode(raw: string): string {
  const text = raw.trim();

  // A pasted redirect URL: take the `code` query parameter.
  const fromUrl = /[?&]code=([^&\s#]+)/i.exec(text);
  if (fromUrl) return decodeURIComponent(fromUrl[1]);

  return (
    text
      // "DigiLocker Code: abc123" → "abc123".
      .replace(/^.*?\bcode\b\s*[:=]\s*/i, '')
      // Copying off a web page picks up newlines and non-breaking spaces.
      .replace(/\s+/g, '')
  );
}

/**
 * Deliberately permissive. The code is an opaque provider token whose length
 * and alphabet are not contracted anywhere, so this rejects only what cannot
 * possibly be one — something too short, or carrying characters no token uses.
 * A tighter guess would block a user who pasted a perfectly good code.
 */
const CODE_SHAPE = /^[A-Za-z0-9._~-]{16,512}$/;

export default function AadhaarScreen() {
  const { status, loading } = useKycStatus();
  const [opening, setOpening] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [sessionRef, setSessionRef] = useState<string | null>(null);
  /**
   * The URL of the session currently in flight, kept so REOPENING returns to
   * the same one.
   *
   * Without it, "Reopen DigiLocker" called `initiate` again and minted a NEW
   * provider session, so any access code the user was already holding belonged
   * to the previous one. The provider rejects that as "session not valid or
   * expired" — indistinguishable from a mistyped code, so the user retypes a
   * code that cannot ever work.
   */
  const [sessionUrl, setSessionUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const codeField = useRef<TextInput>(null);

  /**
   * A session this device started earlier and the server still has open. Only a
   * PENDING check counts — a FAILED one is a finished attempt, and its stale
   * reference would put the screen straight back into "waiting" on arrival.
   */
  const openCheck = status?.checks.find(
    (c) => c.checkType === 'AADHAAR_OKYC' && c.status === 'PENDING',
  );
  const providerRefId = sessionRef ?? openCheck?.providerRefId ?? null;
  const away = providerRefId != null;

  const trimmed = code.trim();
  const codeValid = CODE_SHAPE.test(trimmed);
  const codeMalformed = trimmed.length > 0 && !codeValid;

  /**
   * @param fresh Abandon the session in flight and start a new one. Only from
   * an explicit "start over" — never from reopening, which must return to the
   * SAME session so a code already in the user's hands stays valid.
   */
  async function open(fresh = false) {
    setError(null);
    setNote(null);

    // Reopening: reuse the URL we already hold rather than minting a session
    // that would silently invalidate the code the user is carrying. A session
    // resumed from the server has no URL to return to, so that case falls
    // through and starts a new one — announced below rather than silent.
    if (!fresh && sessionUrl) {
      await visit(sessionUrl);
      return;
    }

    setOpening(true);
    let authorizationUrl: string;
    try {
      const initiated = await kycService.initiateAadhaarOkyc();
      authorizationUrl = initiated.authorizationUrl;
      setSessionRef(initiated.providerRefId);
      setSessionUrl(initiated.authorizationUrl);
      /**
       * A new session makes any code already pasted meaningless — it belongs
       * to the session it was issued under. Clearing it silently would leave
       * the user wondering where it went, so it is cleared AND said out loud.
       */
      if (code) {
        setCode('');
        setNote(
          'That was a new DigiLocker session, so the earlier code no longer applies. Finish the consent and use the new code.',
        );
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not open DigiLocker. Check your connection and try again.',
      );
      return;
    } finally {
      // Released before the browser opens: the button must not sit spinning
      // underneath a tab the user is going to spend a minute in.
      setOpening(false);
    }

    await visit(authorizationUrl);
  }

  /** Hand the user to the consent page and notice when they come back. */
  async function visit(authorizationUrl: string) {
    try {
      /**
       * An in-app tab rather than `Linking.openURL`, for one behavioural
       * reason: it resolves when the user dismisses it, which is the only
       * signal this screen gets that they are back. That is when the code field
       * takes focus. `Linking` hands the user to another app and never reports
       * back.
       */
      await WebBrowser.openBrowserAsync(authorizationUrl);
      codeField.current?.focus();
    } catch {
      // Some devices have no Custom Tabs / SFSafariViewController provider at
      // all. Falling back keeps the step completable — the user just has to
      // come back on their own.
      await Linking.openURL(authorizationUrl).catch(() => {
        setError('No browser is available to open DigiLocker on this device.');
      });
    }
  }

  async function paste() {
    setError(null);
    const clip = await Clipboard.getStringAsync().catch(() => '');
    if (!clip.trim()) {
      setNote(
        'The clipboard is empty. Copy the code from the DigiLocker page first.',
      );
      return;
    }
    setNote(null);
    setCode(normalizeOkycCode(clip));
  }

  async function complete() {
    if (!providerRefId || completing || codeMalformed) return;
    setError(null);
    setNote(null);
    setCompleting(true);
    try {
      const updated = await kycService.completeAadhaarOkyc(
        providerRefId,
        codeValid ? trimmed : undefined,
      );

      switch (checkStatusOf(updated, 'AADHAAR_OKYC')) {
        case 'PASSED':
        case 'MANUAL_REVIEW':
          haptic.commit();
          router.replace(nextRoute(updated));
          return;

        case 'FAILED':
          haptic.refused();
          setError(
            'DigiLocker did not return your Aadhaar details. Start the consent again, and approve every screen through to the end.',
          );
          return;

        /**
         * Still PENDING — consent is not registered yet. Previously this fell
         * through to `router.replace(nextRoute(...))`, which resolved to THIS
         * screen and so looked like the button did nothing at all.
         */
        default:
          haptic.refused();
          setError(
            trimmed
              ? 'DigiLocker has not confirmed this session yet. If you took a while, start a new session — the access code is only valid for a few minutes.'
              : 'DigiLocker has not confirmed your consent yet. If the page showed you a code, paste it above and try again.',
          );
          return;
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not finish Aadhaar OKYC.',
      );
    } finally {
      setCompleting(false);
    }
  }

  return (
    <StepScreen
      check="AADHAAR_OKYC"
      status={status}
      title="Aadhaar, through DigiLocker"
      lede="You give consent on the government's own portal, then come back here to finish."
      error={error}
      assurance="Pravaah receives a masked Aadhaar — the last four digits — and your verified name. The full number is never sent to us and never stored."
      footer={
        <View style={styles.footer}>
          {away ? (
            <>
              <Button
                label="Finish verification"
                onPress={() => void complete()}
                loading={completing}
                disabled={codeMalformed}
              />
              {/*
                Two distinct actions, because they were one and the difference
                is invisible from the outside. "Reopen" returns to the SAME
                consent page and keeps any code the user already holds valid;
                "Start a new session" abandons it and issues a new code.
                Collapsed into one button, every reopen silently invalidated
                whatever the user had just copied.
              */}
              <Button
                label="Reopen DigiLocker"
                variant="quiet"
                iconEnd="external"
                onPress={() => void open()}
                loading={opening}
              />
              <Button
                label="Start a new session"
                variant="quiet"
                onPress={() => void open(true)}
                hint="Abandons the current DigiLocker session and issues a new code."
              />
            </>
          ) : (
            <Button
              label="Continue to DigiLocker"
              iconEnd="external"
              onPress={() => void open()}
              loading={opening}
              /**
               * Held until the status lands. A session already open on the
               * server only becomes visible then, and a tap in that gap would
               * start a SECOND DigiLocker session and orphan the first.
               */
              disabled={loading}
            />
          )}
        </View>
      }
    >
      {/* Shown once the user has left, so the screen they return to explains
          itself rather than presenting a mystery second button. */}
      {away ? (
        <>
          <Notice tone="caution" title="Finish in DigiLocker, then come back">
            Approve the consent screen. If DigiLocker shows you an access code at
            the end, paste it below and finish straight away — the code expires
            within a few minutes.
          </Notice>

          <TextField
            ref={codeField}
            label="DigiLocker code"
            value={code}
            onChangeText={(t) => {
              setCode(t);
              if (error) setError(null);
              if (note) setNote(null);
            }}
            measured
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            placeholder="Paste the code shown by DigiLocker"
            valid={codeValid}
            hint={
              note ??
              (codeValid
                ? undefined
                : 'Leave this empty if DigiLocker returned you here without showing a code.')
            }
            error={
              codeMalformed
                ? "That doesn't look like a complete code — copy the whole value from the DigiLocker page."
                : null
            }
            returnKeyType="go"
            onSubmitEditing={() => void complete()}
          />

          <Button
            label="Paste from clipboard"
            variant="secondary"
            icon="copy"
            inline
            onPress={() => void paste()}
          />
        </>
      ) : null}

      <Mechanism
        lines={[
          'DigiLocker opens and asks you to approve sharing your Aadhaar KYC data.',
          'It returns a signed document containing your name and a masked Aadhaar.',
          'You come back here — pasting the code if you were shown one — and tap to finish.',
        ]}
      />
    </StepScreen>
  );
}

const styles = StyleSheet.create({ footer: { gap: Space.sm } });
