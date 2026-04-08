import type { FastifyInstance } from 'fastify';

interface OrgWithTokens {
  orgId: string;
  orgAdminEmail: string;
  orgAdminPassword: string;
  orgAdminAccessToken: string;
  orgAdminRefreshToken: string;
}

/**
 * Creates an org via super admin API, then logs in as the org_admin.
 * Returns orgId + org admin tokens.
 */
export async function createOrgAndLogin(
  app: FastifyInstance,
  superAdminToken: string,
  suffix: string,
): Promise<OrgWithTokens> {
  const ts = Date.now();
  const orgAdminEmail = `org-admin-${suffix}-${ts}@example.com`;
  const orgAdminPassword = 'password123!';

  // Create org via super admin
  const createRes = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/organizations',
    headers: { authorization: `Bearer ${superAdminToken}` },
    payload: {
      name: `Test Org ${suffix}`,
      slug: `test-org-${suffix}-${ts}`,
      adminEmail: orgAdminEmail,
      adminPassword: orgAdminPassword,
    },
  });

  if (createRes.statusCode !== 201) {
    throw new Error(`Failed to create org: ${createRes.statusCode} ${createRes.body}`);
  }

  const { id: orgId } = createRes.json<{ id: string }>();

  // Login as org admin
  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      email: orgAdminEmail,
      password: orgAdminPassword,
    },
  });

  if (loginRes.statusCode !== 200) {
    throw new Error(`Failed to login as org admin: ${loginRes.statusCode} ${loginRes.body}`);
  }

  const { accessToken, refreshToken } = loginRes.json<{
    accessToken: string;
    refreshToken: string;
  }>();

  return {
    orgId,
    orgAdminEmail,
    orgAdminPassword,
    orgAdminAccessToken: accessToken,
    orgAdminRefreshToken: refreshToken,
  };
}

/**
 * Logs in as super admin and returns the access token.
 */
export async function loginAsSuperAdmin(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: {
      email: process.env['SEED_ADMIN_EMAIL'] ?? 'admin@cctv-cloud.local',
      password: process.env['SEED_ADMIN_PASSWORD'] ?? 'changeme123!',
    },
  });

  if (res.statusCode !== 200) {
    throw new Error(`Failed to login as super admin: ${res.statusCode} ${res.body}`);
  }

  const { accessToken } = res.json<{ accessToken: string }>();
  return accessToken;
}
