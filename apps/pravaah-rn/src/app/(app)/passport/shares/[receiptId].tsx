import { useLocalSearchParams } from 'expo-router';

import { Header, Notice, Screen } from '@/components/ui';
import { ReceiptScreen } from '@/features/shares/screens';

/**
 * One consent receipt. The id is validated here rather than assumed, so a malformed link
 * produces a readable message instead of a request for a receipt that cannot exist.
 */
export default function ShareReceiptRoute() {
  const { receiptId } = useLocalSearchParams<{ receiptId?: string }>();

  if (!receiptId) {
    return (
      <Screen>
        <Header title="Consent receipt" />
        <Notice tone="error" title="This link is incomplete">
          Open the receipt from “Shared with organisations”.
        </Notice>
      </Screen>
    );
  }

  return <ReceiptScreen receiptId={receiptId} />;
}
