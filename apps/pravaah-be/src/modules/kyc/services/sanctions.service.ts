import { BadRequestException, Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { KycOrchestratorService } from '@/modules/kyc/services/kyc-orchestrator.service'

import { CheckStatus, CheckType } from 'generated/prisma/client'

/**
 * Prototype sanctions/PEP screen against a local seed watchlist. Production
 * swaps in a real PEP/sanctions API behind this same method — the orchestrator
 * treats a FAILED SANCTIONS_PEP as an unconditional hard reject.
 */
@Injectable()
export class SanctionsService {
  private readonly watchlist = new Set<string>([
    // seed a couple of demo names here, lowercased
    'osama bin laden',
    'dawood ibrahim',
  ])

  private readonly logger: AppLogger

  constructor(
    private readonly orchestrator: KycOrchestratorService,
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: SanctionsService.name })
  }

  async screen(
    userId: string,
    name: string,
    _dob?: string,
  ): Promise<{ hit: boolean }> {
    const hit = this.watchlist.has(name.trim().toLowerCase())
    if (hit) {
      this.logger.warn(`[${this.screen.name}] Sanctions/PEP hit`, { userId })
    }
    await this.orchestrator.recordCheck(
      userId,
      CheckType.SANCTIONS_PEP,
      'internal',
      {
        status: hit ? CheckStatus.FAILED : CheckStatus.PASSED,
        extractedName: name,
      },
    )
    return { hit }
  }

  /**
   * Screen the name reconciled from prior checks. If none is provided we fall
   * back to the profile's canonical `verifiedName` (or the most recent
   * extracted name) — so the app can screen without re-supplying identity.
   */
  async screenCurrent(
    userId: string,
    providedName?: string,
  ): Promise<{ hit: boolean }> {
    let name = providedName?.trim()
    if (!name) {
      const profile = await this.prisma.kycProfile.findUnique({
        where: { userId },
        include: { checks: { orderBy: { createdAt: 'desc' } } },
      })
      name =
        profile?.verifiedName ??
        profile?.checks.find((c) => c.extractedName)?.extractedName ??
        undefined
    }
    if (!name) {
      throw new BadRequestException(
        'No name available to screen — complete an identity check first',
      )
    }
    return this.screen(userId, name)
  }
}
