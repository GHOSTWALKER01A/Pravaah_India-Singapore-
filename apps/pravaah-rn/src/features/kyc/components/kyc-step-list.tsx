/**
 * The verification checks, on the security thread.
 *
 * Was: a `gap: 8` stack of `StepRow` cards, each a filled rounded rectangle with a
 * title, a subtitle and a status pill. Six identical boxes, which said nothing
 * about the fact that these are a SEQUENCE where each step's meaning depends on
 * the ones before it.
 *
 * The thread says it: one unbroken line, impressed in gold as far as the user has
 * got, hairline beyond. It also shows the checks the user has NOT reached yet,
 * which the incumbent could not — it only rendered `status.checks`, the attempted
 * ones, so the list grew as you went and you could never see what was still ahead.
 */
import { StyleSheet, View } from 'react-native';

import type { CheckStatus, KycProfileStatus } from '@/api';
import { Micro, Text, Thread, ThreadStep, statusMeta } from '@/components/ui';
import { STATUS_TONE, Space } from '@/theme';
import type { StatusTone } from '@/theme';

import { CHECK_META } from '../check-labels';
import { REQUIRED_CHECKS, checkStatusOf, nextCheck } from '../flow';

export function KycStepList({ status }: { status: KycProfileStatus }) {
  const required = REQUIRED_CHECKS[status.country];
  const pending = nextCheck(status);
  const liveIndex = pending ? required.indexOf(pending) : required.length;

  return (
    <Thread>
      {required.map((type, i) => {
        const state: CheckStatus | undefined = checkStatusOf(status, type);
        const meta = CHECK_META[type];
        const position = i < liveIndex ? 'done' : i === liveIndex ? 'live' : 'ahead';

        // A step the user has not reached has no API status at all. It is not
        // "pending" — nothing is happening — so it reads as not yet attempted.
        const tone: StatusTone = state ? statusMeta(state).tone : 'neutral';

        return (
          <ThreadStep
            key={type}
            tone={tone}
            shape={STATUS_TONE[tone]}
            position={position}
            live={state === 'PENDING'}
            last={i === required.length - 1}
          >
            {/* No status mark here: the seal is already ON the thread beside this
                row. Repeating it would be the same information twice, and the
                second copy would be the one carrying no shape distinction. */}
            <View style={styles.body}>
              <Text role="title" tone={position === 'ahead' ? 'faint' : 'default'}>
                {meta?.label ?? type}
              </Text>
              <Micro tone={position === 'ahead' ? 'faint' : 'dim'}>
                {state ? statusMeta(state).label : meta?.subtitle}
              </Micro>
            </View>
          </ThreadStep>
        );
      })}
    </Thread>
  );
}

const styles = StyleSheet.create({
  body: { gap: Space.xs / 2 },
});
