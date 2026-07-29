/**
 * Query-string building for the payments services.
 *
 * Six near-identical copies of this loop were spread across the service classes, and they were not
 * quite identical — which is the actual problem. Some skipped `''`, some did not; one skipped
 * `undefined` only. A filter that silently became `?status=` on one screen and was omitted on
 * another is a difference nobody would notice until a list came back wrong.
 */

/**
 * Build a `?a=1&b=2` suffix, omitting anything the server should not receive.
 *
 * Omits `undefined`, `null` and `''` — an empty filter means "no filter", and sending `?status=`
 * asks the backend to validate an empty string against an enum, which is a 400 rather than the
 * unfiltered list the user asked for. `false` and `0` are kept: both are meaningful values, and a
 * truthiness check here would drop `offset=0` and quietly re-page the caller to wherever the
 * server's default lands.
 */
export function toQuery(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}
