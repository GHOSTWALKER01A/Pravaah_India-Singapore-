/**
 * M5's presentation pieces.
 *
 * Screens import from here and from `@/components/ui`, never from a sibling file directly —
 * the same rule the payments feature follows, so a component that grows a second consumer
 * is a change to one export rather than a new import path in three screens.
 */
export { ClaimThread } from './claim-thread';
export { CoverPlate } from './cover-plate';
export { CoverageDial, coverageSteps, type CoverageStep } from './coverage-dial';
export { DeclineNotice } from './decline-notice';
export { DocumentRow, DocumentSlot } from './document-row';
export { PolicyCertificate } from './policy-certificate';
export { ClaimStub, PolicyStub } from './policy-stub';
export { PremiumVerdict } from './premium-verdict';
export { TermsPanel } from './terms-panel';
