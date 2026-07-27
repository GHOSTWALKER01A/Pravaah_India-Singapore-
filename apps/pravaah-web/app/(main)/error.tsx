"use client";

import type { ReactElement } from "react";

import { Container } from "@/ui/layout/Container";
import { Button } from "@/ui/primitives/Button";
import { Legend } from "@/ui/primitives/Legend";

export default function MainError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactElement {
  return (
    <section className="bg-rag py-28 sm:py-36">
      <Container>
        <div className="max-w-xl">
          <Legend className="text-carmine">Misprint</Legend>
          <h1 className="denomination mt-7 text-4xl text-intaglio-deep sm:text-5xl">
            This page didn&rsquo;t come off the press.
          </h1>
          <p className="mt-6 text-base leading-relaxed text-intaglio">
            Something failed while rendering. Nothing about your data was
            affected — this site holds none of it. Try again, and if it keeps
            failing the fault is ours, not yours.
          </p>
          <Button onClick={reset} className="mt-10">
            Try again
          </Button>
        </div>
      </Container>
    </section>
  );
}
