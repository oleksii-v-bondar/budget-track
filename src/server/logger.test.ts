import { describe, expect, it } from 'vitest';
import { createLogger, safeErrSerializer } from './logger';

const failedQuery = () =>
  Object.assign(new Error('Failed query: select 1\nparams: secret'), {
    params: ['secret'],
    cause: Object.assign(new Error('duplicate key value violates unique constraint "payee_name_live"'), {
      code: '23505',
      detail: 'Key (name)=(secret) already exists.',
    }),
  });

describe('error logging', () => {
  it('keeps query parameters out of serialized errors', () => {
    for (const err of [{ message: 'Failed query: select 1\nparams: secret', params: ['secret'] }, failedQuery()]) {
      const json = JSON.stringify(safeErrSerializer(err));
      expect(json).not.toContain('secret');
      expect(json).toContain('Failed query: select 1');
    }
  });

  it('logs errors through the safe serializer, cause included', () => {
    const lines: string[] = [];
    const logger = createLogger('info', { write: (line: string) => void lines.push(line) });
    logger.error({ err: failedQuery() }, 'unhandled error');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('secret');
    const { err } = JSON.parse(lines[0]!) as { err: Record<string, unknown> };
    expect(err).toMatchObject({
      type: 'Error',
      message: 'Failed query: select 1',
      cause: { type: 'Error', message: 'duplicate key value violates unique constraint "payee_name_live"', code: '23505' },
    });
    expect(err.stack).toMatch(/^Error: Failed query: select 1\n\s+at /);
  });
});
