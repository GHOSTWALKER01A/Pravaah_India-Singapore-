import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Icon,
  Legend,
  Logo,
  Micro,
  Screen,
  Text,
  type IconName,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { APP_NAME } from '@/constants/ui.constants';
import { Hairline, Space, usePalette } from '@/theme';

/**
 * First run — what the credential is, in three facts.
 *
 * The incumbent was three identical icon-heading-text cards (🛡️ 🌏 🔒) in a
 * stack: the card scaffold the craft floor names first, with emoji doing the
 * iconography.
 *
 * These are not cards. They are the three claims of the credential, ruled apart
 * like clauses on the back of a note, each stating a mechanism rather than a
 * benefit — because for this audience the mechanism IS the reassurance, and a
 * benefit with no mechanism behind it is what every other app says too.
 */
const CLAUSES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'verify',
    title: 'Verified once, carried everywhere',
    body: 'Clear identity checks a single time, against the authority that issued each document. The result travels with you instead of starting over at each border.',
  },
  {
    icon: 'consent',
    title: 'Your data moves only when you say so',
    body: 'Financial history arrives over India’s regulated Account Aggregator rail — no bank password, no screen-scraping. The aggregator itself carries a sealed envelope it cannot read.',
  },
  {
    icon: 'revoke',
    title: 'You can take it back',
    body: 'Revoke a consent and the data fetched under it is deleted immediately. Anything you do not revoke is deleted anyway when its agreed life runs out.',
  },
];

export default function OnboardingScreen() {
  const p = usePalette();

  return (
    <Screen
      footer={
        <Button
          label="Get started"
          iconEnd="chevronRight"
          onPress={() => router.replace(ROUTES.TABS.HOME)}
        />
      }
    >
      <View style={styles.sheet}>
        <View style={styles.masthead}>
          {/* The seal, at the one moment it is the subject rather than the
              ground: the mark being shown before the credential is issued. It
              is the logo here, not a medallion, so it draws at the display cut
              rather than at whatever ornament happened to fit — and it is
              decorative to a screen reader because the line below already says
              the name. */}
          <View style={styles.seal}>
            <Logo size={132} decorative />
          </View>

          <Legend tone="latent">{`Welcome to ${APP_NAME}`}</Legend>
          <Text role="denomination">A reputation passport you own.</Text>
          <Text role="body" tone="dim" style={styles.lede}>
            Seven years of on-time payments should not die at an airport. Here is
            exactly how this works.
          </Text>
        </View>

        <View style={styles.clauses}>
          {CLAUSES.map((c, i) => (
            <View
              key={c.title}
              style={[
                styles.clause,
                i > 0 && { borderTopWidth: Hairline.base, borderTopColor: p.rule },
              ]}
            >
              <View style={styles.clauseHead}>
                <Icon name={c.icon} size={19} color={p.latent} weight={1.5} />
                <Text role="heading" style={styles.flex}>
                  {c.title}
                </Text>
              </View>
              <Text role="bodySm" tone="dim" style={styles.clauseBody}>
                {c.body}
              </Text>
            </View>
          ))}
        </View>

        <Micro>
          Verification takes about four minutes and saves as you go. Nothing
          financial is requested until your identity is confirmed, and nothing is
          shared until you approve it separately.
        </Micro>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxxl, paddingTop: Space.xxl },
  masthead: { gap: Space.md },
  seal: { alignSelf: 'flex-start', marginBottom: Space.sm },
  lede: { maxWidth: 440 },
  clauses: { gap: 0 },
  clause: { paddingVertical: Space.xl, gap: Space.sm },
  clauseHead: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  clauseBody: { maxWidth: 470, paddingLeft: 19 + Space.md },
  flex: { flex: 1 },
});
