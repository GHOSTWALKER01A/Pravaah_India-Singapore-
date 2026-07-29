import { useLocalSearchParams } from 'expo-router';

import { Header, Notice, Screen } from '@/components/ui';
import { PeerCheckScreen } from '@/features/passport/peer-check-screen';

/**
 * The SCANNER's side of a peer check.
 *
 * Sibling of `passport/request/[requestId]`, which is the HOLDER's side of the same
 * handshake. Two routes rather than one because they are opposite roles: this one waits and
 * receives, that one decides and discloses, and a single screen would have to guess which of
 * the two people is holding the phone.
 */
export default function PeerCheckRoute() {
  const { requestId } = useLocalSearchParams<{ requestId?: string }>();

  if (!requestId) {
    return (
      <Screen>
        <Header title="Verification" />
        <Notice tone="error" title="This check is incomplete">
          Scan their code again.
        </Notice>
      </Screen>
    );
  }

  return <PeerCheckScreen requestId={requestId} />;
}
