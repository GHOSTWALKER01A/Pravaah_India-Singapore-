import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import nodemailer, { type Transporter } from 'nodemailer'

import { ENV } from '@/constants/environment.constants'

export type KycDecisionKind = 'APPROVED' | 'REJECTED' | 'INFO_REQUESTED'

/**
 * Transactional email over SMTP (nodemailer). Mirrors {@link SmsService}: it
 * reads config from env, exposes {@link isEnabled}, and self-disables (no-throw)
 * when SMTP env is absent — so the app runs in dev without mail credentials and
 * a delivery failure never breaks the request path.
 */
@Injectable()
export class EmailService {
  private readonly logger: AppLogger
  private transporter: Transporter | null = null

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: EmailService.name })
  }

  isEnabled(): boolean {
    return Boolean(
      this.config.get<string>(ENV.SMTP.HOST) &&
        this.config.get<string>(ENV.SMTP.USER) &&
        this.config.get<string>(ENV.SMTP.PASSWORD),
    )
  }

  /** Lazily build (and reuse) the SMTP transport. */
  private getTransport(): Transporter {
    if (this.transporter) return this.transporter
    this.transporter = nodemailer.createTransport({
      host: this.config.getOrThrow<string>(ENV.SMTP.HOST),
      port: Number(this.config.get<string>(ENV.SMTP.PORT) ?? 587),
      secure: this.config.get<string>(ENV.SMTP.SECURE) === 'true',
      auth: {
        user: this.config.getOrThrow<string>(ENV.SMTP.USER),
        pass: this.config.getOrThrow<string>(ENV.SMTP.PASSWORD),
      },
    })
    return this.transporter
  }

  private from(): string {
    // Matches the .env.example convention: a display name + address, combined
    // into "Name <address>". Falls back to a single SMTP_FROM, then the user.
    const name = this.config.get<string>('SMTP_FROM_NAME')
    const address =
      this.config.get<string>('SMTP_FROM_ADDRESS') ??
      this.config.get<string>(ENV.SMTP.FROM) ??
      this.config.getOrThrow<string>(ENV.SMTP.USER)
    return name ? `${name} <${address}>` : address
  }

  /**
   * Notify a user of their KYC decision. Never throws — a mail failure is logged
   * and swallowed so it cannot roll back the reviewer's decision.
   */
  async sendKycDecision(input: {
    to: string
    name: string | null
    decision: KycDecisionKind
    notes?: string
  }): Promise<{ sent: boolean }> {
    if (!this.isEnabled()) {
      this.logger.warn(
        `[${this.sendKycDecision.name}] SMTP not configured — skipping email`,
        { decision: input.decision },
      )
      return { sent: false }
    }

    const { subject, html, text } = renderKycDecision(input)
    try {
      const info = await this.getTransport().sendMail({
        from: this.from(),
        to: input.to,
        subject,
        text,
        html,
      })
      this.logger.info(`[${this.sendKycDecision.name}] Decision email sent`, {
        decision: input.decision,
        messageId: info.messageId,
      })
      return { sent: true }
    } catch (error) {
      this.logger.error(
        `[${this.sendKycDecision.name}] Failed to send decision email`,
        { err: error },
      )
      return { sent: false }
    }
  }
}

/** Plain, brand-consistent copy per decision. Kept pure for easy testing. */
function renderKycDecision(input: {
  name: string | null
  decision: KycDecisionKind
  notes?: string
}): { subject: string; html: string; text: string } {
  const hello = input.name ? `Hi ${input.name},` : 'Hi,'
  const notesLine = input.notes ? `\n\nReviewer note: ${input.notes}` : ''

  if (input.decision === 'APPROVED') {
    const body = `${hello}\n\nGreat news — your Pravaah verification is complete and your reputation passport is now VERIFIED. You can open the app to view it.${notesLine}\n\n— Team Pravaah`
    return {
      subject: 'Your Pravaah verification is approved ✅',
      text: body,
      html: wrap(
        `<h2>You're verified ✅</h2><p>${escapeHtml(hello)}</p><p>Your Pravaah verification is complete and your reputation passport is now <strong>VERIFIED</strong>. Open the app to view it.</p>${notesHtml(input.notes)}`,
      ),
    }
  }
  if (input.decision === 'REJECTED') {
    const body = `${hello}\n\nWe were unable to approve your Pravaah verification at this time.${notesLine}\n\nYou can review your details and try again in the app.\n\n— Team Pravaah`
    return {
      subject: 'Update on your Pravaah verification',
      text: body,
      html: wrap(
        `<h2>Verification update</h2><p>${escapeHtml(hello)}</p><p>We were unable to approve your Pravaah verification at this time. You can review your details and try again in the app.</p>${notesHtml(input.notes)}`,
      ),
    }
  }
  const body = `${hello}\n\nWe need a little more information to finish your Pravaah verification. Please open the app to continue.${notesLine}\n\n— Team Pravaah`
  return {
    subject: 'Action needed on your Pravaah verification',
    text: body,
    html: wrap(
      `<h2>More info needed</h2><p>${escapeHtml(hello)}</p><p>We need a little more information to finish your verification. Please open the app to continue.</p>${notesHtml(input.notes)}`,
    ),
  }
}

function notesHtml(notes?: string): string {
  return notes
    ? `<p style="color:#555"><em>Reviewer note: ${escapeHtml(notes)}</em></p>`
    : ''
}

function wrap(inner: string): string {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:auto;padding:24px;color:#111">${inner}<hr style="border:none;border-top:1px solid #eee;margin:24px 0"/><p style="color:#888;font-size:12px">Team Pravaah · This is an automated message.</p></div>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
