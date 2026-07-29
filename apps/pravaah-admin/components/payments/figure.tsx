/**
 * An operational count, with its tone derived from whether the number represents WORK.
 *
 * Only two tones, deliberately. On this console a figure is either "nothing to do" or "somebody has
 * to do something", and a five-colour severity scale would invite a reader to decide that amber is
 * the normal state — which is how a queue of held payments becomes background noise. There is no
 * `bad` tone here either: a genuine alarm (a broken trial balance) is a banner with a sentence, not
 * a number in a box.
 */
export function Figure({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: 'ok' | 'warn';
}) {
  return (
    <div
      className={`rounded-md border p-4 ${
        tone === 'warn'
          ? 'border-amber-500/60 bg-amber-50/50 dark:bg-amber-950/20'
          : 'border-black/10 dark:border-white/10'
      }`}
    >
      <div className="text-muted-foreground text-xs tracking-wide uppercase">
        {label}
      </div>
      <div
        className={`mt-1 font-mono text-2xl ${
          tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : ''
        }`}
      >
        {value}
      </div>
      <p className="text-muted-foreground mt-1 text-xs">{detail}</p>
    </div>
  );
}
