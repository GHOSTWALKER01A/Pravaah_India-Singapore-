import type { LivenessGesture } from '@pravaah/schema'

import type { Result } from '@/common/result/result'

/**
 * Liveness + face-match rail. Bound to {@link DevBiometricsProvider} for
 * build/demo; a real SDK (HyperVerge / IDfy / Onfido / Decentro Video-KYC)
 * drops in behind this same interface with no change to the services/controller.
 *
 * Liveness is active challenge-response: {@link startLiveness} issues a
 * randomized, ordered gesture sequence; the client performs it on the live
 * camera and returns a captured frame plus the sequence it completed, which
 * {@link verifyLiveness} validates.
 */
export const BIOMETRICS = Symbol('BIOMETRICS')

export interface LivenessResult {
  live: boolean
  confidence: number
}
export interface FaceMatchResult {
  match: boolean
  confidence: number
}

export interface LivenessVerifyInput {
  sessionId: string
  /** The captured selfie frame from the end of the challenge. */
  selfie: Buffer
  /** The gesture sequence the client reports having completed, in order. */
  completedChallenge: LivenessGesture[]
}

export interface BiometricsProvider {
  startLiveness(
    userRef: string,
  ): Promise<{ sessionId: string; challenge: LivenessGesture[] }>
  verifyLiveness(input: LivenessVerifyInput): Promise<Result<LivenessResult>>
  faceMatch(selfie: Buffer, idPhoto: Buffer): Promise<Result<FaceMatchResult>>
}
