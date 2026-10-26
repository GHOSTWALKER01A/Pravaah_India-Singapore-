import { useEffect, useState } from 'react';

import { passportService } from '@/api';

/**
 * Human labels for claim keys, from the backend's claim catalogue.
 *
 * A receipt stores withheld claims as bare keys (`birth_date`), and the catalogue is the
 * one place their labels live — bundling a copy would drift the day the catalogue grows.
 * Cached for the process lifetime: the catalogue changes with a deploy, not per request.
 *
 * Never blocks rendering. Until (or unless) the catalogue arrives, `labelFor` humanises the
 * key, so an offline holder still reads "Birth date" rather than an empty row.
 */
let cache: Record<string, string> | null = null;
let inflight: Promise<Record<string, string>> | null = null;

function fetchLabels(): Promise<Record<string, string>> {
  inflight ??= passportService
    .claims()
    .then((catalogue) => {
      cache = Object.fromEntries(catalogue.claims.map((c) => [c.claim, c.label]));
      return cache;
    })
    .catch(() => {
      // Retry on the next mount rather than caching the failure.
      inflight = null;
      return {};
    });
  return inflight;
}

export function useClaimLabels(): (claim: string) => string {
  const [labels, setLabels] = useState<Record<string, string>>(cache ?? {});

  useEffect(() => {
    if (cache) return;
    let alive = true;
    void fetchLabels().then((next) => {
      if (alive) setLabels(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (claim: string) => labels[claim] ?? humanise(claim);
}

/** `score_at_least_good` → `Score at least good`. The last resort, never the first. */
function humanise(claim: string): string {
  const words = claim.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : claim;
}
