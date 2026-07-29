/**
 * THESIS: A payment is an INSTRUCTION that may be honoured, dishonoured or returned — not a
 * balance that went down. So this surface is the cheque book the passport's holder spends from,
 * and it refuses the arrangement every UPI app ships: a hero balance, a row of three round
 * buttons, and an avatar feed of "transactions".
 *
 * OWN-WORLD: The inherited banknote world, in its other artifact. Intaglio leaf with a PERFORATED
 * top edge because the leaves above are spent; counterfoil stubs with a torn left edge as the
 * default list row; figures-and-words on every amount; a return memo in carmine when an
 * instruction is dishonoured, a gold hold notice when the rail simply has not answered.
 *
 * STORY: The holder sees what today's rail will still allow, picks the instrument that matches what
 * they already know about the payee, reads the amount twice in two notations, and keeps a stub they
 * can quote to a bank. The book closes on their own code, for being paid.
 *
 * FIRST VIEWPORT: Full-bleed intaglio leaf, perforation across its top, the balance CONCEALED as a
 * latent image until pressed and held, the day's remaining limit and per-payment cap as data-field
 * rows on the same plate, corridor stamp top-right, address and reset time as microtext along the
 * base. The instrument set on rag below it. Then the counterfoils, the drawers, and the receive plate.
 *
 * FORM: Structure 7 of 7 on my ordered list (cheque book and counterfoils), assigned by
 * concept-seed key b72d7db7 --scope surface --mode operate. Kept over my own #1 (balance-first
 * wallet) because it models the saga truthfully; the airport-wayfinding challenger's
 * one-decision-per-junction discipline was taken into the send flow.
 *
 * WHAT CHANGED IN THIS PASS, and why each was a defect rather than a preference:
 *
 *  - **The balance is concealed by default.** It is the one figure here a stranger on a train can
 *    read and act on. Press-and-hold resolves it, which is the world's own committed device.
 *  - **The action set is typed by DESTINATION, not by verb.** `Write a payment / Scan / Request /
 *    Add money` was three verbs and an orphaned third button that wrapped to its own row. What a
 *    holder actually has is a phone number, an account, or a person in front of them — which is the
 *    arrangement every Indian and Singaporean app converged on. `Request` in particular named the
 *    mechanism, not the intent, and is now `Ask someone to pay`.
 *  - **The UPI address provisions itself.** "no upi id yet" was busywork: M0 already verified the
 *    holder's legal name and the allocator already seeds from it.
 *  - **The receive code closes the book.** One tap from home, because "show me your QR" is the
 *    commonest in-person request in this market.
 */
import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import {
  Header,
  Icon,
  Legend,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Press,
  Rule,
  Screen,
  SectionHead,
  Text,
} from '@/components/ui';
import { Hairline, Space, usePalette } from '@/theme';

import { ROUTES } from '@/constants/routes.constants';
import {
  ChequeLeaf,
  Counterfoil,
  InstrumentRow,
  ReceiveCard,
  type Instrument,
} from '@/features/payments/components';
import { CORRIDOR_META } from '@/features/payments/meta';
import { useReceiveCode } from '@/features/payments/use-receive-code';
import { useWallet } from '@/features/payments/use-wallet';
import { ProfileAvatar } from '@/components/ui/profile-avatar';

