import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import { comparePassword } from '@utils/password';
import { hashPassword } from '@utils/password';
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

export async function loginOrgUser(
  db: Sql,
  redis: Redis,
  email: string,
  password: string,
): Promise<TokenPair> {
  const rows = await db<(User & { org_is_active: boolean })[]>`
    SELECT u.id, u.email, u.password_hash, u.role, u.org_id, u.is_active,
           o.is_active AS org_is_active
    FROM users u
    JOIN organizations o ON o.id = u.org_id
    WHERE u.email = ${email} AND u.role IN ('org_admin', 'viewer')
  `;

  const user = rows[0];
  if (!user) {
    throw AppError.invalidCredentials();
  }

  if (!user.is_active) {
    throw AppError.forbidden('Account is deactivated');
  }

  if (!user.org_is_active) {
    throw AppError.forbidden('Organization is deactivated');
  }

  const valid = await comparePassword(password, user.password_hash);
  if (!valid) {
    throw AppError.invalidCredentials();
  }

  return issueTokenPair(redis, user);
}

export async function changePassword(
  db: Sql,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const rows = await db<User[]>`
    SELECT id, password_hash FROM users WHERE id = ${userId}
  `;

  const user = rows[0];
  if (!user) {
    throw AppError.notFound('User not found');
  }

  const valid = await comparePassword(currentPassword, user.password_hash);
  if (!valid) {
    throw AppError.invalidCredentials();
  }

  const newHash = await hashPassword(newPassword);
  await db`UPDATE users SET password_hash = ${newHash} WHERE id = ${userId}`;
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
