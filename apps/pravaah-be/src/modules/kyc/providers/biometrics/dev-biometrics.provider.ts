import { Injectable } from '@nestjs/common'
import { randomInt, randomUUID } from 'crypto'

import { LIVENESS_GESTURES, type LivenessGesture } from '@pravaah/schema'

import { Ok, Result } from '@/common/result/result'

import {
  BiometricsProvider,
  FaceMatchResult,
  LivenessResult,
  LivenessVerifyInput,
} from '@/modules/kyc/providers/biometrics/biometrics.provider'

/** How many gestures make up a challenge. */
const CHALLENGE_LENGTH = 3
/**
 * Minimum plausible size for a real camera capture. A genuine front-camera JPEG
 * is tens of KB+; an empty/placeholder body falls far below this, so it lets the
 * dev provider reject "no real capture happened" without running any ML.
 */
const MIN_IMAGE_BYTES = 3072

/**
 * Deterministic, HONEST dev implementation of the biometrics rail. It performs
 * no ML, but it does NOT rubber-stamp: liveness only passes when the client
 * answered THIS session's randomized challenge in the right order AND uploaded
 * a real (non-trivial) captured frame; face-match only passes when two real
 * images are supplied. The real SDK replaces this class behind the same
 * interface — the services, controller and UI stay identical.
 */
@Injectable()
export class DevBiometricsProvider implements BiometricsProvider {
  // The challenge issued per session, so verify can prove the client answered
  // this specific randomized sequence (anti-replay) rather than a canned one.
  private readonly sessions = new Map<string, LivenessGesture[]>()

  async startLiveness(): Promise<{
    sessionId: string
    challenge: LivenessGesture[]
  }> {
    const sessionId = randomUUID()
    const challenge = this.randomChallenge()
    this.sessions.set(sessionId, challenge)
    return { sessionId, challenge }
  }

  async verifyLiveness(
    input: LivenessVerifyInput,
  ): Promise<Result<LivenessResult>> {
    const issued = this.sessions.get(input.sessionId)
    // Unknown/expired session or an implausibly small frame → not a live capture.
    if (!issued || input.selfie.length < MIN_IMAGE_BYTES) {
      return Ok({ live: false, confidence: 0.2 })
    }
    // One-shot: a challenge can never be replayed once answered.
    this.sessions.delete(input.sessionId)

    const ok =
      issued.length === input.completedChallenge.length &&
      issued.every((g, i) => g === input.completedChallenge[i])
    // Wrong/incomplete sequence → treat as spoof/replay (hard fail upstream).
    return ok
      ? Ok({ live: true, confidence: 0.97 })
      : Ok({ live: false, confidence: 0.35 })
  }

  async faceMatch(
    selfie: Buffer,
    idPhoto: Buffer,
  ): Promise<Result<FaceMatchResult>> {
    // Dev can't run real face comparison; it verifies two genuine images were
    // supplied (the real SDK's comparison drops in here). Empty/undersized → no match.
    if (selfie.length < MIN_IMAGE_BYTES || idPhoto.length < MIN_IMAGE_BYTES) {
      return Ok({ match: false, confidence: 0.3 })
    }
    return Ok({ match: true, confidence: 0.93 })
  }

  /** Pick `CHALLENGE_LENGTH` distinct gestures in a cryptographically random order. */
  private randomChallenge(): LivenessGesture[] {
    const pool = [...LIVENESS_GESTURES]
    // Fisher–Yates using crypto.randomInt (no Math.random).
    for (let i = pool.length - 1; i > 0; i--) {
      const j = randomInt(i + 1)
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    return pool.slice(0, CHALLENGE_LENGTH)
  }
}
