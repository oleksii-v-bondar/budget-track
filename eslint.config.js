import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
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
              group: ['**/server', '**/server/**', '**/web', '**/web/**'],
              message: 'src/engine must stay pure: no imports from server/ or web/.',
            },
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'net', 'child_process', 'os', 'crypto'],
              message: 'src/engine must stay pure: no I/O modules.',
            },
          ],
        },
      ],
    },
  },
);
