import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const engineGlobalsMessage = 'src/engine must stay pure: no I/O or runtime globals.';
const engineDeterminismMessage = 'src/engine must be deterministic: pass time and randomness in as arguments.';

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
              regex: '^(?:\\.{1,2}/)*\\.\\./(?:[^/]+/)*(?:server|web)(?:/|$)',
              message: 'src/engine must stay pure: no imports from server/ or web/.',
            },
            {
              regex: `^(node:|(?:${builtinModules.join('|')})(?:/|$))`,
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
);