export function PayScreen() {
  const router = useRouter();
  const p = usePalette();
  const { wallet, recent, loading, refreshing, error, refresh } = useWallet();

  // The balance can change while the user is on another tab — they may have been paid, or a
  // pending transfer may have settled. Refetching on focus is what stops the leaf showing a
  // figure the user has already seen contradicted elsewhere in the app.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const inr = wallet?.balances.find((b) => b.currency === 'INR') ?? null;
  const sgd = wallet?.balances.find((b) => b.currency === 'SGD') ?? null;

  // Provisioning waits for the wallet, so a cold start makes one round trip rather than three in
  // parallel against an API that may be rate-limited on a metered connection.
  const receive = useReceiveCode(wallet !== null);

  const primaryHandle =
    receive.handle ??
    wallet?.upiHandles.find((h) => h.isPrimary && h.status === 'ACTIVE') ??
    wallet?.upiHandles.find((h) => h.status === 'ACTIVE') ??
    null;

  // A holder with money on both sides of the corridor is the product's whole premise, so the
  // stamp says which rails are actually live for THIS person rather than always claiming both.
  const hasSgd = sgd !== null && sgd.minor !== '0';
  const stamp = hasSgd
    ? CORRIDOR_META.CROSS_BORDER.stamp
    : CORRIDOR_META.DOMESTIC.stamp;

  /**
   * The instrument set, ordered by how often it is reached for.
   *
   * Scan leads and is the one tile drawn on the intaglio field, because it is both the most-used
   * action in this market and the only one with no typing at all. It is deliberately ALSO here
   * despite living in the tab bar's centre: the bar is muscle memory for a returning user, and this
   * tile is how a first-time user discovers that the bar's centre button is the same thing.
   */
  const instruments: Instrument[] = [
    {
      key: 'scan',
      icon: 'scan',
      label: 'Scan a code',
      detail: 'They are in front of you',
      lead: true,
      onPress: () => router.push(ROUTES.PAY.SCAN),
    },
    {
      key: 'phone',
      icon: 'phone',
      label: 'To a phone number',
      detail: 'The commonest way to pay a person',
      onPress: () => router.push(ROUTES.PAY.TO_PHONE),
    },
    {
      key: 'account',
      icon: 'bank',
      label: 'To a bank account',
      detail: 'Account number and IFSC, or a UPI ID',
      onPress: () => router.push(ROUTES.PAY.PAYEE_ADD),
    },
    {
      key: 'payee',
      icon: 'pay',
      label: 'To a saved payee',
      detail: 'Someone you have paid before',
      onPress: () => router.push(ROUTES.PAY.SEND),
    },
    {
      key: 'ask',
      icon: 'receipt',
      // Was "Request" — which named our mechanism rather than the holder's intent. Nobody thinks
      // "I shall raise a collect"; they think "ask Priya for ₹500".
      label: 'Ask someone to pay',
      detail: 'They approve it in their own bank app',
      onPress: () => router.push(ROUTES.PAY.REQUEST),
    },
    {
      key: 'topup',
      icon: 'plus',
      label: 'Add money',
      detail: 'From a bank account you own',
      onPress: () => router.push(ROUTES.PAY.TOPUP),
    },
  ];

  return (
    <Screen scroll tabBar showProfile onRefresh={refresh} refreshing={refreshing}>
      <Header
        legend="Pravaah · payments"
        title="Cheque book"
        lede="What is left in the book, and every instruction you have written."
      />

      {loading && !wallet ? (
        <ListSkeleton rows={4} label="Loading your cheque book" />
      ) : (
        <>
          {error ? (
            <Notice
              tone="error"
              title="Could not load your wallet"
              action="Try again"
              onAction={refresh}
            >
              {error}
            </Notice>
          ) : null}

          {/* THE LEAF — the first viewport's object. */}
          <ChequeLeaf
            balance={inr}
            limits={wallet?.limits.domestic ?? null}
            stamp={stamp}
            vpa={primaryHandle?.vpa ?? null}
          />

          {/*
            A second leaf only when there is genuinely a second currency in hand. Rendering an
            empty SGD plate for every domestic user would make the cross-border corridor look
            like a feature they are failing to use.
          */}
          {hasSgd ? (
            <Panel pad="md" notch>
              <View style={styles.sgdRow}>
                <View style={styles.sgdText}>
                  <Legend small>Singapore dollars</Legend>
                  <Text role="value">{sgd.formatted}</Text>
                  <Micro>{CORRIDOR_META.CROSS_BORDER.detail}</Micro>
                </View>
                <View style={styles.sgdCap}>
                  <Legend small>Left today</Legend>
                  <Text role="valueSm" numberOfLines={1}>
                    {wallet?.limits.crossBorder.dailyRemaining.formatted ?? '—'}
                  </Text>
                </View>
              </View>
            </Panel>
          ) : null}

          {/* THE INSTRUMENTS. On rag, below the plate: the field is the object, and a control on
              it would make the object a container. */}
          <InstrumentRow items={instruments} />

          {/*
            The only remaining reason to interrupt the holder about their address: the backend
            refuses to issue one to an unverified identity, because a UPI address receives money
            from strangers. That is a real gate with a real next step, unlike the notice this
            replaced, which asked them to do work the KYC record had already done.
          */}
          {/*
            Two blocks, because the `!primaryHandle` guard that used to gate this HID a real failure.

            A holder whose address was allocated but whose CODE failed to mint had `blockedReason`
            set and `primaryHandle` truthy — so this notice was suppressed, and the only symptom was
            a receive card reading "No code yet" with no reason and no way to retry. Staying silent
            about a failure the app has already captured is the worst of the three possible states.
          */}
          {receive.blockedReason ? (
            primaryHandle ? (
              <Notice
                tone="caution"
                title="Your code could not be created"
                action="Try again"
                onAction={receive.retry}
              >
                {receive.blockedReason} Your UPI ID {primaryHandle.vpa} is fine — only
                the QR image failed, and people can still pay you at that address.
              </Notice>
            ) : (
              <Notice
                tone="caution"
                title="Finish verifying to be paid"
                action="Open verification"
                onAction={() => router.push(ROUTES.KYC.STATUS)}
              >
                {receive.blockedReason} You can still send money without an address of
                your own.
              </Notice>
            )
          ) : null}

          {/* THE BOOK — the counterfoils. */}
          <View style={styles.book}>
            <SectionHead
              title="Counterfoils"
              detail={
                recent.length > 0
                  ? 'The stub of every instruction you have written.'
                  : undefined
              }
              aside={
                recent.length > 0 ? (
                  <Press
                    onPress={() => router.push(ROUTES.PAY.STATEMENT)}
                    accessibilityRole="link"
                    accessibilityLabel="Open the full statement"
                  >
                    <View style={styles.linkRow}>
                      <Micro>Statement</Micro>
                      <Icon name="chevronRight" size={12} color={p.inkFaint} />
                    </View>
                  </Press>
                ) : undefined
              }
            />

            {recent.length === 0 ? (
              // An empty book, said as a fact about the book rather than as an apology. No
              // illustration, no emoji — the world has neither.
              <View style={[styles.empty, { borderColor: p.rule }]}>
                <Text role="bodySm" tone="dim" center>
                  No instructions written yet.
                </Text>
                <Micro center>
                  Every payment you make leaves a stub here, with the reference your
                  bank recognises.
                </Micro>
              </View>
            ) : (
              <View>
                {recent.map((txn, index) => (
                  <Counterfoil
                    key={txn.id}
                    transaction={txn}
                    last={index === recent.length - 1}
                    onPress={() => router.push(ROUTES.PAY.RECEIPT(txn.id))}
                  />
                ))}
              </View>
            )}
          </View>

          {/* The book's other drawers. A data-field grid, not four more cards. */}
          <Panel pad="none" notch>
            <Drawer
              label="Payees"
              detail="Who you can pay, and the name their bank holds"
              onPress={() => router.push(ROUTES.PAY.PAYEES)}
            />
            <Rule />
            <Drawer
              label="Requests"
              detail="Money you have asked for, and been asked for"
              onPress={() => router.push(ROUTES.PAY.REQUESTS)}
            />
            <Rule />
            <Drawer
              label="AutoPay"
              detail="Standing instructions that debit without you present"
              onPress={() => router.push(ROUTES.PAY.AUTOPAY)}
            />
            <Rule />
            <Drawer
              label="Disputes"
              detail="Payments you have raised a problem with"
              onPress={() => router.push(ROUTES.PAY.DISPUTES)}
            />
            <Rule />
            <Drawer
              label="Withdraw to bank"
              detail="Move money out of your Pravaah wallet"
              onPress={() => router.push(ROUTES.PAY.WITHDRAW)}
            />
          </Panel>

          {/*
            Microtext at the foot of the book, as a security document carries its terms. Real
            text at the microtext size — the assurance, stated rather than marketed.
          */}
          <Micro style={styles.terms}>
            Pravaah never sees your UPI PIN. Every payment is authorised inside your
            bank&apos;s own secure screen. Amounts are held in a double-entry ledger, so a
            payment that fails is returned to you and one the network confirms late is never
            paid twice.
          </Micro>

          {/* The book closes on the holder's own code. `My QR code` left the drawer list because
              it is now the plate itself rather than a row pointing at one. */}
          <ReceiveCard
            payload={receive.code?.payload ?? null}
            vpa={primaryHandle?.vpa ?? null}
            // The payer-visible name is read out of the payload by the card itself. The previous
            // call passed `linkedBankName` as `registeredName`, which labelled every holder with
            // their bank's name as though it were their own.
            bankName={primaryHandle?.linkedBankName ?? null}
            accountTail={primaryHandle?.linkedAccountMasked ?? null}

            loading={receive.provisioning}
            onOpen={() => router.push(ROUTES.PAY.MY_QR)}
          />
        </>
      )}
    </Screen>
  );
}

