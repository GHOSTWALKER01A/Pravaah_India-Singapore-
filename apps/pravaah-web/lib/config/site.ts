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
  name: "MyPravaah",
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

} as const;

/**
 * Where the product actually is — the one place any page may read it from.
 *
 * This replaced a `liveModules: ["M0", "M1"]` list that every surface then
 * paraphrased in prose, which is exactly how a site drifts: the code moved on
 * and six sentences across four pages did not. The rule now is that no page
 * states the stage in its own words; it renders these.
 *
 * The two halves are deliberately separate, because they are separate facts and
 * conflating them is the dishonest move available here. All eight modules are
 * finished and verified. Several of them talk to a regulated third party whose
 * production access needs a licence, a PSP agreement or a carrier — those run
 * against sandboxes, and saying so is not a caveat buried in a footer.
 */
export const STAGE = {
  modulesBuilt: 8,
  modulesTotal: 8,
  /** One sentence. Used verbatim where only one sentence fits. */
  headline:
    "All eight modules are built and verified end-to-end. The app is not published, and the regulated rails run in sandbox.",
  /** What is genuinely finished. */
  built:
    "Identity, consent and data collection, scoring, the issued credential, verification, payments, insurance and the fraud engine are complete, and each is exercised end-to-end against the real database rather than mocked.",
  /** What is not real yet, stated without softening. */
  pending:
    "Nothing here is a live financial service. MyPravaah is not a licensed Financial Information User, holds no payments licence or PSP agreement, and has no insurance carrier on paper. Those integrations are finished and run against provider sandboxes. No real money has moved and no policy is in force.",
  /** Distribution. */
  release:
    "The mobile app is not on the App Store or Google Play. If you find an app claiming to be MyPravaah today, it is not ours.",
} as const;

/** True for any legal value still carrying its placeholder marker. */
export function isPlaceholder(value: string): boolean {
  return value.startsWith("[") && value.endsWith("]");
}
