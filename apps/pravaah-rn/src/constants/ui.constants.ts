/**
 * User-facing product constants.
 *
 * The `Brand` palette and `KYC_STATUS_META` that used to live here are gone. They
 * were the second, competing source of colour truth in the app: `Brand.primary`
 * (#4F46E5) and `Brand.border` (#E5E7EB) were fixed hexes with no dark-mode
 * variant, imported directly by 22 screens alongside the theme-aware `Colors` —
 * which is why the incumbent app had borders that stayed light-grey in dark mode
 * and an accent that belonged to no design system.
 *
 * Colour now lives only in `@/theme`, and status presentation only in
 * `@/components/ui` (`STATUS_META`), where it resolves per theme and is verified
 * against WCAG in both.
 */
export const APP_NAME = 'Pravaah';
export const APP_TAGLINE = 'Your cross-border reputation passport';
