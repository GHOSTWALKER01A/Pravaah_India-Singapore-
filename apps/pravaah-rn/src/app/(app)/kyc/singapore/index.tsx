import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError, kycService, type Persona } from '@/api';
import {
  Button,
  FieldValue,
  Icon,
  Notice,
  Panel,
  Press,
  Rule,
  Spinner,
  Text,
  haptic,
} from '@/components/ui';
import { Mechanism, StepScreen } from '@/features/kyc/components/step-screen';
import { checkStatusOf, nextRoute } from '@/features/kyc/flow';
import { useKycStatus } from '@/features/kyc/use-kyc-status';
import { Radius, Space, usePalette } from '@/theme';

export default function SingpassScreen() {
  const { status } = useKycStatus();
  const [providerRefId, setProviderRefId] = useState<string | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setError(null);
    setConnecting(true);
    try {
      const { providerRefId: ref } = await kycService.initiateSingpass();
      const { personas: list } = await kycService.listPersonas(ref);
      setProviderRefId(ref);
      setPersonas(list);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach Singpass.',
      );
    } finally {
      setConnecting(false);
    }
  }

  async function choose(persona: Persona) {
    if (!providerRefId || selecting) return;
    setError(null);
    setSelecting(persona.uinfin);
    try {
      await kycService.selectPersona(providerRefId, persona.uinfin);
      const updated = await kycService.completeSingpass(providerRefId);
      if (checkStatusOf(updated, 'SINGPASS_MYINFO') === 'FAILED') {
        haptic.refused();
        setError('Myinfo did not return a profile for that persona. Try another one.');
        return;
      }
      haptic.commit();
      router.replace(nextRoute(updated));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not fetch Myinfo.');
    } finally {
      setSelecting(null);
    }
  }

  const connected = providerRefId != null;

  return (
    <StepScreen
      check="SINGPASS_MYINFO"
      status={status}
      title="Singpass Myinfo"
      lede="Your government-verified profile, shared straight from Singapore's national identity service."
      error={error}
      assurance="Myinfo returns only the fields Pravaah asked for. Your Singpass credentials are entered on Singpass's own screen and are never seen by this app."
      footer={
        !connected ? (
          <Button label="Connect Singpass" onPress={() => void connect()} loading={connecting} />
        ) : undefined
      }
    >
      {!connected ? (
        <Mechanism
          lines={[
            'Singpass asks you to approve sharing your Myinfo profile with Pravaah.',
            'It returns your verified name, NRIC/FIN and address directly to us.',
            'No document photograph or manual entry is needed on this corridor.',
          ]}
        />
      ) : (
        <View style={styles.list}>
          {/* Explicitly marked as sandbox. Dressing a test fixture as production
              UI is how a demo becomes an accidental claim. */}
          <Notice tone="sandbox" title="Sandbox — test personas">
            Production redirects to the real Singpass login. In this environment you
            pick one of Singpass&apos;s own published test identities.
          </Notice>

          <Panel pad="none">
            {personas.map((persona, i) => {
              const busy = selecting === persona.uinfin;
              return (
                <View key={persona.uinfin}>
                  {i > 0 ? <Rule /> : null}
                  <PersonaRow
                    persona={persona}
                    busy={busy}
                    disabled={selecting !== null && !busy}
                    onPress={() => void choose(persona)}
                  />
                </View>
              );
            })}
          </Panel>
        </View>
      )}
    </StepScreen>
  );
}

function PersonaRow({
  persona,
  busy,
  disabled,
  onPress,
}: {
  persona: Persona;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const p = usePalette();
  return (
    <Press
      onPress={onPress}
      disabled={disabled || busy}
      depth="none"
      radius={Radius.sm}
      accessibilityRole="button"
      accessibilityLabel={`Use the test persona ${persona.name}, ${persona.nationality}`}
      accessibilityState={{ disabled: disabled || busy, busy }}
      style={disabled ? styles.dim : undefined}
    >
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text role="title">{persona.name}</Text>
          <FieldValue role="fieldSm" tone="faint">
            {`${persona.nationality} · ${persona.uinfin}`}
          </FieldValue>
        </View>
        {busy ? (
          <Spinner size={18} />
        ) : (
          <Icon name="chevronRight" size={16} color={p.inkFaint} weight={1.6} />
        )}
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  list: { gap: Space.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.lg,
  },
  rowText: { flex: 1, gap: 2 },
  dim: { opacity: 0.45 },
});
