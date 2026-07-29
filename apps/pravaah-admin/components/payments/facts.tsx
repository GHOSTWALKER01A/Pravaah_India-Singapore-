/**
 * A labelled fact table.
 *
 * The default for a set of particulars, rather than a card grid. A payment has thirty-odd attributes
 * an operator scans for one specific value, and cards optimise for the opposite — drawing the eye to
 * a few figures. A dense `<dl>` with a fixed left rail is scannable by label, which is how somebody
 * looking for "UTR" actually reads this screen.
 *
 * Values are monospace and right-aligned so identifiers, timestamps and amounts all align on their
 * own edge; `break-words` because a rail reference has no spaces and would otherwise force the page
 * to scroll sideways.
 */
export function Facts({
  title,
  rows,
}: {
  title: string;
  rows: readonly (readonly [string, string])[];
}) {
  return (
    <div className="rounded-md border border-black/10 dark:border-white/10">
      <div className="border-b border-black/10 px-4 py-2 text-sm font-semibold dark:border-white/10">
        {title}
      </div>
      <dl className="divide-y divide-black/5 dark:divide-white/5">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-4 px-4 py-2"
          >
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="max-w-[60%] break-words text-right font-mono text-xs">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
