import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Icon,
  Micro,
  OtpInput,
  Panel,
  Rule,
  Text,
  haptic,
} from '@/components/ui';
import { Radius, Space, usePalette } from '@/theme';

import type { StepUpChallenge } from '@/api/security/schemas';

import {
  STEP_UP_METHOD,
  STEP_UP_OTP_LENGTH,
  formatExpiry,
} from '../security-meta';

/**
 * The step-up prompt — the visible face of M6.
 *
 * ## Why it is a PANEL and not a modal
 *
 * A step-up on a payment arrives when the payment already exists and is sitting in
 * `RISK_HELD`. So the honest place for it is on that payment's own screen: the user can see
 * the amount, the payee and the reference while they confirm, and if they close the app the
 * challenge is still there when they come back — the detail poll re-delivers the nonce.
 *
 * A modal would have neither property. It would float over a screen the user cannot read
 * while deciding, and dismissing it would strand a real payment in a held state with no
 * visible route out. (The consent-to-disclose screen IS a modal, and for the opposite
 * reason: somebody is standing in front of the holder waiting, and there is nothing to
 * return to.)
 *
 * ## Why the reason is always shown
 *
 * "For your security" alone is what every bank says, and it is why nobody reads it. A user
 * who is told "an unusually large amount from a device added recently" learns something
 * true, understands why THIS payment and not the last one, and does not open a support
 * ticket. It is also the DPDP automated-decision-transparency obligation discharged at the
 * moment it actually matters.
 *
 * The reason comes from the server and is deliberately not composed here — the client does
 * not know which signals fired, and should not.
 */
