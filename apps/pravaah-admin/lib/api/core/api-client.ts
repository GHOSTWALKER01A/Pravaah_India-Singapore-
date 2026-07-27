import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';

import { APIError } from './error.types';

/**
 * Singleton HTTP client for the pravaah-be API. Attaches the bearer token,
 * transparently refreshes it on 401, and normalizes errors into `APIError`.
 */
export class APIClient {
  private static instance: APIClient;
  private client: AxiosInstance;
  private readonly baseURL: string;
  private isRefreshing = false;
  private failedQueue: Array<{
    resolve: (token: string) => void;
    reject: (error: unknown) => void;
  }> = [];

  private constructor() {
    const API_URL = process.env.NEXT_PUBLIC_API_URL;
    if (!API_URL) {
      throw new Error(
        'NEXT_PUBLIC_API_URL is not defined. Set it in your environment (.env.local).',
      );
    }
    this.baseURL = API_URL.replace(/\/$/, '');
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    this.setupInterceptors();
  }

  public static getInstance(): APIClient {
    if (!APIClient.instance) {
      APIClient.instance = new APIClient();
    }
    return APIClient.instance;
  }

  private setupInterceptors(): void {
    this.client.interceptors.request.use(
      (config) => {
        if (typeof window !== 'undefined') {
          const token = localStorage.getItem('accessToken');
          if (token) {
            config.headers = config.headers || {};
            config.headers.Authorization = `Bearer ${token}`;
          }
        }
        return config;
      },
      (error) => Promise.reject(error),
    );

    this.client.interceptors.response.use(
      (response: AxiosResponse) => response,
      async (error) => {
        const originalRequest = error.config as InternalAxiosRequestConfig & {
          _retry?: boolean;
        };

        if (
          error.response?.status === 401 &&
          !originalRequest._retry &&
          typeof window !== 'undefined'
        ) {
          const refreshToken = localStorage.getItem('refreshToken');
          if (!refreshToken) {
            this.forceLogout();
            return Promise.reject(
              new APIError({
                ...error.response.data,
                status: error.response.status,
              }),
            );
          }

          if (this.isRefreshing) {
            return new Promise((resolve, reject) => {
              this.failedQueue.push({ resolve, reject });
            }).then((token) => {
              originalRequest.headers.Authorization = `Bearer ${token}`;
              return this.client(originalRequest);
            });
          }

          originalRequest._retry = true;
          this.isRefreshing = true;

          try {
            const res = await this.client.post('api/v1/auth/refresh', {
              refreshToken,
            });
            const {
              accessToken: newAccessToken,
              refreshToken: newRefreshToken,
            } = res.data.data;

            localStorage.setItem('accessToken', newAccessToken);
            localStorage.setItem('refreshToken', newRefreshToken);
            document.cookie = `accessToken=${newAccessToken}; path=/;`;

            this.failedQueue.forEach(({ resolve }) => resolve(newAccessToken));
            this.failedQueue = [];

            originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
            return this.client(originalRequest);
          } catch (refreshError) {
            this.failedQueue.forEach(({ reject }) => reject(refreshError));
            this.failedQueue = [];
            this.forceLogout();
            return Promise.reject(refreshError);
          } finally {
            this.isRefreshing = false;
          }
        }

        if (error.response) {
          return Promise.reject(
            new APIError({
              ...error.response.data,
              status: error.response.status,
            }),
          );
        }

        return Promise.reject(
          new APIError({ message: error.message || 'Network error' }),
        );
      },
    );
  }

  private forceLogout(): void {
    localStorage.clear();
    document.cookie =
      'accessToken=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC;';
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }

  public async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.client.get<T>(url, config);
    return response.data;
  }

  public async post<T, D = Record<string, unknown>>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response = await this.client.post<T>(url, data, config);
    return response.data;
  }

  public async put<T, D = Record<string, unknown>>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response = await this.client.put<T>(url, data, config);
    return response.data;
  }

  public async patch<T, D = Record<string, unknown>>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response = await this.client.patch<T>(url, data, config);
    return response.data;
  }

  public async delete<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.client.delete<T>(url, config);
    return response.data;
  }
}
