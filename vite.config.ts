import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['icons/icon.svg'],
    manifest: {
      name: 'CountAI by AIVON', short_name: 'CountAI', description: 'CCTV-first surveillance and operational intelligence',
      theme_color: '#102321', background_color: '#f4f7f5', display: 'standalone',
      orientation: 'portrait-primary', start_url: '/', scope: '/',
      icons: [{ src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }]
    },
    workbox: {
      navigateFallback: '/index.html',
      globPatterns: ['**/*.{js,css,html,svg,woff2}'],

    }
  })],
  server: { port: 5173 }
});
