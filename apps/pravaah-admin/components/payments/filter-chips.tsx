'use client';

import { cn } from '@/lib/utils/utils';

/**
 * A row of single-select filter chips.
 *
 * The reconciliation and dispute queues had identical copies of this markup, including the same
 * long conditional class string. Two copies of a selected-state style is how one queue ends up with
 * a filter that does not look selected.
 *
 * Generic over the key so a caller keeps its own union — `Outcome | 'ALL'`, `Tab` — rather than
 * widening to `string` at the boundary and losing the exhaustiveness it had.
 */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  /** Right-aligned, for a count or a loading note. */
  trailing,
}: {
  options: readonly { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.map((option) => (
        <button
          key={option.key}
          onClick={() => onChange(option.key)}
          aria-pressed={value === option.key}
          className={cn(
            'rounded-full border px-3 py-1 text-xs transition-colors',
            value === option.key
              ? 'border-transparent bg-black/85 text-white dark:bg-white/90 dark:text-black'
              : 'border-black/15 text-zinc-600 hover:bg-black/5 dark:border-white/15 dark:text-zinc-400 dark:hover:bg-white/5',
          )}
        >
          {option.label}
        </button>
      ))}
      {trailing ? <span className="ml-auto">{trailing}</span> : null}
    </div>
  );
}
