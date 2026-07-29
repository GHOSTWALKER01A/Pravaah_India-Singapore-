import { apiClient } from './api-client';

/** Base for a domain service: binds a base path and proxies the client verbs. */
export abstract class BaseApiService {
  protected constructor(private readonly basePath: string) {}

  private url(path: string): string {
    return `${this.basePath}${path}`;
  }

  protected get<T>(path: string, auth = true): Promise<T> {
    return apiClient.get<T>(this.url(path), auth);
  }
  protected post<T>(path: string, body?: object, auth = true): Promise<T> {
    return apiClient.post<T>(this.url(path), body, auth);
  }
  /**
   * POST carrying an idempotency key. Every M4 mutation goes through this.
   *
   * The key is a REQUIRED parameter rather than an optional one: the server rejects
   * a money-moving request without it, and a signature that let it default would
   * turn that server-side guarantee into a client-side habit.
   */
  protected postIdempotent<T>(
    path: string,
    idempotencyKey: string,
    body?: object,
  ): Promise<T> {
    return apiClient.postWith<T>(this.url(path), body, {
      'Idempotency-Key': idempotencyKey,
    });
  }
  protected postForm<T>(path: string, form: FormData, auth = true): Promise<T> {
    return apiClient.postForm<T>(this.url(path), form, auth);
  }
  protected patch<T>(path: string, body?: object, auth = true): Promise<T> {
    return apiClient.patch<T>(this.url(path), body, auth);
  }
  protected delete<T>(path: string, auth = true): Promise<T> {
    return apiClient.delete<T>(this.url(path), auth);
  }
}
