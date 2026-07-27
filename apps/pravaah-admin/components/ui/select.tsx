import * as React from 'react';

import { cn } from '@/lib/utils/utils';

/**
 * Native `<select>`, themed.
 *
 * A native element rather than a Radix listbox on purpose: these are short filter
 * lists, and the native control gets keyboard handling, type-ahead, and mobile
 * pickers for free. What it does NOT get for free is theming, which is why this
 * exists rather than five copies of a class string.
 *
 * Two things here are load-bearing:
 *
 *  - **`bg-background`, not `bg-transparent`.** A transparent select shows the page
 *    through it, which looks fine until it sits on a card and reads as unstyled.
 *  - **The `<option>` popup is painted by the OS**, so it ignores these classes
 *    entirely. That is handled globally — `color-scheme` on `:root`/`.dark` plus an
 *    explicit `select option` rule in `globals.css`. Both are needed: `color-scheme`
 *    is the correct standards-based fix, and the explicit rule covers Chrome on
 *    Windows, which paints the list from the page's colours regardless.
 *
 * `appearance-none` plus a background-image caret keeps the arrow consistent
 * across platforms; the native arrow is drawn in the OS accent colour and clashes.
 */
function Select({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'border-input bg-background text-foreground h-9 w-full appearance-none rounded-md border py-2 pr-9 pl-3 text-sm',
        'transition-colors',
        'hover:bg-accent/40',
        'focus-visible:border-ring focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // Caret drawn with currentColor so it follows the theme, unlike the native
        // arrow which uses the OS accent colour.
        "bg-[image:var(--select-caret)] bg-[length:0.7rem] bg-[position:right_0.75rem_center] bg-no-repeat",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export { Select };
