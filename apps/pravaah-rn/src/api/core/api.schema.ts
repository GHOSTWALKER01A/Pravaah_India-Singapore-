/** Standard envelope returned by pravaah-be's ResponseBuilder. */
export interface ApiResponse<T> {
  data: T;
  message?: string;
  success: boolean;
  timestamp?: string;
}
