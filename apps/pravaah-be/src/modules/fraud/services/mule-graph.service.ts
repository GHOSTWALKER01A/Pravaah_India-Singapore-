import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'crypto'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { isUniqueViolation } from '@/utils/prisma-error.util'

import { GRAPH, SIGNAL_WEIGHTS } from '@/modules/fraud/fraud.config'
import { clamp01, type Signal } from '@/modules/fraud/fraud.state'
import {
  HASH_NS,
  hashIpNetwork,
  riskHash,
} from '@/modules/fraud/risk-hash.util'
import type { RiskContext } from '@/modules/fraud/risk.types'

import { EntityLinkType, Prisma } from 'generated/prisma/client'

/**
 * Rows per write statement.
 *
 * 500 keeps the parameter count well inside Postgres's 65,535 bound (7 params per row here,
 * so 3,500) while collapsing a thousand nodes into two round trips. Larger chunks buy little
 * once the round trip is amortised, and make a single failed statement lose more work.
 */
const WRITE_CHUNK = 500

/** Split into fixed-size chunks. Pure, so the write loop stays readable. */
function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size))
  }
  return out
}

/**
 * The mule and synthetic-identity graph — M6's most sophisticated layer.
 *
 * ## The insight
 *
 * Fraud rings are visible in the RELATIONSHIPS between accounts, not in any single
 * account. Each individual account in a mule network looks ordinary: a real person, real
 * KYC, modest balances. What gives the ring away is structure — one device operating five
 * "users" (device farming, T9), twenty accounts paying into three beneficiaries (fan-in,
 * T5), or a chain each receiving and immediately forwarding (pass-through, T5). This is
 * the same insight behind NPCI's MuleHunter, and it is why the graph is worth the
 * complexity it costs.
 *
 * ## The fast/slow split, and why it is not optional
 *
 * Computing connected components and cluster-level features is expensive — it is a graph
 * traversal over every edge. It cannot happen inside a payment. So:
 *
 *  - **Inline (`signals`)** reads ONE indexed row from `GraphNodeScore`. Nothing else.
 *  - **Async (`recomputeClusters`)** walks the graph on a schedule and writes those rows.
 *
 * The cost is staleness, and it is the right trade: a mule ring does not form in the
 * seconds between two transfers, so a score computed 15 minutes ago is as good as one
 * computed now — and a payment path that waited for a graph traversal would time out.
 *
 * ## Why the write phase is batched
 *
 * The scoring pass is pure and happens entirely in memory; only then is anything written,
 * in chunked statements. The earlier version interleaved them with one `upsert` per node
 * awaited inside a nested loop, and at this deployment's ~330ms round trip that was 33
 * seconds for 100 nodes and minutes for a thousand — a job holding a pooled connection long
 * enough to starve the payment schedulers and time out unrelated work.
 *
 * ## The privacy position
 *
 * Nodes are user ids (ours, internal) but EDGES are keyed on a salted HMAC of the shared
 * artefact. So the graph can establish that A and B share a device without the table
 * recording which device, and a stolen copy of `EntityLink` yields structure without
 * identifiers. This is the federated-learning-inspired posture the module claims, made
 * concrete rather than asserted.
 */
