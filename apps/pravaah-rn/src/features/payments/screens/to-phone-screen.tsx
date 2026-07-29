/**
 * Pay to a phone number.
 *
 * THESIS: the number is the address people actually know. Nobody has a friend's VPA memorised;
 * everybody has their number. That is why "to mobile" is the first tile in every Indian UPI app, and
 * why PayNow made the number a first-class proxy rather than an alias.
 *
 * The screen's whole job is to be honest about a lookup that can fail in three different ways, which
 * most implementations collapse into one grey "not found":
 *
 *  1. **The number is not a mobile number.** Said before any network call, naming the rule it broke.
 *  2. **The number is fine but nothing is registered against it.** A NORMAL outcome, not an error —
 *     India has no directory, so a miss means "not at `<number>@<the handles we probed>`", and the
 *     person may be perfectly payable at a UPI ID they chose themselves. The recovery is to ask them
 *     for it, and that is what the screen offers.
 *  3. **The network would not answer.** Same empty result, opposite advice: try again.
 *
 * A user told "that number is wrong" about their own mother's number will believe they mistyped it,
 * so case 2 never borrows case 1's words.
 *
 * FORM: the counterfoil's own grammar — a well for the number, the corridor chosen as a struck stamp
 * rather than a dropdown, and the resolved payee arriving as a `PayeeLine`, which is the same
 * component that carries the NPCI name confirmation everywhere else in the app. The name check is not
 * re-implemented here; it is the shared control, so it cannot drift out of step with the send flow.
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import {
  Button,
  Header,
  Legend,
  Micro,
  Notice,
  Press,
  Screen,
  Spinner,
  Text,
  TextField,
  haptic,
} from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';

import { beneficiaryService } from '@/api/payments/services';
import type { ResolvedMobile } from '@/api/payments/schemas';
import { ROUTES } from '@/constants/routes.constants';
import { PayeeLine } from '@/features/payments/components';

/**
 * The two corridors, as the note's own multi-language panel reduced to what the app can honestly
 * carry: a two-letter stamp and the rail's real name.
 *
 * `hint` states each country's actual rule, because "invalid number" is useless and "10 digits
 * starting 6–9" is actionable. The digit counts differ (10 vs 8) which is exactly why the country is
 * chosen rather than inferred.
 */
const CORRIDORS = [
  {
    country: 'IN' as const,
    stamp: 'IN',
    dial: '+91',
    rail: 'UPI',
    digits: 10,
    hint: '10 digits, starting 6, 7, 8 or 9',
  },
  {
    country: 'SG' as const,
    stamp: 'SG',
    dial: '+65',
    rail: 'PayNow',
    digits: 8,
    hint: '8 digits, starting 8 or 9',
  },
];

