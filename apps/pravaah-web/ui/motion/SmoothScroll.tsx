"use client";

import Lenis from "lenis";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Smooth wheel scrolling.
 *
 * Scoped deliberately to the wheel and nothing else. Hash links are left to
 * next/link and the browser: intercepting them means beating next/link to the
 * click, which in practice means a capture-phase listener that stops
 * propagation — and that also kills every React `onClick` on the link,
 * including the one that closes the mobile menu. It further breaks
 * cross-page anchors and the skip link's focus move. An eased jump is not
 * worth any of that, so the router keeps the anchors.
 *
 * Four things this has to get right, each a standard way smooth-scroll
 * libraries break a page:
 *
 * 1. **Reduced motion.** Anyone who has asked the OS for less motion gets plain
 *    native scrolling. Lenis is never constructed, and the preference is watched
 *    live so toggling it mid-session takes effect without a reload.
 * 2. **No fight with CSS.** `scroll-behavior: smooth` and a scroll library both
 *    animating the same scroll position produces a visible stutter. Mounting
 *    stamps `data-lenis` on <html>, which switches the CSS rule off (globals.css).
 * 3. **Scroll-driven animation survives.** Lenis 1.x lerps the real scroll
 *    position via `window.scrollTo` rather than transforming a wrapper, so the
 *    security thread's `animation-timeline: view()` keeps working and simply
 *    follows the eased position. Do not "upgrade" this to a transform wrapper.
 * 4. **The limit has to stay true.** Lenis clamps to a scroll limit it measured,
 *    and a stale limit is indistinguishable from a broken page: the sheet stops
 *    partway down and further wheeling does nothing. The limit moves whenever
 *    the document height does — a webfont swapping in, a route change, an
 *    orientation change — so each of those re-measures explicitly.
 *
 * ── Interpolation: lerp, not duration ──────────────────────────────────────
 * Lenis has two modes. `duration` + `easing` tweens toward a target over a
 * fixed time, and every new wheel event RESTARTS that tween from t=0 with a
 * fresh target. Under sustained wheeling the eased-out tail is therefore never
 * reached and the page appears to plateau and lurch — the "gets stuck partway"
 * feel. `lerp` is a frame-rate-independent exponential approach to a target
 * that accumulates, which is the correct model for continuous input. The eased
 * settle is preserved; only the restart semantics are gone.
 */

/**
 * Module-level handle rather than a context provider: exactly one consumer
 * needs it (the mobile menu, which must freeze the page behind itself), and a
 * provider for one boolean is more machinery than the job deserves.
 */
let instance: Lenis | null = null;

export function stopSmoothScroll(): void {
  instance?.stop();
}

export function startSmoothScroll(): void {
  instance?.start();
}

/**
 * Re-measure the document. Safe to call when Lenis is not running — under
 * reduced motion there is nothing to correct and the call is a no-op.
 */
export function refreshSmoothScroll(): void {
  instance?.resize();
}

export function SmoothScroll(): null {
  const pathname = usePathname();

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;

    function teardown(): void {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      instance?.destroy();
      instance = null;
      document.documentElement.removeAttribute("data-lenis");
    }

    function setup(): void {
      if (query.matches || instance) return;

      instance = new Lenis({
        /**
         * Approach rate per frame, normalised for refresh rate by Lenis. 0.1 is
         * the library default and reads as slightly loose at this page's
         * length; 0.14 keeps the glide without the sheet feeling like it is
         * catching up with the cursor.
         */
        lerp: 0.14,
        // Touch devices already have momentum scrolling that people know by
        // feel. Overriding it makes a phone feel broken, not premium.
        smoothWheel: true,
        syncTouch: false,
        /**
         * A trackpad's horizontal component must reach the page unmolested —
         * there is nothing to scroll sideways here, and swallowing it breaks
         * two-finger back/forward navigation.
         */
        gestureOrientation: "vertical",
        /**
         * Clicking a link mid-glide otherwise leaves Lenis still animating
         * toward a target measured on the page you have just left, so the new
         * route arrives already drifting and ignores the first wheel gesture
         * until the old animation finishes. It is a bubble-phase click listener
         * on the window that only calls `reset()` — it does not preventDefault
         * or stopPropagation, so next/link and every React `onClick` on the
         * link (including the mobile menu's close handler) are untouched.
         */
        stopInertiaOnNavigate: true,
      });
      document.documentElement.setAttribute("data-lenis", "");

      function raf(time: number): void {
        instance?.raf(time);
        frame = requestAnimationFrame(raf);
      }
      frame = requestAnimationFrame(raf);
    }

    setup();

    function onPreferenceChange(): void {
      if (query.matches) teardown();
      else setup();
    }

    /**
     * Lenis observes the document with a ResizeObserver, which catches most
     * height changes. It does not catch the two that matter most on first
     * load: a webfont swapping in re-flows every line on the sheet, and a
     * late image or a scrollbar appearing changes the limit after Lenis has
     * already measured. Both leave a limit that is short by hundreds of
     * pixels, which is a page that stops before its own footer.
     */
    function measure(): void {
      instance?.resize();
    }

    window.addEventListener("load", measure);
    window.addEventListener("orientationchange", measure);
    document.fonts?.ready.then(measure).catch(() => {});

    query.addEventListener("change", onPreferenceChange);

    return () => {
      window.removeEventListener("load", measure);
      window.removeEventListener("orientationchange", measure);
      query.removeEventListener("change", onPreferenceChange);
      teardown();
    };
  }, []);

  /**
   * A client-side navigation swaps the whole document body while Lenis holds a
   * limit measured against the PREVIOUS page. Landing on a shorter route with
   * a taller page's limit lets the sheet scroll into empty space; landing with
   * a shorter one strands it partway down. Next restores scroll position
   * itself, so this only has to re-measure — after paint, hence the double
   * frame rather than a timeout guess.
   */
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => instance?.resize());
    });

    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [pathname]);

  return null;
}
