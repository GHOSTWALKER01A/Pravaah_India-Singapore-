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
import { formatDateTime } from '@/helper/date-convertor';
import { passportService } from '@/lib/api/passport/passport.service';

/**
 * The issuer keys — Pravaah's trust anchor, and our analogue of the ICAO Public Key Directory.
 *
 * This page exists because of one property: a lender in Singapore trusts a Pravaah passport
 * by fetching our public key from a resolvable `did:web` and checking the signature
 * themselves. No agreement, no integration, no call to us at presentation time. Everything
 * here protects that.
 *
 * The rule an operator must understand before pressing Rotate: rotated keys are NOT deleted.
 * They stay in the DID document and JWKS until every credential they signed has expired,
 * because removing a public key breaks every credential it signed — rotation without that
 * guarantee is a mass revocation with extra steps. The `credentialCount` column is what makes
 * that visible.
 */
export default function IssuerKeysPage() {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['issuer-keys'],
    queryFn: () => passportService.listKeys(),
  });

  const rotate = useMutation({
    mutationFn: () => passportService.rotateKey(),
    onSuccess: (result) => {
      toast.success(`New signing key: ${result.kid}`);
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ['issuer-keys'] });
    },
    onError: (caught: Error) => toast.error(caught.message),
  });

  const active = data?.find((key) => key.isActive);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Issuer keys</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            The keys that sign every passport, published at{' '}
            <code className="text-xs">/.well-known/did.json</code> and{' '}
            <code className="text-xs">/.well-known/jwks.json</code>. This is what lets a
            verifier abroad check a credential without ever contacting us.
          </p>
        </div>
        {!confirming && (
          <Button variant="outline" onClick={() => setConfirming(true)}>
            Rotate signing key
          </Button>
        )}
      </div>

      {confirming && (
        <div className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <h2 className="text-sm font-medium">Rotate the signing key?</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            A new key starts signing immediately. Existing passports keep working: the current
            key stays published until the last credential it signed expires, so nothing already
            in the wild is invalidated. That is what makes this safe to press during an
            incident.
          </p>
          <div className="mt-3 flex gap-2">
            <Button disabled={rotate.isPending} onClick={() => rotate.mutate()}>
              {rotate.isPending ? 'Rotating…' : 'Rotate'}
            </Button>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {active && (
        <div className="mt-6 rounded-lg border border-black/10 p-4 dark:border-white/10">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">
            Currently signing
          </p>
          <p className="mt-1 break-all font-mono text-sm">{active.kid}</p>
          <p className="text-muted-foreground mt-1 break-all font-mono text-xs">
            thumbprint {active.thumbprint}
          </p>
        </div>
      )}

      {isLoading && (
        <p className="text-muted-foreground mt-6 text-sm">Loading…</p>
      )}
      {isError && (
        <p className="mt-6 text-sm text-red-600 dark:text-red-400">
          {(error as Error).message}
        </p>
      )}

      {data && data.length === 0 && (
        <p className="mt-6 text-sm text-red-600 dark:text-red-400">
          No issuer key exists. Passport issuance will fail until one is provisioned — the
          backend normally creates one at boot, so this means that failed.
        </p>
      )}

      {data && data.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key id</TableHead>
                <TableHead>Alg</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Signed</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Rotated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="max-w-xs break-all font-mono text-xs">
                    {key.kid}
                  </TableCell>
                  <TableCell className="text-xs">{key.alg}</TableCell>
                  <TableCell
                    className={
                      key.retiredAt
                        ? 'text-zinc-500 dark:text-zinc-400'
                        : key.isActive
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-amber-600 dark:text-amber-400'
                    }
                  >
                    {key.retiredAt
                      ? 'retired'
                      : key.isActive
                        ? 'signing'
                        : 'published'}
                  </TableCell>
                  {/* The number that makes retirement safe to reason about: a key with live
                      credentials behind it must stay published. */}
                  <TableCell>{key.credentialCount}</TableCell>
                  <TableCell className="text-xs">
                    {formatDateTime(key.createdAt)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {key.rotatedAt ? formatDateTime(key.rotatedAt) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-muted-foreground mt-6 text-xs">
        A key is retired automatically once every credential it signed has expired, and only
        then does it drop out of the published key set. Retiring one earlier would leave live
        passports unverifiable — which reads to a verifier as a broken issuer rather than a
        revoked credential.
      </p>
    </div>
  );
}
