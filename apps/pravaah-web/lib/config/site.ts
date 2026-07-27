/**
 * Hardcoded external URLs, contact details and app-store plumbing.
 * Single source of truth — nothing here is duplicated into a component.
 */

/** Canonical origin. Set NEXT_PUBLIC_SITE_URL in env to override. */
export const BASE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://pravaah.app"
).replace(/\/$/, "");

export type AppPlatform = "android" | "ios";

/**
 * The mobile app is not published yet (see PRODUCT.md). The deep-link scheme
 * and bundle identifiers are real — they come from apps/pravaah-rn/app.json —
 * but both store URLs are intentionally empty. `APP_IS_PUBLISHED` is derived,
 * never hardcoded, so filling either env var is the only step needed to turn
 * every download surface on the site live.
 */
export const MOBILE_APP = {
  /** Route that resolves a deep link and falls back to the right store. */
  openPath: "/get-app",
  /** expo `scheme` in apps/pravaah-rn/app.json */
  deepLinkScheme: "parvaahrn",
  androidPackage: "com.pravaah.app",
  iosBundleId: "com.pravaah.app",
  androidStoreUrl: process.env.NEXT_PUBLIC_ANDROID_STORE_URL ?? "",
  iosStoreUrl: process.env.NEXT_PUBLIC_IOS_STORE_URL ?? "",
} as const;

export const APP_IS_PUBLISHED: boolean = Boolean(
  MOBILE_APP.androidStoreUrl || MOBILE_APP.iosStoreUrl,
);

export function storeUrlFor(platform: AppPlatform): string {
  return platform === "ios" ? MOBILE_APP.iosStoreUrl : MOBILE_APP.androidStoreUrl;
}

function normaliseAppPath(path?: string): string {
  const trimmed = path?.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Build a link into the app-open route. `source` is carried through so the
 * pre-launch page can tell which surface sent the visitor without a tracker.
 */
export function buildOpenAppHref(
  options: { path?: string; fallback?: AppPlatform; source?: string } = {},
): string {
  const params = new URLSearchParams();
  if (options.fallback) params.set("fallback", options.fallback);
  if (options.source) params.set("source", options.source);

  const pathname = `${MOBILE_APP.openPath}${normaliseAppPath(options.path)}`;
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * Corridor the product serves today. M0 requires a different check sequence
 * per side, which is why this is data rather than prose.
 */
export const CORRIDOR = {
  from: { code: "IN", name: "India", currency: "₹" },
  to: { code: "SG", name: "Singapore", currency: "S$" },
} as const;

export const SITE_CONFIG = {
  name: "Pravaah",
  /** Sanskrit — flow. Used verbatim in the wordmark legend. */
  meaning: "flow",
  tagline: "A financial reputation that crosses the border with you.",

  /**
   * PLACEHOLDER — replace before launch.
   * PRODUCT.md records these as deliberately unverified. They are surfaced
   * as visible placeholders on the legal pages rather than invented.
   */
  legal: {
    entityName: "[REGISTERED ENTITY NAME]",
    registeredAddress: "[REGISTERED ADDRESS]",
    grievanceOfficer: "[GRIEVANCE OFFICER NAME]",
    grievanceEmail: "[GRIEVANCE EMAIL]",
    privacyEmail: "[PRIVACY / DPO EMAIL]",
    securityEmail: "[SECURITY DISCLOSURE EMAIL]",
    lastUpdated: "26 July 2026",
  },

  /** Modules verified end-to-end today. Everything else is roadmap. */
  liveModules: ["M0", "M1"] as const,
} as const;

/** True for any legal value still carrying its placeholder marker. */
export function isPlaceholder(value: string): boolean {
  return value.startsWith("[") && value.endsWith("]");
}
