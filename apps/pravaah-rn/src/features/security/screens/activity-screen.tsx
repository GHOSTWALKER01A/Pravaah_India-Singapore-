import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import {
  Button,
  FieldValue,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Rule,
  Screen,
  SectionHead,
  StatusMark,
  Text,
} from '@/components/ui';
import { Space } from '@/theme';

import type { HoldView, SecurityActivityView } from '@/api/security/schemas';
import { ROUTES } from '@/constants/routes.constants';

import { HOLD_STATUS, RISK_DECISION, RISK_SUBJECT } from '../security-meta';
import { useSecurityActivity } from '../use-security-activity';

/**
 * "My security activity" — the DPDP transparency answer, made tangible.
 *
 * ## What this screen deliberately does NOT show
 *
 * No score, no signal names, no weights. That is a security property rather than reticence:
 * a numeric score turns this screen into a calibration oracle, letting somebody tune an
 * amount, a device and a payee until the number drops below a threshold they can watch. And
 * naming the detectors hands an account under investigation the evasion instructions.
 *
 * What a person IS owed — and what this shows — is the DECISION and the REASONS, in words
 * they can contest. That is the actual substance of the automated-decision obligation; the
 * arithmetic is the implementation, and the analyst console is where it lives.
 *
 * ## Why allowed actions are listed too
 *
 * A screen that only listed the times the user was stopped would read as a rap sheet. Most
 * of these rows say "allowed", and that is the point: it is a record of a system watching,
 * not a list of accusations.
 */
export function ActivityScreen() {
  const router = useRouter();
  const { activity, holds, loading, error, refresh } = useSecurityActivity();

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Security activity' }} />

      {error ? (
        <Notice tone="error" action="Try again" onAction={() => void refresh()}>
          {error}
        </Notice>
      ) : null}

      {/*
        Holds come FIRST, unconditionally.

        They are the only rows on this screen the user can still do something about, and the
        only ones with money attached. A history above a live hold would bury the one thing
        that matters under things that no longer do.
      */}
      {holds.length > 0 ? (
        <>
          <SectionHead
            title="Under review"
            detail="These are with a person right now."
          />
          {holds.map((hold) => (
            <HoldCard key={hold.reference} hold={hold} router={router} />
          ))}
        </>
      ) : null}

      <SectionHead
        title="Recent decisions"
        detail="Every security check we ran on your account, and what we decided."
      />

      {loading ? (
        <ListSkeleton rows={4} label="Loading your security activity" />
      ) : activity.length === 0 ? (
        <Panel>
          <Text role="bodyMedium">Nothing to show yet</Text>
          <Text role="bodySm" tone="dim" style={styles.gap}>
            We check every payment, sign-in and claim. Once you have used your account,
            those checks appear here.
          </Text>
        </Panel>
      ) : (
        <Panel>
          {activity.map((row, index) => (
            <ActivityRow
              key={row.id}
              row={row}
              last={index === activity.length - 1}
            />
          ))}
        </Panel>
      )}
    </Screen>
  );
}

/**
 * One held action, with its reference.
 *
 * The reference IS the analyst's case id, and surfacing it is deliberate: it is what support
 * will ask for, and it ties a customer's complaint to the exact signal trail a reviewer
 * reads. A screen that said "under review" without one forces the user to describe the
 * payment from memory.
 */
function HoldCard({
  hold,
  router,
}: {
  hold: HoldView;
  router: ReturnType<typeof useRouter>;
}) {
  const status = HOLD_STATUS[hold.status];

  return (
    <Panel>
      <View style={styles.head}>
        <Text role="bodyMedium">{RISK_SUBJECT[hold.subjectType]}</Text>
        <StatusMark status="IN_REVIEW" labelled={false} />
      </View>

      <Text role="bodySm" tone="dim" style={styles.gap}>
        {status.detail}
      </Text>

      {hold.reasons.length > 0 ? (
        <View style={styles.reasons}>
          {hold.reasons.map((reason) => (
            <Micro key={reason} tone="faint">
              · {reason}
            </Micro>
          ))}
        </View>
      ) : null}

      <Rule />

      <View style={styles.reference}>
        <Micro tone="faint">Reference</Micro>
        {/*
          Tabular figures via `FieldValue`, and the FULL id rather than a truncation.
          A reference a user has to read out over the phone must be complete — an
          eight-character prefix is a reference support cannot find.
        */}
        <FieldValue role="fieldSm" selectable>
          {hold.reference}
        </FieldValue>
      </View>

      {/*
        A route to the payment itself, when there is one.

        Only for TRANSACTION holds: the other subject types have no screen a user can be sent
        to, and a dead button is worse than no button.
      */}
      {hold.subjectType === 'TRANSACTION' ? (
        <Button
          label="Open this payment"
          onPress={() => router.push(ROUTES.PAY.RECEIPT(hold.subjectId))}
          variant="secondary"
        />
      ) : null}
    </Panel>
  );
}

function ActivityRow({
  row,
  last,
}: {
  row: SecurityActivityView;
  last: boolean;
}) {
  const decision = RISK_DECISION[row.decision];

  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Text role="bodySmMedium">{RISK_SUBJECT[row.subjectType]}</Text>
        <Micro tone={decision.tone === 'field' ? 'faint' : 'latent'}>
          {decision.label}
        </Micro>
      </View>

      <Micro tone="faint">{formatWhen(row.computedAt)}</Micro>

      {/*
        The reasons, only when there are any.

        An ALLOW usually has none — nothing fired — and rendering an empty bullet list under
        it would imply we withheld something. Silence is the honest presentation of "nothing
        was unusual".
      */}
      {row.reasons.length > 0 ? (
        <View style={styles.reasons}>
          {row.reasons.map((reason) => (
            <Micro key={reason} tone="dim">
              · {reason}
            </Micro>
          ))}
        </View>
      ) : null}

      {last ? null : <Rule />}
    </View>
  );
}

/**
 * "Today at 14:32" / "12 Mar at 09:04".
 *
 * Absolute, not relative. A security history is something a user cross-references against
 * their own memory of what they were doing — "3 days ago" cannot be checked against
 * anything, and a date can.
 */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const time = at.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

  const today = new Date();
  const sameDay =
    at.getDate() === today.getDate() &&
    at.getMonth() === today.getMonth() &&
    at.getFullYear() === today.getFullYear();
  if (sameDay) return `Today at ${time}`;

  const date = at.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
  return `${date} at ${time}`;
}

const styles = StyleSheet.create({
  row: { gap: Space.sm },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  gap: { marginTop: Space.md },
  reasons: { gap: Space.xs, marginTop: Space.sm },
  reference: { gap: Space.xs, marginBottom: Space.lg },
});
