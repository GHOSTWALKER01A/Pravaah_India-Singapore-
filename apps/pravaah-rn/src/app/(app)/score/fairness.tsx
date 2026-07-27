import { Stack } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { FairnessConsentRequest } from '@/api';
import {
  Button,
  Chip,
  ChipRow,
  FieldGrid,
  FieldRow,
  Header,
  Legend,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Screen,
  StatusMark,
  Text,
} from '@/components/ui';
import { useFairnessConsent } from '@/features/score/use-fairness-consent';
import { Space, usePalette } from '@/theme';

type Gender = NonNullable<FairnessConsentRequest['gender']>;
type AgeBand = NonNullable<FairnessConsentRequest['ageBand']>;

const GENDERS: { value: Gender; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'other', label: 'Other' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
];

const AGE_BANDS: AgeBand[] = ['18-25', '26-35', '36-45', '46-60', '60+'];

const NATIONALITIES: { value: string; label: string }[] = [
  { value: 'IN', label: 'India' },
  { value: 'SG', label: 'Singapore' },
  { value: 'AE', label: 'UAE' },
  { value: 'US', label: 'United States' },
  { value: 'GB', label: 'United Kingdom' },
];

const ATTRIBUTE_LABEL: Record<string, string> = {
  gender: 'Gender',
  age_band: 'Age range',
  nationality: 'Nationality',
};

/**
 * Help us prove the score is fair — the separate, explicit consent for the
 * audit-only protected attributes.
 *
 * The incumbent's structural decision is right and preserved: this is its own
 * screen, not a step inside the M1 data-share flow. Bundling "share my bank data"
 * with "record my gender" would make neither a real choice, and the entire defence
 * of collecting these is that the choice is genuine, separate and reversible.
 *
 * The copy still leads with what this does NOT do, because that is the part a user
 * will otherwise assume wrongly. What changes is that the disclaimer is no longer
 * a four-paragraph block in one bordered card with an indigo tint — it is the
 * screen's opening statement, and the chips are now real radio controls that
 * announce their state, which on a protected-attribute form is not optional.
 */
export default function FairnessConsentScreen() {
  const p = usePalette();
  const { status, loading, saving, error, save } = useFairnessConsent();

  const [gender, setGender] = useState<Gender | null>(null);
  const [ageBand, setAgeBand] = useState<AgeBand | null>(null);
  const [nationality, setNationality] = useState<string | null>(null);

  const granted = status?.consentGiven ?? false;
  // The backend requires at least one attribute when granting.
  const canGrant = Boolean(gender ?? ageBand ?? nationality);

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Fairness' }} />

      <View style={styles.sheet}>
        <Header
          legend="Optional · separate consent"
          title="Help us prove this is fair"
          lede="These details are never used to calculate your score. Not as a factor, not indirectly, not at all — the model cannot see them."
        />

        <View style={styles.why}>
          <Text role="bodySm" tone="dim" style={styles.body}>
            They do exactly one job: checking that people in different groups get
            similar scores for similar financial behaviour. Without them we could
            claim the model is fair, but we could not{' '}
            <Text role="bodySmMedium" tone="default">
              show
            </Text>{' '}
            it — and a claim nobody can check is worth very little.
          </Text>
          <Micro>
            Stored encrypted. Never shown to staff. Withdraw at any time and the
            values are deleted, not just ignored.
          </Micro>
        </View>

        {loading && !status ? <ListSkeleton rows={1} label="Loading your fairness settings" /> : null}

        {error ? <Notice tone="error">{error}</Notice> : null}

        {status ? (
          <View style={styles.block}>
            <Legend tone="faint">Right now</Legend>
            <FieldGrid>
              <FieldRow label="Status">
                {/* Reuses the same seal vocabulary as every other status in the
                    app, so "sharing" here reads the same way "active" does on a
                    consent. */}
                <StatusMark status={granted ? 'ACTIVE' : 'NOT_STARTED'} />
              </FieldRow>
              {granted ? (
                <FieldRow
                  label="Held"
                  value={
                    status.attributesHeld.map((a) => ATTRIBUTE_LABEL[a] ?? a).join(', ') || '—'
                  }
                  prose
                />
              ) : null}
              {granted && status.consentedAt ? (
                <FieldRow label="Since" value={status.consentedAt.slice(0, 10)} />
              ) : null}
            </FieldGrid>
            {!granted ? (
              <Micro>
                Your score works exactly the same either way. This only decides
                whether you are counted in our fairness checks.
              </Micro>
            ) : null}
          </View>
        ) : null}

        {/* Values are never read back from the server, so re-granting means
            re-stating them — see useFairnessConsent. */}
        {status ? (
          <View style={styles.form}>
            <Legend tone="faint">{granted ? 'Update what you share' : 'Choose what to share'}</Legend>
            <Micro tone="dim">All optional. Pick any one, or all three.</Micro>

            <Panel pad="lg">
              <View style={styles.fields}>
                <Field label="Gender">
                  <ChipRow>
                    {GENDERS.map((g) => (
                      <Chip
                        key={g.value}
                        label={g.label}
                        selected={gender === g.value}
                        clearable
                        onPress={() => setGender(gender === g.value ? null : g.value)}
                      />
                    ))}
                  </ChipRow>
                </Field>

                <Field label="Age range">
                  <ChipRow>
                    {AGE_BANDS.map((a) => (
                      <Chip
                        key={a}
                        label={a}
                        selected={ageBand === a}
                        clearable
                        onPress={() => setAgeBand(ageBand === a ? null : a)}
                      />
                    ))}
                  </ChipRow>
                </Field>

                <Field label="Nationality">
                  <ChipRow>
                    {NATIONALITIES.map((n) => (
                      <Chip
                        key={n.value}
                        label={n.label}
                        selected={nationality === n.value}
                        clearable
                        onPress={() => setNationality(nationality === n.value ? null : n.value)}
                      />
                    ))}
                  </ChipRow>
                </Field>
              </View>
            </Panel>

            <Button
              label={granted ? 'Update what I share' : 'Share these details'}
              loading={saving}
              disabled={!canGrant || saving}
              hint={canGrant ? undefined : 'Choose at least one detail above first.'}
              onPress={() => {
                void save({
                  consentGiven: true,
                  gender: gender ?? undefined,
                  ageBand: ageBand ?? undefined,
                  nationality: nationality ?? undefined,
                }).then((ok) => {
                  if (ok) {
                    setGender(null);
                    setAgeBand(null);
                    setNationality(null);
                  }
                });
              }}
            />

            {granted ? (
              <View style={[styles.withdraw, { borderTopColor: p.rule }]}>
                <Button
                  label="Withdraw and delete what you hold"
                  variant="destructive"
                  icon="revoke"
                  loading={saving}
                  onPress={() => void save({ consentGiven: false })}
                  hint="Deletes the stored values immediately. Your score is unaffected."
                />
                <Micro center>
                  Deleted immediately, not just ignored. Your score does not change.
                </Micro>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View
      style={styles.field}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      <Text role="title">{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl },
  why: { gap: Space.md },
  body: { maxWidth: 470 },
  block: { gap: Space.md },
  form: { gap: Space.md },
  fields: { gap: Space.xl },
  field: { gap: Space.md },
  withdraw: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.xl,
    gap: Space.md,
  },
});
