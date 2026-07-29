export { authService } from './auth/auth.service';
export { tokenManager } from './auth/token-manager';
export { kycService } from './kyc/kyc.service';
export { consentService } from './consent/consent.service';
export { scoreService } from './score/score.service';
export { passportService } from './passport/passport.service';
export { userService } from './users/user.service';
export { ApiError } from './core/error.types';

// A value export, not a type: the score endpoint returns a discriminated union
// and screens need the narrowing helper at runtime.
export { isComputedScore } from './score/score.schema';
// Same reason — the wallet endpoint returns ACTIVE | NOT_ISSUED | NEEDS_REISSUE.
export { isActivePassport } from './passport/passport.schema';

export type * from './auth/auth.schema';
export type * from './kyc/kyc.schema';
export type * from './consent/consent.schema';
export type * from './score/score.schema';
export type * from './passport/passport.schema';
export type * from './users/user.schema';
