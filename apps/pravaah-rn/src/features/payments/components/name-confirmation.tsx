import { StyleSheet, View } from 'react-native';

import { Checkbox, Micro, Text } from '@/components/ui';
import { Radius, Space, usePalette } from '@/theme';

/**
 * The NPCI name confirmation — the single most effective fraud control in the product.
 *
 * An attacker running a social-engineering payment fraud controls the address string they hand the
 * victim, but they do not control what the payee's BANK calls the account behind it. So the one
 * question that defeats the whole class of attack is: *is the name their bank holds the name you
 * expect?* Everything here exists to make the user actually read that name rather than tap past it.
 *
 * This was duplicated across the send-confirmation and the QR-scan screens, and the copies had
 * DIVERGED in a way that mattered: only the send screen carried the warning explaining *why* a
 * wrong name is dangerous. Scan is the higher-risk path — a swapped shopfront sticker is the
 * commonest way this fraud is run at scale — and it was the copy missing the warning. Unifying them
 * gave the scan path the warning it should always have had, which is the real reason this component
 * exists rather than tidiness.
 *
 * The checkbox is deliberately unchecked by default and there is no "remember this" affordance.
 * A confirmation that can be pre-satisfied is not a confirmation.
 */
interface NameConfirmationProps {
  /** The name the payee's BANK holds. `null` when the payee could not be verified. */
  registeredName: string | null;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /**
   * Whether to prefix with "I have read the name above."
   *
   * True where the name is displayed on the same screen immediately above this control, which is
   * the send-confirmation layout. False where the name sits further away.
   */
  nameShownAbove?: boolean;
}

export function NameConfirmation({
  registeredName,
  checked,
  onChange,
  nameShownAbove = true,
}: NameConfirmationProps) {
  const p = usePalette();

  return (
    <View style={[styles.frame, { borderColor: p.ruleStrong }]}>
      <Checkbox
        checked={checked}
        onChange={onChange}
        label={`Confirm you are paying ${registeredName ?? 'this payee'}`}
      >
        <Text role="bodySm">
          {nameShownAbove ? 'I have read the name above. ' : ''}
          {registeredName ? (
            <Text role="bodySmMedium">{registeredName}</Text>
          ) : (
            'This payee is not verified, and'
          )}{' '}
          is who I mean to pay.
        </Text>
      </Checkbox>

      {/*
        Always rendered, on every path. This sentence is the entire reason the checkbox is not just
        friction: it tells a user who is being socially engineered what they are looking at.
      */}
      <Micro>
        Their bank gave us this name. If it is not who you expected, stop — somebody may have
        given you the wrong UPI ID on purpose.
      </Micro>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.sm,
    padding: Space.md,
    gap: Space.sm,
  },
});
