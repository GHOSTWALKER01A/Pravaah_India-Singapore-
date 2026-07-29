'use client';

import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fraudAdminService } from '@/lib/api/fraud/fraud.service';
import type {
  ListEntityType,
  ListKind,
} from '@/lib/api/fraud/fraud.schema';

/**
 * `WATCH` first, and it is the safest thing on this page.
 *
 * Ordered by consequence ascending, so the least destructive option is the default and the
 * one that blocks every future customer from paying an address takes a deliberate change.
 */
const KINDS: { key: ListKind; label: string; detail: string }[] = [
  {
    key: 'WATCH',
    label: 'Watch',
    detail: 'Contributes a weighted signal. Never blocks on its own.',
  },
  {
    key: 'MULE',
    label: 'Mule',
    detail: 'Hard block. Use for an account confirmed to be forwarding illicit funds.',
  },
  {
    key: 'BLOCK',
    label: 'Block',
    detail: 'Hard block. A general refusal with a stated reason.',
  },
  {
    key: 'SANCTIONS',
    label: 'Sanctions',
    detail: 'Hard block. Only for a designation from a consolidated list.',
  },
];

const ENTITY_TYPES: { key: ListEntityType; label: string }[] = [
  { key: 'VPA', label: 'Payment address (VPA)' },
  { key: 'BENEFICIARY', label: 'Payee handle' },
  { key: 'MOBILE', label: 'Mobile number' },
  { key: 'IP', label: 'IP address' },
  { key: 'DEVICE', label: 'Device id' },
  { key: 'USER', label: 'Pravaah user id' },
];

/**
 * The watchlists, blocklists, mule registry and sanctions list.
 *
 * ## Why this page shows COUNTS and not entries
 *
 * There is no endpoint that returns the entries, deliberately. `valueHash` is a keyed HMAC and
 * it is the one value in M6 that could plausibly be brute-forced offline — a VPA is
 * `<name>@<one of ~20 handles>` and an Indian mobile is one of 10^10 with a known prefix
 * structure. Shipping the register to a browser would defeat the reason it is hashed at all,
 * and a leaked plaintext blocklist is also a roadmap telling every listed account that it is
 * known.
 *
 * So an analyst LISTS a specific identifier and can check a specific one. Nobody browses.
 *
 * ## Why adding takes plaintext
 *
 * The server hashes it. If the client supplied a hash, the client would choose the salt — so
 * two consoles would produce two different hashes for the same VPA and neither would ever match
 * a lookup. The salt is a server secret; only the server can compute the key.
 *
 * ## Why a hard listing needs a second click
 *
 * A `MULE`, `BLOCK` or `SANCTIONS` entry outlives the case that produced it and affects people
 * who are not party to it: listing a VPA blocks every future customer who tries to pay it. That
 * is not a one-click action, and the confirmation states who else it hits.
 */
