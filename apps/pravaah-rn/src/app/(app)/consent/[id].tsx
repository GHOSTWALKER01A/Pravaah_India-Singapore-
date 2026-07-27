import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { ApiError, consentService, type ConsentStatus } from '@/api';
import {
  Button,
  FieldGrid,
  FieldRow,
  Header,
  Icon,
  Legend,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  ProgressRule,
  Screen,
  Spinner,
  StatusMark,
  Text,
  Thread,
  ThreadStep,
  haptic,
} from '@/components/ui';
import { API_BASE_URL } from '@/constants/api.constants';
import { ROUTES } from '@/constants/routes.constants';
import { fiTypeLabel } from '@/features/consent/consent-meta';
import { useConsentStatus } from '@/features/consent/use-consent-status';
import { STATUS_TONE, Space, usePalette } from '@/theme';

type Phase = 'approve' | 'fetch' | 'ready';

const TERMINAL: ConsentStatus[] = ['REVOKED', 'EXPIRED', 'REJECTED', 'FAILED'];

/**
 * A single consent's life.
 *
 * The three phases are the security thread: approve → fetch → ready, one unbroken
 * line. The incumbent already had a timeline here and it was the best-composed
 * screen in the app; it becomes the shared `Thread` so the same shape carries the
 * KYC checks and these phases.
 *
 * The revoke path is the one place in the product that gets carmine, a Heavy
 * haptic, and a destructive confirm — because it destroys data irreversibly, and
 * because product principle 4 says it deserves real weight rather than being
 * hidden behind a grey "secondary" button labelled like a back link.
 */
