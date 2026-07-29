/**
 * M5's screens.
 *
 * The route files under `app/(app)/insurance/` are thin: they read params and render one of
 * these. That split is the payments feature's convention and it exists so a screen is
 * testable and re-orderable without touching the router — and so a route file never grows
 * logic that then has to be duplicated when the same screen is reached from two places.
 */
export { ClaimDocumentsScreen } from './claim-documents-screen';
export { ClaimScreen } from './claim-screen';
export { ClaimsScreen } from './claims-screen';
export { CoverScreen } from './cover-screen';
export { FileClaimScreen } from './file-claim-screen';
export { InsuranceScreen } from './insurance-screen';
export { PoliciesScreen } from './policies-screen';
export { PolicyScreen } from './policy-screen';
export { PremiumsScreen } from './premiums-screen';
export { QuoteScreen } from './quote-screen';
