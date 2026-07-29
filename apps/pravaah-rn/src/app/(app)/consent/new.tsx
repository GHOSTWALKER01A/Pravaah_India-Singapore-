import { router, Stack, type Href } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import * as Linking from 'expo-linking';

import {
  ApiError,
  consentService,
  type CreateConsentRequest,
  type FiType,
} from '@/api';
import {
  Button,
  Checkbox,
  ChoicePlate,
  FieldGrid,
  FieldRow,
  Header,
  Icon,
  Legend,
  Micro,
  Notice,
  Panel,
  Rule,
  Screen,
  Text,
  haptic,
} from '@/components/ui';
import {
  FI_TYPE_META,
  PURPOSE_PRESETS,
  dataLifeLabel,
  type PurposePreset,
} from '@/features/consent/consent-meta';
import { Radius, Space, usePalette } from '@/theme';

/** Last 12 months → today, as YYYY-MM-DD (the AA FI data range). */
function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setFullYear(to.getFullYear() - 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

/** Data-life and frequency implied by a preset's fetch type. */
function retentionFor(preset: PurposePreset): {
  dataLife: CreateConsentRequest['dataLife'];
  frequency?: CreateConsentRequest['frequency'];
} {
  return preset.fetchType === 'PERIODIC'
    ? { dataLife: { unit: 'YEAR', value: 1 }, frequency: { unit: 'MONTH', value: 1 } }
    : { dataLife: { unit: 'MONTH', value: 6 } };
}

/** A date the user can read, from the ISO the API needs. */
const readable = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

/**
 * The consent request — the most consequential screen in the product.
 *
 * The terms panel is the centrepiece and it stays a data-field grid, because that
 * is what a consent artefact IS: a set of named terms. Two substantive changes
 * beyond the visual system:
 *
 *   - the period showed as `2025-07-26 → 2026-07-26`, raw ISO strings in a consent
 *     the user is being asked to agree to. Now readable dates;
 *   - "Approval expires in 30 minutes" sat in the same grid as the terms, implying
 *     it was one of them. It is a property of the NEXT step, not of the agreement,
 *     so it moved out of the terms and next to the button it constrains.
 */
export default function NewConsentScreen() {
  const p = usePalette();
  const [presetKey, setPresetKey] = useState(PURPOSE_PRESETS[0].key);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset =
    PURPOSE_PRESETS.find((x) => x.key === presetKey) ?? PURPOSE_PRESETS[0];
  // `useState`, not a bare call: `defaultRange()` reads the clock, so calling it in render
  // would hand a different window to every render. The compiler's memoisation is a
  // performance optimisation and cannot be relied on to freeze a value — `useState` can.
  const [range] = useState(defaultRange);
  const { dataLife, frequency } = retentionFor(preset);

  async function create() {
    if (!agreed || busy) return;
    setError(null);
    setBusy(true);
    try {
      const req: CreateConsentRequest = {
        fiTypes: preset.fiTypes,
        purpose: preset.purpose,
        purposeCode: preset.purposeCode,
        fetchType: preset.fetchType,
        frequency,
        dataRange: range,
        dataLife,
        // The AA redirects here after approval; the detail screen waits on the
        // same deep link so the in-app browser closes itself.
        redirectUrl: Linking.createURL('consent-return'),
      };
      const res = await consentService.create(req);
      haptic.commit();
      router.replace({
        pathname: '/(app)/consent/[id]',
        params: {
          id: res.consentId,
          approvalUrl: res.approvalUrl ?? '',
          providerConsentId: res.providerConsentId ?? '',
        },
      } as Href);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'The consent could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      footer={
        <View style={styles.footer}>
          <Button
            label="Create consent"
            onPress={() => void create()}
            loading={busy}
            disabled={!agreed}
            hint={
              agreed
                ? undefined
                : 'Tick the agreement above before you can create this consent.'
            }
          />
          {/* Says WHY the button is inactive, visibly. The reason lived only in an
              accessibilityHint, so a sighted user saw a dead primary action with
              no explanation and the checkbox that unlocks it is at the bottom of
              a long scroll. */}
          <Micro center tone={agreed ? 'faint' : 'latent'}>
            {agreed
              ? 'The next screen is your Account Aggregator’s. The approval link it gives you is valid for 30 minutes.'
              : 'Tick the agreement above to continue.'}
          </Micro>
        </View>
      }
    >
      <Stack.Screen options={{ title: 'New consent' }} />

      <View style={styles.sheet}>
        <Header
          legend="Consent request"
          title="Exactly what you're agreeing to"
          lede="You approve this on your Account Aggregator's own screen. Pravaah never sees a bank password, and you can revoke it at any moment."
        />

        {/* 1 — what for */}
        <View style={styles.block}>
          <Legend tone="faint">Why you&apos;re sharing</Legend>
          <View
            style={styles.choices}
            accessibilityRole="radiogroup"
            accessibilityLabel="Purpose of this data share"
          >
            {PURPOSE_PRESETS.map((x) => (
              <ChoicePlate
                key={x.key}
                selected={x.key === preset.key}
                onSelect={() => setPresetKey(x.key)}
                title={x.title}
                detail={x.detail}
              />
            ))}
          </View>
        </View>

        {/* 2 — the terms, as the note's data-field grid */}
        <View style={styles.block}>
          <Legend tone="faint">The terms</Legend>

          <FieldGrid>
            <FieldRow label="Purpose" value={preset.purpose} prose />
            <FieldRow
              label="Period"
              value={`${readable(range.from)} — ${readable(range.to)}`}
            />
            <FieldRow
              label="Kept for"
              value={dataLifeLabel(dataLife.unit, dataLife.value)}
              tone="latent"
            />
            <FieldRow
              label="Refreshes"
              value={frequency ? 'Monthly, while active' : 'Once, then never again'}
            />
          </FieldGrid>
        </View>

        {/* 3 — what, specifically. Named sources, not a count. */}
        <View style={styles.block}>
          <Legend tone="faint">{`What is requested · ${preset.fiTypes.length} source${preset.fiTypes.length === 1 ? '' : 's'}`}</Legend>
          <Panel pad="none">
            {preset.fiTypes.map((t: FiType, i) => (
              <View key={t}>
                {i > 0 ? <Rule /> : null}
                <View style={styles.source}>
                  <View style={[styles.sourceGlyph, { borderColor: p.rule }]}>
                    <Icon name={FI_TYPE_META[t].icon} size={18} color={p.latent} />
                  </View>
                  <View style={styles.sourceText}>
                    <Text role="title">{FI_TYPE_META[t].label}</Text>
                    <Micro tone="dim">{FI_TYPE_META[t].description}</Micro>
                  </View>
                </View>
              </View>
            ))}
          </Panel>
          <Micro>
            Nothing outside this list is requested, and your Account Aggregator will
            not let us fetch it even if we tried.
          </Micro>
        </View>

        {error ? <Notice tone="error">{error}</Notice> : null}

        {/* 4 — the gate */}
        <View style={[styles.gate, { borderTopColor: p.rule }]}>
          <Checkbox
            checked={agreed}
            onChange={setAgreed}
            label="I agree to share the data listed above, for this purpose, for the retention period shown"
          >
            <Text role="bodySm">
              I agree to share the data above, for this purpose, for the retention
              period shown. I understand I can revoke it at any time and the data
              will be deleted.
            </Text>
          </Checkbox>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl },
  block: { gap: Space.md },
  choices: { gap: Space.md },
  source: { flexDirection: 'row', alignItems: 'center', gap: Space.lg, padding: Space.lg },
  sourceGlyph: {
    width: 38,
    height: 38,
    borderRadius: Radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceText: { flex: 1, gap: 1 },
  gate: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: Space.lg },
  footer: { gap: Space.md },
});
