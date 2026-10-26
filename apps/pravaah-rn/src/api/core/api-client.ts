import { API_BASE_URL, API_ENDPOINTS } from '@/constants/api.constants';

import { tokenManager } from '@/api/auth/token-manager';

import { ApiResponse } from './api.schema';
import { ApiError } from './error.types';
import {
  sendJson,
  sendMultipart,
  TransportError,
  type TransportResponse,
} from './transport';

/** A JSON request body — any plain object, including typed request interfaces. */
type Json = object;

/**
 * Deadlines. Generous for JSON because a payment call waits on a rail round-trip server-side;
 * far longer for uploads because a full-resolution photo on 3G is legitimately slow and the
 * server runs OCR and a tamper check before it answers.
 */
const JSON_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A plain object (sent as JSON) or a FormData (sent as multipart). */
  body?: Json | FormData;
  auth?: boolean;
  /**
   * Extra request headers. Added for M4, which requires an `Idempotency-Key` on
   * every money-moving request.
   *
   * It matters that these live on the options object rather than being passed
   * separately to `fetch`: the 401 refresh path below RE-RUNS `raw()` with the
   * same options, so a retried request carries the SAME idempotency key. Minting
   * the key inside the client instead would give the retry a new one, and the
   * server would treat it as a second payment — the exact failure idempotency
   * exists to prevent.
   */
  headers?: Record<string, string>;
}

/**
 * Fetch-based HTTP client for the pravaah-be API. Attaches the bearer token,
 * transparently refreshes it once on a 401, and unwraps the `{ data }`
 * envelope. Kept dependency-free (no axios) so the RN bundle stays lean.
 */
class ApiClient {
  private refreshing: Promise<boolean> | null = null;

  private buildUrl(path: string): string {
    const clean = path.startsWith('/') ? path.slice(1) : path;
    return `${API_BASE_URL}/${clean}`;
  }

  private async raw<T>(path: string, options: RequestOptions): Promise<T> {
    // Multipart bodies must NOT set Content-Type — fetch generates the
    // `multipart/form-data; boundary=...` header itself.
    const isForm =
      typeof FormData !== 'undefined' && options.body instanceof FormData;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!isForm) headers['Content-Type'] = 'application/json';
    if (options.auth !== false) {
      const token = tokenManager.getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    // Caller headers last, so an explicit one wins. The bearer is still correct on
    // a retry because `raw()` re-reads it from the token manager on every attempt —
    // the refresh path replays these same options, it does not reuse this object.
    Object.assign(headers, options.headers);

    const url = this.buildUrl(path);
    const method = options.method ?? 'GET';

    let res: TransportResponse;
    try {
      res = isForm
        ? // Multipart goes over XHR, never `fetch` — see transport.ts for why.
          await sendMultipart(url, options.body as FormData, {
            method,
            headers,
            timeoutMs: UPLOAD_TIMEOUT_MS,
          })
        : await sendJson(
            url,
            options.body ? JSON.stringify(options.body) : undefined,
            { method, headers, timeoutMs: JSON_TIMEOUT_MS },
          );
    } catch (error) {
      // `status: 0` for BOTH kinds: neither produced an HTTP response, so the request may or
      // may not have reached the server. `code` tells them apart for anyone who needs to.
      const timedOut = error instanceof TransportError && error.kind === 'TIMEOUT';
      throw new ApiError({
        message: timedOut
          ? 'The server is taking too long to respond. Check your connection and try again.'
          : `Can't reach the server at ${API_BASE_URL}. Check your connection and EXPO_PUBLIC_API_URL (a phone can't use localhost).`,
        code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        status: 0,
      });
    }

    const payload = parseBody<T>(res.text);

    if (!res.ok) {
      throw new ApiError({ ...payload, status: res.status });
    }
    return payload.data as T;
  }

  private async refresh(): Promise<boolean> {
    const refreshToken = tokenManager.getRefreshToken();
    if (!refreshToken) return false;
    this.refreshing ??= this.raw<{ accessToken: string; refreshToken: string }>(
      `${API_ENDPOINTS.AUTH.BASE}${API_ENDPOINTS.AUTH.REFRESH}`,
      { method: 'POST', body: { refreshToken }, auth: false },
    )
      .then((data) => {
        tokenManager.setTokens(data.accessToken, data.refreshToken);
        return true;
      })
      .catch(() => {
        tokenManager.clear();
        return false;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private async request<T>(path: string, options: RequestOptions): Promise<T> {
    try {
      return await this.raw<T>(path, options);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        options.auth !== false
      ) {
        const ok = await this.refresh();
        if (ok) return this.raw<T>(path, options);
      }
      throw error;
    }
  }

  get<T>(path: string, auth = true): Promise<T> {
    return this.request<T>(path, { method: 'GET', auth });
  }
  post<T>(path: string, body?: Json, auth = true): Promise<T> {
    return this.request<T>(path, { method: 'POST', body, auth });
  }
  /**
   * POST with extra headers — the M4 money-moving verb.
   *
   * Separate from `post` rather than a fourth positional argument, so a call site
   * that needs an idempotency key cannot silently omit it by getting the argument
   * order wrong.
   */
  postWith<T>(
    path: string,
    body: Json | undefined,
    headers: Record<string, string>,
    auth = true,
  ): Promise<T> {
    return this.request<T>(path, { method: 'POST', body, headers, auth });
  }
  /** POST a multipart/form-data body (file uploads). */
  postForm<T>(path: string, form: FormData, auth = true): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: form, auth });
  }
  patch<T>(path: string, body?: Json, auth = true): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body, auth });
  }
  delete<T>(path: string, auth = true): Promise<T> {
    return this.request<T>(path, { method: 'DELETE', auth });
  }
}

/**
 * The `{ data }` envelope, or an empty object when the body is not JSON.
 *
 * A 204, a gateway's HTML error page, or a proxy's plain-text 502 all have bodies that are not
 * JSON. Each must become "no payload", never a parse exception: on an error status the caller
 * still needs the real status code, and a throw here would replace it with a SyntaxError.
 */
function parseBody<T>(text: string): ApiResponse<T> & Record<string, unknown> {
  if (!text) return {} as ApiResponse<T> & Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    return (parsed && typeof parsed === 'object' ? parsed : {}) as ApiResponse<T> &
      Record<string, unknown>;
  } catch {
    return {} as ApiResponse<T> & Record<string, unknown>;
  }
}

export const apiClient = new ApiClient();
