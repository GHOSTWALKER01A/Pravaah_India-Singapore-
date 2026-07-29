import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import {
  Button,
  Checkbox,
  Header,
  Legend,
  Micro,
  Notice,
  Panel,
  Screen,
  Segmented,
  Spinner,
  Text,
  TextField,
  type Segment,
} from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';

import { ROUTES } from '@/constants/routes.constants';
import { PayeeLine } from '@/features/payments/components';
import { useAddPayee, useResolvePayee } from '@/features/payments/use-payees';

/** A shape check before we ask a server about somebody's banking details. */
const VPA_SHAPE = /^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9.-]{1,63}$/;
const IFSC_SHAPE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

type Kind = 'UPI_VPA' | 'ACCOUNT_IFSC' | 'PAYNOW_UPI';

const KINDS: readonly Segment<Kind>[] = [
  { value: 'UPI_VPA', label: 'UPI ID' },
  { value: 'ACCOUNT_IFSC', label: 'Bank account' },
  { value: 'PAYNOW_UPI', label: 'To India' },
];

/**
 * Add a payee.
 *
 * The screen's whole job is to get the BANK-HELD NAME in front of the user before they save
 * anything. So the resolve is live and the result is the largest thing on the screen — and the
 * "Add" button is gated on it having arrived, because a payee saved without a verified name is a
 * payee who cannot be paid and a user who will not know why until they try.
 *
 * The lookup is debounced and shape-gated. Every keystroke would otherwise be a query about a real
 * person's banking details — `ravi@ybl` is somebody's actual address on the way to typing
 * `ravi.kumar@ybl` — so nothing is sent until the string could plausibly be paid.
 */
