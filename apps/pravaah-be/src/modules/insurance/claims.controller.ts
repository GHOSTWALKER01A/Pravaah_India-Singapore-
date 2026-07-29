import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common'
import { FileFieldsInterceptor } from '@nestjs/platform-express'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  AddClaimDocSchema,
  ClaimListQuerySchema,
  SubmitClaimSchema,
  WithdrawClaimSchema,
  type AddClaimDocDto,
  type ClaimListQueryDto,
  type SubmitClaimDto,
  type WithdrawClaimDto,
} from '@pravaah/schema'

import {
  User,
  type AuthenticatedUser,
} from '@/common/decorators/user.decorator'
import { AuthGuard } from '@/common/guards/auth.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { CLAIM_ROUTES } from '@/modules/insurance/insurance.route'
import { MAX_CLAIM_DOC_BYTES } from '@/modules/insurance/insurance.config'
import { ClaimsService } from '@/modules/insurance/services/claims.service'

/** What multer hands us. Only the buffer is used; the bytes never reach the database. */
type UploadedDocument = { buffer: Buffer; originalname?: string; size?: number }

/**
 * Claiming.
 *
 * The flow is three calls rather than one, and the split is deliberate:
 *
 *  1. `POST /insurance/claims` — file the incident. Every coverage guard runs here, so a
 *     claim that is not covered is refused BEFORE the claimant photographs six documents.
 *     Refusing after the upload would waste the time of somebody who may be in a hospital.
 *  2. `POST /insurance/claims/:id/documents` — attach evidence. OCR runs per upload, so
 *     "this photo is too blurry to read" comes back immediately rather than at review.
 *  3. `POST /insurance/claims/:id/finalise` — "I'm done." The fraud gate runs against the
 *     COMPLETE picture and either auto-approves a small clean claim or routes it to a
 *     person.
 *
 * Scoring at step 1 would assess every claim as though it had no documents; scoring on
 * each upload would re-run the whole assessment per photo and let a claimant watch their
 * risk score move.
 */
@Controller(CLAIM_ROUTES.BASE)
@UseGuards(AuthGuard)
export class ClaimsController {
  private readonly logger: AppLogger

