import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { ApiError, kycService } from '@/api';
import { Button, Notice, haptic } from '@/components/ui';
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
 */
export default function AadhaarScreen() {
  const { status } = useKycStatus();
  const [opening, setOpening] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [providerRefId, setProviderRefId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const away = providerRefId != null;

  async function open() {
    setError(null);
    setOpening(true);
    try {
      const { authorizationUrl, providerRefId: ref } =
        await kycService.initiateAadhaarOkyc();
      setProviderRefId(ref);
      await Linking.openURL(authorizationUrl);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not open DigiLocker. Check your connection and try again.',
      );
    } finally {
      setOpening(false);
    }
  }

  async function complete() {
    if (!providerRefId || completing) return;
    setError(null);
    setCompleting(true);
    try {
      const updated = await kycService.completeAadhaarOkyc(providerRefId);
      if (checkStatusOf(updated, 'AADHAAR_OKYC') === 'FAILED') {
        haptic.refused();
        setError(
          'DigiLocker has not confirmed your consent yet. If you closed it before finishing, reopen it and complete the consent screen.',
        );
        return;
      }
      haptic.commit();
      router.replace(nextRoute(updated));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not finish Aadhaar OKYC.');
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
                label="I've finished — check now"
                onPress={() => void complete()}
                loading={completing}
              />
              <Button
                label="Reopen DigiLocker"
                variant="quiet"
                iconEnd="external"
                onPress={() => void open()}
              />
            </>
          ) : (
            <Button
              label="Continue to DigiLocker"
              iconEnd="external"
              onPress={() => void open()}
              loading={opening}
            />
          )}
        </View>
      }
    >
      {/* Shown once the user has left, so the screen they return to explains
          itself rather than presenting a mystery second button. */}
      {away ? (
        <Notice tone="caution" title="Waiting on DigiLocker">
          Finish the consent screen in DigiLocker, then come back and tap
          &ldquo;I&apos;ve finished&rdquo;. If you closed it by accident, reopen it
          — your place here is saved either way.
        </Notice>
      ) : null}

      <Mechanism
        lines={[
          'DigiLocker opens and asks you to approve sharing your Aadhaar KYC data.',
          'It returns a signed document to Pravaah containing your name and a masked Aadhaar.',
          'You come back here and tap to finish — this screen does not know you are done until you do.',
        ]}
      />
    </StepScreen>
  );
}

const styles = StyleSheet.create({ footer: { gap: Space.sm } });
