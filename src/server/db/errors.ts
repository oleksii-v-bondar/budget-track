/** True when `error`, or an error in its `cause` chain (Drizzle wraps driver errors), has a matching SQLSTATE. */
function hasSqlState(error: unknown, matches: (code: string) => boolean): boolean {
  for (let e: unknown = error; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && matches(code)) return true;
  }
  return false;
}

/** True when `error` (or the driver error Drizzle wraps as `cause`) is a Postgres unique violation (23505). */
export function isUniqueViolation(error: unknown): boolean {
  return hasSqlState(error, (code) => code === '23505');
}

/** True for any Postgres integrity constraint violation (SQLSTATE class 23: foreign key, unique, not-null, check). */
export function isIntegrityViolation(error: unknown): boolean {
  return hasSqlState(error, (code) => /^23[0-9A-Z]{3}$/.test(code));
}
