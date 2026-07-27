import { AxiosRequestConfig } from 'axios';

import { APIClient } from './api-client';

/** Base class for domain API services. Prefixes every call with `basePath`. */
export abstract class BaseAPIService {
  protected client: APIClient;
  protected basePath: string;

  constructor(basePath: string) {
    this.client = APIClient.getInstance();
    this.basePath = basePath;
  }

  protected getUrl(path: string): string {
    return `${this.basePath}${path}`;
  }

  protected async get<T>(path: string, config?: AxiosRequestConfig): Promise<T> {
    return this.client.get<T>(this.getUrl(path), config);
  }

  protected async post<T, D = Record<string, unknown>>(
    path: string,
    data?: D,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.client.post<T, D>(this.getUrl(path), data, config);
  }

  protected async put<T, D = Record<string, unknown>>(
    path: string,
    data?: D,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.client.put<T, D>(this.getUrl(path), data, config);
  }

  protected async patch<T, D = Record<string, unknown>>(
    path: string,
    data?: D,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.client.patch<T, D>(this.getUrl(path), data, config);
  }

  protected async delete<T>(
    path: string,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.client.delete<T>(this.getUrl(path), config);
  }
}
