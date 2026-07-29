import { StyleSheet, View } from 'react-native';

import {
  Button,
  Logo,
  Micro,
  Notice,
  Screen,
  Spinner,
  Text,
} from '@/components/ui';
import { Space } from '@/theme';

import type { UseUnlockResult } from '../use-unlock';

/**
 * The launch gate. What a returning user sees instead of an SMS code.
 *
 * ## Why this exists as a screen rather than a modal or a splash
 *
 * It replaces the phone-number screen for a returning user, so it has to occupy the same place in
 * the tree — it is the unauthenticated root, not something layered over an authenticated one.
 * Rendering it as an overlay would mean the app briefly mounts the signed-in tree behind it, which
 * fires every data hook on that tree with a session that has not been unlocked yet.
 *
 * ## Why there is no PIN field here
 *
 * A tempting shortcut: let the user type their PIN to unlock the app. It is refused, and the
 * reason is worth stating because it looks like a convenience.
 *
 * The persisted session is encrypted under a key the OS releases only after authenticating the
 * user. A PIN cannot open that — the key is not derived from anything the app knows. So a
 * PIN-unlock path would mean storing the session in a way the app CAN read unaided, which is
 * exactly the weaker design `session-vault.ts` exists to avoid. The PIN authorises payments,
 * where the server is the one checking it; the OS authorises the session, where the hardware is.
 *
 * ## Why "sign in with a code" is always available
 *
 * Because every biometric fails eventually — a bandaged thumb, a cracked sensor, a locked-out
 * scanner after a child's five attempts. A gate with no way past it is a gate that eventually
 * locks a real user out of their own money. The escape hatch is not a weakness in the design; it
 * is the same factor the account was created with, and it discards the stored session rather than
 * working around it.
 */
export function UnlockScreen({
  unlock,
  signInWithCode,
  phase,
  label,
  message,
  failure,
}: UseUnlockResult) {
  const working = phase === 'unlocking';

  return (
    <Screen>
      <View style={styles.body}>
        {/*
          The same 132dp display cut the onboarding screen uses, and `decorative` for the same
          reason: the heading below already says where the user is, so announcing the mark would
          make a screen reader read the app's name twice before reaching the actual instruction.
        */}
        <Logo size={132} decorative />

        <Text role="heading" style={styles.title}>
          Welcome back
        </Text>

        <Text role="bodySm" tone="dim" style={styles.subtitle}>
          {working
            ? 'Waiting for your confirmation…'
            : `Unlock with ${label.toLowerCase()} to continue.`}
        </Text>

        {/*
          `LOCKED_OUT` is not a message about the app, so it gets a Notice rather than the inline
          subtitle: the sensor is disabled by the OS and no amount of tapping here will help. The
          user has to unlock their phone, or take the code route.
        */}
        {message && failure !== 'DECLINED' ? (
          <View style={styles.notice}>
            <Notice tone="caution">{message}</Notice>
          </View>
        ) : null}

        {message && failure === 'DECLINED' ? (
          <Micro tone="faint" style={styles.hint}>
            {message}
          </Micro>
        ) : null}

        <View style={styles.actions}>
          {working ? (
            <Spinner />
          ) : (
            <>
              <Button
                label={`Unlock with ${label.toLowerCase()}`}
                onPress={() => void unlock()}
              />
              {/*
                Quiet, not secondary. The code route is a fallback, and giving it equal weight
                would invite a user to take the slower, weaker path by default — the same reason
                the PIN change screen words its reset as a situation rather than an option.
              */}
              <Button
                label="Sign in with a code instead"
                onPress={() => void signInWithCode()}
                variant="quiet"
              />
            </>
          )}
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, justifyContent: 'center', gap: Space.md },
  title: { marginTop: Space.xxl },
  subtitle: { marginBottom: Space.lg },
  notice: { marginTop: Space.md },
  hint: { marginTop: Space.sm },
  actions: { marginTop: Space.xxl, gap: Space.md },
});
