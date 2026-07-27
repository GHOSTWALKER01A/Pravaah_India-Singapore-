/**
 * Access/refresh token store.
 *
 * Currently in-memory (cleared on app restart). To persist across launches,
 * swap the internals for `expo-secure-store`:
 *   await SecureStore.setItemAsync('accessToken', token)
 * and hydrate `load()` on boot. The public API stays the same, so nothing
 * else has to change.
 */
let accessToken: string | null = null;
let refreshToken: string | null = null;

export const tokenManager = {
  getAccessToken: (): string | null => accessToken,
  getRefreshToken: (): string | null => refreshToken,
  setTokens: (access: string, refresh: string): void => {
    accessToken = access;
    refreshToken = refresh;
  },
  clear: (): void => {
    accessToken = null;
    refreshToken = null;
  },
  isAuthenticated: (): boolean => Boolean(accessToken),
};
