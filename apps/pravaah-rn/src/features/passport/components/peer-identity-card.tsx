/**
 * Who they turned out to be — rendered from the disclosed claims and nothing else.
 *
 * The single rule this component follows, and the reason it takes a verdict rather than a
 * user id: EVERY FACT ON THIS SCREEN CAME OUT OF A SIGNED CREDENTIAL THE HOLDER CHOSE TO SEND.
 * Not one field is fetched by looking the person up. That is what makes the display
 * trustworthy — a lookup would produce facts nobody consented to and nothing cryptographic
 * vouches for — and it is also why a claim they withheld renders as an honest absence rather
 * than as a blank that reads like a zero.
 *
 * ── The monogram, and the photograph that is not here ──
 * `portrait` is not in the credential's claim catalogue, so no signed photo of this person
 * exists to show. Fetching one by user id would put a face on screen with nothing tying it to
 * the credential — the exact affordance an impersonator wants, and worse than no face at all
 * because a photograph is the thing people actually trust. So the medallion carries their
 * initials, drawn from the names they disclosed, and says only as much as we can prove.
 */
import { StyleSheet, View } from 'react-native';

import type { PeerCheckVerdict, ScoreBand } from '@/api';
import {
  CornerMedallion,
  GuillocheBand,
  Icon,
  Legend,
  Micro,
  Rule,
  Text,
} from '@/components/ui';
import { SCORE_BAND_META } from '@/features/score/score-meta';
import { Radius, Space, useBand, usePalette } from '@/theme';

import { useState } from 'react';

/**
 * `kyc_level` is minted as a `+`-joined token list — see `kycLevel()` in the backend's
 * `passport.state.ts`. Each token names a check that PASSED, and each check was run against the
 * authority that issued the document, so the token can be rendered as that authority.
 *
 * Naming the authority rather than the check is the point. "GOV_DOC" means nothing to somebody
 * deciding whether to trust a stranger; "a government identity document was checked with its
 * issuer" is a sentence they can weigh. The mapping is deliberately conservative — India's
 * corridor uses UIDAI and the income-tax database, Singapore's uses Singpass, and the credential
 * does not say which, so the label covers both rather than asserting one.
 */
const ASSURANCE: Record<
  string,
  { label: string; detail: string; icon: 'card' | 'face' | 'fingerprint' | 'bank' | 'screening' }
> = {
  GOV_DOC: {
    label: 'Government identity',
    detail: 'A government-issued document was checked with the authority that issued it.',
    icon: 'card',
  },
  LIVENESS: {
    label: 'Liveness',
    detail: 'They were confirmed to be a real person present at enrolment, not a photograph.',
    icon: 'fingerprint',
  },
  FACE_MATCH: {
    label: 'Face match',
    detail: 'Their face was matched against the photograph on their identity document.',
    icon: 'face',
  },
  BANK_ACCOUNT: {
    label: 'Bank account',
    detail: 'A bank confirmed this name holds the account.',
    icon: 'bank',
  },
  SANCTIONS: {
    label: 'Sanctions screening',
    detail: 'Screened against global sanctions and politically-exposed-person lists.',
    icon: 'screening',
  },
};

