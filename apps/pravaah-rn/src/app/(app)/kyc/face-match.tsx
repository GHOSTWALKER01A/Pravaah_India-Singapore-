import { router } from 'expo-router';
import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError, kycService } from '@/api';
import {
  Button,
  CameraCapture,
  Legend,
  Reticle,
  Text,
  haptic,
} from '@/components/ui';
import { Mechanism, StepScreen } from '@/features/kyc/components/step-screen';
import { checkStatusOf, nextRoute } from '@/features/kyc/flow';
import { useKycStatus } from '@/features/kyc/use-kyc-status';
import { Radius, Space, usePalette } from '@/theme';

type Phase = 'selfie' | 'id' | 'review';

const ON_LENS = 'rgba(238,239,231,0.96)';
const ON_LENS_DIM = 'rgba(238,239,231,0.72)';

export default function FaceMatchScreen() {
  const { status } = useKycStatus();
  const p = usePalette();
  const [phase, setPhase] = useState<Phase>('selfie');
  const [selfie, setSelfie] = useState<string | null>(null);
  const [document, setDocument] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!selfie || !document || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const updated = await kycService.faceMatch(selfie, document);
      if (checkStatusOf(updated, 'FACE_MATCH') === 'FAILED') {
        haptic.refused();
        setError(
          'The two photos did not match closely enough. Retake the selfie in even light, facing the camera straight on, and make sure the ID photo is sharp and glare-free.',
        );
        return;
      }
      haptic.commit();
      router.replace(nextRoute(updated));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'The photos could not be sent.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  function restart() {
    setSelfie(null);
    setDocument(null);
    setPhase('selfie');
  }

  return (
    <StepScreen
      check="FACE_MATCH"
      status={status}
      title="Match your face to your ID"
      lede={
        phase === 'selfie'
          ? 'First a live selfie.'
          : phase === 'id'
            ? 'Now the photo page of your ID document.'
            : 'Check both photos before sending them.'
      }
      error={error}
      assurance="A near-miss — twins, an old photo, hard lighting — goes to a human reviewer rather than being rejected automatically."
      footer={
        phase === 'review' ? (
          <View style={styles.footer}>
            <Button
              label="Send for matching"
              onPress={() => void submit()}
              loading={submitting}
            />
            <Button label="Retake both" variant="quiet" onPress={restart} />
          </View>
        ) : undefined
      }
    >
      {phase === 'selfie' ? (
        <CameraCapture
          facing="front"
          canCapture
          captureLabel="Capture selfie"
          onCaptured={(uri) => {
            setSelfie(uri);
            setPhase('id');
          }}
          overlay={
            <View style={styles.overlay}>
              <Reticle ratio={3 / 4} round color={ON_LENS_DIM} />
              <View style={styles.caption}>
                <Text role="bodySm" tone="inherit" center style={{ color: ON_LENS }}>
                  Centre your face in the oval and look straight ahead.
                </Text>
              </View>
            </View>
          }
        />
      ) : null}

      {phase === 'id' ? (
        <CameraCapture
          facing="back"
          canCapture
          captureLabel="Capture ID document"
          onCaptured={(uri) => {
            setDocument(uri);
            setPhase('review');
          }}
          overlay={
            <View style={styles.overlay}>
              <Reticle ratio={16 / 10} color={ON_LENS_DIM} />
              <View style={styles.caption}>
                <Text role="bodySm" tone="inherit" center style={{ color: ON_LENS }}>
                  Fit the photo page inside the marks. Avoid glare and shadow.
                </Text>
              </View>
            </View>
          }
        />
      ) : null}

      {phase === 'review' ? (
        <>
          <View style={styles.previews}>
            <Preview label="Selfie" uri={selfie} />
            <Preview label="ID document" uri={document} />
          </View>
          <Mechanism
            lines={[
              'Both images are compared by the matching provider and scored.',
              'A confident match clears this step immediately.',
              'Anything below that threshold is queued for a person, not refused.',
            ]}
          />
        </>
      ) : null}
    </StepScreen>
  );
}

function Preview({ label, uri }: { label: string; uri: string | null }) {
  const p = usePalette();
  return (
    <View style={styles.previewCol}>
      <Legend small tone="faint">
        {label}
      </Legend>
      <View style={[styles.previewFrame, { borderColor: p.rule, backgroundColor: p.lens }]}>
        {uri ? (
          <Image
            source={{ uri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            accessibilityLabel={`Captured ${label.toLowerCase()}`}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: { gap: Space.sm },
  overlay: { flex: 1, justifyContent: 'space-between' },
  caption: {
    backgroundColor: 'rgba(6,18,14,0.78)',
    borderRadius: Radius.md,
    padding: Space.md,
    margin: Space.md,
  },
  previews: { flexDirection: 'row', gap: Space.md },
  previewCol: { flex: 1, gap: Space.sm },
  previewFrame: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: Radius.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
});
