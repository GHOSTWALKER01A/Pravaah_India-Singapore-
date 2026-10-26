import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useRouter } from 'expo-router';

import { Button, Micro, Text } from '@/components/ui';
import { Radius, Space, usePalette } from '@/theme';

import { ROUTES } from '@/constants/routes.constants';

import { StepUpPrompt } from './components/step-up-prompt';
import { useDeviceBinding } from './use-device-binding';
import { usePin } from './use-pin';

/**
 * Binds this device to the account, once, shortly after sign-in.
 *
 * Rendered inside the `AuthGuard` alongside `PushNotificationsBridge`, and for the same
 * reason: it needs a session, it runs once, and it has no screen of its own. The precedent is
 * deliberate — a boot-time side effect belongs in a bridge component, not scattered through a
 * layout or a context.
 *
 * ## Why binding happens HERE and not at the first payment
 *
 * The cooling-off window is the point. A device bound at the moment of a large transfer is a
 * device in minute one of its window — maximum friction, exactly when the user least wants
 * it. Binding shortly after sign-in means the clock is already running by the time they need
 * it, so an ordinary user answers one code on a screen where a code is expected and is never
 * challenged again.
 *
 * The attacker's experience is unchanged: they bind at takeover time and hit the wall on
 * their first big transfer. That asymmetry is the whole design.
 *
 * ## Why this renders a prompt at all, rather than nothing
 *
 * `PushNotificationsBridge` renders nothing because the OS owns its prompt. A bind challenge
 * is an SMS code, and the app has no way to read it — so somebody has to ask. Rendering a
 * SHEET rather than navigating is what keeps this out of the router: a bind is not a
 * destination, and pushing a screen would put it on the back stack where a swipe could
 * abandon it halfway.
 *
 * ## What happens if the user ignores it
 *
 * They stay unbound, and that is a supported state rather than a broken one. An unbound
 * device is scored `DEVICE_UNBOUND` and challenged when it does something sensitive — so the
 * cost of dismissing this is friction later, not a locked account. Which is why there is a
 * "Not now" and why a failure here is silent.
 */