export function ToPhoneScreen() {
  const router = useRouter();
  const p = usePalette();

  const [country, setCountry] = useState<'IN' | 'SG'>('IN');
  const [phone, setPhone] = useState('');
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<ResolvedMobile | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const corridor = CORRIDORS.find((c) => c.country === country)!;
  const digits = phone.replace(/\D+/g, '');

  /**
   * Local validation mirrors the server's rule so the user is told BEFORE a round trip.
   *
   * Deliberately only a length-and-prefix check, not a re-implementation of the parser: the server's
   * `phone.util.ts` remains the authority, and this exists purely to keep the button honest.
   */
  const wellFormed =
    country === 'IN'
      ? /^[6-9]\d{9}$/.test(digits)
      : /^[89]\d{7}$/.test(digits);

  const reset = () => {
    setFound(null);
    setError(null);
  };

  const onLookup = async () => {
    setLooking(true);
    setError(null);
    setFound(null);
    try {
      const result = await beneficiaryService.resolveMobile({
        phone: digits,
        country,
      });
      setFound(result);
      if (result.matches.length > 0) haptic.commit();
      else haptic.refused();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'That number could not be looked up.',
      );
    } finally {
      setLooking(false);
    }
  };

  const match = found?.matches[0];

  /**
   * Turn the resolved address into a payee, then go straight to the amount.
   *
   * The payee has to exist as a row before an amount can be priced against it — the send flow is
   * keyed on a beneficiary id, not on a raw address, because that row is what carries the
   * new-payee cooling period and the screening result. So this saves first.
   *
   * `add` is idempotent by design: re-adding an address the user already has re-verifies it rather
   * than erroring, so a user who looks up the same number twice gets one payee and a fresh name
   * check, not a duplicate and a 409.
   *
   * The name is NOT re-confirmed here even though it was just displayed. The confirmation that
   * matters happens on the cheque itself, against the name the server returns at that moment — a
   * confirmation collected here would be a confirmation of a name that could have changed by the
   * time the payment is authorised.
   */
  const onContinue = async () => {
    if (!match?.registeredName) return;
    setSaving(true);
    setError(null);
    try {
      const payee =
        match.handleType === 'PAYNOW_UPI'
          ? await beneficiaryService.add({
              handleType: 'PAYNOW_UPI',
              vpa: match.handle,
              displayName: match.registeredName,
              country: 'SG',
            })
          : await beneficiaryService.add({
              handleType: 'UPI_VPA',
              vpa: match.handle,
              displayName: match.registeredName,
            });
      router.push(ROUTES.PAY.SEND_AMOUNT(payee.id));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'That payee could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'To a phone number' }} />

      <Header
        legend="Pravaah · payments"
        title="To a phone number"
        lede="We look up the name their bank holds before you send anything."
      />

      {/* The corridor, as two struck stamps. A dropdown would hide the choice that decides which
          rail and which rulebook applies — and the caps differ by roughly 60×. */}
      <View style={styles.block}>
        <Legend small>Which country</Legend>
        <View style={styles.stamps}>
          {CORRIDORS.map((c) => {
            const active = c.country === country;
            return (
              <Press
                key={c.country}
                onPress={() => {
                  if (active) return;
                  haptic.select();
                  setCountry(c.country);
                  // The number is cleared on purpose. An 8-digit SG number left in the field after
                  // switching to India is not a "nearly right" Indian number; it is a different
                  // person's number, and pre-filling it invites paying them.
                  setPhone('');
                  reset();
                }}
                depth="subtle"
                radius={Radius.sm}
                style={[
                  styles.stamp,
                  {
                    borderColor: active ? p.field : p.rule,
                    backgroundColor: active ? p.field : 'transparent',
                  },
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${c.rail}, ${c.dial}`}
              >
                <Text
                  role="legendSm"
                  surface={active ? 'field' : 'sheet'}
                  tone={active ? undefined : 'dim'}
                >
                  {c.stamp} · {c.rail}
                </Text>
              </Press>
            );
          })}
        </View>
      </View>

      {/*
        The number, in the app's own field primitive rather than a hand-rolled well.

        `TextField` already carries the focus ring, the label, the hint/error swap and the measured
        face — re-implementing those here would have produced a second input that drifts from every
        other field in the app. The dialling code lives in the label because it is a FACT about the
        chosen corridor, not something the user types.
      */}
      <TextField
        label={`Their mobile number (${corridor.dial})`}
        value={phone}
        onChangeText={(next) => {
          // Digits only, capped at the country's length. Typing an eleventh digit into an Indian
          // field is always a mistake, and silently accepting it produces a lookup that cannot
          // succeed and an error that appears to blame the user.
          setPhone(next.replace(/\D+/g, '').slice(0, corridor.digits));
          reset();
        }}
        hint={corridor.hint}
        // Only complain once there is enough typed to be wrong. Showing the rule as an ERROR on the
        // first keystroke tells somebody they are failing while they are still halfway through.
        error={
          digits.length >= corridor.digits && !wellFormed
            ? `That is not a ${corridor.stamp} mobile number — ${corridor.hint}.`
            : null
        }
        valid={wellFormed}
        measured
        keyboardType="phone-pad"
        autoComplete="tel"
        textContentType="telephoneNumber"
        inputMode="numeric"
        returnKeyType="search"
        maxLength={corridor.digits}
        onSubmitEditing={() => {
          if (wellFormed && !looking) void onLookup();
        }}
      />

      <Button
        label={looking ? 'Looking up…' : 'Look up this number'}
        icon="phone"
        disabled={!wellFormed || looking}
        loading={looking}
        onPress={onLookup}
      />

      {error ? (
        <Notice tone="error" title="Could not look that up" action="Try again" onAction={onLookup}>
          {error}
        </Notice>
      ) : null}

      {looking ? (
        <View style={styles.waiting}>
          <Spinner />
          <Micro center>
            {country === 'IN'
              ? 'Checking this number against the UPI network. This can take a few seconds.'
              : 'Checking this number against the PayNow directory.'}
          </Micro>
        </View>
      ) : null}

      {/* Found. The same `PayeeLine` the send flow uses, so the name check cannot drift. */}
      {match?.registeredName ? (
        <View style={styles.block}>
          <Legend small>Who this is</Legend>
          <PayeeLine
            registeredName={match.registeredName}
            handle={match.handle}
            bankName={match.bankName}
          />
          <Micro>
            Found at {found?.phone} · {match.handleType === 'PAYNOW_UPI' ? 'PayNow' : 'UPI'}
          </Micro>
          <Button
            label={`Continue to pay ${match.registeredName}`}
            icon="pay"
            loading={saving}
            disabled={saving}
            onPress={onContinue}
          />
        </View>
      ) : null}

      {/*
        Not found. Two different messages for the same empty list, because the recovery differs.
      */}
      {found && found.matches.length === 0 ? (
        found.railUnavailable ? (
          <Notice
            tone="caution"
            title="The network did not answer"
            action="Try again"
            onAction={onLookup}
          >
            We could not reach the payment network to check {found.phone}. Nothing has been
            sent. This is usually brief.
          </Notice>
        ) : (
          <Notice
            tone="caution"
            title={`No UPI ID is registered against ${found.phone}`}
            action="Type their UPI ID"
            onAction={() => router.push(ROUTES.PAY.PAYEE_ADD)}
          >
            That number looks correct — it simply is not registered as a payment address. Many
            people use a UPI ID they chose themselves instead. Ask them for it, or ask them to
            send you their QR code.
          </Notice>
        )
      ) : null}

      <Micro style={styles.terms}>
        We never send money from this screen. A number is only turned into a name here; the amount,
        the payee confirmation and your bank&apos;s own authorisation all come afterwards.
      </Micro>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { gap: Space.sm },
  stamps: { flexDirection: 'row', gap: Space.sm },
  stamp: {
    borderWidth: Hairline.base,
    borderRadius: Radius.sm,
    paddingHorizontal: Space.md,
    // Vertical padding rather than a fixed height, so the stamp grows with the OS font setting
    // instead of clipping its label.
    paddingVertical: Space.sm,
    minHeight: 48,
    justifyContent: 'center',
  },
  waiting: { gap: Space.sm, alignItems: 'center', paddingVertical: Space.md },
  terms: { marginTop: Space.sm },
});