@Injectable()
export class MuleGraphService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: MuleGraphService.name })
  }

  // ── the collector (inline, one indexed read) ───────────────────────────────
  /**
   * The cached graph signal for this user.
   *
   * ## Fail-safe by construction
   *
   * If the score has never been computed, this returns NOTHING and the other four
   * layers decide. That is deliberate and it is the layered-defence property: the
   * graph being unavailable degrades the system to "device + velocity + behaviour +
   * lists", never to "open". A version that threw, or that treated an absent score
   * as suspicious, would make the async job a hard dependency of every payment.
   */
  async signals(ctx: RiskContext): Promise<Signal[]> {
    const node = await this.prisma.graphNodeScore.findUnique({
      where: { nodeUserId: ctx.userId },
      select: { muleScore: true, clusterSize: true, degree: true },
    })

    if (!node) return []

    const out: Signal[] = []

    if (node.muleScore >= GRAPH.MULE_SCORE_FLOOR) {
      out.push({
        type: 'MULE_GRAPH',
        weight: SIGNAL_WEIGHTS.MULE_GRAPH,
        // The cached score IS the degree — it is already 0..1 and already
        // expresses how strongly the structure implicates this node.
        value: clamp01(node.muleScore),
        reason:
          'This account is linked to others in a pattern associated with money mules',
      })
    }

    /**
     * A large cluster, reported separately from the mule score.
     *
     * Two signals rather than one because they can disagree, and the disagreement is
     * informative: a node can sit in a big cluster while scoring low itself (a shared
     * office network), or score high in a small one (two accounts, one device, rapid
     * pass-through). Folding both into one number would lose the distinction an
     * analyst uses to tell a false positive from a ring.
     */
    if (node.clusterSize >= GRAPH.SUSPICIOUS_CLUSTER_SIZE) {
      out.push({
        type: 'SHARED_DEVICE_CLUSTER',
        weight: SIGNAL_WEIGHTS.SHARED_DEVICE_CLUSTER,
        value: clamp01(node.degree / GRAPH.DEGREE_SATURATION),
        reason: `This account shares identifiers with ${node.clusterSize - 1} others`,
      })
    }

    return out
  }

  // ── observation (write path) ───────────────────────────────────────────────
  /**
   * Record that a user was observed using a shared artefact.
   *
   * Called from the places that learn one: M6 on a device bind, M4 on a new
   * beneficiary or a transfer. It writes ONE edge, from the observing user to the
   * artefact's hash — it does not try to find the counterpart. Resolution happens in
   * the async job, and that split matters: finding who else shares a hash is a query
   * over the whole table, and doing it inline would put a table scan on the
   * beneficiary-creation path.
   *
   * Idempotent per `(owner, type, hash)`, with `observations` counting repeats.
   * Repetition is itself signal — one shared IP is a coffee shop, forty is a farm.
   */
  async observe(params: {
    ownerUserId: string
    linkType: EntityLinkType
    /** The raw artefact. Hashed here so no caller has to know the namespace. */
    artefact: string
    linkedUserId?: string | null
  }): Promise<void> {
    const sharedKeyHash = this.hashArtefact(params.linkType, params.artefact)

    try {
      await this.prisma.entityLink.create({
        data: {
          ownerUserId: params.ownerUserId,
          linkType: params.linkType,
          sharedKeyHash,
          linkedUserId: params.linkedUserId ?? null,
        },
      })
      return
    } catch (error) {
      if (!isUniqueViolation(error)) {
        /**
         * Logged and swallowed, not rethrown.
         *
         * A graph write must never break the action that produced it: failing a
         * legitimate transfer because an analytics edge could not be recorded trades a
         * real cost for an intelligence nicety. The layer degrades; the payment does
         * not.
         */
        this.logger.warn(
          `[${this.observe.name}] Failed to record a graph edge`,
          { err: error, linkType: params.linkType },
        )
        return
      }
    }

    // The edge exists. Count the repeat.
    await this.prisma.entityLink
      .update({
        where: {
          ownerUserId_linkType_sharedKeyHash: {
            ownerUserId: params.ownerUserId,
            linkType: params.linkType,
            sharedKeyHash,
          },
        },
        data: {
          observations: { increment: 1 },
          // Backfilled if the counterpart was unknown when the edge was first written.
          ...(params.linkedUserId ? { linkedUserId: params.linkedUserId } : {}),
        },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `[${this.observe.name}] Failed to increment a graph edge`,
          { err: error },
        )
      })
  }

  /** Observe a device shared between accounts (T9 — device farming). */
  observeDevice(userId: string, clientDeviceId: string): Promise<void> {
    return this.observe({
      ownerUserId: userId,
      linkType: EntityLinkType.SHARED_DEVICE,
      artefact: clientDeviceId,
    })
  }

  /** Observe a beneficiary, the fan-in edge that reveals a mule ring (T5). */
  observeBeneficiary(userId: string, handle: string): Promise<void> {
    return this.observe({
      ownerUserId: userId,
      linkType: EntityLinkType.SHARED_BENEFICIARY,
      artefact: handle,
    })
  }

  observeIp(userId: string, ipAddress: string): Promise<void> {
    return this.observe({
      ownerUserId: userId,
      linkType: EntityLinkType.SHARED_IP,
      artefact: ipAddress,
    })
  }

  // ── the async recompute ───────────────────────────────────────────────────
  /**
   * Recompute clusters and per-node mule scores.
   *
   * ## Why connected components in application code rather than SQL
   *
   * A recursive CTE is the textbook answer and would be faster. It is also
   * essentially unreviewable and hard to unit-test, and this function decides whether
   * people's payments get held. At the scale M6 runs at — bounded explicitly by
   * `RECOMPUTE_EDGE_LIMIT` — a union-find pass in TypeScript takes milliseconds and
   * can be read by anybody who needs to defend a `MULE_GRAPH` signal in a case
   * review. Production at a different scale swaps this for a graph store behind the
   * same method; the contract is what matters.
   *
   * ## What the score actually measures
   *
   * Three structural facts, combined by noisy-OR for the same reasons the risk engine
   * uses it:
   *
   *  1. **Cluster size** — how many accounts are transitively linked. The strongest
   *     of the three: a ring is a cluster.
   *  2. **Degree** — how many distinct artefacts this node shares. A hub in the
   *     cluster is more implicated than a leaf.
   *  3. **Fan-in concentration** — how many DIFFERENT users share this node's
   *     artefacts. The canonical mule shape: many payers, few payees.
   *
   * A high score is never a verdict. It contributes a 0.55-weight signal, which on its
   * own lands in STEP_UP and needs corroboration to HOLD — because the honest failure
   * mode of graph analysis is a family sharing a tablet.
   */
  async recomputeClusters(): Promise<{
    edges: number
    nodes: number
    clusters: number
  }> {
    const edges = await this.prisma.entityLink.findMany({
      select: {
        ownerUserId: true,
        linkedUserId: true,
        sharedKeyHash: true,
        linkType: true,
        observations: true,
      },
      take: GRAPH.RECOMPUTE_EDGE_LIMIT,
      orderBy: { lastSeenAt: 'desc' },
    })

    if (edges.length === GRAPH.RECOMPUTE_EDGE_LIMIT) {
      /**
       * The cap was hit, so this pass did NOT see the whole graph.
       *
       * Logged loudly rather than silently truncated. A partial recompute produces
       * scores that look authoritative but describe a subgraph, and an operator
       * reading "recompute complete" would have no way to know coverage was bounded.
       */
      this.logger.warn(
        `[${this.recomputeClusters.name}] Edge limit reached — the graph was only partially recomputed`,
        { limit: GRAPH.RECOMPUTE_EDGE_LIMIT },
      )
    }

    // ── group users by the artefact they share ──
    const usersByArtefact = new Map<string, Set<string>>()
    const artefactsByUser = new Map<string, Set<string>>()

    for (const edge of edges) {
      const key = `${edge.linkType}:${edge.sharedKeyHash}`

      const users = usersByArtefact.get(key) ?? new Set<string>()
      users.add(edge.ownerUserId)
      if (edge.linkedUserId) users.add(edge.linkedUserId)
      usersByArtefact.set(key, users)

      const artefacts =
        artefactsByUser.get(edge.ownerUserId) ?? new Set<string>()
      artefacts.add(key)
      artefactsByUser.set(edge.ownerUserId, artefacts)
    }

    // ── union-find over shared artefacts ──
    const parent = new Map<string, string>()

    const find = (node: string): string => {
      let root = node
      while (parent.get(root) !== undefined && parent.get(root) !== root) {
        root = parent.get(root) as string
      }
      // Path compression, so repeated lookups on a long chain stay near O(1).
      let cursor = node
      while (parent.get(cursor) !== undefined && parent.get(cursor) !== root) {
        const next = parent.get(cursor) as string
        parent.set(cursor, root)
        cursor = next
      }
      return root
    }

    const union = (a: string, b: string): void => {
      parent.set(a, parent.get(a) ?? a)
      parent.set(b, parent.get(b) ?? b)
      const rootA = find(a)
      const rootB = find(b)
      if (rootA !== rootB) parent.set(rootA, rootB)
    }

    for (const users of usersByArtefact.values()) {
      const list = [...users]
      // Every user on one artefact joins one component.
      for (let index = 1; index < list.length; index += 1) {
        union(list[0], list[index])
      }
      if (list.length === 1) {
        const only = list[0]
        parent.set(only, parent.get(only) ?? only)
      }
    }

    // ── cluster membership ──
    const membersByRoot = new Map<string, string[]>()
    for (const user of parent.keys()) {
      const root = find(user)
      const members = membersByRoot.get(root) ?? []
      members.push(user)
      membersByRoot.set(root, members)
    }

    /**
     * ── score, in memory ──
     *
     * Every figure is computed BEFORE anything is written, so the write phase is pure I/O
     * that can be batched. The previous version interleaved them — one `upsert` per node,
     * awaited inside a nested loop — and that was a genuine defect rather than a style
     * preference:
     *
     * The database round trip on this deployment is ~330ms (India → ap-southeast-2 through
     * the Supabase pooler). Sequential per-node writes therefore cost 33 SECONDS at 100
     * nodes and minutes at a thousand — on a job that fires every 15 minutes and holds a
     * pooled connection the whole time. That is how a graph recompute starves the payment
     * schedulers and makes unrelated jobs time out.
     */
    const computedAt = new Date()
    const rows: {
      userId: string
      clusterId: string
      clusterSize: number
      degree: number
      muleScore: number
    }[] = []

    for (const [root, members] of membersByRoot) {
      /**
       * A stable, deterministic cluster id derived from the root.
       *
       * Deterministic so the id does not churn on every pass — an analyst who noted
       * "cluster 8f21…" must find the same cluster tomorrow. Derived through the
       * keyed hash so the id does not leak a member's user id, then formatted as a
       * uuid because `clusterId` is a `@db.Uuid` column.
       */
      const clusterId = clusterUuidFor(root)
      const clusterSize = members.length

      for (const userId of members) {
        const degree = artefactsByUser.get(userId)?.size ?? 0

        /**
         * Fan-in: how many OTHER users touch the artefacts this user touches.
         *
         * The mule-defining shape. A user whose three artefacts are each shared with
         * twelve other accounts is a collection point; one whose artefacts are shared
         * with nobody is simply a user with a phone.
         */
        let coSharers = 0
        for (const key of artefactsByUser.get(userId) ?? []) {
          coSharers += (usersByArtefact.get(key)?.size ?? 1) - 1
        }

        rows.push({
          userId,
          clusterId,
          clusterSize,
          degree,
          muleScore: scoreNode({ clusterSize, degree, coSharers }),
        })
      }
    }

    // ── persist, in chunks ──
    await this.persistNodeScores(rows, computedAt)
    await this.stampClusters(rows)

    const nodeCount = rows.length

    this.logger.info(`[${this.recomputeClusters.name}] Graph recomputed`, {
      edges: edges.length,
      nodes: nodeCount,
      clusters: membersByRoot.size,
    })

    return {
      edges: edges.length,
      nodes: nodeCount,
      clusters: membersByRoot.size,
    }
  }

  // ── the analyst's ring view ────────────────────────────────────────────────
  /**
   * The graph neighbourhood around one user.
   *
   * Returns the cluster's members and the edge types binding them — enough for the
   * console to draw the ring. Never returns `sharedKeyHash`: it is unreadable to a
   * human anyway, and shipping it to a browser would put the one value that could be
   * brute-forced offline into a client.
   */
  async neighbourhood(userId: string): Promise<{
    clusterId: string | null
    clusterSize: number
    muleScore: number
    members: Array<{ userId: string; muleScore: number; degree: number }>
    edgeTypes: Array<{ linkType: EntityLinkType; count: number }>
  }> {
    const node = await this.prisma.graphNodeScore.findUnique({
      where: { nodeUserId: userId },
    })

    if (!node?.clusterId) {
      return {
        clusterId: null,
        clusterSize: 1,
        muleScore: node?.muleScore ?? 0,
        members: [],
        edgeTypes: [],
      }
    }

    const members = await this.prisma.graphNodeScore.findMany({
      where: { clusterId: node.clusterId },
      select: { nodeUserId: true, muleScore: true, degree: true },
      orderBy: { muleScore: 'desc' },
      take: 100,
    })

    const grouped = await this.prisma.entityLink.groupBy({
      by: ['linkType'],
      where: { clusterId: node.clusterId },
      _count: { _all: true },
    })

    return {
      clusterId: node.clusterId,
      clusterSize: node.clusterSize,
      muleScore: node.muleScore,
      members: members.map((member) => ({
        userId: member.nodeUserId,
        muleScore: member.muleScore,
        degree: member.degree,
      })),
      edgeTypes: grouped.map((row) => ({
        linkType: row.linkType,
        count: row._count._all,
      })),
    }
  }

  /**
   * Write every node's score in chunked statements.
   *
   * One `INSERT … ON CONFLICT DO UPDATE` per chunk, so a thousand nodes is two round trips
   * rather than a thousand. `ON CONFLICT ("node_user_id")` is valid because that column
   * carries a `@unique` — this is the same atomic upsert Prisma would emit for a single row,
   * batched.
   *
   * `id` is supplied explicitly because `@default(uuid())` is a PRISMA-level default, not a
   * database one: raw SQL bypasses the client's generation, so an INSERT without it violates
   * the NOT NULL. That is the sort of thing that only fails once there is data.
   */
  private async persistNodeScores(
    rows: {
      userId: string
      clusterId: string
      clusterSize: number
      degree: number
      muleScore: number
    }[],
    computedAt: Date,
  ): Promise<void> {
    for (const chunk of chunked(rows, WRITE_CHUNK)) {
      const values = chunk.map(
        (row) => Prisma.sql`(
          ${randomUUID()}::uuid,
          ${row.userId}::uuid,
          ${row.muleScore}::double precision,
          ${row.clusterId}::uuid,
          ${row.degree}::integer,
          ${row.clusterSize}::integer,
          ${computedAt}::timestamptz
        )`,
      )

      await this.prisma.$executeRaw`
        INSERT INTO "GraphNodeScore" (
          "id", "node_user_id", "mule_score", "cluster_id", "degree",
          "cluster_size", "computed_at"
        )
        VALUES ${Prisma.join(values)}
        ON CONFLICT ("node_user_id") DO UPDATE SET
          "mule_score"   = EXCLUDED."mule_score",
          "cluster_id"   = EXCLUDED."cluster_id",
          "degree"       = EXCLUDED."degree",
          "cluster_size" = EXCLUDED."cluster_size",
          "computed_at"  = EXCLUDED."computed_at"
      `
    }
  }

  /**
   * Stamp each edge with its cluster, so the analyst ring view is one query.
   *
   * `UPDATE … FROM (VALUES …)` rather than one `updateMany` per cluster: a graph with two
   * hundred clusters was two hundred round trips, which at this deployment's latency is over
   * a minute of held connection for a job that should take under a second.
   *
   * The explicit `::uuid` casts are required, not decorative — Postgres cannot infer a
   * parameter's type inside a `VALUES` list in a `FROM` clause, and without them the
   * statement fails with "could not determine data type of parameter".
   */
  private async stampClusters(
    rows: { userId: string; clusterId: string }[],
  ): Promise<void> {
    for (const chunk of chunked(rows, WRITE_CHUNK)) {
      const values = chunk.map(
        (row) => Prisma.sql`(${row.userId}::uuid, ${row.clusterId}::uuid)`,
      )

      await this.prisma.$executeRaw`
        UPDATE "EntityLink" AS e
        SET "cluster_id" = v.cluster_id
        FROM (VALUES ${Prisma.join(values)}) AS v(owner_user_id, cluster_id)
        WHERE e."owner_user_id" = v.owner_user_id
      `
    }
  }

  private hashArtefact(linkType: EntityLinkType, artefact: string): string {
    switch (linkType) {
      case EntityLinkType.SHARED_DEVICE:
        return riskHash(HASH_NS.DEVICE, artefact)
      case EntityLinkType.SHARED_BENEFICIARY:
        return riskHash(HASH_NS.BENEFICIARY, artefact)
      case EntityLinkType.SHARED_VPA:
        return riskHash(HASH_NS.VPA, artefact)
      case EntityLinkType.SHARED_IP:
        return hashIpNetwork(artefact)
    }
  }
}