export function DeviceBindingBridge({ enabled }: { enabled: boolean }) {
  const p = usePalette();
  const router = useRouter();
  const { state, confirm, dismiss } = useDeviceBinding(enabled);
  const pin = usePin(enabled);

  const [error, setError] = useState<string | null>(null);
  /**
   * True once the bind has been completed IN THIS SESSION.
   *
   * The PIN nudge is gated on this rather than on "is a PIN missing", and the distinction is the
   * difference between a prompt and a nag. A user without a PIN who signs in on an already-bound
   * device would otherwise meet this sheet on every single launch — and a security prompt that
   * appears unbidden every time is one people learn to dismiss without reading, which is exactly
   * the reflex that makes the real prompts fail.
   *
   * They reach the PIN from the security screen instead, where they went looking for it.
   */
  const [justBound, setJustBound] = useState(false);
  const [pinDismissed, setPinDismissed] = useState(false);

  const submit = async (answer: string) => {
    const result = await confirm(answer);
    if (!result.ok) {
      setError(result.error ?? 'That code was not correct.');
      return;
    }

    setJustBound(true);

    /**
     * Record the biometric the moment the bind lands, before asking about the PIN.
     *
     * This is step 2 of the three-step enrolment — **SMS OTP → biometric → PIN** — and the order
     * is load-bearing rather than tidy. The biometric is what will later authorise CHANGING the
     * PIN, so recording it first means the account has the strong change route from the instant
     * the PIN exists. Doing it afterwards would leave a window in which a brand-new PIN could
     * only be changed by the weaker SMS reset, complete with its cooling-off.
     *
     * Not awaited, and it cannot throw: the bind has already SUCCEEDED, and a bookkeeping call
     * that failed must not make a completed registration look broken.
     */
    void pin.recordBiometric();
  };

  /**
   * The PIN step, shown after a fresh bind on an account that has none.
   *
   * Placed before the `challenge` early-return so it survives the phase moving to `bound`.
   */
  const askForPin =
    justBound &&
    !pinDismissed &&
    /**
     * `!pin.loading` closes a race that would silently drop the nudge.
     *
     * `usePin` fetches on mount, which is well before the user has typed a six-digit code — so in
     * practice the status is settled. But `status` is `null` until it lands, and `null?.enrolled
     * === false` is false, so an unusually slow status call on an unusually fast bind would skip
     * the PIN step entirely and leave the user with no idea it existed. Waiting for the answer
     * costs a frame and makes the branch deterministic.
     */
    !pin.loading &&
    pin.status?.enrolled === false;

  if (askForPin) {
    return (
      <View
        style={[styles.scrim, { backgroundColor: p.scrim }]}
        accessibilityViewIsModal
      >
        <View
          style={[
            styles.sheet,
            { backgroundColor: p.ground, borderColor: p.ruleStrong },
          ]}
        >
          <Text role="title">Set a payment PIN</Text>
          {/*
            The reason, in terms of the threat the user can picture.

            "For extra security" is what every bank writes and it persuades nobody. The true
            reason is specific and checkable against the user's own experience: the code they
            just typed arrived on THIS phone, so it protects them from someone far away and not
            at all from someone holding the handset. A PIN is the part that does.
          */}
          <Micro tone="faint" style={styles.blurb}>
            This phone is registered. One more step: a six-digit PIN for
            payments. The code you just entered arrived on this phone, so it
            cannot protect you from someone holding it — a PIN can, because only
            you know it.
          </Micro>

          <Button
            label="Set my PIN"
            onPress={() => {
              setPinDismissed(true);
              router.push(ROUTES.SECURITY.PIN);
            }}
          />

          {/*
            Skippable, with the cost named. Same reasoning as the bind's own "Not now": a sheet
            somebody cannot escape immediately after sign-in is a sheet they close the app on,
            and an uninstalled app has no PIN either.
          */}
          <Button
            label="Later"
            onPress={() => setPinDismissed(true)}
            variant="quiet"
          />
          <Micro tone="faint" center>
            Without a PIN, we confirm larger payments with a code sent to this
            phone.
          </Micro>
        </View>
      </View>
    );
  }

  /**
   * Only the challenge phase renders. `binding`, `bound` and `failed` are all silent.
   *
   * `failed` in particular: the most common causes are an offline launch or a user who is not
   * KYC-verified yet, and neither is something to interrupt somebody about on the screen they
   * just landed on. The degradation is already safe.
   */
  if (state.phase !== 'challenge') return null;

  return (
    /*
      An overlay, not a modal route and not a full-screen takeover.

      It sits over whatever the user landed on so the app is visibly still there behind it —
      a full-screen interruption immediately after sign-in reads as a second login step and
      is where users abandon onboarding.
    */
    <View
      style={[styles.scrim, { backgroundColor: p.scrim }]}
      accessibilityViewIsModal
    >
      <View
        style={[
          styles.sheet,
          { backgroundColor: p.ground, borderColor: p.ruleStrong },
        ]}
      >
        <Text role="title">Register this phone</Text>
        <Micro tone="faint" style={styles.blurb}>
          Registering this phone lets us tell your payments apart from someone
          else&apos;s. It takes one code, once.
        </Micro>

        <StepUpPrompt
          challenge={state.challenge}
          onSubmit={(answer) => void submit(answer)}
          error={error}
          reason={null}
        />

        {/*
          "Not now" is a real option, and the copy says what it costs.

          A dismissible security prompt sounds like a weakness and is the opposite: a modal a
          user cannot escape at sign-in is a modal they close the app on, and an uninstalled
          app has no device layer at all. Stating the consequence is what makes the choice
          informed rather than a trap.
        */}
        <Button label="Not now" onPress={dismiss} variant="quiet" />
        <Micro tone="faint" center>
          If you skip this, larger payments will ask you to confirm them with a
          code each time.
        </Micro>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'flex-end',
    zIndex: 10,
  },
  sheet: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    padding: Space.xxl,
    gap: Space.lg,
  },
  blurb: { marginBottom: Space.sm },
});
