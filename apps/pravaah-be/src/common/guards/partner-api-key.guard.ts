import { createHash, timingSafeEqual } from 'node:crypto'

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import type { VerifierPartner } from 'generated/prisma/client'

/** Header a verifier presents its key in. */
export const PARTNER_API_KEY_HEADER = 'x-pravaah-partner-key'

/**
 * Authenticates a registered verifier (an M7 partner) on the `/verify` surface and
 * attaches the resolved row as `req.partner`.
 *
 * Why the verify surface needs authentication at all, when the SD-JWT is already
 * self-proving: the AUDIENCE. A key binding proof is made out to one verifier, and
 * that binding is what stops a presentation captured at one lender being replayed at
 * another. An anonymous caller could name any audience it liked, which would make the
 * strongest replay defence in the credential a self-declared field.
 *
 * It also gives every presentation a real name in the holder's share history — "who
 * saw my score" is only meaningful if the answer is an organisation rather than a
 * string somebody typed.
 */
@Injectable()
export class PartnerApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{
        headers: Record<string, string | string[] | undefined>
        partner?: VerifierPartner
      }>()

    const raw = request.headers[PARTNER_API_KEY_HEADER]
    const presented = Array.isArray(raw) ? raw[0] : raw
    if (!presented) {
      throw new UnauthorizedException(
        `Missing ${PARTNER_API_KEY_HEADER} header`,
      )
    }

    // Looked up by HASH, so the plaintext key is never stored and never compared
    // against something stored. The lookup is an indexed equality on a digest, which
    // leaks nothing timing-wise about the key itself.
    const hash = createHash('sha256').update(presented).digest('hex')
    const partner = await this.prisma.verifierPartner.findUnique({
      where: { apiKeyHash: hash },
    })

    // Constant-time confirmation of the digest we just matched. The database lookup
    // has already decided, so this is belt-and-braces against a future refactor that
    // replaces the unique lookup with a scan — where a `===` would become a genuine
    // timing oracle.
    if (
      !partner ||
      !partner.isActive ||
      !safeEqual(partner.apiKeyHash, hash)
    ) {
      throw new UnauthorizedException('Invalid or inactive partner key')
    }

    request.partner = partner
    // Fire-and-forget: a last-used timestamp is observability, and must never fail
    // a verification that is otherwise fine.
    void this.prisma.verifierPartner
      .update({ where: { id: partner.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined)

    return true
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // `timingSafeEqual` throws on a length mismatch, which would itself be a signal.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
