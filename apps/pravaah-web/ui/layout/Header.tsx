"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactElement } from "react";

import { buildOpenAppHref } from "@/lib/config/site";
import { NAV_ITEMS, ROUTES } from "@/lib/constants/routes";
import { cn } from "@/lib/utils";
import { GuillocheBand } from "@/ui/engraving/Guilloche";
import { Wordmark } from "@/ui/layout/Wordmark";
import { startSmoothScroll, stopSmoothScroll } from "@/ui/motion/SmoothScroll";

/**
 * The narrow-viewport menu carries more than the desktop bar: with the whole
 * panel available there is no reason to bury Privacy behind the footer.
 */
const MOBILE_NAV: ReadonlyArray<{
  label: string;
  href: string;
  emphasis?: boolean;
}> = [
  ...NAV_ITEMS,
  { label: "Privacy", href: ROUTES.LEGAL.PRIVACY },
  {
    label: "Get the app",
    href: buildOpenAppHref({ source: "header-mobile" }),
    emphasis: true,
  },
];

/**
 * The header is the note's top margin: wordmark at the left, legends across,
 * and an engine-turned band closing it off. It sits on the sheet rather than
 * floating above it — no glass, no blur, no drop shadow. The band is the only
 * thing separating it from the content, exactly as printing would do it.
 */
export function Header(): ReactElement {
  const pathname = usePathname();

  /**
   * The menu records the route it was opened on, and "open" is derived by
   * comparing that to the current route. Navigating therefore closes the panel
   * as a consequence of rendering — without it, tapping a link on mobile
   * navigates behind an overlay that is still covering the page.
   */
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;

  function toggle(): void {
    setOpenedAt(open ? null : pathname);
  }

  /**
   * An overlay over a scrollable body scrolls the page behind it. `overflow:
   * hidden` handles native scrolling; Lenis drives `window.scrollTo` directly
   * and ignores it, so it has to be paused too — otherwise a wheel gesture over
   * the open menu still moves the sheet underneath.
   */
  useEffect(() => {
    if (!open) return;

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    stopSmoothScroll();

    return () => {
      document.body.style.overflow = previous;
      startSmoothScroll();
    };
  }, [open]);

  function isActive(href: string): boolean {
    if (href.startsWith("/#")) return false;
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <header className="relative z-50 bg-rag">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-6 px-5 py-5 sm:px-8 lg:px-12">
        <Wordmark />

        {/* Five items plus a wordmark and a call to action do not fit at
            `gap-8` on a 1024px viewport — the row wraps or the CTA is pushed
            off. The gap opens up again once there is room for it. */}
        <nav
          aria-label="Primary"
          className="hidden items-center gap-5 lg:flex xl:gap-8"
        >
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "legend relative py-1 transition-colors duration-200",
                isActive(item.href)
                  ? "text-intaglio-deep"
                  : "text-intaglio-mid hover:text-intaglio-deep",
              )}
            >
              {item.label}
              {isActive(item.href) ? (
                <span
                  aria-hidden="true"
                  className="absolute -bottom-0.5 left-0 h-px w-full bg-carmine"
                />
              ) : null}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <Link
            href={buildOpenAppHref({ source: "header" })}
            className="legend hidden bg-intaglio px-5 py-2.5 text-reverse transition-colors duration-200 hover:bg-intaglio-deep sm:inline-flex notch-sm"
          >
            Get the app
          </Link>

          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls="site-menu"
            className="legend flex items-center gap-2 py-2 text-intaglio-deep lg:hidden"
          >
            {open ? "Close" : "Menu"}
            <span aria-hidden="true" className="flex w-4 flex-col gap-0.75">
              <span
                className={cn(
                  "h-px w-full bg-current transition-transform duration-200",
                  open && "translate-y-1 rotate-45",
                )}
              />
              <span
                className={cn(
                  "h-px w-full bg-current transition-opacity duration-200",
                  open && "opacity-0",
                )}
              />
              <span
                className={cn(
                  "h-px w-full bg-current transition-transform duration-200",
                  open && "-translate-y-1 -rotate-45",
                )}
              />
            </span>
          </button>
        </div>
      </div>

      <GuillocheBand className="text-intaglio/45" height={14} />

      {/* Mobile panel. The field colour, so the sheet behind it is plainly
          covered rather than dimmed — no scrim, no blur. Anchored to the
          header's own bottom edge so it never needs a hardcoded offset. */}
      {open ? (
        <div
          id="site-menu"
          // The panel is taller than the viewport on a short phone, so it is
          // its own scroller. Lenis intercepts the wheel at the window and
          // would otherwise swallow a gesture aimed at this list; the attribute
          // is how Lenis is told to leave a nested scroller alone.
          data-lenis-prevent
          className="absolute inset-x-0 top-full z-40 max-h-[calc(100dvh-5.5rem)] overflow-y-auto overscroll-contain bg-intaglio pb-8 lg:hidden"
        >
          <nav
            aria-label="Primary"
            className="flex flex-col px-5 sm:px-8 [&>a+a]:border-t [&>a+a]:border-reverse/12"
          >
            {MOBILE_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                // Closing on route change is not enough on its own: a
                // same-page hash link scrolls without changing the pathname,
                // which would leave the panel covering the section it just
                // scrolled to.
                onClick={() => setOpenedAt(null)}
                className={cn(
                  "denomination py-5 text-3xl",
                  item.emphasis ? "text-latent" : "text-reverse",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      ) : null}
    </header>
  );
}
