import { builtinModules } from 'node:module';
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const engineGlobalsMessage = 'src/engine must stay pure: no I/O or runtime globals.';
const engineDeterminismMessage = 'src/engine must be deterministic: pass time and randomness in as arguments.';
const nodeModules = `^(node:|(?:${builtinModules.join('|')})(?:/|$))`;
/** Import paths that leave the current directory and enter one of `layers`, e.g. '../../server/http/app'. */
const intoLayer = (...layers) => `^(?:\\.{1,2}/)*\\.\\./(?:[^/]+/)*(?:${layers.join('|')})(?:/|$)`;

export default defineConfig(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Only paths that leave the current directory and enter server/ or web/;
              // same-directory engine modules such as './web' stay allowed.
              regex: intoLayer('server', 'web'),
              message: 'src/engine must stay pure: no imports from server/ or web/.',
            },
            {
              regex: nodeModules,
              message: 'src/engine must stay pure: no I/O modules.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...[
          'process',
          'fetch',
          'Buffer',
          'require',
          '__dirname',
          '__filename',
          'setTimeout',
          'setInterval',
          'XMLHttpRequest',
        ].map((name) => ({ name, message: engineGlobalsMessage })),
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'ImportExpression', message: 'src/engine must stay pure: no dynamic import().' },
        { selector: "MemberExpression[object.name='globalThis']", message: engineGlobalsMessage },
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: engineDeterminismMessage },
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: engineDeterminismMessage },
        { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: engineDeterminismMessage },
      ],
    },
  },
  {
    files: ['src/server/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: intoLayer('web'), message: 'The server and src/shared must not import from src/web.' }] },
      ],
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: intoLayer('server', 'web'), message: 'src/shared is used by the browser: no imports from server/ or web/.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/server/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name=/^(insert|update|delete)$/][callee.object.property.name='tx'][callee.object.object.name='rec']",
          message: 'Write through the ChangeRecorder (rec.insert/update/delete), not rec.tx, so undo sees the change.',
        },
      ],
    },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: intoLayer('server'),
              allowTypeImports: true,
              message: 'src/web may import only types from src/server (use `import type`).',
            },
            { regex: nodeModules, message: 'src/web runs in the browser: no Node modules.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['process', 'Buffer', 'require', '__dirname', '__filename', 'global'].map((name) => ({
          name,
          message: 'src/web runs in the browser: no Node globals.',
        })),
      ],
    },
  },
);
