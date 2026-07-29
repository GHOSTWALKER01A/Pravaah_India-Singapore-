import * as SecureStore from 'expo-secure-store';

import { readBiometricCapability } from './biometric';

/**
 * The persisted session, held behind hardware-enforced authentication.
 *
 * ## What this replaces, and why the old behaviour was the actual bug
 *
 * `token-manager.ts` keeps tokens in module state, so every cold start had no session and the
 * user re-entered an SMS OTP. That is what made the login OTP feel like it fired "every time" —
 * it did, and it was not a security control, it was a missing feature wearing one's clothes.
 *
 * It is worth being precise about why that is worse than it sounds. An OTP on every launch
 * trains the user to expect a code, type it without reading it, and treat the arrival of one as
 * routine. That is the exact conditioning every OTP phishing script depends on. A relaunch that
 * asks for a fingerprint instead is both less friction AND a stronger factor.
 *
 * ## Why the REFRESH token and not the access token
 *
 * The access token lives 12 hours and the refresh token 30 days. Persisting the access token
 * would mean a session that silently dies within a day, and the app would fall back to an OTP
 * anyway. Storing the refresh token and exchanging it at unlock gets a fresh pair each launch,
 * which also rotates it — `TokenService.refresh` mints a new pair rather than reusing the old
 * one, so a token captured from one launch is spent by the next.
 *
 * ## Why `requireAuthentication` rather than authenticating and then reading
 *
 * This is the load-bearing choice. With `requireAuthentication: true` the value is encrypted
 * under a Keychain/Keystore key the OS refuses to release until it has authenticated the user.
 * The app CANNOT read the token and then decide whether it should have — the read itself fails.
 *
 * The tempting alternative — call `authenticateAsync`, and on success read a normally-stored
 * token — is materially weaker in a way that is easy to miss: the check and the secret are
 * independent, so anything that skips the check still gets the secret. Extracted app storage on
 * a rooted device, a patched binary, a debugger attached to the JS thread. Here there is nothing
 * to skip, because the ciphertext is useless without the OS releasing the key.
 *
 * ## What this deliberately does NOT store
 *
 * No PIN, and no hash of one. The PIN is verified server-side against a bcrypt hash for the
 * whole reason the feature exists: a locally-checked PIN is a comparison an attacker with the
 * handset controls both sides of. There is nothing about the PIN worth keeping here.
 */

/**
 * Keychain/Keystore item ids, versioned like `device-identity.ts`.
 *
 * `.v1` so a later migration — to a per-user item, or to a hardware-attested scheme — can be
 * introduced alongside rather than silently reinterpreting these bytes.
 */
const SESSION_ITEM = 'pravaah.security.session.v1';

/**
 * A PLAIN, ungated marker recording that a session was persisted.
 *
 * ## Why a second item is necessary and not redundant
 *
 * When the user adds a fingerprint or re-enrols their face, the OS invalidates every key that
 * gated on the old enrolment — and `getItemAsync` then returns **null**, exactly as it does
 * when nothing was ever stored. Those two cases need opposite handling and are otherwise
 * indistinguishable:
 *
 *  - nothing stored → this is a first run or a signed-out app. Show the phone-number screen.
 *  - stored but unreadable → the credential was invalidated, or the user declined the prompt.
 *    Say so, offer to try again, and only then fall back to signing in with a code.
 *
 * Without the marker, a user who added a fingerprint would be dropped onto a login screen with
 * no explanation and no idea they had not been signed out. With it, they get told what happened.
 *
 * It holds no secret — a boolean and a timestamp — so gating it would only mean an
 * authentication prompt to discover whether there is anything to prompt for.
 */
const SESSION_MARKER_ITEM = 'pravaah.security.sessionMarker.v1';

/**
 * A keychain service name, so these items are addressed consistently.
 *
 * Android requires the same value at read as at write — omitting it on one side yields a null
 * read that looks exactly like an invalidated key, which would send a perfectly good session
 * down the recovery path on every launch.
 */
const KEYCHAIN_SERVICE = 'pravaah.session';

export interface PersistedSession {
  refreshToken: string;
  /** The user this session belongs to, so a restore can be sanity-checked against `/users/me`. */
  userId: string;
  /** When it was written, for the staleness check below. */
  savedAt: number;
}

export type SessionMarker = {
  /** True once a session has been written and not explicitly cleared. */
  present: boolean;
  savedAt: number;
};

