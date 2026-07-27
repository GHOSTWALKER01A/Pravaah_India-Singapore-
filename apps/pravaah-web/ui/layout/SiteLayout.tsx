import type { ReactElement, ReactNode } from "react";

import { Footer } from "@/ui/layout/Footer";
import { Header } from "@/ui/layout/Header";

/**
 * Shared chrome for every public route. Route groups re-export this as their
 * default layout, so a page never mounts the header or footer itself.
 */
export function SiteLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <>
      <a
        href="#main"
        className="legend sr-only bg-intaglio px-5 py-3 text-reverse focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60]"
      >
        Skip to content
      </a>
      <Header />
      <main id="main" className="flex-auto">
        {children}
      </main>
      <Footer />
    </>
  );
}

export default SiteLayout;
