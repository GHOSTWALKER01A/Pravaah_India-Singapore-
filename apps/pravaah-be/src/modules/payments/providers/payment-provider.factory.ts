import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { ENV } from '@/constants/environment.constants'
import { DecentroUpiProvider } from '@/modules/payments/providers/decentro-upi.provider'
import type { PaymentProvider } from '@/modules/payments/providers/payment.provider'
import {
  UpiPayNowSimProvider,
  UpiSimProvider,
} from '@/modules/payments/providers/simulated-rail.provider'

import { Corridor } from 'generated/prisma/client'

/**
 * Routes a transaction to its rail.
 *
 * Two selection rules, and they are not symmetric:
 *
 *  - **Domestic** picks between the live Decentro sandbox and the simulator, chosen by
 *    `PAYMENTS_UPI_PROVIDER`. A live provider that is not fully configured is REFUSED
 *    rather than silently downgraded to the simulator: an operator who set
 *    `=decentro` and got simulated payments would believe they had tested the real
 *    rail, and would find out otherwise in production.
 *  - **Cross-border** has no live option at all. The UPI↔PayNow linkage is a bank rail
 *    (DBS Singapore / Liquid Group) reached through a regulated PSP, not an API anyone
 *    can sign up for. Pretending a live mode exists would be dishonest about what the
 *    system can do; production requires a PSP or sponsor-bank partnership (Nium,
 *    Thunes, Wise Platform) under RBI/MAS licensing.
 *
 * {@link byName} resolves the provider that ORIGINATED a transaction, from the name
 * persisted on the row. Every operation after submission — status, refund, webhook
 * verification — must route back to it. A transaction submitted on the simulator and
 * polled against Decentro would get "unknown reference" and be marked DEEMED, and
 * routing a refund to the wrong rail would be worse than that.
 */
@Injectable()
export class PaymentProviderFactory {
  private readonly logger: AppLogger
  private readonly byNameMap: Record<string, PaymentProvider>

  constructor(
    private readonly config: ConfigService,
    private readonly decentro: DecentroUpiProvider,
    private readonly upiSim: UpiSimProvider,
    private readonly payNowSim: UpiPayNowSimProvider,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PaymentProviderFactory.name })
    this.byNameMap = {
      [decentro.name]: decentro,
      [upiSim.name]: upiSim,
      [payNowSim.name]: payNowSim,
    }
  }

  /** The configured domestic mode: `sim` (default) | `decentro`. */
  domesticMode(): string {
    return (
      this.config
        .get<string>(ENV.PAYMENTS.UPI_PROVIDER)
        ?.trim()
        .toLowerCase() ?? 'sim'
    )
  }

  forCorridor(corridor: Corridor): PaymentProvider {
    return corridor === Corridor.CROSS_BORDER
      ? this.payNowSim
      : this.domesticProvider()
  }

  /** The provider name to persist on a new transaction. */
  nameFor(corridor: Corridor): string {
    return this.forCorridor(corridor).name
  }

  /**
   * Resolve the provider a transaction was submitted on.
   *
   * Throws on an unknown name rather than falling back. A fallback here would poll the
   * wrong rail about somebody's money and get a confident, wrong answer — the exact
   * shape of mistake that ends in a double payout.
   */
  byName(name: string): PaymentProvider {
    const provider = this.byNameMap[name]
    if (!provider) {
      throw new InternalServerErrorException(
        `No payment provider registered under "${name}"`,
      )
    }
    return provider
  }

  /** Providers a webhook could plausibly have come from. */
  all(): PaymentProvider[] {
    return [this.decentro, this.upiSim, this.payNowSim]
  }

  private domesticProvider(): PaymentProvider {
    const mode = this.domesticMode()
    if (mode !== 'decentro' && mode !== 'live') return this.upiSim

    if (!this.decentro.isConfigured()) {
      /**
       * Refused, not downgraded.
       *
       * The tempting behaviour is to log a warning and hand back the simulator. That
       * would mean an operator who deliberately selected the live rail keeps getting
       * simulated `SIM-` references, believes the integration works, and discovers
       * otherwise the first time real money is expected to move.
       */
      this.logger.error(
        `[${this.domesticProvider.name}] PAYMENTS_UPI_PROVIDER=${mode} but Decentro credentials are missing`,
      )
      throw new InternalServerErrorException(
        'The live UPI provider is selected but not configured. Set the Decentro credentials or switch PAYMENTS_UPI_PROVIDER to "sim".',
      )
    }
    return this.decentro
  }
}
