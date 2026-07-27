import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError, kycService, type LivenessSessionData } from '@/api';
import {
  Button,
  CameraCapture,
  Icon,
  Legend,
  Reticle,
  Spinner,
  Text,
  haptic,
} from '@/components/ui';
import { StepScreen } from '@/features/kyc/components/step-screen';
import { checkStatusOf, nextRoute } from '@/features/kyc/flow';
import { GESTURE_META } from '@/features/kyc/gestures';
import { useKycStatus } from '@/features/kyc/use-kyc-status';
import { Radius, Space, usePalette } from '@/theme';

/** Reversed out of the camera feed, which is whatever the room happens to be. */
const ON_LENS = 'rgba(238,239,231,0.96)';
const ON_LENS_DIM = 'rgba(238,239,231,0.72)';

export default function LivenessScreen() {
  const { status } = useKycStatus();
  const p = usePalette();
  const [session, setSession] = useState<LivenessSessionData | null>(null);
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh, randomised challenge each time the screen opens — a replayed one
  // would defeat the point of the check.
  useEffect(() => {
    let active = true;
    kycService
      .createLivenessSession()
      .then((s) => active && setSession(s))
      .catch(
        (err) =>
          active &&
          setError(
            err instanceof ApiError
              ? err.message
              : 'Could not start the liveness check.',
          ),
      );
    return () => {
      active = false;
    };
  }, []);

  async function submit(selfieUri: string) {
    if (!session) return;
    setError(null);
    setSubmitting(true);
    try {
      const updated = await kycService.verifyLiveness(
        session.sessionId,
        selfieUri,
        session.challenge,
      );
      if (checkStatusOf(updated, 'LIVENESS') === 'FAILED') {
        haptic.refused();
        setError(
          'We could not confirm a live person. Bright, even light and no hat or sunglasses helps most. Here is a fresh challenge.',
        );
        setStep(0);
        setSession(await kycService.createLivenessSession());
        return;
      }
      haptic.commit();
      router.replace(nextRoute(updated));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'The liveness check could not be sent.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  const total = session?.challenge.length ?? 0;
  const complete = total > 0 && step >= total;
  const current = session?.challenge[step];
  const meta = current ? GESTURE_META[current] : null;

  return (
    <StepScreen
      check="LIVENESS"
      status={status}
      title="Prove you're really here"
      lede="A short randomised challenge, then one photo. It confirms a present person rather than a photo or a recording."
      error={error}
      assurance="The server makes the final call. A borderline result goes to a human reviewer — it is never an instant rejection."
    >
      {!session ? (
        <View style={styles.loading}>
          <Spinner size={24} label="Preparing your challenge" />
          <Text role="bodySm" tone="dim">
            Preparing a fresh challenge…
          </Text>
        </View>
      ) : (
        <CameraCapture
          facing="front"
          canCapture={complete}
          busy={submitting}
          captureLabel={complete ? 'Capture and verify' : 'Finish the steps above first'}
          onCaptured={submit}
          overlay={
            <View style={styles.overlay}>
              {/* Progress through the challenge, at the top where it does not
                  cover the face the user is trying to frame. */}
              <View style={styles.ticks}>
                {session.challenge.map((g, i) => (
                  <View
                    key={`${g}-${i}`}
                    style={[
                      styles.tick,
                      {
                        backgroundColor:
                          i < step ? p.onFieldLatent : i === step ? ON_LENS : 'rgba(238,239,231,0.28)',
                      },
                    ]}
                  />
                ))}
              </View>

              <Reticle ratio={3 / 4} round color={ON_LENS_DIM} />

              <View style={styles.prompt}>
                {complete ? (
                  <>
                    <Icon name="check" size={26} color={p.onFieldLatent} weight={2} />
                    <Text role="heading" tone="inherit" center style={{ color: ON_LENS }}>
                      Challenge complete
                    </Text>
                    <Text role="bodySm" tone="inherit" center style={{ color: ON_LENS_DIM }}>
                      Hold still and press the shutter.
                    </Text>
                  </>
                ) : meta ? (
                  <>
                    <Icon name={meta.icon} size={30} color={ON_LENS} weight={1.6} />
                    <Legend small tone="inherit" style={{ color: p.onFieldLatent }}>
                      {`Step ${step + 1} of ${total}`}
                    </Legend>
                    <Text role="heading" tone="inherit" center style={{ color: ON_LENS }}>
                      {meta.label}
                    </Text>
                    <Text role="bodySm" tone="inherit" center style={{ color: ON_LENS_DIM }}>
                      {meta.instruction}
                    </Text>
                    <View style={styles.did}>
                      <Button
                        label="Done — next"
                        variant="secondary"
                        onField
                        onPress={() => {
                          haptic.select();
                          setStep(step + 1);
                        }}
                      />
                    </View>
                  </>
                ) : null}
              </View>
            </View>
          }
        />
      )}
    </StepScreen>
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', gap: Space.md, paddingVertical: Space.h2 },
  overlay: { flex: 1, justifyContent: 'space-between', padding: Space.md },
  ticks: { flexDirection: 'row', gap: Space.xs, alignSelf: 'center' },
  tick: { width: 26, height: 3, borderRadius: 1.5 },
  prompt: {
    backgroundColor: 'rgba(6,18,14,0.78)',
    borderRadius: Radius.md,
    padding: Space.lg,
    gap: Space.sm,
    alignItems: 'center',
  },
  did: { alignSelf: 'stretch', marginTop: Space.xs },
});
