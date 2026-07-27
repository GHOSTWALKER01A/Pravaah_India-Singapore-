import { API_BASE_URL, API_ENDPOINTS } from '@/constants/api.constants';

import { tokenManager } from '@/api/auth/token-manager';

import { ApiResponse } from './api.schema';
import { ApiError } from './error.types';

/** A JSON request body — any plain object, including typed request interfaces. */
type Json = object;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A plain object (sent as JSON) or a FormData (sent as multipart). */
  body?: Json | FormData;
  auth?: boolean;
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

    let res: Response;
    try {
      res = await fetch(this.buildUrl(path), {
        method: options.method ?? 'GET',
        headers,
        body: options.body
          ? isForm
            ? (options.body as FormData)
            : JSON.stringify(options.body)
          : undefined,
      });
    } catch {
      throw new ApiError({
        message: `Can't reach the server at ${API_BASE_URL}. Check your connection and EXPO_PUBLIC_API_URL (a phone can't use localhost).`,
        status: 0,
      });
    }

    const payload = (await res.json().catch(() => ({}))) as ApiResponse<T> &
      Record<string, unknown>;

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

export const apiClient = new ApiClient();