export default function FraudListsPage() {
  const queryClient = useQueryClient();

  const [kind, setKind] = useState<ListKind>('WATCH');
  const [entityType, setEntityType] = useState<ListEntityType>('VPA');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [mode, setMode] = useState<'add' | 'remove'>('add');

  const summary = useQuery({
    queryKey: ['fraud-lists'],
    queryFn: () => fraudAdminService.lists(),
  });

  const reset = () => {
    setValue('');
    setReason('');
    setConfirming(false);
  };

  const add = useMutation({
    mutationFn: () =>
      fraudAdminService.addListEntry({ kind, entityType, value, reason }),
    onSuccess: () => {
      toast.success(`Added to the ${kind.toLowerCase()} list`);
      reset();
      void queryClient.invalidateQueries({ queryKey: ['fraud-lists'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: () =>
      fraudAdminService.removeListEntry({ kind, entityType, value, reason }),
    onSuccess: (result) => {
      /**
       * `removed: false` is not an error — it means nothing active matched.
       *
       * Reported as a warning rather than a success, because an analyst who believes they have
       * lifted a listing that is still live would stop looking for why a customer is blocked.
       */
      if (result.removed) {
        toast.success('Listing lifted');
      } else {
        toast.warning('No active listing matched that identifier');
      }
      reset();
      void queryClient.invalidateQueries({ queryKey: ['fraud-lists'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const isHard = kind !== 'WATCH';
  const incomplete = value.trim().length < 3 || reason.trim().length < 5;
  const busy = add.isPending || remove.isPending;
  const rows = summary.data ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Watchlists</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Listed identifiers are stored as keyed hashes, so the register cannot be
          browsed — only added to, checked, and lifted.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        {/* ── THE REGISTER, AS COUNTS ─────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="font-medium">Active listings</h2>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>List</TableHead>
                <TableHead>Kind of identifier</TableHead>
                <TableHead className="text-right">Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && !summary.isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-muted-foreground py-8 text-center text-sm"
                  >
                    Nothing listed yet.
                  </TableCell>
                </TableRow>
              ) : null}

              {rows.map((row) => (
                <TableRow key={`${row.kind}-${row.entityType}`}>
                  <TableCell>
                    <span
                      className={
                        row.kind === 'WATCH'
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-red-600 dark:text-red-400'
                      }
                    >
                      {row.kind}
                    </span>
                    {row.kind === 'WATCH' ? (
                      <span className="text-muted-foreground ml-2 text-[11px]">
                        signal only
                      </span>
                    ) : (
                      <span className="text-muted-foreground ml-2 text-[11px]">
                        hard block
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{row.entityType}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {row.count}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <p className="text-muted-foreground text-xs">
            An expired time-boxed listing is deactivated rather than deleted, so the
            record of who listed what and when survives an appeal.
          </p>
        </section>

        {/* ── ADD OR LIFT ─────────────────────────────────────────────────── */}
        <section className="space-y-3 rounded-lg border p-4">
          <div className="flex gap-2">
            <Button
              variant={mode === 'add' ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setMode('add');
                setConfirming(false);
              }}
            >
              Add a listing
            </Button>
            <Button
              variant={mode === 'remove' ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setMode('remove');
                setConfirming(false);
              }}
            >
              Lift a listing
            </Button>
          </div>

          <div className="space-y-1">
            <label htmlFor="list-kind" className="block text-xs font-medium">
              List
            </label>
            <select
              id="list-kind"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as ListKind);
                setConfirming(false);
              }}
              className="w-full rounded-md border bg-transparent p-2 text-sm"
            >
              {KINDS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            {/*
              The consequence of the selected kind, stated inline.

              The difference between WATCH and MULE is the difference between a weighted signal
              and refusing every future payment to an address. That is not obvious from a
              four-letter label, so it is spelled out at the moment of choosing.
            */}
            <p className="text-muted-foreground text-xs">
              {KINDS.find((option) => option.key === kind)?.detail}
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="list-entity" className="block text-xs font-medium">
              Kind of identifier
            </label>
            <select
              id="list-entity"
              value={entityType}
              onChange={(event) =>
                setEntityType(event.target.value as ListEntityType)
              }
              className="w-full rounded-md border bg-transparent p-2 text-sm"
            >
              {ENTITY_TYPES.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="list-value" className="block text-xs font-medium">
              Identifier
            </label>
            <input
              id="list-value"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setConfirming(false);
              }}
              placeholder="fraudster@ybl"
              className="w-full rounded-md border bg-transparent p-2 font-mono text-sm"
            />
            <p className="text-muted-foreground text-xs">
              Typed in full. It is hashed before it is stored — this console never sees
              the register.
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="list-reason" className="block text-xs font-medium">
              Reason
            </label>
            <textarea
              id="list-reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setConfirming(false);
              }}
              rows={3}
              placeholder={
                mode === 'add'
                  ? 'Which cases this identifier appeared in, and what was confirmed.'
                  : 'Why this listing no longer applies.'
              }
              className="w-full rounded-md border bg-transparent p-2 text-sm"
            />
          </div>

          {/*
            Two-step, and only for a HARD add.

            Lifting is safe (it restores normal service) and a WATCH entry blocks nothing, so
            neither needs a confirmation. A hard listing affects people who are not party to
            the case, and the confirmation is where that is said out loud.
          */}
          {confirming && mode === 'add' && isHard ? (
            <div className="space-y-2 rounded-md border border-red-500/50 bg-red-50 p-3 dark:bg-red-950/30">
              <p className="text-sm font-medium">
                This blocks every customer, not just this case.
              </p>
              <p className="text-muted-foreground text-xs">
                Any Pravaah user who tries to pay this identifier will be refused, with
                no explanation of why beyond &ldquo;not permitted&rdquo;. Lift it if the
                listing turns out to be wrong.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => add.mutate()}
                >
                  {add.isPending ? 'Adding…' : `Add to ${kind}`}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              className="w-full"
              variant={mode === 'remove' ? 'outline' : isHard ? 'destructive' : 'default'}
              disabled={incomplete || busy}
              onClick={() => {
                if (mode === 'remove') {
                  remove.mutate();
                  return;
                }
                if (isHard) {
                  setConfirming(true);
                  return;
                }
                add.mutate();
              }}
            >
              {mode === 'remove'
                ? remove.isPending
                  ? 'Lifting…'
                  : 'Lift this listing'
                : isHard
                  ? 'Add to the list…'
                  : add.isPending
                    ? 'Adding…'
                    : 'Add to the watchlist'}
            </Button>
          )}

          <p className="text-muted-foreground text-xs">
            Adding and lifting are both ADMIN or senior-reviewer actions, and both write an
            audit row naming you. The row records the kind and the reason, never the
            identifier.
          </p>
        </section>
      </div>
    </div>
  );
}
