import { router } from 'expo-router';
import { useState } from 'react';

import { ApiError, kycService } from '@/api';
import { Button, haptic } from '@/components/ui';
import { Mechanism, StepScreen } from '@/features/kyc/components/step-screen';
import { nextRoute } from '@/features/kyc/flow';
import { useKycStatus } from '@/features/kyc/use-kyc-status';

export default function SanctionsScreen() {
  const { status } = useKycStatus();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const updated = await kycService.screenSanctions();
      // A hit sets the profile to REJECTED. Either way this is the last step, so
      // the flow routes to the result screen and it explains what happened there.
      haptic.commit();
      router.replace(nextRoute(updated));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'The screening could not be run. Nothing about your other checks has changed.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <StepScreen
      check="SANCTIONS_PEP"
      status={status}
      title="The last check"
      lede="Your verified name is screened against global sanctions and politically-exposed-person lists."
      error={error}
      onRetry={() => void run()}
      assurance="Required by regulation, and it is what lets a partner institution trust the passport at all. Nothing new is asked of you here."
      footer={
        <Button label="Run the screening" onPress={() => void run()} loading={loading} />
      }
    >
      <Mechanism
        lines={[
          'The name confirmed by your earlier checks is matched against published watchlists.',
          'No new document is needed — this uses what has already been verified.',
          'A match is reviewed by a person before anything is decided about your passport.',
        ]}
      />
    </StepScreen>
  );
}