/**
 * One drawer of the book.
 *
 * A row in a shared panel rather than its own card, because these are five items of one list and
 * five same-size cards is the page scaffold the world refuses. The chevron is the only ornament.
 */
function Drawer({
  label,
  detail,
  onPress,
}: {
  label: string;
  detail: string;
  onPress: () => void;
}) {
  const p = usePalette();
  return (
    <Press
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={detail}
    >
      <View style={styles.drawer}>
        <View style={styles.drawerText}>
          <Text role="bodyMedium">{label}</Text>
          <Micro>{detail}</Micro>
        </View>
        <Icon name="chevronRight" size={14} color={p.inkFaint} />
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  sgdRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.lg },
  sgdText: { flexGrow: 1, flexShrink: 1, gap: 2 },
  sgdCap: { flexShrink: 0, alignItems: 'flex-end', gap: 2 },
  book: { gap: Space.md },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  empty: {
    borderWidth: Hairline.base,
    borderStyle: 'dashed',
    borderRadius: 5,
    paddingVertical: Space.xxl,
    paddingHorizontal: Space.lg,
    gap: Space.xs,
  },
  drawer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    // 48dp minimum touch target, with the vertical padding carrying it rather than a fixed
    // height — so the row grows with the OS font setting instead of clipping.
    paddingVertical: Space.md,
    minHeight: 48,
  },
  drawerText: { flexGrow: 1, flexShrink: 1, gap: 1 },
  terms: { marginTop: Space.sm },
});
