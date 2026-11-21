import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();
const BOUNDARY_RULES = [
  'no-restricted-imports',
  '@typescript-eslint/no-restricted-imports',
  'no-restricted-globals',
  'no-restricted-syntax',
  'react-hooks/rules-of-hooks',
];

/** The messages of the boundary rules for `code`, linted as if it were the file at `filePath`. */
async function violations(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => BOUNDARY_RULES.includes(m.ruleId ?? '')).map((m) => m.message);
}

/** Exactly one violation, whose message contains `text`. */
const one = (text: string) => [expect.stringContaining(text)];

describe('layer boundaries (ESLint)', () => {
  it('let the web app import only types from the server', async () => {
    const value = "import { createApp } from '../../server/http/app';\nexport const make = createApp;\n";
    const typeOnly = "import type { App } from '../../server/http/app';\nexport type Api = App;\n";
    const shared = "import { CSRF_HEADER } from '../../shared/http';\nexport const h = CSRF_HEADER;\n";
    expect(await violations('src/web/lib/api.ts', value)).toEqual(one('src/web may import only types from src/server'));
    expect(await violations('src/web/lib/api.ts', typeOnly)).toEqual([]);
    expect(await violations('src/web/lib/api.ts', shared)).toEqual([]);
  });

  it('keep Node modules and globals out of the web app', async () => {
    const fs = "import { readFile } from 'node:fs';\nexport const r = readFile;\n";
    expect(await violations('src/web/lib/x.ts', fs)).toEqual(one('src/web runs in the browser: no Node modules.'));
    const env = 'export const env = process.env;\n';
    expect(await violations('src/web/lib/x.ts', env)).toEqual(one('src/web runs in the browser: no Node globals.'));
  });

  it('check the rules of hooks in the web app', async () => {
    const code =
      "import { useState } from 'react';\nexport function F({ on }: { on: boolean }) {\n  if (on) useState(0);\n  return null;\n}\n";
    expect(await violations('src/web/ui/f.tsx', code)).toEqual(one('React Hook "useState" is called conditionally'));
  });

  it('keep the server and src/shared independent of the web app, and src/shared of the server', async () => {
    const fromWeb = "import { formatMoney } from '../web/lib/format';\nexport const f = formatMoney;\n";
    expect(await violations('src/server/x.ts', fromWeb)).toEqual(one('must not import from src/web'));
    const fromServer = "import { loadConfig } from '../server/config';\nexport const f = loadConfig;\n";
    expect(await violations('src/shared/x.ts', fromServer)).toEqual(one('src/shared is used by the browser'));
  });

  it('keep the engine pure', async () => {
    const fs = "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n";
    expect(await violations('src/engine/x.ts', fs)).toEqual(one('src/engine must stay pure: no I/O modules.'));
  });

  it('make commands write through the ChangeRecorder', async () => {
    const code = 'export async function f(rec: { tx: { insert(t: unknown): unknown } }) {\n  await rec.tx.insert(1);\n}\n';
    expect(await violations('src/server/payees/payee-commands.ts', code)).toEqual(one('Write through the ChangeRecorder'));
  });
});
