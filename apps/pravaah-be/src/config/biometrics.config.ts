/**
 * Server-side decision thresholds for liveness + face match. The client result
 * is advisory only — these gates are the authority. Below the min but not a
 * hard spoof → MANUAL_REVIEW (twins, poor lighting), never an auto-reject.
 */
export const BIOMETRICS_THRESHOLDS = {
  LIVENESS_MIN: 0.8,
  FACE_MATCH_MIN: 0.8,
} as const
