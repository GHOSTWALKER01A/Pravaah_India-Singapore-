import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import type { AccountAggregatorProvider } from '@/modules/consent/providers/aa/aa.provider'
import { FinvuAaProvider } from '@/modules/consent/providers/aa/finvu-aa.provider'
import { SandboxAaProvider } from '@/modules/consent/providers/aa/sandbox-aa.provider'
import { SetuAaProvider } from '@/modules/consent/providers/aa/setu-aa.provider'

export type AaMode = 'sandbox' | 'setu' | 'finvu' | 'live'

/**
 * Routes AA operations to the right provider.
 *
 *  - `byName(consent.aaProvider)` — every operation AFTER consent creation is
 *    pinned to the provider that created the consent (you cannot create on Setu
 *    and fetch on Finvu; AA state is provider-local).
 *  - `createOrder()` — the ordered list of providers to ATTEMPT at creation.
 *    AA_MODE=live means "Setu, then fall back to Finvu"; the winner's name is
 *    persisted on the consent so all later calls route back to it.
 *
 * AA_MODE: sandbox (default) | setu | finvu | live.
 */
@Injectable()
export class AaProviderRegistry {
  private readonly logger: AppLogger
  private readonly byNameMap: Record<string, AccountAggregatorProvider>

  constructor(
    private readonly config: ConfigService,
    private readonly sandbox: SandboxAaProvider,
    private readonly setu: SetuAaProvider,
    private readonly finvu: FinvuAaProvider,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AaProviderRegistry.name })
    this.byNameMap = { sandbox, setu, finvu }
  }

  mode(): AaMode {
    return (this.config.get<string>('AA_MODE') as AaMode) ?? 'sandbox'
  }

  /** The primary provider (mock screen + webhook signature default). */
  primary(): AccountAggregatorProvider {
    const m = this.mode()
    if (m === 'finvu') return this.finvu
    if (m === 'setu' || m === 'live') return this.setu
    return this.sandbox
  }

  /** Resolve the provider that owns an existing consent (by persisted name). */
  byName(name: string): AccountAggregatorProvider {
    return this.byNameMap[name] ?? this.primary()
  }

  /** Ordered providers to attempt at consent CREATE time (with fallback). */
  createOrder(): AccountAggregatorProvider[] {
    switch (this.mode()) {
      case 'setu':
        return [this.setu]
      case 'finvu':
        return [this.finvu]
      case 'live':
        // Setu primary → Finvu fallback. Skip a provider that isn't configured
        // so a missing-credential provider never shadows a working one.
        return [this.setu, this.finvu].filter((p) => p.isConfigured?.() ?? true)
      case 'sandbox':
      default:
        return [this.sandbox]
    }
  }

  /** All providers (used for best-effort webhook signature verification). */
  all(): AccountAggregatorProvider[] {
    return [this.sandbox, this.setu, this.finvu]
  }
}
