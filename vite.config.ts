import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['icons/icon.svg'],
    manifest: {
      name: 'CountAI by AIVON', short_name: 'CountAI', description: 'AI-powered visual counting',
      theme_color: '#102321', background_color: '#f4f7f5', display: 'standalone',
      orientation: 'portrait-primary', start_url: '/', scope: '/',
      icons: [{ src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }]
    },
    workbox: {
      navigateFallback: '/index.html',
      globPatterns: ['**/*.{js,css,html,svg,woff2}'],
      // Keep the large ML model/runtime chunk out of the install-time precache.
      // It is cached on demand so first install stays lightweight, while repeat
      // use and later offline sessions can reuse a successfully fetched chunk.
      globIgnores: ['**/localDetector-*.js'],
      runtimeCaching: [{
        urlPattern: /\/assets\/localDetector-[^/]+\.js$/,
        handler: 'CacheFirst',
        options: {
          cacheName: 'countai-detector-assets',
          expiration: { maxEntries: 2, maxAgeSeconds: 30 * 24 * 60 * 60 }
        }
      }]
    }
  })],
  server: { port: 5173 }
});