export default function ConsentDetailScreen() {
  const p = usePalette();
  const params = useLocalSearchParams<{
    id: string;
    approvalUrl?: string;
    providerConsentId?: string;
  }>();
  const id = params.id;
  const approvalUrl = params.approvalUrl || null;
  const providerConsentId = params.providerConsentId || null;

  // The in-app approve/reject shortcut applies ONLY to the sandbox provider, whose
  // approvalUrl is our own /mock/aa screen. A live AA is approved on its hosted
  // webview, so the shortcut must never appear there.
  const isSandbox = !!approvalUrl && approvalUrl.includes('/mock/aa/');
  // The backend builds the sandbox URL from API_PUBLIC_URL, usually an unreachable
  // "localhost" on a real device. Rebuild it from the base this app actually
  // reaches. A live AA URL is a real host — use it as-is.
  const effectiveApprovalUrl =
    isSandbox && providerConsentId
      ? `${API_BASE_URL}/api/v1/mock/aa/${providerConsentId}`
      : approvalUrl;

  const { status, notFound, loading, error, refetch } = useConsentStatus(id);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /**
   * Action failures render as an inline Notice, not `Alert.alert(…, 'Try again.')`.
   *
   * This is the screen where a failure matters most: after a failed revoke the one
   * thing the user needs to know is whether their data was deleted, and a two-word
   * platform alert cannot say it. An inline notice also survives being dismissed
   * by accident, and `Notice` announces itself.
   */
  const [actionError, setActionError] = useState<string | null>(null);

  async function openApproval() {
    if (!effectiveApprovalUrl) return;
    setBusy('approve');
    setActionError(null);
    try {
      const returnUrl = Linking.createURL('consent-return', { queryParams: { id } });
      const sep = effectiveApprovalUrl.includes('?') ? '&' : '?';
      await WebBrowser.openAuthSessionAsync(
        `${effectiveApprovalUrl}${sep}returnUrl=${encodeURIComponent(returnUrl)}`,
        returnUrl,
      );
    } catch {
      setActionError(
        isSandbox
          ? 'The sandbox approval page would not open. Use the Approve or Reject buttons below instead — they do the same thing without the browser.'
          : 'Your Account Aggregator’s approval page would not open. Nothing has been shared. Check your connection and try the button again.',
      );
    } finally {
      setBusy(null);
      void refetch();
    }
  }

  /** Sandbox only: approve without leaving the app. */
  async function simulate(decision: 'APPROVE' | 'REJECT') {
    if (!providerConsentId) return;
    setBusy(decision);
    setActionError(null);
    try {
      await consentService.mockDecision(providerConsentId, decision);
      await refetch();
    } catch (err) {
      setActionError(
        err instanceof ApiError
          ? err.message
          : `The sandbox could not record a ${decision.toLowerCase()}. Nothing changed — try again.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    setBusy('revoke');
    setActionError(null);
    try {
      await consentService.revoke(id);
      haptic.destroy();
      await refetch();
    } catch (err) {
      // The one error in the product where the user most needs to know the actual
      // state of their data, so it says it explicitly.
      setActionError(
        `${
          err instanceof ApiError ? err.message : 'The revoke request did not go through.'
        } Your data has NOT been deleted and this consent is still active. Nothing partial happened — try again, and if it fails twice, contact support with this consent open.`,
      );
    } finally {
      setBusy(null);
    }
  }

  function confirmRevoke() {
    Alert.alert(
      'Revoke and delete?',
      'Every statement fetched under this consent is deleted immediately. Any score built from it expires. This cannot be undone.',
      [
        { text: 'Keep sharing', style: 'cancel' },
        { text: 'Revoke and delete', style: 'destructive', onPress: () => void revoke() },
      ],
    );
  }

  async function refetchData() {
    setBusy('refetch');
    setActionError(null);
    try {
      await consentService.refetch(id);
      await refetch();
    } catch (err) {
      setActionError(
        err instanceof ApiError
          ? err.message
          : 'The remaining sources could not be reached. What you have already shared is unaffected — you can try again now or later.',
      );
    } finally {
      setBusy(null);
    }
  }

  if (loading && !status && !notFound) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Consent' }} />
        <ListSkeleton rows={3} label="Loading this consent" />
      </Screen>
    );
  }

  if (notFound) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Consent' }} />
        <View style={styles.sheet}>
          <Header
            title="Not found"
            lede="This consent does not exist, or it belongs to another account."
          />
          <Button
            label="Back to data sharing"
            variant="secondary"
            onPress={() => router.replace(ROUTES.CONSENT.DASHBOARD)}
          />
        </View>
      </Screen>
    );
  }

  if (!status) return null;

  const session = status.dataSession;
  const hasData = session?.status === 'COMPLETED' || session?.status === 'PARTIAL';
  const fetching = status.status === 'ACTIVE' && !hasData;
  const terminal = TERMINAL.includes(status.status);
  const coverage =
    session?.fipTotal && session.fipTotal > 0 ? session.fipCompleted / session.fipTotal : 0;
  const phase: Phase = status.status === 'PENDING' ? 'approve' : fetching ? 'fetch' : 'ready';

  const order: Phase[] = ['approve', 'fetch', 'ready'];
  const at = order.indexOf(phase);
  const position = (s: Phase) => {
    const i = order.indexOf(s);
    return i < at ? 'done' : i === at ? 'live' : 'ahead';
  };
  const tone = (s: Phase) => (position(s) === 'ahead' ? 'neutral' : position(s) === 'done' ? 'field' : 'latent');

  const revocable = status.status === 'ACTIVE' || status.status === 'PAUSED';

  return (
    <Screen
      onRefresh={async () => {
        setRefreshing(true);
        await refetch();
        setRefreshing(false);
      }}
      refreshing={refreshing}
      footer={
        revocable ? (
          <View style={styles.footer}>
            <Button
              label="Revoke and delete my data"
              variant="destructive"
              icon="revoke"
              onPress={confirmRevoke}
              loading={busy === 'revoke'}
              hint="Deletes every statement fetched under this consent, immediately and permanently."
            />
            <Micro center>Immediate and permanent. Your identity verification is unaffected.</Micro>
          </View>
        ) : (
          <Button
            label="Back to data sharing"
            variant="secondary"
            onPress={() => router.replace(ROUTES.CONSENT.DASHBOARD)}
          />
        )
      }
    >
      <Stack.Screen options={{ title: 'Consent' }} />

      <View style={styles.sheet}>
        <Header
          title={headline(status.status, phase)}
          lede={terminal ? undefined : phaseDesc(phase)}
          aside={<StatusMark status={status.status} labelled={false} size={18} />}
        />

        {error ? (
          <Notice tone="error" action="Try again" onAction={() => void refetch()}>
            {error}
          </Notice>
        ) : null}

        {/* Failures from an action the user just took — approve, simulate, revoke,
            re-fetch. Dismissible, because unlike a load error it refers to a past
            attempt rather than the current state of the screen. */}
        {actionError ? (
          <Notice tone="error" action="Dismiss" onAction={() => setActionError(null)}>
            {actionError}
          </Notice>
        ) : null}

        {terminal ? (
          <TerminalPanel status={status.status} />
        ) : (
          <Thread>
            <ThreadStep
              tone={tone('approve')}
              shape={STATUS_TONE[tone('approve')]}
              position={position('approve')}
            >
              <Text role="title" tone={position('approve') === 'ahead' ? 'faint' : 'default'}>
                Approve at your aggregator
              </Text>

              {phase === 'approve' ? (
                <View style={styles.stepBody}>
                  <Micro tone="dim">
                    Your Account Aggregator asks you to confirm the terms. Pravaah
                    never sees your bank credentials, and neither does the
                    aggregator.
                  </Micro>

                  {effectiveApprovalUrl ? (
                    <Button
                      label="Approve at Account Aggregator"
                      iconEnd="external"
                      onPress={() => void openApproval()}
                      loading={busy === 'approve'}
                    />
                  ) : (
                    <Micro tone="dim">
                      Finish in the aggregator screen you already opened, then pull
                      down to refresh this page.
                    </Micro>
                  )}

                  {isSandbox && providerConsentId ? (
                    <Notice tone="sandbox" title="Sandbox">
                      <View style={styles.sandbox}>
                        <Micro tone="dim">
                          A live aggregator is approved on its own hosted page. Here
                          you can simulate either decision.
                        </Micro>
                        <View style={styles.sandboxRow}>
                          <View style={styles.flex}>
                            <Button
                              label="Approve"
                              variant="secondary"
                              onPress={() => void simulate('APPROVE')}
                              loading={busy === 'APPROVE'}
                            />
                          </View>
                          <View style={styles.flex}>
                            <Button
                              label="Reject"
                              variant="secondary"
                              onPress={() => void simulate('REJECT')}
                              loading={busy === 'REJECT'}
                            />
                          </View>
                        </View>
                      </View>
                    </Notice>
                  ) : null}
                </View>
              ) : (
                <Micro tone="dim">Approved — this consent is active.</Micro>
              )}
            </ThreadStep>

            <ThreadStep
              tone={tone('fetch')}
              shape={STATUS_TONE[tone('fetch')]}
              position={position('fetch')}
              live={phase === 'fetch'}
            >
              <Text role="title" tone={position('fetch') === 'ahead' ? 'faint' : 'default'}>
                Fetch and decrypt
              </Text>
              {phase === 'fetch' ? (
                <View style={styles.fetchRow}>
                  <Spinner size={16} label="Fetching your statements" />
                  <Micro tone="dim" style={styles.flex}>
                    Pulling your statements over the encrypted channel and decrypting
                    them here. Usually a few seconds.
                  </Micro>
                </View>
              ) : phase === 'ready' ? (
                <Micro tone="dim">Statements fetched and decrypted.</Micro>
              ) : (
                <Micro tone="faint">Starts as soon as you approve.</Micro>
              )}
            </ThreadStep>

            <ThreadStep
              tone={tone('ready')}
              shape={STATUS_TONE[tone('ready')]}
              position={position('ready')}
              last
            >
              <Text role="title" tone={position('ready') === 'ahead' ? 'faint' : 'default'}>
                Ready to score
              </Text>
              {phase === 'ready' ? (
                <View style={styles.stepBody}>
                  <ProgressRule
                    value={coverage}
                    label={
                      session?.fipTotal
                        ? `${session.fipCompleted} of ${session.fipTotal} sources fetched`
                        : 'Coverage'
                    }
                  />
                  <Micro tone="dim">
                    {session?.fipTotal
                      ? `${session.fipCompleted} of ${session.fipTotal} sources · `
                      : ''}
                    {status.featuresAvailable} feature set
                    {status.featuresAvailable === 1 ? '' : 's'} ready — the inputs your
                    score is built from.
                  </Micro>
                  {session?.status === 'PARTIAL' ? (
                    <Button
                      label="Try the remaining sources again"
                      variant="secondary"
                      icon="refresh"
                      onPress={() => void refetchData()}
                      loading={busy === 'refetch'}
                    />
                  ) : null}
                </View>
              ) : (
                <Micro tone="faint">Your score can be computed once the fetch completes.</Micro>
              )}
            </ThreadStep>
          </Thread>
        )}

        {/* What is covered, and the two facts that make it verifiable. */}
        <View style={styles.block}>
          <Legend tone="faint">On this consent</Legend>
          <FieldGrid>
            <FieldRow label="Sources" value={status.fiTypes.map(fiTypeLabel).join(', ')} prose />
            <FieldRow
              label="Signature"
              value={status.artefactVerified ? 'Verified' : 'Pending'}
              tone={status.artefactVerified ? 'cleared' : 'latent'}
            />
            {status.expiresAt ? (
              <FieldRow label="Data deleted on" value={status.expiresAt.slice(0, 10)} />
            ) : null}
          </FieldGrid>
          <Micro>
            The signature is the aggregator&apos;s cryptographic proof that these
            exact terms are what you approved — it is what makes the consent
            auditable rather than a claim we make about ourselves.
          </Micro>
        </View>
      </View>
    </Screen>
  );
}

const TERMINAL_META: Record<
  string,
  { icon: 'revoke' | 'clock' | 'cross' | 'alert'; tone: 'cleared' | 'caution' | 'error'; title: string; body: string }
> = {
  REVOKED: {
    icon: 'revoke',
    // Cleared, not error: the user asked for this and it worked. Revocation
    // succeeding is a good outcome and should not be styled as a failure.
    tone: 'cleared',
    title: 'Revoked — the data is gone',
    body: 'Every statement fetched under this consent has been permanently deleted. Your identity verification is untouched.',
  },
  EXPIRED: {
    icon: 'clock',
    tone: 'caution',
    title: 'Expired, and deleted',
    body: 'The retention period you agreed to ran out, so the data was deleted automatically. Nothing was kept beyond it.',
  },
  REJECTED: {
    icon: 'cross',
    tone: 'caution',
    title: 'You declined this request',
    body: 'Nothing was fetched and nothing was stored. You can create a new request whenever you want to.',
  },
  FAILED: {
    icon: 'alert',
    tone: 'error',
    title: 'The request failed',
    body: 'It could not be completed, and nothing was shared. Starting a new one is safe.',
  },
};

function TerminalPanel({ status }: { status: ConsentStatus }) {
  const p = usePalette();
  const m = TERMINAL_META[status] ?? TERMINAL_META.FAILED;
  const ink = m.tone === 'cleared' ? p.cleared : m.tone === 'error' ? p.carmine : p.latent;

  return (
    <Panel pad="lg" rule={ink}>
      <View style={styles.terminal}>
        <View style={[styles.terminalGlyph, { borderColor: ink }]}>
          <Icon name={m.icon} size={22} color={ink} />
        </View>
        <Text role="heading" center tone="inherit" style={{ color: ink }}>
          {m.title}
        </Text>
        <Text role="bodySm" tone="dim" center style={styles.terminalBody}>
          {m.body}
        </Text>
      </View>
    </Panel>
  );
}

function headline(status: ConsentStatus, phase: Phase): string {
  switch (status) {
    case 'PENDING':
      return 'One approval left';
    case 'REVOKED':
      return 'Revoked';
    case 'EXPIRED':
      return 'Expired';
    case 'REJECTED':
      return 'Declined';
    case 'FAILED':
      return 'Failed';
    case 'PAUSED':
      return 'Sharing paused';
    default:
      return phase === 'fetch' ? 'Fetching your data' : 'Your data is ready';
  }
}

function phaseDesc(phase: Phase): string {
  return phase === 'approve'
    ? 'One approval at your Account Aggregator, then Pravaah does the rest.'
    : phase === 'fetch'
      ? 'Securely fetching and decrypting your statements.'
      : 'Everything needed for your reputation score is in place.';
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl, paddingTop: Space.sm },
  block: { gap: Space.md },
  stepBody: { gap: Space.md, paddingTop: Space.xs },
  fetchRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  sandbox: { gap: Space.md },
  sandboxRow: { flexDirection: 'row', gap: Space.sm },
  terminal: { alignItems: 'center', gap: Space.sm },
  terminalGlyph: {
    width: 52,
    height: 52,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Space.xs,
  },
  terminalBody: { maxWidth: 400 },
  footer: { gap: Space.md },
  flex: { flex: 1 },
});