/**
 * Combine the three structural features into a 0..1 mule score.
 *
 * Noisy-OR again, for consistency with the risk engine and for the same property: three
 * weak structural hints compound without any one of them being able to saturate the score
 * alone.
 *
 * ## What each term measures, and why co-sharing outranks degree
 *
 *  - **Cluster size** (0.60) — how many accounts are transitively linked. A ring IS a
 *    cluster, so this is the strongest single term.
 *  - **Co-sharing** (0.55) — how many OTHER users touch this node's artefacts. The
 *    mule-defining shape: many payers, few payees.
 *  - **Degree** (0.25) — how many distinct artefacts this node touches. Weakest on
 *    purpose: a person can legitimately own several devices. Owning several devices that
 *    OTHER accounts also use is the thing worth flagging, and that is the co-sharing term.
 *
 * ## The scaling, and the bug it fixes
 *
 * Both denominators are derived from the thresholds they are supposed to express, rather
 * than sharing one generic `DEGREE_SATURATION`. An earlier version divided co-sharing by
 * 12, which said "4 co-sharers out of 12" and badly understated it — the result was that
 * one device operating five accounts (textbook device farming, T9) scored 0.45 and fell
 * BELOW `MULE_SCORE_FLOOR`, so the graph emitted no signal at all for the exact pattern it
 * exists to catch. Scaling co-sharing against `SHARED_DEVICE_USERS` fixes that and gives
 * that config value its only use.
 *
 * The cluster term is scaled so `SUSPICIOUS_CLUSTER_SIZE` lands at half the term's full
 * contribution, which is what its name implies and what the old `* 2 - 1` denominator did
 * not deliver.
 *
 * A high score is still never a verdict. It contributes a 0.55-weight signal, which alone
 * lands in STEP_UP and needs corroboration to HOLD — because the honest failure mode of
 * graph analysis is a family sharing a tablet, and that case is verified below to stay well
 * under the floor.
 */
