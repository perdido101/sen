import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          pixi: ['pixi.js'],
        },
      },
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['terrain.png', 'fonts/*.woff2', 'icons/*.png'],
      manifest: {
        name: 'Super El Niño',
        short_name: 'SuperElNino',
        description:
          'Start as a dust devil. End as Super El Niño - a storm big enough to have a name.',
        theme_color: '#0A1420',
        background_color: '#0A1420',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        categories: ['games', 'entertainment'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The terrain map is 4096x2048; the default 2MB cap would skip it and
        // offline play would break on the one asset the game cannot start
        // without.
        maximumFileSizeToCacheInBytes: 24 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,png,woff2,svg}'],
        navigateFallback: '/index.html',
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
});
