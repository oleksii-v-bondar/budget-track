/** True when `error` (or the driver error Drizzle wraps as `cause`) is a Postgres unique violation (23505). */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error || (typeof e === 'object' && e !== null); ) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
