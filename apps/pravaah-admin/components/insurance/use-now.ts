'use client';

import { useEffect, useState } from 'react';

/**
 * The current time, as a value that is stable during a render and refreshed on a tick.
 *
 * ## Why this exists rather than `Date.now()` at the call site
 *
 * React Compiler refuses an impure call during render, and it is right to: a component that reads
 * the clock while rendering produces a different tree on every re-render for reasons unrelated to
 * its props, which breaks memoization and makes the output unstable.
 *
 * The naive fix is to capture the clock once on mount. That is wrong for THIS use: the claim queue
 * shows how long each claim has been waiting, tones it amber past 24 hours and red past 48, and an
 * operator may leave the tab open for an afternoon. A frozen clock would leave a claim reading
 * "22h" for hours after it crossed the threshold that makes it a service failure.
 *
 * So the clock lives in state and advances on an interval. During any single render it is a plain
 * value; between renders it moves. The default cadence matches the queue's own `refetchInterval`,
 * so the age and the data it describes refresh together rather than drifting apart.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

/**
 * Hours between an ISO timestamp and `now`.
 *
 * Takes `now` as an argument rather than reading the clock itself, so it stays pure and the caller
 * owns the cadence. That is what lets one `useNow()` drive every row of a table instead of each
 * row starting its own timer.
 */
export function hoursSince(iso: string, now: number): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return (now - then) / 3_600_000;
}

/**
 * Hours → something a person reads at a glance.
 *
 * Under a day in hours, beyond that in days. "73h" makes a reader do arithmetic on a screen whose
 * whole purpose is spotting the claim that has waited too long.
 */
export function formatAge(hours: number): string {
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The same, spelled out. For a detail page where there is room for words. */
export function formatAgeLong(hours: number): string {
  if (hours < 1) return 'less than an hour';
  if (hours < 24) return `${Math.floor(hours)} hours`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}
