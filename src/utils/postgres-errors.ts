const UNIQUE_VIOLATION = '23505';

/**
 * Returns the violated constraint's name (e.g. `users_email_key`) when `err` is a
 * Postgres unique-violation, otherwise null. postgres.js exposes the name as
 * `constraint_name`.
 */
export function uniqueViolationConstraint(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, constraint_name: constraintName } = err as {
    code?: string;
    constraint_name?: string;
  };
  if (code !== UNIQUE_VIOLATION) return null;
  return constraintName ?? '';
}
