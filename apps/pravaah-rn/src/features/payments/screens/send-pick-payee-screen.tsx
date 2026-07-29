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
 * Step 1 of writing a payment: WHO.
 *
 * One junction, one decision — the discipline taken from the airport-signage challenger. The
 * screen asks a single question and shows only the choices ahead of it; there is no amount field
 * here, because pricing a transfer requires knowing the payee's corridor and asking for both at
 * once means re-pricing every time the payee changes.
 *
 * Payees are ordered by LAST USED rather than alphabetically. A person paying rent pays the same
 * landlord every month, and the list's job is to put that row under their thumb — an alphabetical
 * book is a filing system, not a payment surface.
 */
export function SendPickPayeeScreen() {
  const router = useRouter();
  const p = usePalette();
  const [search, setSearch] = useState('');
  const { payees, loading, error, refresh } = usePayees();

  const term = search.trim().toLowerCase();
  const filtered = term
    ? payees.filter((payee) =>
        [payee.displayName, payee.registeredName ?? '', payee.handle]
          .join(' ')
          .toLowerCase()
          .includes(term),
      )
    : payees;

  // Payable and unpayable are split rather than mixed with a disabled style. A blocked or
  // unverified payee in the same list, greyed out, reads as a rendering glitch — and a user will
  // tap it anyway. Below a rule, under their own heading, they are information instead.
  const payable = filtered.filter((payee) => payee.status === 'VERIFIED');
  const blocked = filtered.filter((payee) => payee.status !== 'VERIFIED');

  return (
    <Screen scroll onRefresh={refresh} refreshing={false}>
      <Stack.Screen options={{ title: 'Who are you paying?' }} />

      <Header
        legend="Step 1 of 3"
        title="Pay to"
        lede="Pick a payee, or add one. We will show you the name their bank holds before you pay."
      />

      {payees.length > 3 ? (
        <TextField
          label="Find a payee"
          value={search}
          onChangeText={setSearch}
          placeholder="Name or UPI ID"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
      ) : null}

      <Button
        label="Add a new payee"
        icon="plus"
        variant="secondary"
        onPress={() => router.push(ROUTES.PAY.PAYEE_ADD)}
      />

      {error ? (
        <Notice tone="error" title="Could not load your payees" action="Try again" onAction={refresh}>
          {error}
        </Notice>
      ) : null}

      {loading ? (
        <ListSkeleton rows={4} label="Loading your payees" />
      ) : payees.length === 0 ? (
        <View style={[styles.empty, { borderColor: p.rule }]}>
          <Text role="bodySm" tone="dim" center>
            No payees yet.
          </Text>
          <Micro center>
            Add someone by their UPI ID or bank account. We check the name their bank
            holds before any money can move.
          </Micro>
        </View>
      ) : (
        <>
          {payable.length > 0 ? (
            <Panel pad="none" notch>
              {payable.map((payee, index) => (
                <View key={payee.id}>
                  {index > 0 ? <Rule /> : null}
                  <PayeeRow
                    payee={payee}
                    onPress={() => router.push(ROUTES.PAY.SEND_AMOUNT(payee.id))}
                  />
                </View>
              ))}
            </Panel>
          ) : null}

          {blocked.length > 0 ? (
            <View style={styles.blockedBlock}>
              <SectionHead
                title="Cannot be paid yet"
                detail="These need verifying, or you blocked them."
              />
              <Panel pad="none" notch>
                {blocked.map((payee, index) => (
                  <View key={payee.id}>
                    {index > 0 ? <Rule /> : null}
                    <PayeeRow
                      payee={payee}
                      onPress={() => router.push(ROUTES.PAY.PAYEE_DETAIL(payee.id))}
                    />
                  </View>
                ))}
              </Panel>
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}

/**
 * One payee row.
 *
 * The BANK-HELD name is the primary line and the address is microtext beneath it — the opposite
 * of the convention, and deliberate. The handle is what somebody told the user to pay; the
 * registered name is what is true. Leading with the true thing is the whole point of resolving
 * it, and it is what lets a user notice at a glance that `ravi.landlord@ybl` belongs to somebody
 * called PRIYA SHARMA.
 */
function PayeeRow({
  payee,
  onPress,
}: {
  payee: BeneficiaryView;
  onPress: () => void;
}) {
  const p = usePalette();
  const inCooling = payee.coolingPeriod !== null;

  return (
    <Press
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[
        payee.registeredName ?? payee.displayName,
        payee.handle,
        payee.status === 'VERIFIED' ? 'verified' : payee.status.toLowerCase(),
      ].join(', ')}
    >
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text role="bodyMedium" numberOfLines={1}>
            {payee.registeredName ?? payee.displayName}
          </Text>
          <Micro numberOfLines={1}>
            {payee.handle}
            {payee.registeredName && payee.displayName !== payee.registeredName
              ? ` · saved as ${payee.displayName}`
              : ''}
          </Micro>

          {/*
            The cooling period, said before the user picks rather than after they enter an
            amount. ₹5,000 for the first 24 hours is the highest-yield anti-fraud control in UPI
            and the one users are most surprised by; surfacing it here turns a rejection into a
            known constraint.
          */}
          {inCooling ? (
            <Micro style={{ color: p.latent }} numberOfLines={2}>
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
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: 48,
  },
  rowText: { flexGrow: 1, flexShrink: 1, gap: 2 },
  blockedBlock: { gap: Space.md },
  empty: {
    borderWidth: Hairline.base,
    borderStyle: 'dashed',
    borderRadius: 5,
    paddingVertical: Space.xxl,
    paddingHorizontal: Space.lg,
    gap: Space.xs,
  },
});
