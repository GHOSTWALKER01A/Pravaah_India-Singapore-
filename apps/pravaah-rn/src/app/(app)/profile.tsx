import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, StyleSheet, View, Image } from 'react-native';

import {
  Button,
  Header,
  Icon,
  Micro,
  Press,
  Screen,
  SectionHead,
  StatusMark,
  Text,
  type IconName,
} from '@/components/ui';
import { PravaahIdCard } from '@/components/common/pravaah-id-card';
import { ROUTES } from '@/constants/routes.constants';
import { APP_NAME } from '@/constants/ui.constants';
import { useAuth } from '@/context/auth-context';
import { awaitingApproval } from '@/features/kyc/flow';
import { useKycStatus } from '@/features/kyc/use-kyc-status';
import { Radius, Space, usePalette } from '@/theme';

export default function ProfileScreen() {
  const { user, logout } = useAuth();
  /**
   * The LIVE status, not `user.kycStatus`.
   *
   * The auth context's copy is written once — at sign-in or session restore —
   * and nothing ever updates it (`setKycStatus` has no callers). So this screen
   * showed whatever was true the last time the user signed in: it said IN
   * PROGRESS next to a passport that said VERIFIED, from the same account, on
   * the same phone. `GET /kyc/status` is the canonical shape every other surface
   * renders from, and this row is now one of them.
   */
  const { status } = useKycStatus({ pollMs: 10_000 });
  const kycStatus = status?.overallStatus ?? user?.kycStatus ?? 'NOT_STARTED';
  const p = usePalette();
  const [busy, setBusy] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);

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

  // A mock image picker to fulfill the UI request
  function handleImagePick() {
    Alert.alert('Image Selection', 'This would open the native image picker.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Pick Image', onPress: () => setImageUri('https://picsum.photos/200') }
    ]);
  }

  return (
    <Screen>
      <View style={styles.sheet}>
        <View style={styles.topNav}>
          <Press onPress={() => router.back()} depth="none" style={styles.backButton}>
            {/*
              `Icon` deliberately takes no `style` prop — the set is stroked geometry tinted by
              `color`, and letting callers pass arbitrary styles is how a glyph ends up scaled or
              skewed away from the 24-unit grid. A rotation belongs on a wrapper.
            */}
            <View style={styles.backChevron}>
              <Icon name="chevronRight" size={24} color={p.ink} />
            </View>
            <Text role="body" style={styles.backText}>Back</Text>
          </Press>
        </View>
        <Header title="Bearer" lede={`Who this ${APP_NAME} credential belongs to.`} />

        <View style={styles.imageSection}>
          <Press
            onPress={handleImagePick}
            depth="none"
            radius={60}
            style={[styles.imageCircle, { backgroundColor: p.panel, borderColor: p.rule }]}
          >
            {imageUri ? (
              <Image source={{ uri: imageUri }} style={styles.image} />
            ) : (
              <Icon name="camera" size={32} color={p.inkDim} />
            )}
            <View style={[styles.editBadge, { backgroundColor: p.field }]}>
              <Icon name="plus" size={14} color={p.onField} />
            </View>
          </Press>
          <Text role="bodyMedium" tone="default">Profile Picture</Text>
        </View>

        {user ? <PravaahIdCard pravaahId={user.pravaahId} /> : null}

        <View style={styles.block}>
          <SectionHead title="Identity" />
          <View style={styles.rows}>
            <ControlRow
              icon="verify"
              title="Verification"
              detail={
                kycStatus === 'VERIFIED'
                  ? 'Your identity is verified'
                  : status && awaitingApproval(status)
                    ? 'Every check cleared — a reviewer is signing it off'
                    : kycStatus === 'REJECTED'
                      ? 'Declined — open it to see which check did not clear'
                      : 'Open the checks and see what is left'
              }
              onPress={() => router.push(ROUTES.KYC.STATUS)}
              value={<StatusMark status={kycStatus} />}
            />
            <ControlRow
              icon="reputation"
              title="Reputation score"
              detail="The number, the factors behind it, and its confidence band"
              onPress={() => router.push(ROUTES.SCORE.ROOT)}
            />
          </View>
        </View>

        {/*
          Security sits between Identity and Your data, deliberately.

          It belongs after identity because a device is a thing that acts AS you, and before
          data because it is the more urgent of the two: a user who came to this screen
          worried about their account is looking for "which devices can act as me", and making
          them scroll past consent settings to find it is the wrong ordering for the one case
          that is time-sensitive.
        */}
        <View style={styles.block}>
          <SectionHead
            title="Security"
            detail="Devices that can act as you, and every check we ran."
          />
          <View style={styles.rows}>
            <ControlRow
              icon="lock"
              title="Your devices"
              detail="Remove any device you do not recognise"
              onPress={() => router.push(ROUTES.SECURITY.DEVICES)}
            />
            <ControlRow
              icon="shield"
              title="Security activity"
              detail="Every decision we made, and why"
              onPress={() => router.push(ROUTES.SECURITY.ACTIVITY)}
            />
          </View>
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
  value,
}: {
  icon: IconName;
  title: string;
  detail: string;
  onPress: () => void;
  value?: ReactNode;
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
        {value}
        <Icon name="chevronRight" size={16} color={p.inkFaint} weight={1.6} />
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl },
  topNav: {
    flexDirection: 'row',
    marginTop: Space.md,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
  // A back chevron is the forward one turned around; the icon set ships one chevron by design.
  backChevron: { transform: [{ rotate: '180deg' }] },
  backText: {
    fontSize: 16,
    fontWeight: '500',
  },
  imageSection: {
    alignItems: 'center',
    gap: Space.md,
    marginTop: Space.md,
  },
  imageCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  image: {
    width: 120,
    height: 120,
    borderRadius: 60,
  },
  editBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#ffffff',
  },
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
