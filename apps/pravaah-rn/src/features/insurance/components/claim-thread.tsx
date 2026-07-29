import { StyleSheet, View } from 'react-native';

import type { Claim } from '@/api/insurance/schemas';
import { Icon, Legend, Micro, Text } from '@/components/ui';
import { Hairline, Radius, Space, toneColor, usePalette } from '@/theme';
import {
  CLAIM_JOURNEY,
  CLAIM_META,
  journeyIndex,
  policyDate,
} from '@/features/insurance/insurance-meta';

/**
 * Where a claim has got to, on the security thread.
 *
 * ## Why the thread and not a stepper
 *
 * The world already owns this device: M0's verification steps run down one unbroken
 * engraved line with a mark at each station. Reusing it here means a claimant who learned
 * to read their KYC progress reads their claim progress the same way, and the app has one
 * metaphor for "a process with stations" rather than two.
 *
 * ## The three decisions that make this honest
 *
 * **`APPROVED` is not the terminus — `PAID` is.** The claimant's question is "where is my
 * money", not "what did the reviewer decide". A thread that ended at approval would show a
 * completed journey while the money was still in transit.
 *
 * **`INFO_REQUESTED` is a HOLD at the review station, not a step of its own.** The claim
 * has not moved backwards; it is waiting inside review, for the claimant. Drawing it as a
 * fourth station would suggest progress where there is none, and — worse — would hide the
 * one fact that matters: nothing will happen until they act.
 *
 * **A rejection or a withdrawal LEAVES the thread.** Both are exits, and drawing them as
 * a final station would imply every claim passes through them. Instead the thread is drawn
 * struck through at the point it stopped.
 */
export function ClaimThread({ claim }: { claim: Claim }) {
  const p = usePalette();
  const current = journeyIndex(claim.status);
  const meta = CLAIM_META[claim.status];
  const tone = toneColor(meta.tone, p);

  const exited = claim.status === 'REJECTED' || claim.status === 'WITHDRAWN';
  const held = claim.status === 'INFO_REQUESTED';

  return (
    <View style={styles.wrap}>
      <Legend small tone="faint">
        Progress
      </Legend>

      <View style={styles.thread}>
        {CLAIM_JOURNEY.map((step, index) => {
          const done = !exited && index < current;
          const active = !exited && index === current;
          const isLast = index === CLAIM_JOURNEY.length - 1;

          /**
           * The mark's ink.
           *
           * A completed station takes the CLEARED ink, an active one takes the claim's own
           * tone (gold while in flight, green only at PAID), and a future one stays faint.
           * That is what keeps an approved-but-unpaid claim from showing a green terminus.
           */
          const ink = done
            ? p.cleared
            : active
              ? tone.ink
              : exited && index <= current
                ? p.inkFaint
                : p.rule;

          return (
            <View key={step.status} style={styles.station}>
              <View style={styles.rail}>
                <View
                  style={[
                    styles.mark,
                    {
                      borderColor: ink,
                      backgroundColor: done ? p.cleared : 'transparent',
                    },
                  ]}
                >
                  {done ? (
                    <Icon name="check" size={10} color={p.panel} weight={2.4} />
                  ) : active ? (
                    <View style={[styles.pip, { backgroundColor: ink }]} />
                  ) : null}
                </View>
                {!isLast ? (
                  <View
                    style={[
                      styles.line,
                      { backgroundColor: done ? p.cleared : p.rule },
                    ]}
                  />
                ) : null}
              </View>

              <View style={styles.stationText}>
                <Text
                  role={active ? 'bodySmMedium' : 'bodySm'}
                  tone={done || active ? 'default' : 'faint'}
                >
                  {step.label}
                </Text>
                {active ? (
                  <Micro tone="inherit" style={{ color: tone.ink }}>
                    {held ? 'waiting on you' : stationNote(claim, step.status)}
                  </Micro>
                ) : done ? (
                  <Micro tone="faint">{stationDate(claim, step.status)}</Micro>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>

      {/* ── the exit, when the claim left the thread ─────────────────────────── */}
      {exited ? (
        <View style={[styles.exit, { borderColor: tone.rule }]}>
          <Icon name={meta.icon} size={15} color={tone.ink} weight={1.7} />
          <View style={styles.exitText}>
            <Text role="bodySmMedium" tone="inherit" style={{ color: tone.ink }}>
              {meta.label}
              {claim.decidedAt ? ` · ${policyDate(claim.decidedAt)}` : ''}
            </Text>
            {/*
              The reason, verbatim.

              A claimant who disagrees with a rejection needs the exact ground it rested
              on — that is the first thing an appeal turns on, and paraphrasing it here
              would leave them arguing against a summary nobody wrote down.
            */}
            {claim.decisionReason ? (
              <Text role="bodySm" tone="dim">
                {claim.decisionReason}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** What is happening at the station the claim is currently sitting at. */
function stationNote(claim: Claim, status: string): string {
  if (status === 'SUBMITTED') {
    return claim.documents.length === 0
      ? 'add your documents next'
      : 'ready to submit for review';
  }
  if (status === 'UNDER_REVIEW') return 'a reviewer is looking at this';
  if (status === 'APPROVED') return 'crediting your wallet';
  return '';
}

/** When a completed station was passed. */
function stationDate(claim: Claim, status: string): string {
  if (status === 'SUBMITTED') return policyDate(claim.submittedAt);
  if (status === 'APPROVED' && claim.decidedAt) {
    return policyDate(claim.decidedAt);
  }
  if (status === 'PAID' && claim.paidAt) return policyDate(claim.paidAt);
  return '';
}

const styles = StyleSheet.create({
  wrap: { gap: Space.md },
  thread: { gap: 0 },
  station: { flexDirection: 'row', gap: Space.md },
  rail: { alignItems: 'center', width: 18 },
  mark: {
    width: 16,
    height: 16,
    borderRadius: Radius.pill,
    borderWidth: Hairline.thick,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pip: { width: 6, height: 6, borderRadius: 3 },
  // The connector's height sets the station rhythm. Tall enough for two lines of text,
  // so an active station's note does not push the next mark out of alignment.
  line: { width: Hairline.thick, flex: 1, minHeight: 26 },
  stationText: { flex: 1, gap: 1, paddingBottom: Space.lg },
  exit: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.sm,
    borderLeftWidth: Hairline.thick,
    paddingLeft: Space.md,
  },
  exitText: { flex: 1, gap: Space.xs },
});
