/**
 * The drawer's alarm and notice tones, in one place, with the contrast worked out.
 *
 * These do NOT use `--destructive`, and that is deliberate rather than an oversight. In
 * this token set `--destructive` is a mid red in light mode but a DARK surface red in dark
 * mode (`oklch(0.396 0.141 25.723)`), which lands at roughly 2:1 against the sidebar's
 * `oklch(0.1286)` — an alarm nobody can read, in the theme that ships as the default. The
 * payments screens already reached the same conclusion and use explicit
 * `red-600 / dark:red-400`; the drawer follows them so money alarms look the same wherever
 * an operator meets them.
 *
 * Measured against the sidebar surface (`--sidebar`), light and dark:
 *
 *   ALARM_TEXT      red-600 on 0.985 → 4.6:1   ·  red-400 on 0.1286 → 7.3:1
 *   ALARM_CHIP      white on red-600 → 4.8:1   ·  same both themes
 *   NOTICE_CHIP     foreground on foreground/10 → 15.5:1  ·  6.8:1
 *
 * The chip is a SOLID fill rather than a tinted one because a 15% red wash puts the text
 * at 4.1:1 — under AA — and because a count that means money is stranded has earned the
 * louder treatment. It is only ever on screen when the number is non-zero.
 */

/** Alarm as text, on the sidebar surface. */
export const ALARM_TEXT = 'text-red-600 dark:text-red-400';

/** Alarm as a filled chip. `red-600` in both themes: white on `red-500` is only 3.8:1. */
export const ALARM_CHIP = 'bg-red-600 text-white';

/** A queue that is merely non-empty. Neutral on purpose — it competes with nothing. */
export const NOTICE_CHIP = 'bg-foreground/10 text-foreground';

/** Alarm as a small solid dot (a graphic, so the 3:1 non-text floor applies). */
export const ALARM_DOT = 'bg-red-600 dark:bg-red-400';

export const NOTICE_DOT = 'bg-muted-foreground';

/** A destructive control that stays neutral until intent is shown. */
export const DESTRUCTIVE_HOVER =
  'hover:bg-red-600/10 hover:text-red-600 dark:hover:bg-red-400/10 dark:hover:text-red-400';

/** A quiet alarm surface for the rail's ledger warning. */
export const ALARM_SURFACE = 'bg-red-600/10 dark:bg-red-400/10';
