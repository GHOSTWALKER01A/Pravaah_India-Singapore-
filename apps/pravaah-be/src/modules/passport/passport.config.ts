import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import { PASSPORT_VCT_PATH } from '@pravaah/schema'

import { ENV } from '@/constants/environment.constants'

/**
 * Resolves every issuer identity string from one place.
 *
 * These strings are not configuration in the ordinary sense — they are the
 * credential's identity. `did:web:pravaah.app` is baked into every SD-JWT we sign,
 * and a verifier resolves it to find our public key. If the domain changes, every
 * credential in the wild becomes unverifiable, so the value has to be derived once
 * and consistently rather than assembled ad hoc in five services.
 */
@Injectable()
export class PassportConfig {
  private readonly logger: AppLogger

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PassportConfig.name })
  }

  /**
   * The issuer domain, as it appears in `did:web`.
   *
   * `did:web` resolution requires a bare host (optionally with a path), so any
   * scheme or trailing slash from `API_PUBLIC_URL` is stripped. A colon in a
   * did:web is a PATH separator, so a `host:port` would be resolved as a path
   * segment — which is why a port is dropped rather than passed through, and why
   * local development uses the explicit override.
   */
  domain(): string {
    const explicit = this.config.get<string>(ENV.PASSPORT.ISSUER_DOMAIN)
    if (explicit) return explicit.replace(/^https?:\/\//, '').replace(/\/+$/, '')

    const apiUrl = this.config.get<string>(ENV.API.PUBLIC_URL)
    if (apiUrl) {
      try {
        return new URL(apiUrl).hostname
      } catch {
        this.logger.warn(
          `[${this.domain.name}] API_PUBLIC_URL is not a URL; falling back to the default issuer domain`,
        )
      }
    }
    return 'pravaah.app'
  }

  /** The issuer DID — the `iss` of every credential, and the trust anchor. */
  did(): string {
    return `did:web:${this.domain()}`
  }

  /**
   * Public base URL for anything a verifier must FETCH (JWKS, status lists, card
   * verify links). Distinct from {@link domain} on purpose: the DID is an
   * identifier and must stay stable, while this is a network address that may
   * legitimately be an ngrok tunnel during a demo.
   */
  publicUrl(): string {
    const configured =
      this.config.get<string>(ENV.PASSPORT.PUBLIC_URL) ??
      this.config.get<string>(ENV.API.PUBLIC_URL)
    if (configured) return configured.replace(/\/+$/, '')
    return `https://${this.domain()}`
  }

  /** The credential type URI. Verifiers key their claim expectations off this. */
  vct(): string {
    return `https://${this.domain()}${PASSPORT_VCT_PATH}`
  }

  /** Canonical URI of a status list, as embedded in the credential's `status`. */
  statusListUri(listId: number | string): string {
    return `${this.publicUrl()}/api/v1/status/${listId}`
  }

  /** The URL a scanned card QR / tapped NFC tag resolves to. */
  cardVerifyUrl(cardRef: string): string {
    return `${this.publicUrl()}/api/v1/verify/card/${cardRef}`
  }

  /**
   * Deep link that hands a verifier request to the wallet app.
   *
   * The scheme is normalised down to its bare name and then rebuilt with `://`, because
   * `APP_DEEPLINK` is written inconsistently in practice — `parvaahrn`, `parvaahrn:`,
   * `parvaahrn://` and `parvaahrn:///` all appear in env files. Naively trimming trailing
   * slashes off `parvaahrn://` leaves `parvaahrn:`, which yields a single-slash
   * `parvaahrn:/passport/...` that React Native's Linking does not resolve — a card tap that
   * silently opens nothing.
   *
   * The path has no `(app)` segment because expo-router groups contribute none: the route
   * file at `app/(app)/passport/request/[requestId].tsx` IS `/passport/request/:id`.
   */
  walletRequestLink(requestId: string): string {
    const configured =
      this.config.get<string>(ENV.AA.APP_DEEPLINK) ?? 'parvaahrn://'
    const scheme = configured.replace(/:?\/*$/, '').replace(/:$/, '')
    return `${scheme}://passport/request/${requestId}`
  }
}
