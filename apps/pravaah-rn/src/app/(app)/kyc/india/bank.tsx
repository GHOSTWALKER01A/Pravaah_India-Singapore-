import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { ApiError, kycService } from '@/api';
import { Button, TextField, haptic } from '@/components/ui';
import { Mechanism, StepScreen } from '@/features/kyc/components/step-screen';
import { checkStatusOf, nextRoute } from '@/features/kyc/flow';
import { useKycStatus } from '@/features/kyc/use-kyc-status';
import { Space } from '@/theme';

const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const VALIDITY_REGEX = /^(0[1-9]|1[0-2])\/\d{2}$/;

/** Digits → MM/YY as the user types ("1229" → "12/29"). */
function formatValidity(input: string): string {
  const digits = input.replace(/\D/g, '').slice(0, 4);
  return digits.length <= 2 ? digits : `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

export default function BankScreen() {
  const { status } = useKycStatus();
  const [account, setAccount] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [validity, setValidity] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The keyboard's action key now advances through the form instead of doing
  // nothing, which on a three-field screen is the difference between one pass
  // and three taps into the field list.
  const ifscRef = useRef<TextInput>(null);
  const validityRef = useRef<TextInput>(null);

  const accountOk = account.length >= 6;
  const ifscOk = IFSC_REGEX.test(ifsc);
  const validityOk = VALIDITY_REGEX.test(validity);
  const ready = accountOk && ifscOk && validityOk;

  async function verify() {
    if (!ready || loading) return;
    setError(null);
    setLoading(true);
    try {
      const updated = await kycService.bankPennyDrop({
        accountNumber: account,
        ifsc,
        cardValidity: validity,
      });
      if (checkStatusOf(updated, 'BANK_PENNY_DROP') === 'FAILED') {
        haptic.refused();
        setError(
          'Your bank did not accept these details. The account number and IFSC must belong to the same account, and the account must be active.',
        );
        return;
      }
      haptic.commit();
      router.replace(nextRoute(updated));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not verify this account.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <StepScreen
      check="BANK_PENNY_DROP"
      status={status}
      title="Your bank account"
      lede="A one-rupee deposit confirms the account is yours and that your bank knows you by the same name."
      error={error}
      assurance="Only a masked account number is stored. This is a name check — Pravaah gains no ability to move money, now or later."
      footer={
        <Button
          label="Verify account"
          onPress={() => void verify()}
          loading={loading}
          disabled={!ready}
        />
      }
    >
      <View style={styles.form}>
        <TextField
          label="Account number"
          value={account}
          onChangeText={(t) => setAccount(t.replace(/\D/g, ''))}
          measured
          keyboardType="number-pad"
          maxLength={18}
          placeholder="000000000000"
          valid={accountOk}
          returnKeyType="next"
          onSubmitEditing={() => ifscRef.current?.focus()}
        />

        <TextField
          ref={ifscRef}
          label="IFSC"
          value={ifsc}
          onChangeText={(t) => setIfsc(t.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          measured
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={11}
          placeholder="HDFC0001234"
          valid={ifscOk}
          hint={ifsc.length === 0 ? 'Printed on your cheque book and in your banking app.' : undefined}
          error={
            ifsc.length > 0 && !ifscOk
              ? 'An IFSC is four letters, a zero, then six characters — like HDFC0001234.'
              : null
          }
          returnKeyType="next"
          onSubmitEditing={() => validityRef.current?.focus()}
        />

        <TextField
          ref={validityRef}
          label="Debit card validity"
          value={validity}
          onChangeText={(t) => setValidity(formatValidity(t))}
          measured
          keyboardType="number-pad"
          maxLength={5}
          placeholder="MM/YY"
          valid={validityOk}
          hint={validity.length === 0 ? 'The expiry printed on the debit card for this account.' : undefined}
          error={validity.length > 0 && !validityOk ? 'Enter the expiry as MM/YY.' : null}
          returnKeyType="go"
          onSubmitEditing={() => void verify()}
        />
      </View>

      <Mechanism
        lines={[
          'Your bank is asked to accept a deposit of one rupee into this account.',
          'It replies with the name it holds for the account. The rupee stays with you.',
          'That name is matched against your PAN and Aadhaar. A near-miss goes to a person.',
        ]}
      />
    </StepScreen>
  );
}

const styles = StyleSheet.create({
  form: { gap: Space.md },
});