/** Why a restore did not produce a session. Each drives different copy on the unlock screen. */
export type RestoreFailure =
  /** Nothing was ever stored, or the user signed out. Not an error. */
  | 'ABSENT'
  /** The user dismissed the OS prompt. Offer the prompt again. */
  | 'DECLINED'
  /**
   * The stored value is gone or undecryptable although the marker says it existed — almost
   * always a biometric re-enrolment. The user must sign in with a code once.
   */
  | 'INVALIDATED'
  /** Older than the refresh token's own life. Nothing to salvage. */
  | 'EXPIRED'
  /** The keystore is unavailable on this device. Sessions cannot be persisted here at all. */
  | 'UNAVAILABLE';

export type RestoreResult =
  | { ok: true; session: PersistedSession }
  | { ok: false; failure: RestoreFailure };

/**
 * The server's refresh token lives 30 days. Treating anything older as spent avoids handing a
 * certainly-dead token to the API and rendering the resulting 401 as a mysterious failure —
 * the user is told to sign in again, which is the truth.
 *
 * Slightly SHORTER than the server's window on purpose. A client clock that has drifted
 * forward would otherwise keep offering a token the server has already rejected.
 */
const MAX_SESSION_AGE_MS = 29 * 24 * 60 * 60 * 1000;

/**
 * Whether this device can hold a session at all.
 *
 * False on a handset with no lock screen — and that is a real device class, not a hypothetical.
 * The honest consequence is stated to the user rather than worked around: without a lock screen
 * there is no key to gate the token under, so persisting it would mean writing a 30-day
 * credential in the clear on a phone anyone who picks it up can already open. An SMS code every
 * launch is worse UX and better security, so that is what those devices get.
 */
export async function canPersistSession(): Promise<boolean> {
  const capability = await readBiometricCapability();
  return capability.canGateStorage;
}

/**
 * Store the session behind the device's own authentication.
 *
 * Returns whether it was actually persisted, and NEVER throws. A failure to save must not fail
 * the sign-in that produced it: the user is already authenticated, the in-memory session is
 * live, and the only consequence of not persisting is that the next launch asks for a code. An
 * exception here would instead throw away a completed login.
 */
export async function saveSession(params: {
  refreshToken: string;
  userId: string;
}): Promise<boolean> {
  if (!(await canPersistSession())) return false;

  const payload: PersistedSession = {
    refreshToken: params.refreshToken,
    userId: params.userId,
    savedAt: Date.now(),
  };

  try {
    await SecureStore.setItemAsync(SESSION_ITEM, JSON.stringify(payload), {
      requireAuthentication: true,
      keychainService: KEYCHAIN_SERVICE,
      authenticationPrompt: 'Confirm it is you to keep you signed in',
      /**
       * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` — iOS only, and both halves matter.
       *
       * `THIS_DEVICE_ONLY` keeps the item out of encrypted iCloud backups, so restoring a
       * backup onto a different handset does not carry a live session with it. That would be a
       * silent bypass of the entire device-binding layer: the restored phone would arrive
       * already signed in, on a device the server has never seen bound.
       *
       * `WHEN_UNLOCKED` rather than `AFTER_FIRST_UNLOCK` because nothing here runs in the
       * background — there is no push handler or background fetch that needs the session while
       * the phone is locked, so the wider window would buy nothing.
       */
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });

    /**
     * The marker is written AFTER the gated item, and that order is deliberate.
     *
     * The reverse would leave a marker claiming a session exists when the write that mattered
     * failed — and the launch gate would then insist on recovering something that was never
     * there, on every launch, with no way out but a reinstall.
     */
    await SecureStore.setItemAsync(
      SESSION_MARKER_ITEM,
      JSON.stringify({ present: true, savedAt: payload.savedAt }),
      { keychainService: KEYCHAIN_SERVICE },
    );

    return true;
  } catch {
    /**
     * Clear a half-written state rather than leaving one behind.
     *
     * On Android the gated write itself prompts, so a user who dismisses that prompt lands
     * here — a normal outcome, not a fault. Leaving a gated item with no marker would make the
     * next launch's null read look like a first run, which is at least harmless; leaving a
     * marker with no item would make it look like invalidation forever, which is not.
     */
    await forgetSession();
    return false;
  }
}

/**
 * What we know WITHOUT prompting: whether there is a session to unlock.
 *
 * Read first by the launch gate, so a first-run install goes straight to the phone-number
 * screen and never sees an authentication prompt for a session that does not exist. Prompting
 * on a fresh install would be a small thing that reads as a broken app.
 */
export async function readSessionMarker(): Promise<SessionMarker> {
  try {
    const raw = await SecureStore.getItemAsync(SESSION_MARKER_ITEM, {
      keychainService: KEYCHAIN_SERVICE,
    });
    if (!raw) return { present: false, savedAt: 0 };

    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as SessionMarker).present !== true
    ) {
      return { present: false, savedAt: 0 };
    }

    const savedAt = (parsed as SessionMarker).savedAt;
    return {
      present: true,
      savedAt: typeof savedAt === 'number' ? savedAt : 0,
    };
  } catch {
    return { present: false, savedAt: 0 };
  }
}

