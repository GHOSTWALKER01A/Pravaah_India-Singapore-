#!/usr/bin/env node
/**
 * Prints the webhook headers the KYC webhook guard expects, for a given body.
 *
 *   npm run sign:webhook                 # signs the built-in sample body
 *   npm run sign:webhook -- --file body.json
 *   npm run sign:webhook -- --body '{"eventId":"e1","type":"DIGILOCKER_COMPLETED","decentroTxnId":"abc"}'
 *   echo '{"eventId":"e1"}' | npm run sign:webhook
 *
 * The guard verifies HMAC-SHA256(WEBHOOK_HMAC_SECRET, `${timestamp}.${rawBody}`)
 * over the EXACT bytes sent (bootstrap uses rawBody). So paste the printed
 * `body` line verbatim into the .http request — reformatting/whitespace changes
 * invalidate the signature. Timestamp must be within 5 minutes of the request.
 */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_BODY = JSON.stringify({
  eventId: `evt_${Date.now()}`,
  type: 'DIGILOCKER_COMPLETED',
  decentroTxnId: 'PASTE_providerRefId_FROM_OKYC_INITIATE',
})

function arg(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : undefined
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8').trim()
  } catch {
    return ''
  }
}

function loadSecret() {
  if (process.env.WEBHOOK_HMAC_SECRET) return process.env.WEBHOOK_HMAC_SECRET
  // Fall back to parsing the local env file (no dependency on dotenv).
  for (const file of ['.env.development.local', '.env']) {
    try {
      const line = readFileSync(resolve(process.cwd(), file), 'utf8')
        .split(/\r?\n/)
        .find((l) => l.startsWith('WEBHOOK_HMAC_SECRET='))
      if (line) return line.slice('WEBHOOK_HMAC_SECRET='.length).trim()
    } catch {
      // file not present — keep looking
    }
  }
  return undefined
}

const secret = loadSecret()
if (!secret) {
  console.error(
    'WEBHOOK_HMAC_SECRET not found (env or .env.development.local). Set it and retry.',
  )
  process.exit(1)
}

const bodyFile = arg('--file')
const body = (
  arg('--body') ??
  (bodyFile ? readFileSync(resolve(process.cwd(), bodyFile), 'utf8') : '') ??
  ''
).trim()
const finalBody = body || (process.stdin.isTTY ? DEFAULT_BODY : readStdin()) || DEFAULT_BODY

const timestamp = Date.now()
const signature = createHmac('sha256', secret)
  .update(`${timestamp}.${finalBody}`)
  .digest('hex')

console.log('\n# Paste these into the §9 webhook request:\n')
console.log(`x-webhook-timestamp: ${timestamp}`)
console.log(`x-webhook-signature: ${signature}`)
console.log('\n# Body (send exactly this — one line):\n')
console.log(finalBody)
console.log()
