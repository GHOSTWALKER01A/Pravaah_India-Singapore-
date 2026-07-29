import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import * as Clipboard from 'expo-clipboard';

import {
  Button,
  Field,
  FieldGrid,
  FieldRow,
  Header,
  Legend,
  Micro,
  Notice,
  Panel,
  Rule,
  Screen,
  SectionHead,
  Segmented,
  Spinner,
  Text,
  haptic,
  type Segment,
} from '@/components/ui';
import { Gutter, Hairline, Radius, Space, usePalette } from '@/theme';

import {
  paymentQrService,
  paymentsService,
} from '@/api/payments/services';
import type {
  PaymentQrView,
  UpiHandleView,
} from '@/api/payments/schemas';
import { QrMatrix } from '@/features/payments/components';
import { formatCountdown } from '@/features/payments/meta';

type Tab = 'mine' | 'codes';

const TABS: readonly Segment<Tab>[] = [
  { value: 'mine', label: 'My UPI ID' },
  { value: 'codes', label: 'One-time codes' },
];

/**
 * Being paid: the user's own UPI ID, drawn as a QR, and the one-time codes they have minted.
 *
 * The static code is the shopfront sticker — amount-less, reusable, and it carries no signature
 * because it is not a payment instruction: the payer types the amount, so there is nothing on it
 * to tamper with. The one-time code IS an instruction, so it is signed, short-lived and spent on
 * first payment, and the screen says all three of those things rather than presenting the two as
 * interchangeable.
 */