export function PeerIdentityCard({ verdict }: { verdict: PeerCheckVerdict }) {
  const p = usePalette();
  const bandInk = useBand();
  const [width, setWidth] = useState(0);

  const claims = verdict.claims;
  const given = text(claims.given_name);
  const family = text(claims.family_name);
  const fullName = [given, family].filter(Boolean).join(' ').trim();

  const band = text(claims.score_band) as ScoreBand | '';
  const bandLabel = band && band in SCORE_BAND_META ? SCORE_BAND_META[band].label : null;
  const scoreValue = number(claims.score_value);
  const confidence = number(claims.confidence);
  const nationality = text(claims.nationality);
  const pravaahId = text(claims.pravaah_id);
  const asOf = text(claims.score_as_of);

  const assurances = text(claims.kyc_level)
    .split('+')
    .map((token) => ASSURANCE[token])
    .filter((entry): entry is (typeof ASSURANCE)[string] => !!entry);

  return (
    <View style={styles.stack}>
      {/* The plate. Same intaglio field as the holder's own passport, because what is being
          shown IS their passport — read out by somebody else, with their permission. */}
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={[styles.plate, { backgroundColor: p.field }]}
      >
        <CornerMedallion size={150} top={-34} right={-40} opacity={0.3} />

        <View style={styles.plateBody}>
          <Legend small surface="field" tone="dim">
            Verified holder
          </Legend>

          <View style={styles.identity}>
            <Monogram given={given} family={family} />
            <View style={styles.names}>
              {/* Capped at two lines and never truncated mid-name: this is the string the
                  scanner is matching against the person in front of them. */}
              <Text role="denominationSm" surface="field" numberOfLines={2}>
                {fullName || 'Name not shared'}
              </Text>
              {nationality ? (
                <Micro surface="field" tone="dim">
                  {nationality}
                </Micro>
              ) : null}
            </View>
          </View>

          <Rule onField />

          {/* The reputation. Band and number are separate facts and are shown separately,
              because a holder may share one without the other — and a band with no number
              is a complete answer, not a partial one. */}
          <View style={styles.reputation}>
            <View style={styles.repBlock}>
              <Legend small surface="field" tone="dim">
                Reputation
              </Legend>
              {bandLabel ? (
                <View style={styles.bandRow}>
                  {/* The band's own ink, on a wash, so the tier reads at a glance without
                      the plate acquiring a second accent colour. */}
                  <View
                    style={[styles.bandTag, { borderColor: bandInk(band) }]}
                  >
                    <Text role="bodySmMedium" tone="inherit" style={{ color: bandInk(band) }}>
                      {bandLabel}
                    </Text>
                  </View>
                </View>
              ) : (
                <Micro surface="field" tone="dim">
                  Not shared
                </Micro>
              )}
            </View>

            <View style={[styles.repBlock, styles.repRight]}>
              <Legend small surface="field" tone="dim">
                Score
              </Legend>
              {scoreValue != null ? (
                <Text role="valueSm" surface="field" tone="latent">
                  {scoreValue}
                </Text>
              ) : (
                <Micro surface="field" tone="dim">
                  Not shared
                </Micro>
              )}
            </View>
          </View>

          {/* Confidence sits with the score rather than in a separate panel, because it is
              not decoration: a 780 at 0.31 confidence and a 780 at 0.92 are different facts,
              and separating them invites reading only the first. */}
          {confidence != null || asOf ? (
            <Micro surface="field" tone="dim">
              {[
                confidence != null
                  ? `${Math.round(confidence * 100)}% confidence`
                  : null,
                asOf ? `data to ${formatDate(asOf)}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Micro>
          ) : null}

          {pravaahId ? (
            <View style={styles.serialRow}>
              <Legend small surface="field" tone="dim">
                Pravaah ID
              </Legend>
              <Text
                role="fieldSm"
                surface="field"
                selectable
                maxFontSizeMultiplier={1.1}
              >
                {pravaahId}
              </Text>
            </View>
          ) : null}
        </View>

        {width > 0 ? (
          <View style={styles.band} pointerEvents="none">
            <GuillocheBand width={width} height={20} lines={7} opacity={0.26} />
          </View>
        ) : null}
      </View>

      {/* Who actually checked them. Off the plate, on rag — these are facts ABOUT the
          credential's provenance rather than fields printed on the document. */}
      {assurances.length ? (
        <View style={styles.assurance}>
          <Legend small tone="dim">
            Checked by
          </Legend>
          {assurances.map((entry) => (
            <View key={entry.label} style={styles.assuranceRow}>
              <Icon name={entry.icon} size={17} color={p.latent} weight={1.5} />
              <View style={styles.assuranceText}>
                <Text role="bodySmMedium">{entry.label}</Text>
                <Micro tone="dim">{entry.detail}</Micro>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   The monogram
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Initials in an engraved medallion, standing where a portrait would.
 *
 * It is drawn from the DISCLOSED names, so a holder who shared no name gets a neutral mark
 * rather than a letter invented from somewhere else. Deliberately not a coloured avatar keyed
 * to a name hash: a generated colour looks like identity and carries none, and on a document
 * that is exactly the wrong impression to give.
 */
function Monogram({ given, family }: { given: string; family: string }) {
  const p = usePalette();
  const initials = `${given.charAt(0)}${family.charAt(0)}`.toUpperCase().trim();

  return (
    <View
      // One object to assistive tech, and described rather than spelled out — a screen
      // reader announcing "A S" beside the full name is noise.
      accessible
      accessibilityRole="image"
      accessibilityLabel={
        initials ? 'Initials, shown in place of a photograph' : 'No photograph available'
      }
      style={[styles.monogram, { borderColor: p.onFieldLatent }]}
    >
      {initials ? (
        <Text role="denominationSm" surface="field" tone="latent">
          {initials}
        </Text>
      ) : (
        <Icon name="passport" size={24} color={p.onFieldLatent} weight={1.4} />
      )}
    </View>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Claim readers
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Claims arrive as `unknown` and that is not pedantry.
 *
 * The values come out of a credential minted by a possibly-older issuer version, decoded from
 * base64url JSON. A `score_value` that arrives as a string, or a `kyc_level` that arrives as
 * null, must render as "not shared" rather than crash the one screen somebody is looking at
 * while a stranger waits.
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // A numeric string is accepted: JSON round-trips through the disclosure encoding, and
  // refusing a "780" that is merely quoted would drop a claim the holder did share.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

const styles = StyleSheet.create({
  stack: { gap: Space.xl },
  plate: { borderRadius: Radius.lg, overflow: 'hidden' },
  plateBody: {
    paddingHorizontal: Space.xl,
    paddingTop: Space.xl,
    // Room for the guilloche band along the base.
    paddingBottom: Space.xxxl,
    gap: Space.lg,
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: Space.lg },
  monogram: {
    width: 60,
    height: 60,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  names: { flex: 1, gap: 2 },

  reputation: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: Space.lg,
  },
  repBlock: { gap: Space.xs, flexShrink: 1 },
  repRight: { alignItems: 'flex-end' },
  bandRow: { flexDirection: 'row' },
  bandTag: {
    borderWidth: 1,
    borderRadius: Radius.sm,
    paddingHorizontal: Space.sm,
    paddingVertical: 3,
  },

  serialRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  band: { position: 'absolute', left: 0, right: 0, bottom: 0 },

  assurance: { gap: Space.md },
  assuranceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  assuranceText: { flex: 1, gap: 1 },
});
