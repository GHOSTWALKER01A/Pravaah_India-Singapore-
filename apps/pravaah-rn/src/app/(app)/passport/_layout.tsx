import { Stack } from 'expo-router';
import { Platform } from 'react-native';

import { Type, platformFamily, usePalette } from '@/theme';

/**
 * The passport's child routes (card, history, a verifier request).
 *
 * Identical chrome to the consent, KYC and score stacks, deliberately: the user moves
 * between the credential, the data that powers it, and who has seen it, and differing
 * headers would make that feel like leaving the app.
 *
 * There is no `index` here — `(tabs)/index.tsx` IS the Passport tab. Groups contribute no
 * path segment, so an index in this folder would resolve to `/passport` while the tab
 * resolves to `/`, which would split one destination across two routes.
 */
export default function PassportLayout() {
  const p = usePalette();

  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerBackTitle: 'Back',
        headerShadowVisible: false,
        headerStyle: { backgroundColor: p.ground },
        headerTintColor: p.latent,
        headerTitleStyle: {
          fontFamily: platformFamily(Type.title.fontFamily),
          fontSize: Type.title.fontSize,
          color: p.ink,
        },
        headerTitleAlign: Platform.OS === 'ios' ? 'center' : 'left',
        contentStyle: { backgroundColor: p.ground },
      }}
    >
      {/*
        The consent-to-disclose screen is presented as a MODAL, and that is a statement about
        what it is rather than a transition preference.

        Somebody is standing in front of the holder waiting for an answer. A pushed screen
        joins the navigation stack — it has a back button, it can be navigated away from and
        rediscovered later, and it reads as a place you went. A request for consent is not a
        place; it is an interruption with two answers, and it should sit over whatever the
        holder was doing and leave when it is answered.

        It is a full sheet rather than a small alert on purpose. The one thing this screen
        cannot compress is WHAT IS BEING SHARED — a two-button alert that says "Approve?"
        without the claim list would be exactly the consent theatre selective disclosure
        exists to prevent.
      */}
      <Stack.Screen
        name="request/[requestId]"
        options={{
          presentation: 'modal',
          title: 'Verification request',
          // No back affordance: the two answers are Approve and Reject, both of which are
          // buttons on the sheet. A gesture dismiss still works and simply leaves the
          // request pending, which is the honest outcome of walking away from a question.
          headerBackVisible: false,
        }}
      />
    </Stack>
  );
}
