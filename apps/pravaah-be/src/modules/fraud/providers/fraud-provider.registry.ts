import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { ENV } from '@/constants/environment.constants'

import { DevTelcoProvider } from '@/modules/fraud/providers/dev-telco.provider'
import type { TelcoProvider } from '@/modules/fraud/providers/telco.provider'

/**
 * Selects the telco provider.
 *
 * A REGISTRY rather than the shorter `useClass: process.env.X === 'dev' ? A : B`,
 * for the reasons `InsuranceProviderRegistry` and `PaymentProviderFactory` both
 * document at length:
 *
 *  - A ternary in a module's provider array is evaluated ONCE, at module load,
 *    from `process.env` directly — before `ConfigModule` has read the `.env.*.local`
 *    files this app loads. It would silently select the dev provider in every
 *    environment whose mode came from a file rather than the shell.
 *  - It cannot REFUSE. A live carrier selected without credentials would resolve
 *    to a class that fails on first use, deep inside a risk evaluation — and a
 *    risk evaluation that throws is a payment that fails for a reason nobody can
 *    explain.
 */
@Injectable()
export class FraudProviderRegistry {
  private readonly logger: AppLogger
  private readonly telcosByName: Record<string, TelcoProvider>

  constructor(
    private readonly config: ConfigService,
    private readonly devTelco: DevTelcoProvider,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: FraudProviderRegistry.name })
    this.telcosByName = { [devTelco.name]: devTelco }
  }

  /** The configured telco mode: `dev` (default) | a carrier name. */
  telcoMode(): string {
    return (
      this.config.get<string>(ENV.FRAUD.TELCO_MODE)?.trim().toLowerCase() ??
      'dev'
    )
  }

  /**
   * The telco to ask about SIM swaps.
   *
   * A non-dev mode is REFUSED rather than downgraded. The tempting behaviour — log
   * a warning, hand back the dev provider — would mean an operator who deliberately
   * selected a real carrier keeps getting "nothing contradicts this serial" on
   * every check, believes SIM-swap corroboration is live, and discovers otherwise
   * when an account is drained through a swapped SIM the carrier knew about.
   */
  telco(): TelcoProvider {
    const mode = this.telcoMode()
    if (mode === 'dev') return this.devTelco

    this.logger.error(
      `[${this.telco.name}] TELCO_MODE=${mode} but no live telco provider is implemented`,
      { mode },
    )
    throw new InternalServerErrorException(
      `TELCO_MODE is "${mode}", but no live telco integration exists yet. Production requires a carrier SIM-swap API (or GSMA Open Gateway / NPCI SIM-Binding) behind TelcoProvider; set TELCO_MODE=dev until one is wired.`,
    )
  }

  /**
   * Resolve the provider a callback claims to be from.
   *
   * `null` rather than a throw, and the difference matters on this path: an unknown
   * provider name in a webhook URL is an UNAUTHENTICATED caller's input. Throwing
   * would turn a probe for `/webhooks/fraud/telco/anything` into a 500 and a stack
   * trace in the logs; returning null lets the controller answer a flat 403.
   */
  telcoByName(name: string): TelcoProvider | null {
    return this.telcosByName[name] ?? null
  }

  /**
   * What the module is actually running.
   *
   * Surfaced through the admin API on purpose, exactly as M5 does it. An auditor
   * should be able to read whether SIM-swap detection is carrier-corroborated
   * without inferring it from behaviour, and a build that quietly presented a dev
   * stub as a live carrier integration would discredit the rest of the module.
   */
  describe(): {
    telco: {
      mode: string
      provider: string
      live: boolean
      configured: boolean
    }
  } {
    const mode = this.telcoMode()
    return {
      telco: {
        mode,
        provider: this.devTelco.name,
        live: false,
        configured: this.devTelco.isConfigured(),
      },
    }
  }
}
