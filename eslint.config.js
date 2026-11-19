import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const engineGlobalsMessage = 'src/engine must stay pure: no I/O or runtime globals.';

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
    },
  },
);
