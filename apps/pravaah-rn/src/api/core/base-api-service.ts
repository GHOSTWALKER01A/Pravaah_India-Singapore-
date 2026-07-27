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
