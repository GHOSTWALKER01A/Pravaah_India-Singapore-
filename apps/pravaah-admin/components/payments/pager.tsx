'use client';

import { Button } from '@/components/ui/button';

/**
 * Offset pagination controls.
 *
 * Extracted because the reconciliation and dispute queues carried byte-identical copies, and the
 * range arithmetic is the kind that is wrong in exactly one of two places forever: `page * size + 1`
 * for the lower bound, `min((page + 1) * size, total)` for the upper. Getting it right once beats
 * getting it right twice.
 *
 * Shows "No records" rather than "1–0 of 0" when empty. The range form is only meaningful when there
 * is a range.
 */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
  /** What is being counted, plural. "records", "disputes", "payments". */
  noun = 'records',
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  noun?: string;
}) {
  const first = page * pageSize + 1;
  const last = Math.min((page + 1) * pageSize, total);

  return (
    <div className="mt-4 flex items-center justify-between">
      <Button
        variant="outline"
        size="sm"
        disabled={page === 0}
        onClick={() => onPage(Math.max(0, page - 1))}
      >
        Previous
      </Button>
      <span className="text-muted-foreground text-xs">
        {total === 0
          ? `No ${noun}`
          : `${first}–${last} of ${total}`}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={(page + 1) * pageSize >= total}
        onClick={() => onPage(page + 1)}
      >
        Next
      </Button>
    </div>
  );
}
