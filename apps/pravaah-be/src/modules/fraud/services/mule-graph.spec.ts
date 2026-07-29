import { GRAPH } from '@/modules/fraud/fraud.config'
import { resetRiskHashKeyCache } from '@/modules/fraud/risk-hash.util'
import {
  clusterUuidFor,
  scoreNode,
} from '@/modules/fraud/services/mule-graph.service'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env.RISK_HASH_KEY = 'test-risk-hash-key-not-a-real-secret'
  resetRiskHashKeyCache()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  resetRiskHashKeyCache()
})

describe('scoreNode', () => {
  /**
   * The false-positive floor. A user with their own devices and their own payees shares
   * nothing with anybody, and must score zero — a graph layer that flagged ordinary
   * users would be switched off within a week.
   */
  it('scores an isolated user at zero', () => {
    expect(scoreNode({ clusterSize: 1, degree: 0, coSharers: 0 })).toBe(0)
  })

  it('still scores near zero for a user with many of their OWN artefacts', () => {
    // Five devices, but nobody else touches any of them.
    const score = scoreNode({ clusterSize: 1, degree: 5, coSharers: 0 })

    expect(score).toBeLessThan(GRAPH.MULE_SCORE_FLOOR)
  })

  /**
   * The signal that matters: it is not how many artefacts a user has, it is how many
   * OTHER accounts touch them. A family sharing one tablet is two users on one device;
   * a farm is twenty.
   */
  it('scores a large cluster above the contribution floor', () => {
    const score = scoreNode({
      clusterSize: GRAPH.SUSPICIOUS_CLUSTER_SIZE * 2,
      degree: 4,
      coSharers: 8,
    })

    expect(score).toBeGreaterThanOrEqual(GRAPH.MULE_SCORE_FLOOR)
  })

  it('is monotonic in cluster size', () => {
    const small = scoreNode({ clusterSize: 2, degree: 1, coSharers: 1 })
    const medium = scoreNode({ clusterSize: 5, degree: 1, coSharers: 1 })
    const large = scoreNode({ clusterSize: 20, degree: 1, coSharers: 1 })

    expect(medium).toBeGreaterThan(small)
    expect(large).toBeGreaterThanOrEqual(medium)
  })

  it('is monotonic in co-sharers', () => {
    const few = scoreNode({ clusterSize: 3, degree: 2, coSharers: 1 })
    const many = scoreNode({ clusterSize: 3, degree: 2, coSharers: 10 })

    expect(many).toBeGreaterThan(few)
  })

  it('weights co-sharing above raw degree', () => {
    const highDegree = scoreNode({ clusterSize: 2, degree: 10, coSharers: 0 })
    const highCoSharing = scoreNode({
      clusterSize: 2,
      degree: 1,
      coSharers: 10,
    })

    expect(highCoSharing).toBeGreaterThan(highDegree)
  })

  it('never exceeds 1', () => {
    const score = scoreNode({
      clusterSize: 500,
      degree: 500,
      coSharers: 5_000,
    })

    expect(score).toBeLessThanOrEqual(1)
  })

  /**
   * The fan-in mule pattern (T5): twenty accounts paying into three beneficiaries. Each
   * individual account looks ordinary; the structure is what gives the ring away.
   */
  it('flags the fan-in mule shape', () => {
    const score = scoreNode({ clusterSize: 20, degree: 3, coSharers: 19 })

    expect(score).toBeGreaterThan(0.7)
  })

  /**
   * Device farming (T9): one device operating five "users". Small cluster, but total
   * co-sharing on every artefact.
   *
   * This case is why the co-sharing term is scaled against `SHARED_DEVICE_USERS` rather
   * than a generic saturation constant. An earlier scaling put this at 0.45 — below the
   * floor — so the graph emitted NO signal for the exact pattern it exists to catch.
   */
  it('flags the device-farming shape', () => {
    const score = scoreNode({ clusterSize: 5, degree: 1, coSharers: 4 })

    expect(score).toBeGreaterThanOrEqual(GRAPH.MULE_SCORE_FLOOR)
  })

  /**
   * The other side of that scaling, and the more important one.
   *
   * Two people sharing one tablet — a couple, a parent and child — is the honest failure
   * mode of graph analysis, and it must stay well under the floor. A version tuned only to
   * catch farms would flag every shared household device and the layer would be disabled.
   */
  it('does NOT flag a household sharing one device', () => {
    const score = scoreNode({ clusterSize: 2, degree: 1, coSharers: 1 })

    expect(score).toBeLessThan(GRAPH.MULE_SCORE_FLOOR)
    expect(score).toBeLessThan(0.3)
  })

  /**
   * Three users on one device sits at the declared threshold and is deliberately left
   * BELOW the signal floor. Three is genuinely ambiguous — a family — and the right answer
   * is to record the edges and let a larger cluster or a second shared artefact push it
   * over, rather than to challenge a household.
   */
  it('leaves the ambiguous three-user case below the floor', () => {
    const score = scoreNode({ clusterSize: 3, degree: 1, coSharers: 2 })

    expect(score).toBeLessThan(GRAPH.MULE_SCORE_FLOOR)
  })
})

describe('clusterUuidFor', () => {
  /**
   * Deterministic, because an analyst who noted "cluster 8f21…" must find the same
   * cluster tomorrow. A random id per pass would make every case note stale.
   */
  it('is deterministic for the same root', () => {
    expect(clusterUuidFor('user-a')).toBe(clusterUuidFor('user-a'))
  })

  it('differs between roots', () => {
    expect(clusterUuidFor('user-a')).not.toBe(clusterUuidFor('user-b'))
  })

  /**
   * `GraphNodeScore.clusterId` is `@db.Uuid`, so a merely-hex-of-the-right-length value
   * would be rejected by Postgres with `22P02` — the same class of failure
   * `KycCheck.providerRefId` once hit on every insert.
   */
  it('is a well-formed v4-shaped uuid', () => {
    expect(clusterUuidFor('user-a')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  /**
   * Derived through the keyed hash rather than from the raw user id, so the cluster id
   * does not identify its root member to anybody reading the console.
   */
  it('does not contain the root user id', () => {
    const rootId = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
    const clusterId = clusterUuidFor(rootId)

    expect(clusterId).not.toContain('7c9e6679')
    expect(clusterId).not.toBe(rootId)
  })
})
