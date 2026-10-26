import { verifyHmacWebhook } from '@/common/http/webhook-signature.util'

import {
  WebhookTargetError,
  assertWebhookUrl,
  isPrivateAddress,
  signWebhook,
} from '@/modules/partner/partner-webhook.util'

/**
 * Outbound webhook safety: the signature a partner verifies, and the SSRF wall in
 * front of every delivery.
 */
describe('signWebhook', () => {
  it('produces exactly what our own inbound verifier accepts — one signing scheme in the product', () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'verification.approved' })
    const timestamp = Date.now()
    const signature = signWebhook('whsec_test', timestamp, body)

    expect(
      verifyHmacWebhook({
        signature,
        timestamp,
        rawBody: body,
        secret: 'whsec_test',
      }),
    ).toEqual({ ok: true })
  })

  it('binds the timestamp, so a replayed delivery with a fresh timestamp fails', () => {
    const body = '{"id":"evt_1"}'
    const signature = signWebhook('whsec_test', 1_000, body)
    expect(
      verifyHmacWebhook({
        signature,
        timestamp: Date.now(),
        rawBody: body,
        secret: 'whsec_test',
      }).ok,
    ).toBe(false)
  })

  it('binds the body, so a tampered payload fails', () => {
    const timestamp = Date.now()
    const signature = signWebhook('whsec_test', timestamp, '{"approved":false}')
    expect(
      verifyHmacWebhook({
        signature,
        timestamp,
        rawBody: '{"approved":true}',
        secret: 'whsec_test',
      }).ok,
    ).toBe(false)
  })
})

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata — the classic SSRF prize
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1', // IPv4-mapped — must not smuggle loopback past a v4 check
    '::ffff:10.0.0.1',
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows public %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false)
  })
})

describe('assertWebhookUrl', () => {
  const strict = { allowPrivate: false, requireHttps: true }

  it('accepts a public https URL', () => {
    expect(
      assertWebhookUrl('https://hooks.lender.example.sg/pravaah', strict)
        .hostname,
    ).toBe('hooks.lender.example.sg')
  })

  it.each([
    ['http://hooks.lender.example.sg/x', 'plain http in production'],
    ['https://user:pass@hooks.lender.example.sg/x', 'embedded credentials'],
    ['https://127.0.0.1/x', 'loopback literal'],
    ['https://[::1]/x', 'IPv6 loopback literal'],
    ['https://169.254.169.254/latest/meta-data', 'metadata endpoint'],
    ['https://localhost/x', 'localhost'],
    ['https://db.internal/x', '.internal host'],
    ['ftp://hooks.lender.example.sg/x', 'non-http scheme'],
    ['not a url', 'garbage'],
  ])('refuses %s (%s)', (url) => {
    expect(() => assertWebhookUrl(url, strict)).toThrow(WebhookTargetError)
  })

  it('lets a developer target localhost only when explicitly allowed', () => {
    expect(() =>
      assertWebhookUrl('http://localhost:4000/hook', {
        allowPrivate: true,
        requireHttps: false,
      }),
    ).not.toThrow()
  })
})
