import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** `npm run dev:web` forwards these paths to the API server started by `npm run dev` (PORT=3080 in .env). */
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3080';

export default defineConfig({
  root: fileURLToPath(new URL('src/web', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: { '/api': apiTarget, '/healthz': apiTarget },
  },
});
