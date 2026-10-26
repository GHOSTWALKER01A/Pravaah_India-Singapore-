import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import type {
  CreatePartnerTemplateDto,
  PredicateSpec,
  UpdatePartnerTemplateDto,
} from '@pravaah/schema'

import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { claimsOutsideScope } from '@/modules/passport/passport.state'
import { isUniqueViolation } from '@/utils/prisma-error.util'

import type { PartnerTemplate } from 'generated/prisma/client'

import {
  PredicateError,
  compilePredicates,
  predicateClaims,
} from '@/modules/partner/partner.state'

const TEMPLATE_VIEW = {
  id: true,
  name: true,
  purpose: true,
  claims: true,
  predicates: true,
  isArchived: true,
  createdAt: true,
  updatedAt: true,
} as const

/**
 * A partner's own saved requests ("SG personal-loan pre-check").
 *
 * Validated at SAVE time against the partner's scope and the predicate compiler,
 * so a template that could never be used fails when it is written — not months
 * later in front of an applicant. It is re-validated at USE time too, because a
 * scope can narrow after a template was saved.
 */
@Injectable()
export class PartnerTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  list(partnerId: string, includeArchived = false) {
    return this.prisma.partnerTemplate.findMany({
      where: { partnerId, ...(includeArchived ? {} : { isArchived: false }) },
      orderBy: { name: 'asc' },
      select: TEMPLATE_VIEW,
    })
  }

  /** A usable template, scoped to its partner. */
  async requireUsable(
    partnerId: string,
    templateId: string,
  ): Promise<PartnerTemplate> {
    const template = await this.prisma.partnerTemplate.findFirst({
      where: { id: templateId, partnerId },
    })
    if (!template) throw new NotFoundException('Template not found')
    if (template.isArchived)
      throw new BadRequestException('This template is archived')
    return template
  }

  async create(
    partnerId: string,
    allowedScopes: string[],
    dto: CreatePartnerTemplateDto,
  ) {
    this.validate(allowedScopes, dto.claims, dto.predicates)
    try {
      return await this.prisma.partnerTemplate.create({
        data: {
          partnerId,
          name: dto.name,
          purpose: dto.purpose,
          claims: [...new Set(dto.claims)],
          predicates: dto.predicates,
        },
        select: TEMPLATE_VIEW,
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `A template named "${dto.name}" already exists`,
        )
      }
      throw error
    }
  }

  async update(
    partnerId: string,
    templateId: string,
    allowedScopes: string[],
    dto: UpdatePartnerTemplateDto,
  ) {
    const existing = await this.prisma.partnerTemplate.findFirst({
      where: { id: templateId, partnerId },
    })
    if (!existing) throw new NotFoundException('Template not found')

    const claims = dto.claims ?? existing.claims
    const predicates =
      dto.predicates ?? (existing.predicates as PredicateSpec[])
    if (claims.length + predicates.length === 0) {
      throw new BadRequestException(
        'A template must ask for at least one claim or predicate',
      )
    }
    this.validate(allowedScopes, claims, predicates)

    try {
      return await this.prisma.partnerTemplate.update({
        where: { id: existing.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.purpose !== undefined ? { purpose: dto.purpose } : {}),
          ...(dto.claims !== undefined
            ? { claims: [...new Set(dto.claims)] }
            : {}),
          ...(dto.predicates !== undefined
            ? { predicates: dto.predicates }
            : {}),
          ...(dto.isArchived !== undefined
            ? { isArchived: dto.isArchived }
            : {}),
        },
        select: TEMPLATE_VIEW,
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `A template named "${dto.name}" already exists`,
        )
      }
      throw error
    }
  }

  /** Throws a 400 naming the exact problem: an unanswerable predicate or an out-of-scope claim. */
  private validate(
    allowedScopes: string[],
    claims: readonly string[],
    predicates: readonly PredicateSpec[],
  ): void {
    let predicateNeeds: string[]
    try {
      predicateNeeds = predicateClaims(compilePredicates(predicates))
    } catch (error) {
      if (error instanceof PredicateError)
        throw new BadRequestException(error.message)
      throw error
    }
    const outside = claimsOutsideScope(
      [...claims, ...predicateNeeds],
      allowedScopes,
    )
    if (outside.length) {
      throw new BadRequestException(
        `This template needs claims outside your approved scope: ${outside.join(', ')}`,
      )
    }
  }
}
