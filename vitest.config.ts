import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'engine', include: ['src/engine/**/*.test.ts'] } },
      {
        test: {
          name: 'server',
          include: ['src/server/**/*.test.ts', 'src/shared/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
