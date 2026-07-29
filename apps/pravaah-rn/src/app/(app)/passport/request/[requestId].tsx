import { useLocalSearchParams } from 'expo-router';

import { Header, Notice, Screen } from '@/components/ui';
import { DiscloseScreen } from '@/features/passport/disclose-screen';

/**
 * The consent-to-disclose route.
 *
 * Also the deep-link target a card tap resolves to (`parvaahrn://passport/request/<id>`),
 * which is why the id is validated here rather than assumed: a malformed link must produce
 * a readable message, not a screen that spins forever against a request that cannot exist.
 */
export default function VerifierRequestRoute() {
  const { requestId } = useLocalSearchParams<{ requestId?: string }>();

  if (!requestId) {
    return (
      <Screen>
        <Header title="Verification request" />
        <Notice tone="error" title="This link is incomplete">
          Ask the verifier to show their code again.
        </Notice>
      </Screen>
    );
  }

  return <DiscloseScreen requestId={requestId} />;
}