export function AddPayeeScreen() {
  const router = useRouter();
  const p = usePalette();

  const [kind, setKind] = useState<Kind>('UPI_VPA');
  const [vpa, setVpa] = useState('');
  const [account, setAccount] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [nickname, setNickname] = useState('');
  const [isSelf, setIsSelf] = useState(false);
  const [confirmedName, setConfirmedName] = useState(false);

  const resolver = useResolvePayee();
  const { add, saving, error: saveError } = useAddPayee();

  const isUpi = kind === 'UPI_VPA' || kind === 'PAYNOW_UPI';
  const normalisedVpa = vpa.trim().toLowerCase();
  const vpaLooksPayable = VPA_SHAPE.test(normalisedVpa);

  const onVpaChange = (next: string) => {
    setVpa(next);
    setConfirmedName(false);
    const clean = next.trim().toLowerCase();
    if (VPA_SHAPE.test(clean)) resolver.resolve(clean);
    else resolver.clear();
  };

  const accountReady =
    /^[0-9]{9,18}$/.test(account.trim()) && IFSC_SHAPE.test(ifsc.trim().toUpperCase());

  // A UPI payee must be resolved AND confirmed. A bank account cannot be resolved before it is
  // saved — the penny-drop runs server-side on add — so it is gated on shape alone and the name
  // is confirmed on the payee's own screen afterwards.
  const canSave = isUpi
    ? vpaLooksPayable && resolver.resolved?.reachable === true && confirmedName
    : accountReady && nickname.trim().length > 0;

  const onSave = async () => {
    const created = await add(
      isUpi
        ? kind === 'PAYNOW_UPI'
          ? {
              handleType: 'PAYNOW_UPI',
              vpa: normalisedVpa,
              displayName: nickname.trim() || resolver.resolved?.registeredName || normalisedVpa,
              country: 'IN',
            }
          : {
              handleType: 'UPI_VPA',
              vpa: normalisedVpa,
              displayName: nickname.trim() || resolver.resolved?.registeredName || normalisedVpa,
              isSelf,
            }
        : {
            handleType: 'ACCOUNT_IFSC',
            accountNumber: account.trim(),
            ifsc: ifsc.trim().toUpperCase(),
            displayName: nickname.trim(),
            isSelf,
          },
    );
    if (!created) return;
    // `replace`, so the back gesture returns to the payee list rather than to a form for a payee
    // that now exists.
    router.replace(ROUTES.PAY.PAYEE_DETAIL(created.id));
  };

  return (
    <Screen
      scroll
      footer={
        <Button
          label={saving ? 'Adding…' : 'Add payee'}
          onPress={onSave}
          disabled={!canSave || saving}
          loading={saving}
          hint={
            isUpi && resolver.resolved?.reachable && !confirmedName
              ? 'Confirm the name their bank holds'
              : undefined
          }
        />
      }
    >
      <Stack.Screen options={{ title: 'Add a payee' }} />

      <Header
        title="Add a payee"
        lede="We ask their bank for the name on the account before you can pay them."
      />

      <Segmented
        segments={KINDS}
        value={kind}
        onChange={(next) => {
          setKind(next);
          resolver.clear();
          setConfirmedName(false);
        }}
        label="How you are paying them"
      />

      {kind === 'PAYNOW_UPI' ? (
        <Notice tone="caution" title="Sending from Singapore to India">
          The UPI–PayNow link is address-based: you need their registered UPI ID, not a bank
          account number. A daily cap of SGD 1,000 applies, and we screen the payee against
          compliance watchlists before the first payment.
        </Notice>
      ) : null}

      {isUpi ? (
        <TextField
          label="Their UPI ID"
          value={vpa}
          onChangeText={onVpaChange}
          placeholder="name@bank"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          measured
          error={
            vpa.length > 3 && !vpaLooksPayable
              ? 'A UPI ID looks like name@bank. Check what you were given.'
              : (resolver.error ?? null)
          }
          hint="Ask them to send it to you rather than typing it from memory."
        />
      ) : (
        <>
          <TextField
            label="Account number"
            value={account}
            onChangeText={setAccount}
            placeholder="9 to 18 digits"
            keyboardType="number-pad"
            measured
            error={
              account.length > 3 && !/^[0-9]{9,18}$/.test(account.trim())
                ? 'An Indian account number is 9 to 18 digits.'
                : null
            }
          />
          <TextField
            label="IFSC code"
            value={ifsc}
            onChangeText={(next) => setIfsc(next.toUpperCase())}
            placeholder="HDFC0001234"
            autoCapitalize="characters"
            autoCorrect={false}
            measured
            error={
              ifsc.length > 3 && !IFSC_SHAPE.test(ifsc.trim().toUpperCase())
                ? 'An IFSC is four letters, a zero, then six characters.'
                : null
            }
            hint="On their cheque book or bank app."
          />
        </>
      )}

      {/* ── THE NAME ────────────────────────────────────────────────────── */}
      {isUpi && vpaLooksPayable ? (
        <View style={[styles.nameBox, { borderColor: p.ruleStrong, backgroundColor: p.panel }]}>
          {resolver.resolving ? (
            <View style={styles.resolving}>
              <Spinner />
              <Micro>Asking their bank…</Micro>
            </View>
          ) : resolver.resolved ? (
            resolver.resolved.reachable ? (
              <PayeeLine
                registeredName={resolver.resolved.registeredName}
                handle={resolver.resolved.vpa}
                bankName={resolver.resolved.bankName}
              />
            ) : (
              <View style={styles.unreachable}>
                <Legend small>Not found</Legend>
                <Text role="bodySm" style={{ color: p.carmine }}>
                  {resolver.resolved.reason ??
                    'Their bank does not recognise that UPI ID.'}
                </Text>
                <Micro>
                  Check every character. A single wrong letter is a different person&apos;s
                  address, or nobody&apos;s.
                </Micro>
              </View>
            )
          ) : null}
        </View>
      ) : null}

      {isUpi && resolver.resolved?.reachable ? (
        <View style={[styles.confirm, { borderColor: p.ruleStrong }]}>
          <Checkbox
            checked={confirmedName}
            onChange={setConfirmedName}
            label={`Confirm this is ${resolver.resolved.registeredName ?? 'the right person'}`}
          >
            <Text role="bodySm">
              {resolver.resolved.registeredName ? (
                <Text role="bodySmMedium">{resolver.resolved.registeredName}</Text>
              ) : (
                'This person'
              )}{' '}
              is who I mean to pay.
            </Text>
          </Checkbox>
          <Micro>
            This is the name their bank holds, not a name they chose. If it is not who you
            expected, do not add them.
          </Micro>
        </View>
      ) : null}

      <TextField
        label={isUpi ? 'Save them as (optional)' : 'Save them as'}
        value={nickname}
        onChangeText={setNickname}
        placeholder={resolver.resolved?.registeredName ?? 'Landlord'}
        hint="Only you see this. The bank's name is what gets checked when you pay."
      />

      {kind === 'UPI_VPA' || kind === 'ACCOUNT_IFSC' ? (
        <Panel pad="md" notch>
          <Checkbox
            checked={isSelf}
            onChange={setIsSelf}
            label="This is my own account"
          >
            <Text role="bodySm">This is my own account.</Text>
          </Checkbox>
          <Micro>
            Own-account transfers skip the new-payee cap and let you add money and withdraw.
            We check this against the account you verified during sign-up — ticking it does not
            make it true.
          </Micro>
        </Panel>
      ) : null}

      {saveError ? (
        <Notice tone="error" title="Could not add that payee">
          {saveError}
        </Notice>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  nameBox: {
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    padding: Space.lg,
    minHeight: 96,
    justifyContent: 'center',
  },
  resolving: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  unreachable: { gap: Space.xs },
  confirm: {
    borderTopWidth: Hairline.base,
    borderBottomWidth: Hairline.base,
    paddingVertical: Space.lg,
    gap: Space.sm,
  },
});
