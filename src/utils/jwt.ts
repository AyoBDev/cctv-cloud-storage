import jwt from 'jsonwebtoken';
import type { StringValue } from 'ms';
import { randomUUID } from 'crypto';
import { env } from '@config/env';

export interface AccessTokenPayload {
  sub: string;
  role: string;
  org_id: string | null;
  jti: string;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'jti' | 'type'>): string {
  const jti = randomUUID();
  const options: jwt.SignOptions = {
    algorithm: 'RS256',
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as StringValue,
  };
  return jwt.sign({ ...payload, jti, type: 'access' }, env.JWT_PRIVATE_KEY, options);
}

export function signRefreshToken(userId: string): { token: string; jti: string } {
  const jti = randomUUID();
  const options: jwt.SignOptions = {
    algorithm: 'RS256',
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as StringValue,
  };
  const token = jwt.sign({ sub: userId, jti, type: 'refresh' }, env.JWT_PRIVATE_KEY, options);
  return { token, jti };
}

export function verifyToken<T extends object>(token: string): T {
  return jwt.verify(token, env.JWT_PUBLIC_KEY, { algorithms: ['RS256'] }) as T;
}
