import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Where the game will be served from.
 *
 * Root ('/') for a custom domain or Vercel; '/sen/' for GitHub Pages on a
 * project repo. Everything that emits a URL - assets, the manifest, the
 * service worker's navigation fallback - derives from this one value, because
 * a subpath deploy that gets it wrong fails as a blank screen with a 404 on
 * terrain.png and nothing else to go on.
 */
const BASE = process.env.SEN_BASE ?? '/';

export default defineConfig({
  base: BASE,
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
      base: BASE,
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
        start_url: BASE,
        scope: BASE,
        categories: ['games', 'entertainment'],
        icons: [
          { src: `${BASE}icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${BASE}icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
          {
            src: `${BASE}icons/icon-maskable-512.png`,
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
        globPatterns: ['**/*.{js,css,html,png,woff2,svg,webmanifest}'],
        navigateFallback: `${BASE}index.html`,
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
});
