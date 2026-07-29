import { StyleSheet, View } from 'react-native';

import type { ClaimDocStatus, ClaimDocument } from '@/api/insurance/schemas';
import {
  Icon,
  Legend,
  Micro,
  Press,
  Spinner,
  Text,
  type IconName,
} from '@/components/ui';
import { Hairline, Radius, Space, toneColor, usePalette, type StatusTone } from '@/theme';
import { docMeta } from '@/features/insurance/insurance-meta';

/**
 * How a document's verification state reads to the claimant.
 *
 * ## The decision that governs this whole map: SUSPECT never says "forged"
 *
 * The server's tamper gate is a hard control — a document over the threshold cannot
 * auto-approve, full stop. But the claimant is NOT told they submitted a forgery, and that
 * is deliberate rather than squeamish:
 *
 *  - The tamper score is a heuristic. A photograph of a photocopy, a re-saved scan, or a
 *    bill printed on a bad thermal printer can all score high. Accusing somebody of fraud
 *    on that basis — in an app, automatically, to a person holding a hospital bill — would
 *    be indefensible.
 *  - Telling them the threshold was hit tells a genuine fraudster exactly how much less
 *    altered the next attempt needs to be.
 *
 * So `SUSPECT` reads as "a person will check this", which is TRUE and is the whole
 * consequence of the flag. The fraud signal is fully preserved for the reviewer, who has
 * the context to weigh it.
 *
 * `UPLOADED` with `needsBetterCopy` is the opposite case and gets a plain, actionable
 * prompt: a blurry payslip is not a forgery, and conflating the two would accuse somebody
 * with a cracked phone camera.
 */
const DOC_STATUS: Record<
  ClaimDocStatus,
  { tone: StatusTone; label: string; icon: IconName }
> = {
  UPLOADED: { tone: 'neutral', label: 'Received', icon: 'document' },
  OCR_DONE: { tone: 'latent', label: 'Being read', icon: 'clock' },
  VERIFIED: { tone: 'field', label: 'Checked', icon: 'check' },
  // Not "forged". See the note above.
  SUSPECT: { tone: 'latent', label: 'A person will check this', icon: 'info' },
  REJECTED: { tone: 'carmine', label: 'Could not be read', icon: 'cross' },
};

/** One attached document. */
export function DocumentRow({ doc }: { doc: ClaimDocument }) {
  const p = usePalette();
  const meta = DOC_STATUS[doc.status];
  const tone = toneColor(meta.tone, p);
  const kind = docMeta(doc.docType);

  return (
    <View style={[styles.row, { borderColor: p.rule }]}>
      <View style={[styles.mark, { borderColor: tone.rule }]}>
        <Icon name={meta.icon} size={14} color={tone.ink} weight={1.7} />
      </View>

      <View style={styles.body}>
        <Text role="bodySmMedium">{kind.label}</Text>
        <View style={styles.metaRow}>
          <Micro tone="inherit" style={{ color: tone.ink }}>
            {meta.label}
          </Micro>
          {/*
            The amount the OCR read off the document.

            Shown because it is the claimant's own check: if the bill says ₹12,450 and this
            row says ₹1,245, they photographed it badly and can fix it before a reviewer
            reads a figure that will not match their claim.
          */}
          {doc.extractedAmount ? (
            <>
              <Micro tone="faint">·</Micro>
              <Micro tone="dim">read as {doc.extractedAmount.formatted}</Micro>
            </>
          ) : null}
        </View>

        {doc.needsBetterCopy ? (
          <Micro tone="inherit" style={{ color: p.latent }}>
            Hard to read — a clearer photo would help your claim.
          </Micro>
        ) : null}
      </View>
    </View>
  );
}

/**
 * A document the claim still needs, as an action.
 *
 * ## Why the hint is not optional
 *
 * "Payslip" to a daily-wage worker paid in cash names a document that does not exist. The
 * hint from `DOC_META` lists what a reviewer will actually accept — an employer letter, a
 * muster-roll photo — and without it this row would be an instruction to produce something
 * impossible, which is how a legitimate claim gets abandoned rather than refused.
 */
export function DocumentSlot({
  docType,
  required,
  uploading,
  onPress,
}: {
  docType: string;
  /** Whether the claim cannot be assessed without it. */
  required: boolean;
  uploading: boolean;
  onPress: () => void;
}) {
  const p = usePalette();
  const kind = docMeta(docType);

  return (
    <Press
      onPress={onPress}
      disabled={uploading}
      depth="subtle"
      radius={Radius.sm}
      accessibilityRole="button"
      accessibilityLabel={`Add ${kind.label}. ${kind.hint}`}
      accessibilityState={{ busy: uploading }}
    >
      <View
        style={[
          styles.slot,
          {
            borderColor: required ? p.ruleStrong : p.rule,
            backgroundColor: p.groundSunk,
          },
        ]}
      >
        <View style={styles.slotHead}>
          {uploading ? (
            <Spinner size={16} />
          ) : (
            <Icon name="camera" size={16} color={p.field} weight={1.6} />
          )}
          <Text role="bodySmMedium" style={styles.slotLabel}>
            {kind.label}
          </Text>
          {required ? (
            <Legend small tone="inherit" style={{ color: p.latent }}>
              needed
            </Legend>
          ) : (
            <Legend small tone="faint">
              optional
            </Legend>
          )}
        </View>
        <Micro tone="dim">{uploading ? 'Sending…' : kind.hint}</Micro>
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.md,
    borderWidth: Hairline.base,
    borderRadius: Radius.sm,
    padding: Space.md,
  },
  mark: {
    width: 28,
    height: 28,
    borderRadius: Radius.sm,
    borderWidth: Hairline.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, gap: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  slot: {
    borderWidth: Hairline.base,
    borderRadius: Radius.sm,
    padding: Space.md,
    gap: Space.xs,
  },
  slotHead: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  slotLabel: { flex: 1 },
});