/**
 * Prompt, and return the session if the OS releases it.
 *
 * This is the call that shows the fingerprint sheet — reading IS authenticating, which is the
 * whole point of the design. It must therefore only be made in response to a deliberate user
 * action (opening the app, tapping "Unlock"), never speculatively on a render.
 */
export async function restoreSession(): Promise<RestoreResult> {
  const marker = await readSessionMarker();
  if (!marker.present) return { ok: false, failure: 'ABSENT' };

  if (!(await canPersistSession())) {
    /**
     * A marker exists but the device can no longer gate storage — the user removed their
     * screen lock after signing in.
     *
     * `INVALIDATED`, not `UNAVAILABLE`: removing the lock screen destroys the key, so the
     * token is unrecoverable rather than merely unreadable right now, and the marker must go
     * so the next launch is a clean first run.
     */
    await forgetSession();
    return { ok: false, failure: 'INVALIDATED' };
  }

  if (isStale(marker.savedAt)) {
    await forgetSession();
    return { ok: false, failure: 'EXPIRED' };
  }

  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(SESSION_ITEM, {
      requireAuthentication: true,
      keychainService: KEYCHAIN_SERVICE,
      authenticationPrompt: 'Unlock Pravaah',
    });
  } catch {
    /**
     * A THROWN read is a declined or failed prompt; a NULL read is an invalidated key. The two
     * are different outcomes and the platforms do not agree on which they use, so both are
     * handled — this branch and the `!raw` one below.
     *
     * `DECLINED` keeps the marker, because the token is intact and another tap will get it.
     * Deleting it here would sign out every user who fat-fingered the sheet once.
     */
    return { ok: false, failure: 'DECLINED' };
  }

  if (!raw) {
    /**
     * The marker says a session was stored and the OS says there is nothing there. The key was
     * invalidated — a new fingerprint, a re-enrolled face, a changed passcode on some builds.
     *
     * Documented behaviour rather than a guess: SecureStore returns null for values whose
     * `requireAuthentication` key the system has invalidated.
     */
    await forgetSession();
    return { ok: false, failure: 'INVALIDATED' };
  }

  const session = parseSession(raw);
  if (!session) {
    await forgetSession();
    return { ok: false, failure: 'INVALIDATED' };
  }

  if (isStale(session.savedAt)) {
    await forgetSession();
    return { ok: false, failure: 'EXPIRED' };
  }

  return { ok: true, session };
}

/**
 * Drop the persisted session.
 *
 * Called on sign-out, on any unrecoverable restore, and — importantly — when the server reports
 * this device as `SUSPECTED_SWAP` or its integrity as compromised. In that last case the
 * biometric may well pass and still not mean what it usually means, so the session it would
 * unlock has to stop existing. See `use-unlock.ts`.
 *
 * The marker is deleted FIRST. If the second delete fails, what is left is an unreadable
 * orphan that no code path consults — whereas the reverse order would leave a marker pointing
 * at nothing, and the launch gate would report invalidation on every launch forever.
 */
export async function forgetSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SESSION_MARKER_ITEM, {
      keychainService: KEYCHAIN_SERVICE,
    });
  } catch {
    // Nothing to do — the read path treats an unparseable marker as absent.
  }
  try {
    await SecureStore.deleteItemAsync(SESSION_ITEM, {
      requireAuthentication: true,
      keychainService: KEYCHAIN_SERVICE,
    });
  } catch {
    /**
     * On Android a gated DELETE can itself prompt, so this can fail when the user dismisses
     * it. Swallowed: the marker is already gone, so the value is unreachable by any code here,
     * and the next `saveSession` overwrites it.
     */
  }
}

function parseSession(raw: string): PersistedSession | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const candidate = parsed as Partial<PersistedSession>;
    if (
      typeof candidate.refreshToken !== 'string' ||
      candidate.refreshToken.length === 0 ||
      typeof candidate.userId !== 'string' ||
      candidate.userId.length === 0
    ) {
      return null;
    }

    return {
      refreshToken: candidate.refreshToken,
      userId: candidate.userId,
      savedAt:
        typeof candidate.savedAt === 'number' ? candidate.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * `savedAt === 0` is NOT stale.
 *
 * A marker written by an older build, or one whose timestamp failed to parse, reads as 0 — and
 * treating that as "saved at the epoch" would expire every such session on sight. The unknown
 * case defers to the server, which is the only party that can actually judge the token.
 */
function isStale(savedAt: number): boolean {
  if (!savedAt) return false;
  return Date.now() - savedAt > MAX_SESSION_AGE_MS;
}
