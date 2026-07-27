import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  MockAaDecisionSchema,
  type MockAaDecisionDto,
} from '@pravaah/schema'

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { MOCK_AA_ROUTES } from '@/modules/consent/consent.route'
import { SandboxAaProvider } from '@/modules/consent/providers/aa/sandbox-aa.provider'
import { ConsentNotificationService } from '@/modules/consent/services/consent-notification.service'

/**
 * DEV-ONLY mock AA consent screen (no auth) — the SandboxAaProvider's
 * `approvalUrl` points here. It mirrors the real AA approval UX: the user sees
 * the purpose/FI types/data-life and approves or rejects. Approving drives the
 * exact same notification path a live AA webhook would (→ ACTIVE → auto-fetch).
 *
 * Refuses to run against a live provider (only the sandbox is approvable).
 */
@Controller(MOCK_AA_ROUTES.BASE)
export class MockAaController {
  private readonly logger: AppLogger

  constructor(
    private readonly sandbox: SandboxAaProvider,
    private readonly prisma: PrismaService,
    private readonly notif: ConsentNotificationService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: MockAaController.name })
  }

  @Get(MOCK_AA_ROUTES.SCREEN)
  @Header('content-type', 'text/html; charset=utf-8')
  // Relax the global helmet CSP for THIS dev-only page so its inline script /
  // onclick handlers run and its same-origin fetch isn't force-upgraded to
  // https (the sandbox backend is http). Scoped to this route only.
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
  )
  async screen(
    @Param('providerConsentId') providerConsentId: string,
    // Deep link the page redirects to after a decision so the in-app browser
    // auto-closes and returns to the app (passed by the RN auth session).
    @Query('returnUrl') returnUrl: string | undefined,
  ): Promise<string> {
    const consent = await this.findConsent(providerConsentId)
    const dataLife = `${consent.dataLifeValue} ${consent.dataLifeUnit.toLowerCase()}`
    const range = `${consent.dataRangeFrom.toISOString().slice(0, 10)} → ${consent.dataRangeTo
      .toISOString()
      .slice(0, 10)}`
    return renderScreen({
      providerConsentId,
      vua: consent.vua,
      purpose: consent.purpose,
      fiTypes: consent.fiTypes.join(', '),
      range,
      dataLife,
      status: consent.status,
      returnUrl: returnUrl ?? '',
    })
  }

  @Post(MOCK_AA_ROUTES.DECISION)
  async decide(
    @Param('providerConsentId') providerConsentId: string,
    @Body(new ZodValidationPipe(MockAaDecisionSchema)) dto: MockAaDecisionDto,
  ): Promise<{ ok: boolean; status: string }> {
    const consent = await this.findConsent(providerConsentId) // 404 if unknown
    if (consent.aaProvider !== 'sandbox') {
      throw new NotFoundException(
        'Mock AA screen is only available for sandbox consents',
      )
    }

    if (dto.decision === 'APPROVE') {
      this.sandbox.approve(providerConsentId)
      await this.notif.onConsentNotification({
        ConsentStatusNotification: {
          consentId: providerConsentId,
          consentStatus: 'ACTIVE',
        },
      })
      this.logger.info('[decide] Mock consent APPROVED', { providerConsentId })
      return { ok: true, status: 'ACTIVE' }
    }

    this.sandbox.reject(providerConsentId)
    await this.notif.onConsentNotification({
      ConsentStatusNotification: {
        consentId: providerConsentId,
        consentStatus: 'REJECTED',
      },
    })
    this.logger.info('[decide] Mock consent REJECTED', { providerConsentId })
    return { ok: true, status: 'REJECTED' }
  }

  private async findConsent(providerConsentId: string) {
    const consent = await this.prisma.consent.findUnique({
      where: { providerConsentId },
    })
    if (!consent) throw new NotFoundException('Consent not found')
    return consent
  }
}

function renderScreen(v: {
  providerConsentId: string
  vua: string
  purpose: string
  fiTypes: string
  range: string
  dataLife: string
  status: string
  returnUrl: string
}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>PRAVAAH · Account Aggregator consent</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;
    background:#0b1020;color:#e7ecf5;display:grid;place-items:center;min-height:100vh}
  .card{max-width:440px;width:92%;background:#141b30;border:1px solid #223;border-radius:16px;
    padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
  h1{font-size:18px;margin:0 0 4px} .sub{color:#8b96ad;font-size:13px;margin:0 0 18px}
  .row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid #223;font-size:14px}
  .row .k{color:#8b96ad} .row .v{text-align:right;font-weight:600}
  .actions{display:flex;gap:12px;margin-top:22px}
  button{flex:1;border:0;border-radius:10px;padding:13px;font-size:15px;font-weight:700;cursor:pointer}
  .ok{background:#3ddc97;color:#04231a} .no{background:#2a3350;color:#c9d3e6}
  .msg{margin-top:16px;font-size:14px;text-align:center;min-height:20px}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#22304f;font-size:12px}
</style></head>
<body><div class="card">
  <h1>Approve data sharing</h1>
  <p class="sub">Mock Account Aggregator · <span class="badge">${v.status}</span></p>
  <div class="row"><span class="k">VUA</span><span class="v">${v.vua}</span></div>
  <div class="row"><span class="k">Purpose</span><span class="v">${v.purpose}</span></div>
  <div class="row"><span class="k">Data requested</span><span class="v">${v.fiTypes}</span></div>
  <div class="row"><span class="k">Period</span><span class="v">${v.range}</span></div>
  <div class="row"><span class="k">We keep it for</span><span class="v">${v.dataLife}</span></div>
  <div class="actions">
    <button class="ok" onclick="decide('APPROVE')">Approve</button>
    <button class="no" onclick="decide('REJECT')">Reject</button>
  </div>
  <p class="msg" id="msg"></p>
</div>
<script>
  var RETURN_URL = ${JSON.stringify(v.returnUrl)};
  async function decide(decision){
    var msg = document.getElementById('msg');
    var btns = document.querySelectorAll('button');
    btns.forEach(function(b){ b.disabled = true; });
    msg.textContent = 'Submitting…';
    try {
      var r = await fetch(location.pathname,{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify({decision})});
      var j = await r.json();
      var ok = j.status === 'ACTIVE';
      msg.textContent = ok
        ? '✓ Approved — returning to the app…'
        : '✕ Rejected — returning to the app…';
      if (RETURN_URL) {
        setTimeout(function(){ window.location.href = RETURN_URL; }, 900);
      } else {
        msg.textContent += ' You can close this window.';
      }
    } catch (e) {
      msg.textContent = 'Something went wrong — please try again.';
      btns.forEach(function(b){ b.disabled = false; });
    }
  }
</script>
</body></html>`
}
