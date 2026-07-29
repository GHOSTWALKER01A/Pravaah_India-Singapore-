import { Stack, useLocalSearchParams } from 'expo-router';

import { QuoteScreen } from '@/features/insurance/screens';

/** Step 2 of buying — the price, and the decision. */
export default function QuoteRoute() {
  const { quoteId } = useLocalSearchParams<{ quoteId: string }>();

  return (
    <>
      <Stack.Screen options={{ title: 'Your price' }} />
      <QuoteScreen quoteId={quoteId} />
    </>
  );
}
