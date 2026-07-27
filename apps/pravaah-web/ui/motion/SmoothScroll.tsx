"use client";

import Lenis from "lenis";
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
 * Three things this does have to get right, each a standard way smooth-scroll
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

export function SmoothScroll(): null {
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
        duration: 0.9,
        // Exponential ease-out: fast to start, settles without overshoot.
        easing: (t: number): number => 1 - Math.pow(1 - t, 3),
        // Touch devices already have momentum scrolling that people know by
        // feel. Overriding it makes a phone feel broken, not premium.
        smoothWheel: true,
        syncTouch: false,
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

    query.addEventListener("change", onPreferenceChange);

    return () => {
      query.removeEventListener("change", onPreferenceChange);
      teardown();
    };
  }, []);

  return null;
}
