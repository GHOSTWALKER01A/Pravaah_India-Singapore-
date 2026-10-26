import { createHmac } from 'node:crypto'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isIP } from 'node:net'

/**
 * Sign a webhook body: `hex(HMAC-SHA256(secret, "${timestamp}.${rawBody}"))`.
 *
 * Byte-for-byte the scheme `verifyHmacWebhook` checks on our own inbound
 * webhooks, so a partner verifying ours and us verifying a provider's are the same
 * code. The timestamp is inside the MAC, which is what lets the receiver enforce a
 * freshness window — a captured delivery replayed an hour later fails.
 */
export function signWebhook(
  secret: string,
  timestamp: number,
  rawBody: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')
}

export class WebhookTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebhookTargetError'
  }
}

/**
 * True for any address a webhook must never reach from our network: loopback,
 * RFC 1918, link-local (which includes the 169.254.169.254 cloud metadata
 * endpoint — the classic SSRF prize), CGNAT, benchmarking, multicast, and the
 * IPv6 equivalents, including IPv4-mapped IPv6 that would otherwise smuggle a
 * private v4 address past a v4-only check.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPrivateV4(address)
  if (family === 6) {
    const lower = address.toLowerCase()
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped?.[1]) return isPrivateV4(mapped[1])
    if (lower === '::1' || lower === '::') return true
    const first = parseInt(lower.split(':')[0] || '0', 16)
    // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
    if ((first & 0xfe00) === 0xfc00) return true
    if ((first & 0xffc0) === 0xfe80) return true
    if ((first & 0xff00) === 0xff00) return true
    return false
  }
  // Not an IP at all — never "safe" by default.
  return true
}

function isPrivateV4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

/**
 * Static checks on a webhook URL, run when a partner SAVES it and again before
 * each delivery. Scheme, credentials, and an IP-literal host are decidable here;
 * a hostname's addresses are only decidable at connect time (see
 * {@link safeLookupFor}), because DNS can change between a check and a request.
 */
export function assertWebhookUrl(
  raw: string,
  opts: { allowPrivate: boolean; requireHttps: boolean },
): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WebhookTargetError('The webhook URL is not a valid URL')
  }
  if (url.username || url.password) {
    throw new WebhookTargetError('The webhook URL must not embed credentials')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebhookTargetError('The webhook URL must use https')
  }
  if (opts.requireHttps && url.protocol !== 'https:') {
    throw new WebhookTargetError('The webhook URL must use https')
  }

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!opts.allowPrivate) {
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.internal')
    ) {
      throw new WebhookTargetError('The webhook URL must be a public host')
    }
    if (isIP(host) && isPrivateAddress(host)) {
      throw new WebhookTargetError(
        'The webhook URL must not target a private network address',
      )
    }
  }
  return url
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void

/**
 * A `dns.lookup` replacement for the delivery agent that refuses private
 * addresses AT CONNECT TIME.
 *
 * Checking the hostname's addresses before the request is not enough: an attacker
 * who controls the DNS answers public on the check and 127.0.0.1 on the connect
 * (DNS rebinding). Validating inside the socket's own lookup closes that window,
 * because the address checked is the address connected to.
 */
export function safeLookupFor(allowPrivate: boolean) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number } | number | undefined,
    callback: LookupCallback,
  ): void => {
    const opts = typeof options === 'object' && options ? options : {}
    dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err, [])
      const list = addresses
      if (!allowPrivate) {
        const blocked = list.find((entry) => isPrivateAddress(entry.address))
        if (blocked || !list.length) {
          const refusal = Object.assign(
            new Error(
              `Refusing to deliver a webhook to a private address (${hostname})`,
            ),
            { code: 'EPRIVATEADDR' },
          ) as NodeJS.ErrnoException
          return callback(refusal, [])
        }
      }
      if (opts.all) return callback(null, list)
      const first = list[0]
      return callback(null, first.address, first.family)
    })
  }
}
