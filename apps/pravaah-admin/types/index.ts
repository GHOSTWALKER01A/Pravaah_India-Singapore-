/** Shape of the pravaah-be access-token JWT payload. */
export interface DecodedToken {
  sub: string;
  user_role: 'ADMIN' | 'USER';
  exp: number;
}

export type Nullable<T> = T | null;
