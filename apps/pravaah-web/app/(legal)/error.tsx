"use client";

import type { ReactElement } from "react";

import { Container } from "@/ui/layout/Container";
import { Button } from "@/ui/primitives/Button";
import { Legend } from "@/ui/primitives/Legend";

export default function LegalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactElement {
  return (
    <section className="bg-rag py-28 sm:py-36">
      <Container>
        <div className="max-w-xl">
          <Legend className="text-carmine">Document unavailable</Legend>
          <h1 className="denomination mt-7 text-4xl text-intaglio-deep sm:text-5xl">
            This document failed to load.
          </h1>
          <p className="mt-6 text-base leading-relaxed text-intaglio">
            The terms that apply to you are the ones published here, so a page
            that will not render is a real problem — not a cosmetic one. Try
            again, and if it persists, treat the document as unread and ask us
            for a copy.
          </p>
          <Button onClick={reset} className="mt-10">
            Try again
          </Button>
        </div>
      </Container>
    </section>
  );
}
