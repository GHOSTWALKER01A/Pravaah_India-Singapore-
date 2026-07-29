import { StyleSheet, View } from 'react-native';

import { Icon, Legend, Micro, Rule, Text } from '@/components/ui';
import { Space, usePalette } from '@/theme';

/**
 * "Pay to the order of ______" — the most load-bearing line on a cheque.
 *
 * On paper this is the line a bank clerk verifies against the account. Here it carries the name
 * the payee's BANK holds, which NPCI requires be shown to the payer before they authorise, and
 * which the server then requires back as `confirmedRegisteredName`. It is the single most
 * effective control against social-engineering fraud: the attacker chooses the UPI ID, but not
 * what the bank calls the account behind it. A victim told to pay "ravi.landlord@ybl" reads
 * PRIYA SHARMA and stops.
 *
 * So the composition is deliberate about which name is bigger. The **registered name is the
 * hero** and the address is microtext beneath it — the opposite of every payments app, which
 * leads with the handle the payer typed. The handle is what they were TOLD; the name is what is
 * TRUE, and the true thing gets the type.
 *
 * `printedName` exists for the QR case, where the code carries a `pn` parameter chosen by
 * whoever printed it. It is rendered as a claim, visibly subordinate to the bank's answer, and
 * only when the two disagree — because a matching pair is not information, and showing it always
 * would train the eye to skip the row.
 */
interface PayeeLineProps {
  /** The name the payee's bank holds. The thing being confirmed. */
  registeredName: string | null;
  /** The masked address. Microtext — it is not the control. */
  handle: string;
  bankName?: string | null;
  /** From a scanned QR's `pn` parameter. Shown only when it contradicts the bank. */
  printedName?: string | null;
  onField?: boolean;
  /** Why this payee cannot be paid, when they cannot. */
  unreachableReason?: string | null;
}

export function PayeeLine({
  registeredName,
  handle,
  bankName,
  printedName,
  onField = false,
  unreachableReason,
}: PayeeLineProps) {
  const p = usePalette();
  const surface = onField ? 'field' : 'sheet';

  const nameDisagrees =
    Boolean(printedName) &&
    Boolean(registeredName) &&
    normalise(printedName!) !== normalise(registeredName!);

  return (
    <View style={styles.wrap}>
      <Legend small surface={surface}>
        Pay to
      </Legend>

      {registeredName ? (
        <Text role="title" surface={surface}>
          {registeredName}
        </Text>
      ) : (
        // An unverified payee gets a stated absence, not a blank line. "We could not check this
        // name" is actionable; an empty row reads as a rendering failure and invites the user to
        // proceed anyway.
        <Text role="title" tone="carmine" surface={surface}>
          Name not verified
        </Text>
      )}

      <Rule onField={onField} />

      <View style={styles.metaRow}>
        <Micro surface={surface}>{handle}</Micro>
        {bankName ? (
          <Micro surface={surface} style={styles.bank}>
            {bankName}
          </Micro>
        ) : null}
      </View>

      {nameDisagrees ? (
        <View style={styles.warn}>
          <Icon name="alert" size={13} color={onField ? p.onFieldCarmine : p.carmine} />
          <Micro
            surface={surface}
            style={{ color: onField ? p.onFieldCarmine : p.carmine, flex: 1 }}
          >
            The code says “{printedName}”. Their bank says{' '}
            {registeredName}. Trust the bank.
          </Micro>
        </View>
      ) : null}

      {unreachableReason ? (
        <View style={styles.warn}>
          <Icon name="alert" size={13} color={onField ? p.onFieldCarmine : p.carmine} />
          <Micro
            surface={surface}
            style={{ color: onField ? p.onFieldCarmine : p.carmine, flex: 1 }}
          >
            {unreachableReason}
          </Micro>
        </View>
      ) : null}
    </View>
  );
}

/** Compare names the way a bank does — case, spacing and punctuation are not the signal. */
function normalise(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const styles = StyleSheet.create({
  wrap: { gap: Space.xs },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  bank: { flexShrink: 0 },
  warn: { flexDirection: 'row', gap: Space.sm, marginTop: Space.xs },
});
