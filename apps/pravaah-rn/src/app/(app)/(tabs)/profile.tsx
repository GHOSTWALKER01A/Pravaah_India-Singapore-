import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import {
  Button,
  FieldGrid,
  FieldRow,
  Header,
  Icon,
  Micro,
  Press,
  Screen,
  SectionHead,
  StatusMark,
  Text,
} from '@/components/ui';
import { PravaahIdCard } from '@/components/common/pravaah-id-card';
import { ROUTES } from '@/constants/routes.constants';
import { APP_NAME } from '@/constants/ui.constants';
import { useAuth } from '@/context/auth-context';
import { Radius, Space, usePalette } from '@/theme';

/**
 * Bearer — who this credential belongs to, and the controls over it.
 *
 * The incumbent was three elements: a 48pt "Profile" title, the ID card, a card
 * containing one status row, and a "Log out" button. Everything the user might
 * actually want here — where their data lives, how to revoke it, what the app
 * even knows about them — was elsewhere or nowhere.
 *
 * Log out is now confirmed, because on an app with in-memory token storage it
 * ends the session irrecoverably and the user would have to re-do OTP.
 */
export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const p = usePalette();
  const [busy, setBusy] = useState(false);

  function confirmLogout() {
    Alert.alert(
      'Log out?',
      "You'll need to verify your phone number again to get back in. Nothing about your passport or your data changes.",
      [
        { text: 'Stay signed in', style: 'cancel' },
        {
          text: 'Log out',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            logout();
            router.replace(ROUTES.AUTH.SEND_OTP);
          },
        },
      ],
    );
  }

  return (
    <Screen tabBar>
      <View style={styles.sheet}>
        <Header title="Bearer" lede={`Who this ${APP_NAME} credential belongs to.`} />

        {user ? <PravaahIdCard pravaahId={user.pravaahId} /> : null}

        <View style={styles.block}>
          <SectionHead title="Identity" />
          <FieldGrid>
            <FieldRow label="Verification">
              <StatusMark status={user?.kycStatus ?? 'NOT_STARTED'} />
            </FieldRow>
          </FieldGrid>
        </View>

        <View style={styles.block}>
          <SectionHead
            title="Your data"
            detail="Everything Pravaah holds about you, and the switch that deletes it."
          />
          <View style={styles.rows}>
            <ControlRow
              icon="consent"
              title="Data sharing"
              detail="See every consent, and revoke any of them"
              onPress={() => router.push(ROUTES.CONSENT.DASHBOARD)}
            />
            <ControlRow
              icon="scales"
              title="Fairness self-report"
              detail="Optional, and never used to score you"
              onPress={() => router.push(ROUTES.SCORE.FAIRNESS)}
            />
            <ControlRow
              icon="history"
              title="Score history"
              detail="Every score, and the model version behind it"
              onPress={() => router.push(ROUTES.SCORE.HISTORY)}
            />
          </View>
        </View>

        <View style={[styles.foot, { borderTopColor: p.rule }]}>
          <Button
            label="Log out"
            variant="secondary"
            icon="logout"
            disabled={busy}
            onPress={confirmLogout}
            hint="Ends this session. You will need to verify your phone number again."
          />
          <Micro center>
            Revoking a consent deletes the financial data behind it immediately and
            permanently. Logging out does not — your passport is waiting when you
            come back.
          </Micro>
        </View>
      </View>
    </Screen>
  );
}

function ControlRow({
  icon,
  title,
  detail,
  onPress,
}: {
  icon: 'consent' | 'scales' | 'history';
  title: string;
  detail: string;
  onPress: () => void;
}) {
  const p = usePalette();
  return (
    <Press
      onPress={onPress}
      depth="subtle"
      radius={Radius.md}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}`}
      style={styles.rowOuter}
    >
      <View style={[styles.row, { borderColor: p.rule, backgroundColor: p.panel }]}>
        <Icon name={icon} size={20} color={p.latent} />
        <View style={styles.rowText}>
          <Text role="title">{title}</Text>
          <Micro tone="dim">{detail}</Micro>
        </View>
        <Icon name="chevronRight" size={16} color={p.inkFaint} weight={1.6} />
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl },
  block: { gap: Space.md },
  rows: { gap: Space.sm },
  rowOuter: { alignSelf: 'stretch' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.lg,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.lg,
  },
  rowText: { flex: 1, gap: 1 },
  foot: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.xl,
    gap: Space.md,
  },
});
