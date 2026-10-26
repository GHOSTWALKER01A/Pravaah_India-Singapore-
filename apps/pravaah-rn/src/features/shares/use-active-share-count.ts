import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { sharesService } from '@/api';

/**
 * How many organisations currently hold something the holder shared.
 *
 * One `limit=1` call — only `total` is read. Refreshed on focus, so coming back from a
 * withdrawal updates the wallet's count. `null` means "unknown" (loading, offline, or a
 * backend without M7), and callers render neutral copy rather than a wrong zero.
 */
export function useActiveShareCount(): number | null {
  const [count, setCount] = useState<number | null>(null);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void sharesService
        .list({ status: 'ACTIVE', limit: 1 })
        .then((page) => {
          if (alive) setCount(page.total);
        })
        .catch(() => {
          if (alive) setCount(null);
        });
      return () => {
        alive = false;
      };
    }, []),
  );

  return count;
}
