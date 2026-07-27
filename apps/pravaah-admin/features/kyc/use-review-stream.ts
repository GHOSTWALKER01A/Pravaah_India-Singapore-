'use client';

import { useEffect } from 'react';

/**
 * Subscribes to the backend's Server-Sent Events review stream and calls
 * `onEvent` whenever a case is opened/claimed/resolved on any API instance
 * (fanned out via Redis pub/sub). EventSource can't set headers, so the admin
 * token is passed as `?access_token=` — the backend JwtStrategy accepts it.
 *
 * Degrades gracefully: with no token/URL it does nothing, and EventSource
 * auto-reconnects on transient drops. This layers on top of the normal query
 * refetch — it never replaces it, so a cache/Redis outage just means updates
 * arrive on the next manual refresh instead of instantly.
 */
export function useReviewStream(onEvent: () => void): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return;
    }
    const base = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '');
    const token = localStorage.getItem('accessToken');
    if (!base || !token) return;

    const url = `${base}/api/v1/admin/kyc/stream?access_token=${encodeURIComponent(token)}`;
    const source = new EventSource(url);
    source.onmessage = () => onEvent();
    // On error EventSource reconnects on its own; nothing to do here.

    return () => source.close();
  }, [onEvent]);
}