  constructor(
    private readonly claims: ClaimsService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ClaimsController.name })
  }

  /**
   * File a claim.
   *
   * No `Idempotency-Key`, and that is not an omission. The duplicate guard here is a
   * DATABASE CONSTRAINT on `(policyId, dedupeHash)` where the hash is
   * `policy + incident day + amount` — which is strictly stronger than a client-supplied
   * key for this operation. A key would stop the same REQUEST twice; the fingerprint
   * stops the same CLAIM twice, including from two different devices with two different
   * keys.
   */
  @Post(CLAIM_ROUTES.FILE)
  async file(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(SubmitClaimSchema)) dto: SubmitClaimDto,
  ) {
    this.logger.info(`[${this.file.name}] Claim being filed`, {
      userId: user.id,
      policyId: dto.policyId,
    })

    const claim = await this.claims.submit(user.id, dto)
    return ResponseBuilder.success(
      this.claims.describe(claim),
      'Claim filed. Attach your documents, then submit it for review.',
    )
  }

  /**
   * Attach a document.
   *
   * `FileFieldsInterceptor` with an explicit size limit, matching the KYC upload path. The
   * limit is enforced by multer BEFORE the buffer reaches us, which is the point — an
   * unbounded upload on an unauthenticated-adjacent route is a cheap way to exhaust
   * memory, and a size check after the read has already lost.
   */
  @Post(CLAIM_ROUTES.DOCUMENTS)
  @UseInterceptors(
    FileFieldsInterceptor([{ name: 'document', maxCount: 1 }], {
      limits: { fileSize: MAX_CLAIM_DOC_BYTES },
    }),
  )
  async addDocument(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
    @UploadedFiles() files: { document?: UploadedDocument[] },
    @Body(new ZodValidationPipe(AddClaimDocSchema)) dto: AddClaimDocDto,
  ) {
    const document = files?.document?.[0]
    /**
     * An empty upload is refused up front.
     *
     * A zero-byte file would reach the OCR provider, fail to parse, and be recorded as a
     * REJECTED document — which looks to the claimant like their bill was rejected rather
     * than never sent. Better to say so now.
     */
    if (!document?.buffer?.length) {
      throw new BadRequestException(
        'Attach the document as a `document` file field',
      )
    }

    const doc = await this.claims.addDocument(user.id, id, dto, document)
    const claim = await this.claims.loadOwned(user.id, id)

    return ResponseBuilder.success(
      {
        document: {
          id: doc.id,
          docType: doc.docType,
          status: doc.verificationStatus,
          uploadedAt: doc.uploadedAt,
        },
        claim: this.claims.describe(claim),
      },
      this.documentMessage(doc.verificationStatus),
    )
  }

  /**
   * The message for a document's verdict.
   *
   * A SUSPECT document does NOT say "we think this is forged". It says a person will check
   * it — which is true, is what happens, and does not accuse a claimant who may simply
   * have photographed a photocopy. Telling somebody their document looks altered when the
   * signal is a heuristic would be both unfair and, if they were attempting fraud, a hint
   * about what to change.
   */
  private documentMessage(status: string): string {
    switch (status) {
      case 'VERIFIED':
        return 'Document received and read.'
      case 'SUSPECT':
        return 'Document received. Someone from our team will check this one personally.'
      case 'REJECTED':
        return 'We could not read that document. Please upload a clearer copy.'
      default:
        return 'Document received, but it was hard to read — a clearer photo would help.'
    }
  }

  /**
   * Submit for review.
   *
   * The response says whether a person will look at it or whether it settled
   * automatically, because those are genuinely different experiences and a claimant who
   * has just been paid should be told so rather than left polling.
   */
  @Post(CLAIM_ROUTES.FINALISE)
  async finalise(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const claim = await this.claims.finalise(user.id, id)
    const described = this.claims.describe(claim)

    return ResponseBuilder.success(
      described,
      described.status === 'PAID'
        ? `Approved and paid — ${described.amountApproved?.formatted ?? ''} is in your wallet.`.trim()
        : described.status === 'APPROVED'
          ? 'Approved. The payment is on its way to your wallet.'
          : 'Submitted for review. We will come back to you.',
    )
  }

  @Get(CLAIM_ROUTES.LIST)
  async list(
    @User() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(ClaimListQuerySchema))
    query: ClaimListQueryDto,
  ) {
    const { items, total } = await this.claims.list(user.id, query)
    return ResponseBuilder.paginatedWithOffset(
      items.map((claim) => this.claims.describe(claim)),
      total,
      query.offset,
      query.limit,
      'Your claims',
    )
  }

  /**
   * The status the client polls.
   *
   * `isFinal` is returned so the app knows when to STOP polling rather than inferring it
   * from a status enum it would have to keep in sync with ours. Note that `APPROVED` is
   * NOT final: the claimant has been promised money that has not arrived, and a client
   * that stopped polling there would leave them staring at "approved" with no idea when it
   * becomes cash.
   */
  @Get(CLAIM_ROUTES.DETAIL)
  async detail(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const claim = await this.claims.loadOwned(user.id, id)
    return ResponseBuilder.success(
      this.claims.describe(claim),
      claim.claimNumber,
    )
  }

  @Post(CLAIM_ROUTES.WITHDRAW)
  async withdraw(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(WithdrawClaimSchema)) dto: WithdrawClaimDto,
  ) {
    const claim = await this.claims.withdraw(user.id, id, dto.reason)
    return ResponseBuilder.success(
      {
        id: claim.id,
        claimNumber: claim.claimNumber,
        status: claim.status,
      },
      'Claim withdrawn.',
    )
  }
}
