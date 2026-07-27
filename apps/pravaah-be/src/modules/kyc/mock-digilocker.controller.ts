import { Controller, Get, Header, Query } from '@nestjs/common'

import { KYC_ROUTES } from '@/modules/kyc/kyc.route'
import { DevIndiaKycProvider } from '@/modules/kyc/providers/india/dev-india-kyc.provider'

/**
 * Dev-only DigiLocker consent simulation. It stands in for the real
 * MeriPehchaan / DigiLocker OAuth consent screen so the Aadhaar OKYC flow is
 * HONEST end-to-end without live Decentro: the user must explicitly grant or
 * decline consent here, and only an explicit grant lets the OKYC fetch return
 * data. Public (no bearer) because it is opened in the system browser. In live
 * mode Decentro hosts the real screen and this route is never used.
 */
@Controller(KYC_ROUTES.BASE)
export class MockDigilockerController {
  constructor(private readonly dev: DevIndiaKycProvider) {}

  @Get(KYC_ROUTES.OKYC_MOCK_CONSENT)
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  consent(@Query('ref') ref?: string, @Query('action') action?: string): string {
    if (!ref) {
      return shell(
        'Invalid request',
        `<p class="muted">This consent link is missing its reference. Please return to the app and start Aadhaar verification again.</p>`,
      )
    }

    if (action === 'approve') {
      const known = this.dev.markConsent(ref, true)
      return known ? resultPage(true) : expiredPage()
    }
    if (action === 'deny') {
      this.dev.markConsent(ref, false)
      return resultPage(false)
    }

    return consentPage(ref)
  }
}

const BRAND = '#4F46E5'

/** The consent form: what will be shared, with Approve / Decline actions. */
function consentPage(ref: string): string {
  const r = encodeURIComponent(ref)
  return shell(
    'Aadhaar Offline KYC',
    `
    <div class="badge">DigiLocker · Government of India (sandbox)</div>
    <h1>Share your Aadhaar details</h1>
    <p class="muted">
      <strong>Pravaah</strong> is requesting your consent to retrieve the
      following from your DigiLocker-issued Aadhaar, for the sole purpose of
      identity verification (KYC):
    </p>
    <ul class="scopes">
      <li>Name as per Aadhaar</li>
      <li>Date of birth</li>
      <li>Address</li>
      <li>Masked Aadhaar number (last 4 digits only)</li>
      <li>Photograph</li>
    </ul>
    <p class="fineprint">
      Your full Aadhaar number is never shared. You may decline without
      affecting other verification options.
    </p>
    <div class="actions">
      <a class="btn primary" href="?ref=${r}&action=approve">Approve &amp; share</a>
      <a class="btn ghost" href="?ref=${r}&action=deny">Decline</a>
    </div>
  `,
  )
}

/** Result after the user approves or declines — tells them to return to the app. */
function resultPage(approved: boolean): string {
  return shell(
    approved ? 'Consent granted' : 'Consent declined',
    `
    <div class="status ${approved ? 'ok' : 'no'}">${approved ? '✓' : '✕'}</div>
    <h1>${approved ? 'Consent granted' : 'Consent declined'}</h1>
    <p class="muted">
      ${
        approved
          ? 'Your Aadhaar details are ready to be retrieved. Return to the Pravaah app and tap “I’ve finished — verify” to continue.'
          : 'You declined to share your Aadhaar details. Return to the Pravaah app — you can try again or choose another verification method.'
      }
    </p>
  `,
  )
}

function expiredPage(): string {
  return shell(
    'Session expired',
    `<p class="muted">This consent session is no longer valid. Return to the app and start Aadhaar verification again.</p>`,
  )
}

/** Shared, self-contained styled HTML document. */
function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · Pravaah</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; background: #f4f4f5;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #18181b;
  }
  .card {
    width: 100%; max-width: 440px; background: #fff; border: 1px solid #e4e4e7;
    border-radius: 16px; padding: 28px; box-shadow: 0 8px 30px rgba(0,0,0,.06);
  }
  .badge {
    display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .5px;
    color: ${BRAND}; background: ${BRAND}14; padding: 6px 10px; border-radius: 999px; margin-bottom: 16px;
  }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .muted { color: #52525b; font-size: 14px; line-height: 1.55; margin: 0 0 16px; }
  .fineprint { color: #a1a1aa; font-size: 12px; line-height: 1.5; margin: 0 0 20px; }
  ul.scopes { margin: 0 0 16px; padding: 0; list-style: none; }
  ul.scopes li {
    font-size: 14px; padding: 10px 12px; border: 1px solid #e4e4e7; border-radius: 10px;
    margin-bottom: 8px; background: #fafafa;
  }
  ul.scopes li::before { content: "🔒"; margin-right: 8px; }
  .actions { display: flex; flex-direction: column; gap: 10px; }
  .btn {
    display: block; text-align: center; text-decoration: none; font-size: 15px; font-weight: 600;
    padding: 14px; border-radius: 12px;
  }
  .btn.primary { background: ${BRAND}; color: #fff; }
  .btn.ghost { background: transparent; color: #52525b; border: 1px solid #e4e4e7; }
  .status { font-size: 40px; text-align: center; width: 72px; height: 72px; line-height: 72px; border-radius: 50%; margin: 0 auto 16px; }
  .status.ok { background: #10b98122; color: #10b981; }
  .status.no { background: #ef444422; color: #ef4444; }
  @media (prefers-color-scheme: dark) {
    body { background: #09090b; color: #fafafa; }
    .card { background: #18181b; border-color: #27272a; }
    .muted { color: #a1a1aa; }
    ul.scopes li { background: #0f0f11; border-color: #27272a; }
    .btn.ghost { color: #a1a1aa; border-color: #3f3f46; }
  }
</style>
</head>
<body>
  <div class="card">${body}</div>
</body>
</html>`
}
