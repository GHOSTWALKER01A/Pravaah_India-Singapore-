import { StyleSheet, View } from 'react-native';

import { Icon, Micro, Text } from '@/components/ui';
import { Radius, Space, usePalette } from '@/theme';

import {
  countryLabel,
  partnerTypeLabel,
  retentionLabel,
} from '../share-meta';

export interface CounterpartyProps {
  name: string;
  /** The domain PRAVAAH verified at approval. Null for an organisation registered without one. */
  domain: string | null;
  type: string | null;
  country: string | null;
  /** False once PRAVAAH has suspended or revoked the organisation. */
  approved: boolean;
  trustLevel?: 'STANDARD' | 'HIGH';
  /** The retention promise — shown on the consent screen, before the holder decides. */
  retentionDays?: number;
}

/**
 * Who an organisation is — the anti-phishing half of every M7 screen.
 *
 * The DOMAIN is the load-bearing line. A display name is whatever the organisation
 * registered; the domain is the one PRAVAAH verified when an admin approved them, and it
 * is the thing a holder can check against the website or the letter in front of them. So
 * it gets its own row with the lock, rather than sitting in a subtitle.
 *
 * An organisation PRAVAAH has stopped vouching for is said so in carmine, in words. A
 * greyed-out name would be the kind of signal people learn to overlook.
 */
export function Counterparty({
  name,
  domain,
  type,
  country,
  approved,
  trustLevel,
  retentionDays,
}: CounterpartyProps) {
  const p = usePalette();
  const place = countryLabel(country);

  return (
    <View style={styles.block}>
      <View style={styles.head}>
        <Icon
          name={approved ? 'verify' : 'alert'}
          size={20}
          color={approved ? p.cleared : p.carmine}
          weight={1.6}
        />
        <View style={styles.headText}>
          <Text role="title">{name}</Text>
          <Micro tone="dim">
            {partnerTypeLabel(type)}
            {place ? ` · ${place}` : ''}
            {trustLevel === 'HIGH' ? ' · enhanced checks' : ''}
          </Micro>
        </View>
      </View>

      {domain ? (
        <View
          style={[styles.domain, { borderColor: p.rule, backgroundColor: p.groundSunk }]}
          accessible
          accessibilityLabel={`Verified website: ${domain}`}
        >
          <Icon name="lock" size={13} color={p.latent} weight={1.4} />
          <Text role="fieldSm" style={styles.domainText} numberOfLines={1}>
            {domain}
          </Text>
          <Micro tone="dim">verified by Pravaah</Micro>
        </View>
      ) : null}

      {!approved ? (
        <Micro tone="carmine">
          Pravaah no longer vouches for this organisation — it has been suspended or removed.
        </Micro>
      ) : null}

      {retentionDays !== undefined && approved ? (
        <View style={styles.promise}>
          <Icon name="clock" size={13} color={p.inkFaint} weight={1.3} />
          <Micro style={styles.promiseText}>
            They may keep what you share for {retentionLabel(retentionDays)}. After that,
            Pravaah deletes its copy — and you can withdraw sooner at any time.
          </Micro>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: Space.sm },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  headText: { flex: 1, gap: 1 },
  domain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.sm,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
  },
  // flexShrink, not flex: 1 — `flex: 1` is flexBasis 0 in Yoga and would squeeze the
  // domain to nothing beside the caption on a narrow phone.
  domainText: { flexShrink: 1 },
  promise: { flexDirection: 'row', gap: Space.sm, alignItems: 'flex-start' },
  promiseText: { flex: 1 },
});
