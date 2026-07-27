import type { LivenessGesture } from '@/api';
import type { IconName } from '@/components/ui';

/**
 * Label, glyph and instruction for each liveness gesture the backend can
 * challenge with.
 *
 * The glyphs were emoji (👁️ ⬅️ ➡️ 🙂 ↕️). Two problems specific to this screen:
 * they were drawn at 40pt over a live camera feed, where a multi-colour emoji has
 * no contrast control at all against whatever the camera happens to be showing;
 * and ⬅️/➡️ render as plain arrows on some Android builds and as boxed arrows on
 * others, so "turn left" and "turn right" were not reliably distinguishable at a
 * glance — on the one screen where the user is holding the phone at arm's length
 * and has about a second to read the prompt.
 *
 * The engraved glyphs take a colour, so they are drawn in the same reversed-out
 * ink as the prompt text over the viewfinder.
 */
export const GESTURE_META: Record<
  LivenessGesture,
  { label: string; icon: IconName; instruction: string }
> = {
  BLINK: {
    label: 'Blink',
    icon: 'blink',
    instruction: 'Blink your eyes slowly, twice.',
  },
  TURN_LEFT: {
    label: 'Turn left',
    icon: 'turnLeft',
    instruction: 'Slowly turn your head to the left, then back to centre.',
  },
  TURN_RIGHT: {
    label: 'Turn right',
    icon: 'turnRight',
    instruction: 'Slowly turn your head to the right, then back to centre.',
  },
  SMILE: {
    label: 'Smile',
    icon: 'smile',
    instruction: 'Give a natural smile.',
  },
  NOD: {
    label: 'Nod',
    icon: 'nod',
    instruction: 'Nod your head gently up and down.',
  },
};
