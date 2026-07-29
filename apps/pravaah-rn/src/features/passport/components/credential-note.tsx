import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ActivePassport } from '@/api';
import {
  CornerMedallion,
  GuillocheBand,
  Legend,
  Micro,
  Rule,
  Text,
} from '@/components/ui';
import { APP_NAME } from '@/constants/ui.constants';
import { Radius, Space, usePalette } from '@/theme';

/**
 * The credential, rendered as the note it is.
 *
 * Full-bleed intaglio: the field owns the region, the guilloche and medallion carry the
 * latent gold, the serial runs along the base in mono. This is not a status card reporting
 * "you have a credential" — it is the artefact, in the holder's hand, which is the premise
 * of M3.
 *
 * TYPOGRAPHY, because an earlier version of this file got it wrong in a way worth recording.
 * It set the DOCUMENT TITLE at `denomination` — 34pt Bodoni — and force-broke it across three
 * lines with `\n`. Two things went wrong at once:
 *
 *   1. A banknote's denomination is its VALUE, not its title. "Financial Reputation Passport"
 *      is the equivalent of the small engraved line reading "Bank of England"; the thing set
 *      large is the number. Here that value is the score BAND, which is one or two words and
 *      cannot wrap into a mess.
 *   2. Three lines of a role whose line box has 4pt of slack (34/38) overlapped each other
 *      the moment the OS font scale went above ~1.12 — which is a common setting, not an
 *      edge case. `Text` now scales `lineHeight` with the font scale, so wrapping is safe;
 *      but the structural fix is not needing three lines of display type at all.
 *
 * The band is therefore the hero, the document type is a modest line beneath the issuing
 * legend, and nothing on the note is force-broken.
 *
 * What is deliberately NOT printed: the exact score. The band is the strongest thing a
 * surface this photographable should carry, and the number is the one figure the credential
 * goes to such lengths to keep selectively disclosable.
 */
export function CredentialNote({ passport }: { passport: ActivePassport }) {
  const p = usePalette();
  // Measured, not guessed — the same reason the M0 passport card measures: a hard-coded width
  // throws away generated geometry on a small phone and leaves a tablet's edge bare.
  const [width, setWidth] = useState(0);

  const expiring = passport.daysRemaining <= 14;
  const suspended = passport.status === 'SUSPENDED';

  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.note, { backgroundColor: p.field }]}
    >
      {/* Engraved ground: the medallion sits behind the content, the band along the base. */}
      <CornerMedallion size={150} top={-34} right={-40} opacity={0.3} />

      <View style={styles.body}>
        {/* The issuing line. ONE legend for this region, as the note's grammar requires. */}
        <View style={styles.masthead}>
          <Legend>{APP_NAME}</Legend>
          <Text role="bodySmMedium" surface="field" tone="dim" style={styles.docType}>
            Financial Reputation Passport
          </Text>
        </View>

        {/* The denomination — the note's value. One or two words, so it cannot wrap badly;
            capped at two lines regardless, because a long band name must never push the
            serial off the note. */}
        <View style={styles.denomination}>
          <Text
            role="denomination"
            surface="field"
            numberOfLines={2}
            style={styles.band}
          >
            {passport.scoreBand ? bandLabel(passport.scoreBand) : 'Not scored'}
          </Text>
          <Micro surface="field" tone="dim">
            {passport.dataRails.join(' · ')}
            {passport.passportBound ? ' · passport-bound' : ''}
          </Micro>
        </View>

        <Rule onField />

        {/* The base field grid: the two facts a verifier reads off the note by eye. */}
        <View style={styles.footer}>
          <View style={styles.serialBlock}>
            <Legend small>Serial</Legend>
            {/* Never truncated: this is the number a holder reads aloud to a lender, so an
                ellipsis in the middle would make the document unusable. It is allowed to
                take a second line at a large font scale instead. */}
            <Text role="serial" surface="field" style={styles.serial}>
              {passport.credentialNumber}
            </Text>
          </View>
          <View style={styles.validBlock}>
            <Legend small>Valid until</Legend>
            <Micro surface="field" tone={expiring ? 'carmine' : 'dim'}>
              {formatDate(passport.expiresAt)}
            </Micro>
          </View>
        </View>

        {suspended ? (
          <Micro surface="field" tone="carmine">
            On hold — this passport cannot be shared until the hold is lifted.
          </Micro>
        ) : expiring ? (
          <Micro surface="field" tone="carmine">
            {passport.daysRemaining === 0
              ? 'Expires today. Refresh it before you next need it.'
              : `Expires in ${passport.daysRemaining} ${passport.daysRemaining === 1 ? 'day' : 'days'}. Refresh it before you next need it.`}
          </Micro>
        ) : null}
      </View>

      {width > 0 ? (
        <View style={styles.guilloche} pointerEvents="none">
          <GuillocheBand width={width} height={20} lines={7} opacity={0.26} />
        </View>
      ) : null}
    </View>
  );
}

/** `VERY_GOOD` → `Very good`. Sentence case, because it is read as a word, not a constant. */
function bandLabel(band: string): string {
  const words = band.split('_');
  return words
    .map((word, index) =>
      index === 0
        ? word.charAt(0) + word.slice(1).toLowerCase()
        : word.toLowerCase(),
    )
    .join(' ');
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

const styles = StyleSheet.create({
  note: {
    borderRadius: Radius.lg,
    overflow: 'hidden',
    // The note bleeds past the screen gutter, because an object you hold is not inset from
    // the edge of the room.
    marginHorizontal: -Space.lg,
  },
  // Deliberately NOT a uniform gap. The masthead and the denomination belong together as one
  // block; the footer is a separate register and gets the larger space above it via the rule.
  body: {
    paddingHorizontal: Space.xl,
    paddingTop: Space.xl,
    // Room for the guilloche band along the base, so it never sits under the serial.
    paddingBottom: Space.xxxl,
    gap: Space.lg,
  },
  masthead: { gap: 2 },
  docType: { letterSpacing: 0.3 },
  denomination: { gap: 2 },
  // No lineHeight override here. Pinning one is what broke this component before — `Text`
  // now scales the role's own line box with the OS font size.
  band: { marginRight: Space.xxxl },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: Space.lg,
  },
  // `flexShrink` on the serial and not the date: if something has to give at a large font
  // scale, the serial wraps to two lines and the date stays whole.
  serialBlock: { flexShrink: 1 },
  serial: { letterSpacing: 1 },
  validBlock: { alignItems: 'flex-end', flexShrink: 0 },
  guilloche: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