export function StepUpPrompt({
  challenge,
  onSubmit,
  onResend,
  busy = false,
  error,
  /** Shown above the prompt when the caller has richer context than the challenge does. */
  reason,
}: {
  challenge: StepUpChallenge;
  onSubmit: (answer: string) => void;
  onResend?: () => void;
  busy?: boolean;
  error?: string | null;
  reason?: string | null;
}) {
  const p = usePalette();
  const [code, setCode] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const method = STEP_UP_METHOD[challenge.method];
  const expiry = formatExpiry(challenge.expiresAt, now);
  const expired = expiry === null;

  /**
   * A PIN challenge and an OTP challenge look alike and are not alike.
   *
   * Three things change, and each of them would be a real defect if left as the OTP behaviour:
   *
   *  1. **Masked, with autofill off.** A PIN is reused for months; an OTP is dead in five
   *     minutes. Beyond the shoulder-surf, a field advertising itself as `oneTimeCode` invites
   *     the OS to paste an unrelated SMS code into it — and teaches the keychain to file a
   *     long-lived payment secret as a disposable one.
   *
   *  2. **No countdown, but the expiry still bites.** Counting down five minutes beside a PIN
   *     field frames the user's own memory as something with a deadline, so the timer is not
   *     shown. What is NOT skipped is the lapsed state: the challenge row expires server-side
   *     whatever this component renders, so a PIN prompt left open past its window has to say
   *     so and offer a fresh one. Hiding the countdown while also hiding the lapse would leave
   *     a disabled field with no explanation — the exact failure the OTP branch was written to
   *     avoid.
   *
   *  3. **"Try again", not "send a new code".** Re-issuing a PIN challenge is real and
   *     instant — it mints a new nonce and sends no SMS. The OTP wording would be a lie about
   *     what the button does, and a user waiting for a message that never arrives.
   */
  const isPin = challenge.method === 'PIN_REAUTH';

  /**
   * A one-second tick, only while the challenge is live.
   *
   * Stopped once it lapses rather than left running: a timer that keeps firing after it has
   * nothing to count is a wake-up per second for a screen that will not change.
   */
  useEffect(() => {
    if (expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [expired]);

  /**
   * Clear the field when a wrong code comes back.
   *
   * Leaving the digits in place looks like nothing happened, and the user retypes over a
   * full field. `OtpInput` shakes on `error`, so the clear plus the shake is one legible
   * event: that was wrong, try again.
   */
  useEffect(() => {
    if (error) {
      setCode('');
      haptic.refused();
    }
  }, [error]);

  const submit = (value: string) => {
    if (busy || expired) return;
    onSubmit(value);
  };

  return (
    <Panel>
      <View style={styles.head}>
        {/*
          `lock`, not `alert`. The distinction is the whole tone of this component: a
          challenge is a protection being applied, not a warning about the user. An alarm
          glyph here would read as an accusation to the overwhelming majority of people who
          see it — who are, at these thresholds, legitimate users.
        */}
        <Icon name="lock" size={18} color={p.latent} />
        <Text role="heading" style={styles.title}>
          {method.title}
        </Text>
      </View>

      {reason ? (
        <Text role="bodySm" tone="dim" style={styles.reason}>
          {reason}
        </Text>
      ) : challenge.reason ? (
        <Text role="bodySm" tone="dim" style={styles.reason}>
          {challenge.reason}
        </Text>
      ) : null}

      <Rule />

      <Text role="bodySm" style={styles.prompt}>
        {method.prompt}
      </Text>

      {/*
        The real code field, with OS autofill. `OtpInput` owns one hidden `TextInput` behind
        display cells so `oneTimeCode` / `sms-otp` and paste-the-whole-code both work — which
        matters more here than anywhere, because this prompt appears mid-payment and a user
        who has to leave the app to read an SMS is a user who may not come back to it.
      */}
      <OtpInput
        value={code}
        onChangeText={setCode}
        length={STEP_UP_OTP_LENGTH}
        autoFocus
        error={Boolean(error)}
        editable={!busy && !expired}
        onComplete={submit}
        secure={isPin}
      />

      {error ? (
        <Text role="bodySmMedium" tone="carmine" style={styles.error}>
          {error}
        </Text>
      ) : null}

      {/*
        Attempts remaining, shown only once it starts to matter.

        Rendered from the second attempt onward rather than from the first: "3 attempts
        remaining" on a fresh challenge invites a user to treat the code as a guess. After a
        miss it is genuinely useful information — it tells them whether to check the SMS
        again or ask for a new code.
      */}
      {challenge.attemptsRemaining !== undefined &&
      challenge.attemptsRemaining < 3 ? (
        <Micro tone="faint" style={styles.meta}>
          {challenge.attemptsRemaining === 0
            ? isPin
              ? 'No attempts left. Reset your PIN to continue.'
              : 'No attempts left on this code. Ask for a new one.'
            : `${challenge.attemptsRemaining} ${
                challenge.attemptsRemaining === 1 ? 'attempt' : 'attempts'
              } left${isPin ? '' : ' on this code'}`}
        </Micro>
      ) : null}

      <View style={styles.footer}>
        {isPin ? (
          /*
            A PIN prompt: one action while live, and an honest lapse when it times out.

            Deliberately NOT sharing the OTP branch below, because every string in it is about a
            secret that was DELIVERED — "that code has expired", "send a new code", the visible
            countdown. Wrapping a PIN field in an expiring code's furniture would tell the user
            their own PIN had expired.
          */
          expired ? (
            <>
              <Micro tone="carmine" style={styles.meta}>
                This confirmation timed out.
              </Micro>
              {onResend ? (
                <Button
                  label="Try again"
                  onPress={onResend}
                  variant="secondary"
                  disabled={busy}
                />
              ) : null}
            </>
          ) : (
            <Button
              label="Confirm"
              onPress={() => submit(code)}
              disabled={code.length < STEP_UP_OTP_LENGTH || busy}
              loading={busy}
            />
          )
        ) : expired ? (
          /*
            An expired challenge keeps the panel on screen and changes the ACTION.

            Blanking it would leave the user on a held payment with no explanation of what
            happened to the prompt they were looking at — the same reasoning the send-confirm
            screen applies to a lapsed price.
          */
          <>
            <Micro tone="carmine" style={styles.meta}>
              That code has expired.
            </Micro>
            {onResend ? (
              <Button
                label="Send a new code"
                onPress={onResend}
                variant="secondary"
                disabled={busy}
              />
            ) : null}
          </>
        ) : (
          <>
            <Micro tone="faint" style={styles.meta}>
              Expires in {expiry}
            </Micro>
            <Button
              label="Confirm"
              onPress={() => submit(code)}
              disabled={code.length < STEP_UP_OTP_LENGTH || busy}
              loading={busy}
            />
            {onResend ? (
              <Button
                label="Send a new code"
                onPress={onResend}
                variant="quiet"
                disabled={busy}
              />
            ) : null}
          </>
        )}
      </View>

    </Panel>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  title: { flexShrink: 1 },
  reason: { marginTop: Space.md },
  prompt: { marginTop: Space.lg, marginBottom: Space.lg },
  error: { marginTop: Space.md },
  meta: { marginTop: Space.sm },
  footer: { marginTop: Space.xxl, gap: Space.md },
});
