export { authService } from './auth/auth.service';
export { tokenManager } from './auth/token-manager';
export { kycService } from './kyc/kyc.service';
export { consentService } from './consent/consent.service';
export { scoreService } from './score/score.service';
export { userService } from './users/user.service';
export { ApiError } from './core/error.types';

// A value export, not a type: the score endpoint returns a discriminated union
// and screens need the narrowing helper at runtime.
export { isComputedScore } from './score/score.schema';

export type * from './auth/auth.schema';
export type * from './kyc/kyc.schema';
export type * from './consent/consent.schema';
export type * from './score/score.schema';
export type * from './users/user.schema';
