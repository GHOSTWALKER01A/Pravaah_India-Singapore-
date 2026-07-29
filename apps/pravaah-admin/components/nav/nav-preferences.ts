/**
 * The drawer's remembered preferences, as external stores rather than React state.
 *
 * `localStorage` and `matchMedia` ARE external systems, so they are read through
 * `useSyncExternalStore` instead of being copied into state inside an effect. That is not
 * only what the lint rule asks for — it removes the hydration dance entirely: the store
 * hands React a server snapshot during SSR and the real value on the client, with no
 * cascading render and no `mounted` flag threaded through every component.
 *
 * A `storage` listener keeps two open tabs in agreement, which an operator with the
 * ledger on one screen and a KYC queue on the other will otherwise notice.
 */

type Listener = () => void;

interface Preference<T> {
  subscribe: (listener: Listener) => () => void;
  get: () => T;
  getServer: () => T;
  set: (value: T) => void;
}

function createPreference<T>(
  key: string,
  fallback: T,
  decode: (raw: string) => T | null,
  encode: (value: T) => string,
): Preference<T> {
  // `getSnapshot` must be referentially stable or React re-renders forever, so the parsed
  // value is cached rather than re-derived on every read.
  let cache: T = fallback;
  let loaded = false;
  const listeners = new Set<Listener>();

  const read = (): T => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      return decode(raw) ?? fallback;
    } catch {
      // Safari in private mode throws on storage access. A navigation that cannot
      // remember a preference is fine; one that crashes the console is not.
      return fallback;
    }
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      const onStorage = (event: StorageEvent) => {
        if (event.key !== null && event.key !== key) return;
        loaded = false;
        notify();
      };
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener('storage', onStorage);
      };
    },
    get() {
      if (!loaded) {
        cache = read();
        loaded = true;
      }
      return cache;
    },
    getServer() {
      return fallback;
    },
    set(value) {
      cache = value;
      loaded = true;
      try {
        window.localStorage.setItem(key, encode(value));
      } catch {
        /* the preference is optional; the navigation is not */
      }
      notify();
    },
  };
}

/** Desktop: the drawer is an icon rail. */
export const collapsedPreference = createPreference<boolean>(
  'pravaah.admin.sidebar.collapsed',
  false,
  (raw) => raw === '1',
  (value) => (value ? '1' : '0'),
);

/** Which groups the operator has shut. Absent means open. */
export const groupsPreference = createPreference<Record<string, boolean>>(
  'pravaah.admin.sidebar.groups',
  {},
  (raw) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') return null;
      // Filtered to booleans rather than cast: this is user-editable storage, and a
      // hand-mangled entry must not put a non-boolean into the open/closed test.
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          ([, value]) => typeof value === 'boolean',
        ),
      ) as Record<string, boolean>;
    } catch {
      return null;
    }
  },
  (value) => JSON.stringify(value),
);

// ── viewport ────────────────────────────────────────────────────────────────
/** Matches Tailwind's `lg`. Below it the drawer is an overlay, above it a rail. */
const DESKTOP_QUERY = '(min-width: 1024px)';

export function subscribeDesktop(listener: Listener): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

export function getDesktopSnapshot(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

/**
 * Assume desktop on the server.
 *
 * The drawer is page furniture at `lg` and an off-canvas overlay below it, and the
 * server cannot know which. Guessing desktop renders the nav visible-but-static, which
 * degrades to a harmless flash of a wide sidebar on a phone; guessing mobile would render
 * the primary navigation `inert` and translated off-screen for every desktop visitor
 * until JavaScript arrived.
 */
export function getDesktopServerSnapshot(): boolean {
  return true;
}
