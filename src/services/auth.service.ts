import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import { comparePassword } from '@utils/password';
import { signAccessToken, signRefreshToken, verifyToken } from '@utils/jwt';
import type { RefreshTokenPayload } from '@utils/jwt';
import { AppError, ErrorCodes } from '@utils/errors';

interface User {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  org_id: string | null;
  is_active: boolean;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// 7 days in seconds for Redis TTL
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60;

function refreshTokenRedisKey(jti: string): string {
  return `refresh:${jti}`;
}

export async function loginSuperAdmin(
  db: Sql,
  redis: Redis,
  email: string,
  password: string,
): Promise<TokenPair> {
  const rows = await db<User[]>`
    SELECT id, email, password_hash, role, org_id, is_active
    FROM users
    WHERE email = ${email} AND role = 'super_admin'
  `;

  const user = rows[0];
  if (!user) {
    throw AppError.invalidCredentials();
  }

  if (!user.is_active) {
    throw AppError.forbidden('Account is deactivated');
  }

  const valid = await comparePassword(password, user.password_hash);
  if (!valid) {
    throw AppError.invalidCredentials();
  }

  return issueTokenPair(redis, user);
}

export async function refreshTokens(db: Sql, redis: Redis, token: string): Promise<TokenPair> {
  let payload: RefreshTokenPayload;
  try {
    payload = verifyToken<RefreshTokenPayload>(token);
  } catch {
    throw new AppError(ErrorCodes.TOKEN_INVALID, 'Invalid refresh token', 401);
  }

  if (payload.type !== 'refresh') {
    throw new AppError(ErrorCodes.TOKEN_INVALID, 'Invalid token type', 401);
  }

  // Check revocation
  const key = refreshTokenRedisKey(payload.jti);
  const exists = await redis.exists(key);
  if (!exists) {
    throw new AppError(ErrorCodes.TOKEN_REVOKED, 'Refresh token has been revoked', 401);
  }

  // Revoke old token (rotation)
  await redis.del(key);

  // Fetch user
  const rows = await db<User[]>`
    SELECT id, email, role, org_id, is_active
    FROM users
    WHERE id = ${payload.sub}
  `;

  const user = rows[0];
  if (!user || !user.is_active) {
    throw AppError.unauthorized('User not found or inactive');
  }

  return issueTokenPair(redis, user);
}

export async function logout(redis: Redis, refreshToken: string): Promise<void> {
  try {
    const payload = verifyToken<RefreshTokenPayload>(refreshToken);
    if (payload.type === 'refresh') {
      await redis.del(refreshTokenRedisKey(payload.jti));
    }
  } catch {
    // Silent — token invalid or expired, nothing to revoke
  }
}

async function issueTokenPair(
  redis: Redis,
  user: Pick<User, 'id' | 'role' | 'org_id'>,
): Promise<TokenPair> {
  const { token: refreshToken, jti } = signRefreshToken(user.id);
  const accessToken = signAccessToken({
    sub: user.id,
    role: user.role,
    org_id: user.org_id,
  });

  // Store refresh token jti in Redis
  await redis.setex(refreshTokenRedisKey(jti), REFRESH_TOKEN_TTL, '1');

  return { accessToken, refreshToken };
}