export function MyQrScreen() {
  const p = usePalette();
  const [tab, setTab] = useState<Tab>('mine');
  const [copied, setCopied] = useState(false);

  /** Copy, with a state that reverts on its own — a stuck "Copied" would still be claiming it later. */
  const copyVpa = async (vpa: string) => {
    await Clipboard.setStringAsync(vpa);
    haptic.select();
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  const [handles, setHandles] = useState<UpiHandleView[]>([]);
  const [codes, setCodes] = useState<PaymentQrView[]>([]);
  const [staticQr, setStaticQr] = useState<PaymentQrView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [handleList, codeList] = await Promise.all([
        paymentsService.listHandles(),
        paymentQrService.list().catch(() => [] as PaymentQrView[]),
      ]);
      setHandles(handleList);
      setCodes(codeList.filter((code) => code.kind === 'DYNAMIC'));
      // The reusable code is found rather than re-minted: a user who already has a shopfront
      // sticker printed must keep getting the same one.
      setStaticQr(
        codeList.find((code) => code.kind === 'STATIC' && code.isActive) ?? null,
      );
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load your codes.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const primary =
    handles.find((h) => h.isPrimary && h.status === 'ACTIVE') ??
    handles.find((h) => h.status === 'ACTIVE') ??
    null;

  const createHandle = async () => {
    setBusy(true);
    setError(null);
    try {
      await paymentsService.createHandle();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create a UPI ID.');
    } finally {
      setBusy(false);
    }
  };

  const createStatic = async () => {
    setBusy(true);
    setError(null);
    try {
      await paymentQrService.create({
        kind: 'STATIC',
        currency: 'INR',
        purposeCode: 'P2P_TRANSFER',
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create that code.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Being paid' }} />
        <View style={styles.centre}>
          <Spinner label="Loading your codes" />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll onRefresh={load} refreshing={false}>
      <Stack.Screen options={{ title: 'Being paid' }} />

      <Header
        title="Being paid"
        lede="Your UPI ID is the address people send money to. It never changes and is never given to anyone else."
      />

      {error ? (
        <Notice tone="error" title="Something went wrong" action="Try again" onAction={load}>
          {error}
        </Notice>
      ) : null}

      {!primary ? (
        <>
          <Notice tone="caution" title="You do not have a UPI ID yet">
            You need one to be paid. You can already send money without it.
          </Notice>
          <Button
            label={busy ? 'Creating…' : 'Create my UPI ID'}
            loading={busy}
            onPress={createHandle}
          />
        </>
      ) : (
        <>
          <Segmented segments={TABS} value={tab} onChange={setTab} label="What to show" />

          {tab === 'mine' ? (
            <>
              {/*
                The code on the intaglio field, full bleed — it is the one thing on this screen a
                stranger will point a camera at, so it gets the plate.
              */}
              <View style={styles.lift}>
                <Field radius={0} style={styles.plate}>
                  <View style={styles.plateBody}>
                    {staticQr ? (
                      <QrMatrix payload={staticQr.payload} size={216} onField />
                    ) : (
                      <View style={styles.noCode}>
                        <Micro surface="field">No reusable code yet</Micro>
                      </View>
                    )}

                    <View style={styles.vpaBlock}>
                      <Legend small surface="field">
                        Your UPI ID
                      </Legend>
                      {/*
                        `serial` here, `field` on the compact receive card — and the difference is
                        deliberate rather than drift. On this screen the address IS the object, at
                        the size somebody reads aloud across a counter. On the card it is a caption
                        under a code, where 18sp at 1.6 tracking sprawled across two lines and
                        competed with the QR it was labelling.

                        Selectable AND a copy button. Long-press is the app's convention for a
                        quotable identifier (the Pravaah ID works the same way), but the note that
                        used to sit here — that an explicit control would mean "adding a clipboard
                        dependency to a deliberately pinned install" — is no longer true:
                        `expo-clipboard` is now a dependency, installed via `expo install` so it is
                        SDK-matched. A person at a till will look for a button.
                      */}
                      <View style={styles.vpaRow}>
                        <Text
                          role="serial"
                          surface="field"
                          selectable
                          maxFontSizeMultiplier={1.4}
                        >
                          {primary.vpa}
                        </Text>
                      </View>
                      <View style={styles.vpaActions}>
                        <Button
                          label={copied ? 'Copied' : 'Copy UPI ID'}
                          icon={copied ? 'check' : 'copy'}
                          variant="secondary"
                          onField
                          inline
                          onPress={() => void copyVpa(primary.vpa)}
                        />
                      </View>
                    </View>
                  </View>
                </Field>
              </View>

              {!staticQr ? (
                <Button
                  label={busy ? 'Creating…' : 'Create a reusable QR code'}
                  loading={busy}
                  onPress={createStatic}
                  hint="Amount-less and reusable — the payer types the amount."
                />
              ) : null}

              <Panel pad="none" notch>
                <FieldGrid>
                  <FieldRow label="Status" value={primary.status === 'ACTIVE' ? 'Active' : primary.status} />
                  {primary.linkedBankName ? (
                    <FieldRow label="Linked bank" value={primary.linkedBankName} />
                  ) : null}
                  {primary.linkedAccountMasked ? (
                    <FieldRow label="Account" value={primary.linkedAccountMasked} />
                  ) : null}
                </FieldGrid>
              </Panel>

              <Micro>
                A UPI ID is never reused. If you ever turn this one off it is retired for good,
                so money somebody sends to an old address of yours can never reach a stranger.
              </Micro>
            </>
          ) : (
            <>
              <SectionHead
                title="One-time codes"
                detail="A code that carries an amount. Signed, short-lived, and paid only once."
              />

              {codes.length === 0 ? (
                <View style={[styles.empty, { borderColor: p.rule }]}>
                  <Text role="bodySm" tone="dim" center>
                    No one-time codes.
                  </Text>
                  <Micro center>
                    Use one when you are charging a specific amount — a bill, an invoice. It
                    cannot be paid twice and it expires.
                  </Micro>
                </View>
              ) : (
                <Panel pad="none" notch>
                  {codes.map((code, index) => (
                    <View key={code.id}>
                      {index > 0 ? <Rule /> : null}
                      <View style={styles.codeRow}>
                        <View style={styles.codeText}>
                          <Text role="bodyMedium">
                            {code.amount?.formatted ?? 'No amount'}
                          </Text>
                          <Micro>
                            {code.consumedAt
                              ? 'Paid'
                              : code.expiresAt && Date.parse(code.expiresAt) < Date.now()
                                ? 'Expired'
                                : code.expiresAt
                                  ? `Expires in ${formatCountdown(Date.parse(code.expiresAt) - Date.now())}`
                                  : 'Active'}
                            {code.scanCount > 0 ? ` · scanned ${code.scanCount}×` : ''}
                          </Micro>
                        </View>
                        {!code.consumedAt && code.isActive ? (
                          <QrMatrix payload={code.payload} size={64} />
                        ) : null}
                      </View>
                    </View>
                  ))}
                </Panel>
              )}
            </>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  lift: {
    marginHorizontal: -Gutter,
    shadowColor: '#082018',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 6,
  },
  plate: { borderRadius: 0 },
  plateBody: { padding: Gutter, alignItems: 'center', gap: Space.lg },
  noCode: {
    width: 216,
    height: 216,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: Hairline.base,
    borderStyle: 'dashed',
    borderRadius: Radius.md,
    borderColor: '#38695A',
  },
  vpaBlock: { alignItems: 'center', gap: Space.xs },
  vpaActions: { flexDirection: 'row', gap: Space.sm, marginTop: Space.xs },
  vpaRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, minHeight: 44 },
  codeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: 48,
  },
  codeText: { flexGrow: 1, flexShrink: 1, gap: 2 },
  empty: {
    borderWidth: Hairline.base,
    borderStyle: 'dashed',
    borderRadius: 5,
    paddingVertical: Space.xxl,
    paddingHorizontal: Space.lg,
    gap: Space.xs,
  },
});
