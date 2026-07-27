/**
 * A screen's opening.
 *
 * The incumbent repeated this block by hand on nine screens:
 *
 *     <View style={styles.header}>
 *       <ThemedText type="small" style={styles.eyebrow}>IDENTITY VERIFICATION</ThemedText>
 *       <ThemedText type="title">Get verified</ThemedText>
 *       <ThemedText type="small" themeColor="textSecondary">…</ThemedText>
 *     </View>
 *
 * with `styles.eyebrow` copy-pasted into each file. Two things were wrong beyond
 * the duplication: `type="title"` is 48/52, which overflows a 360dp screen inside
 * a gutter, and a tracked uppercase eyebrow over EVERY section is the grammar the
 * craft floor names explicitly — one named kicker is a system, an eyebrow
 * everywhere is a tic.
 *
 * So `legend` is optional here and used only where the region genuinely has an
 * issuing authority to name (the corridor, the aggregator, the model). Most
 * screens pass a title and a lede and nothing else.
 */
import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Space } from '@/theme';

import { Legend, Text } from './text';

export function Header({
  legend,
  title,
  lede,
  /** A control that belongs to the title line — a status seal, a count. */
  aside,
  children,
}: {
  legend?: string;
  title: string;
  lede?: string;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      {legend ? (
        <Legend tone="latent" style={styles.legend}>
          {legend}
        </Legend>
      ) : null}

      <View style={styles.titleRow}>
        <Text
          role="denomination"
          style={styles.title}
          // A screen title is the heading of its screen, and a screen reader
          // should be able to jump to it.
          accessibilityRole="header"
        >
          {title}
        </Text>
        {aside}
      </View>

      {lede ? (
        <Text role="body" tone="dim" style={styles.lede}>
          {lede}
        </Text>
      ) : null}

      {children}
    </View>
  );
}

/** A heading inside a screen, with more space above it than below — always. */
export function SectionHead({
  title,
  detail,
  aside,
}: {
  title: string;
  detail?: string;
  aside?: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.titleRow}>
        <Text role="heading" style={styles.flex} accessibilityRole="header">
          {title}
        </Text>
        {aside}
      </View>
      {detail ? (
        <Text role="bodySm" tone="dim">
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: Space.sm },
  legend: { marginBottom: Space.xs },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  title: { flex: 1 },
  // Held near a comfortable measure. A lede that runs the full width of a tablet
  // sheet is a paragraph nobody finishes.
  lede: { maxWidth: 480 },
  section: { gap: Space.xs },
  flex: { flex: 1 },
});