export function scoreNode(features: {
  clusterSize: number
  degree: number
  coSharers: number
}): number {
  const contributions = [
    /**
     * A cluster of one is not a cluster, so the numerator is `size - 1`. The denominator
     * puts `SUSPICIOUS_CLUSTER_SIZE` at exactly half.
     */
    0.6 *
      clamp01(
        (features.clusterSize - 1) / ((GRAPH.SUSPICIOUS_CLUSTER_SIZE - 1) * 2),
      ),
    /**
     * Saturating at twice `SHARED_DEVICE_USERS`, so the declared device-farm threshold is
     * a half-strength contribution rather than a rounding error.
     */
    0.55 * clamp01(features.coSharers / (GRAPH.SHARED_DEVICE_USERS * 2)),
    0.25 * clamp01(features.degree / GRAPH.DEGREE_SATURATION),
  ]

  const product = contributions.reduce(
    (acc, contribution) => acc * (1 - clamp01(contribution)),
    1,
  )
  return Number(clamp01(1 - product).toFixed(4))
}

/**
 * A deterministic uuid for a cluster, derived from its root member.
 *
 * Formatted as a v4-shaped uuid because `clusterId` is `@db.Uuid` and Postgres will
 * reject anything else — the same `22P02` class of failure that
 * `KycCheck.providerRefId` once hit. Derived through the keyed hash rather than from
 * the raw user id, so the cluster id does not identify its root member.
 */
export function clusterUuidFor(rootUserId: string): string {
  const digest = riskHash(HASH_NS.USER, `cluster:${rootUserId}`)
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    // Version nibble forced to 4 and variant to 8..b, so the value is a
    // well-formed uuid rather than merely hex of the right length.
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-')
}
