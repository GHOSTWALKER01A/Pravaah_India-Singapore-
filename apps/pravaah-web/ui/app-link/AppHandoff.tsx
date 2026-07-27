"use client";

import { useEffect, type ReactElement } from "react";

import { MOBILE_APP, type AppPlatform } from "@/lib/config/site";
import { ButtonLink } from "@/ui/primitives/Button";
import { Legend } from "@/ui/primitives/Legend";

/**
 * The handoff, used only once the app is actually published.
 *
 * Attempts the `parvaahrn://` deep link so an installed app opens directly on
 * the requested screen, then falls back to that platform's store. The fallback
 * timer is cancelled when the tab is hidden, which is the only reliable signal
 * that the deep link succeeded — otherwise a visitor who successfully opened
 * the app comes back to a store page they never asked for.
 *
 * There is deliberately no state here. Both store links render as real anchors
 * on first paint, so the page is complete and usable before the effect runs, if
 * the deep link fails, and with JavaScript disabled entirely. The copy is
 * written to be true in all three cases rather than swapped after detection.
 */
export function AppHandoff({
  appPath,
  fallback,
}: {
  /** Path inside the app, e.g. "consent/123". Empty opens the app's root. */
  appPath: string;
  /** Platform hint from the link that sent the visitor here. */
  fallback?: AppPlatform;
}): ReactElement {
  useEffect(() => {
    const platform = fallback ?? detectPlatform();
    if (!platform) return;

    const storeUrl =
      platform === "ios" ? MOBILE_APP.iosStoreUrl : MOBILE_APP.androidStoreUrl;
    if (!storeUrl) return;

    window.location.href = `${MOBILE_APP.deepLinkScheme}://${appPath}`;

    // Still here after the beat — the app is not installed.
    const timer = window.setTimeout(() => {
      window.location.href = storeUrl;
    }, 1400);

    // The app took over. Do not yank the visitor to a store on return.
    function cancelOnHide(): void {
      if (document.visibilityState === "hidden") window.clearTimeout(timer);
    }

    document.addEventListener("visibilitychange", cancelOnHide);
    window.addEventListener("pagehide", cancelOnHide);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", cancelOnHide);
      window.removeEventListener("pagehide", cancelOnHide);
    };
  }, [appPath, fallback]);

  return (
    <div>
      <Legend className="text-latent">Handing you over</Legend>

      <p className="mt-5 text-base leading-relaxed text-reverse-dim">
        If Pravaah is installed, it should be opening now. If it isn&rsquo;t
        installed we will send you to the store in a moment — or go straight
        there yourself.
      </p>

      <div className="mt-9 flex flex-col gap-3 sm:flex-row">
        {MOBILE_APP.androidStoreUrl ? (
          <ButtonLink
            href={MOBILE_APP.androidStoreUrl}
            variant="reverse"
            external
          >
            Google Play
          </ButtonLink>
        ) : null}
        {MOBILE_APP.iosStoreUrl ? (
          <ButtonLink href={MOBILE_APP.iosStoreUrl} variant="quiet" external>
            App Store
          </ButtonLink>
        ) : null}
      </div>
    </div>
  );
}

function detectPlatform(): AppPlatform | null {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "android";
  // iPadOS 13+ reports as Macintosh; the touch-point check separates it from a
  // real desktop Mac, which has no app to open.
  if (
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  ) {
    return "ios";
  }
  return null;
}
