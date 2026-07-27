import { router } from 'expo-router';
import { useState } from 'react';

import { ApiError, kycService } from '@/api';
import { Button, TextField, haptic } from '@/components/ui';
import { Mechanism, StepScreen } from '@/features/kyc/components/step-screen';
import { checkStatusOf, nextRoute } from '@/features/kyc/flow';
import { useKycStatus } from '@/features/kyc/use-kyc-status';

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export default function PanScreen() {
  const { status } = useKycStatus();
  const [pan, setPan] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = PAN_REGEX.test(pan);
  /**
   * Only once ten characters are in.
   *
   * `pan.length > 0` meant the "not a complete PAN" error appeared on keystroke 1
   * and stayed through keystroke 9 of a 10-character entry — telling someone they
   * are wrong while they are still typing. Worse, `TextField` gives that message
   * `accessibilityLiveRegion="polite"` and `role="alert"`, so TalkBack announced
   * the format error on EVERY keystroke.
   */
  const complete = pan.length === 10;

  async function verify() {
    if (!valid || loading) return;
    setError(null);
    setLoading(true);
    try {
      const updated = await kycService.verifyPan({ pan });
      if (checkStatusOf(updated, 'PAN') === 'FAILED') {
        haptic.refused();
        setError(
          'The income-tax database did not recognise that PAN. Check each character against your card — it is easy to read 0 for O.',
        );
        return;
      }
      haptic.commit();
      router.replace(nextRoute(updated));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify your PAN.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <StepScreen
      check="PAN"
      status={status}
      title="Your PAN"
      lede="The ten-character number on your Permanent Account Number card."
      error={error}
      assurance="Your PAN is checked and then stored encrypted — never in plain text, and never shared beyond the check itself."
      footer={
        <Button
          label="Verify PAN"
          onPress={() => void verify()}
          loading={loading}
          disabled={!valid}
        />
      }
    >
      <TextField
        label="PAN"
        value={pan}
        onChangeText={(t) => {
          setPan(t.toUpperCase().replace(/[^A-Z0-9]/g, ''));
          if (error) setError(null);
        }}
        measured
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={10}
        placeholder="ABCDE1234F"
        valid={valid}
        // The format is a hint the whole way in, and only becomes an error once
        // there are ten characters and they still do not match.
        hint={!complete ? 'Five letters, four digits, one letter.' : undefined}
        error={complete && !valid ? "That doesn't match the PAN format — check it against your card. It runs ABCDE1234F." : null}
        returnKeyType="go"
        onSubmitEditing={() => void verify()}
      />

      <Mechanism
        lines={[
          'We send the number to the income-tax database and it returns the name on record.',
          'That name is matched against the rest of your verification.',
          'A near-miss goes to a person to review; it is never an automatic rejection.',
        ]}
      />
    </StepScreen>
  );
}
