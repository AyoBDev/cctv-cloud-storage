import { sql } from './client';
import { hashPassword } from '@utils/password';

async function seed() {
  const email = process.env['SEED_ADMIN_EMAIL'] ?? 'admin@cctv-cloud.local';
  const password = process.env['SEED_ADMIN_PASSWORD'] ?? 'changeme123!';

  console.warn('Seeding super admin:', email);

  const existing = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE email = ${email}
  `;

  if (existing.length > 0) {
    console.warn('Super admin already exists, skipping seed.');
    await sql.end();
    return;
  }

  const passwordHash = await hashPassword(password);

  await sql`
    INSERT INTO users (email, password_hash, role, org_id)
    VALUES (${email}, ${passwordHash}, 'super_admin', NULL)
  `;

  console.warn('Super admin created successfully.');
  await sql.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
