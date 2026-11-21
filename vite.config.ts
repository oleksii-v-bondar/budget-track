import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/** `npm run dev:web` forwards these paths to the API server started by `npm run dev` (PORT=3080 in .env). */
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3080';

export default defineConfig({
  root: fileURLToPath(new URL('src/web', import.meta.url)),
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // main.tsx registers the service worker (virtual:pwa-register), so no inline script breaks the strict CSP.
      injectRegister: false,
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Budget Track',
        short_name: 'Budget',
        description: 'Personal zero-based budgeting',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f3f4f6',
        theme_color: '#15803d',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Spec §11: the service worker caches only the app shell. It precaches the build and answers navigations
        // with index.html; nothing else is routed through it, so /api requests always go to the network.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api(\/|$)/, /^\/healthz$/],
        // A new deploy takes over the open app at once. registerType 'autoUpdate' sets these only with injectRegister
        // 'auto', so without them a new service worker would wait until every tab of the app is closed.
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
  build: {
    outDir: fileURLToPath(new URL('dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: { '/api': apiTarget, '/healthz': apiTarget },
  },
});
