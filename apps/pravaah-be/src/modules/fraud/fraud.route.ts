/**
 * M6 routes.
 *
 * Grouped by AUDIENCE rather than by entity, exactly as M4's and M5's are, and for
 * the same load-bearing reason: the user's security surface, the analyst console
 * and the telco callback each carry a different guard, and co-locating them is how
 * a guard ends up applied to the wrong half.
 *
 * M6 is mostly not a user-facing module — it is called in-process by M0/M1/M4/M5.
 * What IS user-facing is the part that builds trust: manage my devices, answer a
 * challenge, and see why I was challenged.
 */
export const SECURITY_ROUTES = {
  BASE: 'security',

  /** "Manage my devices" — the self-service ATO defence. */
  DEVICES: 'devices',
  /** Begin a bind. Returns a challenge, never a token. */
  DEVICE_BIND: 'devices/bind',
  /** Complete a bind by answering the challenge. */
  DEVICE_BIND_CONFIRM: 'devices/bind/confirm',
  /** "This wasn't me — remove it." Immediate, and never needs a challenge. */
  DEVICE_REVOKE: 'devices/:id/revoke',
  /** Re-verify a device out of SUSPECTED_SWAP after a legitimate SIM change. */
  DEVICE_RECOVER: 'devices/:id/recover',
  /** Rotate the binding token, bounding the useful life of a stolen one. */
  DEVICE_REFRESH: 'devices/:id/refresh',

  /** Ask for a challenge on an action that was told to step up. */
  STEP_UP_REQUEST: 'step-up/request',
  STEP_UP_VERIFY: 'step-up/verify',

  /**
   * The transaction PIN — Pravaah's own knowledge factor.
   *
   * Five routes because they are five different authorisations, and collapsing any two would
   * be a bypass:
   *
   *  - `PIN_STATUS` tells the app which factor to ask for. A read.
   *  - `PIN_SET` enrols, and REFUSES on an unbound device — the PIN is one half of a pair
   *    whose other half is the device.
   *  - `PIN_VERIFY` answers a challenge on an action.
   *  - `PIN_CHANGE` needs a passed BIOMETRIC challenge. Merging it into `PIN_SET` would make
   *    enrolment an unauthenticated change endpoint.
   *  - `PIN_RESET` needs a passed SMS challenge AND restarts the device cooling-off, which is
   *    what stops the reset being a way around the PIN entirely.
   */
  PIN_STATUS: 'pin',
  PIN_SET: 'pin',
  PIN_VERIFY: 'pin/verify',
  PIN_CHANGE: 'pin/change',
  PIN_RESET: 'pin/reset',
  /** Ask for the challenge that authorises a change (biometric) or a reset (SMS). */
  PIN_CHANGE_REQUEST: 'pin/change/request',
  PIN_RESET_REQUEST: 'pin/reset/request',

  /** Record what local authentication the OS says this device has. A claim, not proof. */
  BIOMETRIC_ENROL: 'biometric',

  /**
   * The transparency surface: my recent risk decisions and why they were made.
   *
   * This is the DPDP automated-decision-transparency answer made tangible, and it
   * is also the cheapest trust-building screen in the product — a user who can
   * see "held: unusual amount from a new device" does not file a support ticket.
   */
  ASSESSMENTS: 'assessments',
  /** My open holds, with a reference and an appeal route. */
  HOLDS: 'holds',
}

/**
 * The analyst console. Admin JWT + RBAC, never a user session.
 *
 * Mounted under `admin/` so no user-facing guard can be inherited onto it — the
 * inverse of the webhook concern, and just as important: a fraud queue reachable
 * with a user's own token would let a suspect read their own case.
 */
export const ADMIN_FRAUD_ROUTES = {
  BASE: 'admin/fraud',

  /** Operational overview — queue depth, SLA breaches, decision mix. */
  STATS: 'stats',

  /** Severity then SLA order. A newest-first queue starves the longest-waiting user. */
  CASES: 'cases',
  CASE_DETAIL: 'cases/:id',
  /** Atomic claim. Two analysts racing one case is a 409, not a silent overwrite. */
  CASE_CLAIM: 'cases/:id/claim',
  CASE_NOTE: 'cases/:id/note',
  CASE_RESOLVE: 'cases/:id/resolve',
  /** Ask the user for something, pausing the SLA clock. */
  CASE_REQUEST_INFO: 'cases/:id/request-info',

  /** Every assessment, filterable. The model's behaviour, inspectable. */
  ASSESSMENTS: 'assessments',
  ASSESSMENT_DETAIL: 'assessments/:id',

  /** Watchlist / blocklist / mule registry / sanctions. */
  LISTS: 'lists',
  LIST_REMOVE: 'lists/remove',

  /** One user's full risk picture — devices, links, cases, recent decisions. */
  USER_PROFILE: 'users/:userId',
  /** Suspend or restore an account. The heaviest control an analyst has. */
  USER_SUSPEND: 'users/:userId/suspend',

  /** The mule graph around one user, for the ring view. */
  GRAPH_NEIGHBOURHOOD: 'graph/:userId',
  /** Force the async cluster recompute now, for a demo or after a seed. */
  GRAPH_RECOMPUTE: 'graph/recompute',
}

/**
 * Telco SIM-change callbacks. Unauthenticated by session, verified by HMAC over
 * the raw bytes.
 *
 * Deliberately outside every prefixed group so no session guard can be inherited:
 * a telco has no JWT, and a webhook route that silently required one would fail
 * every SIM-swap notification with a 401 nobody was watching — which is a fraud
 * control that reports success while being switched off.
 */
export const FRAUD_WEBHOOK_ROUTES = {
  BASE: 'webhooks/fraud',
  TELCO: 'telco/:provider',
}

/**
 * The mock telco's own surface, for development and demos.
 *
 * Refused outright in production. These endpoints can flip a device into
 * `SUSPECTED_SWAP` — exactly the authority a real telco has, and exactly what
 * must never be reachable against real accounts.
 */
export const MOCK_TELCO_ROUTES = {
  BASE: 'mock/telco',
  /** Fire a correctly signed SIM-change callback at ourselves. */
  SIM_SWAP: 'sim-swap',
  /** Sign a body without sending it, so a client can replay it by hand. */
  SIGN: 'sign',
}
