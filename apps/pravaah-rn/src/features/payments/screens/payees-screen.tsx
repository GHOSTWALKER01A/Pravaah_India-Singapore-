import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import {
  Button,
  Header,
  Icon,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Press,
  Rule,
  Screen,
  SectionHead,
  StatusMark,
  Text,
  TextField,
} from '@/components/ui';
import { Hairline, Space, usePalette } from '@/theme';

import { ROUTES } from '@/constants/routes.constants';
import { usePayees } from '@/features/payments/use-payees';

import type { BeneficiaryView } from '@/api/payments/schemas';

/**
 * The payee book.
 *
 * Grouped by CORRIDOR rather than alphabetically, because that is the distinction that changes
 * what a payment costs and what it is capped at. Somebody sending money home to India from
 * Singapore and paying their landlord in Bengaluru is doing two different things with two different
 * rulebooks, and a single flat list hides that.
 */
export function PayeesScreen() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const { payees, loading, error, refresh } = usePayees();

  const term = search.trim().toLowerCase();
  const matched = term
    ? payees.filter((payee) =>
        [payee.displayName, payee.registeredName ?? '', payee.handle]
          .join(' ')
          .toLowerCase()
          .includes(term),
      )
    : payees;

  const groups = {
    crossBorder: matched.filter((payee) => payee.handleType === 'PAYNOW_UPI'),
    own: matched.filter((payee) => payee.isSelf && payee.handleType !== 'PAYNOW_UPI'),
    domestic: matched.filter(
      (payee) => !payee.isSelf && payee.handleType !== 'PAYNOW_UPI',
    ),
  };

  return (
    <Screen scroll onRefresh={refresh} refreshing={false}>
      <Stack.Screen options={{ title: 'Payees' }} />

      <Header
        title="Payees"
        lede="Everyone you can pay, and the name their bank holds for them."
      />

      <Button
        label="Add a payee"
        icon="plus"
        variant="secondary"
        onPress={() => router.push(ROUTES.PAY.PAYEE_ADD)}
      />

      {payees.length > 4 ? (
        <TextField
          label="Find a payee"
          value={search}
          onChangeText={setSearch}
          placeholder="Name or UPI ID"
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : null}

      {error ? (
        <Notice tone="error" title="Could not load your payees" action="Try again" onAction={refresh}>
          {error}
        </Notice>
      ) : null}

      {loading ? (
        <ListSkeleton rows={5} label="Loading your payees" />
      ) : payees.length === 0 ? (
        <EmptyBook />
      ) : (
        <>
          <PayeeGroup
            title="In India"
            detail="Instant over UPI, no fee, ₹1,00,000 a day."
            payees={groups.domestic}
            onOpen={(id) => router.push(ROUTES.PAY.PAYEE_DETAIL(id))}
          />
          <PayeeGroup
            title="Singapore to India"
            detail="Over the UPI–PayNow link. SGD 1,000 a day, and a fee applies."
            payees={groups.crossBorder}
            onOpen={(id) => router.push(ROUTES.PAY.PAYEE_DETAIL(id))}
          />
          <PayeeGroup
            title="Your own accounts"
            detail="For adding money and withdrawing. No new-payee cap."
            payees={groups.own}
            onOpen={(id) => router.push(ROUTES.PAY.PAYEE_DETAIL(id))}
          />
        </>
      )}
    </Screen>
  );
}

function PayeeGroup({
  title,
  detail,
  payees,
  onOpen,
}: {
  title: string;
  detail: string;
  payees: BeneficiaryView[];
  onOpen: (id: string) => void;
}) {
  const p = usePalette();
  // An empty group is omitted rather than shown empty: a domestic-only user does not need a
  // cross-border heading telling them they have nobody there.
  if (payees.length === 0) return null;

  return (
    <View style={styles.group}>
      <SectionHead title={title} detail={detail} />
      <Panel pad="none" notch>
        {payees.map((payee, index) => (
          <View key={payee.id}>
            {index > 0 ? <Rule /> : null}
            <Press
              onPress={() => onOpen(payee.id)}
              accessibilityRole="button"
              accessibilityLabel={`${payee.registeredName ?? payee.displayName}, ${payee.handle}`}
            >
              <View style={styles.row}>
                <View style={styles.rowText}>
                  <Text role="bodyMedium" numberOfLines={1}>
                    {payee.registeredName ?? payee.displayName}
                  </Text>
                  <Micro numberOfLines={1}>{payee.handle}</Micro>
                  {payee.coolingPeriod ? (
                    <Micro style={{ color: p.latent }}>
                      New payee — capped for the first 24 hours
                    </Micro>
                  ) : null}
                </View>
                {payee.status === 'VERIFIED' ? (
                  <Icon name="chevronRight" size={14} color={p.inkFaint} />
                ) : (
                  <StatusMark status={payee.status} labelled size={11} />
                )}
              </View>
            </Press>
          </View>
        ))}
      </Panel>
    </View>
  );
}

function EmptyBook() {
  const p = usePalette();
  return (
    <View style={[styles.empty, { borderColor: p.rule }]}>
      <Text role="bodySm" tone="dim" center>
        Your payee book is empty.
      </Text>
      <Micro center>
        Add someone by their UPI ID or bank account. Before you can pay them we ask their
        bank for the name on the account, and show it to you — that check is what stops
        money going to the wrong person.
      </Micro>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: Space.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: 48,
  },
  rowText: { flexGrow: 1, flexShrink: 1, gap: 2 },
  empty: {
    borderWidth: Hairline.base,
    borderStyle: 'dashed',
    borderRadius: 5,
    paddingVertical: Space.xxl,
    paddingHorizontal: Space.lg,
    gap: Space.xs,
  },
});
