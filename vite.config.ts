import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(() => {
  return {
    base: '/Holo-11.29-/',
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'prompt',
        // Public icons are already precached via workbox.globPatterns; keep includeAssets empty to avoid duplicate precache entries
        includeAssets: [],
        manifest: {
          id: './',
          name: 'هلو شرکتی Apex — سامانه جامع حسابداری',
          short_name: 'هلو Apex',
          description: 'سامانه جامع حسابداری شرکتی با هسته هلو Apex، داشبورد مدیریت مالی و گزارش‌گیری پیشرفته',
          theme_color: '#0B0F17',
          background_color: '#0B0F17',
          display: 'standalone',
          orientation: 'any',
          dir: 'rtl',
          lang: 'fa',
          start_url: './',
          scope: './',
          icons: [
            {
              src: './pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: './pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: './pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
          shortcuts: [
            {
              name: 'فاکتور فروش (F2)',
              short_name: 'فروش',
              url: './?view=invoices&action=new-sale',
              icons: [{ src: './pwa-192x192.png', sizes: '192x192', type: 'image/png' }],
            },
            {
              name: 'ثبت سند حسابداری (F3)',
              short_name: 'سند جدید',
              url: './?view=vouchers&action=new-voucher',
              icons: [{ src: './pwa-192x192.png', sizes: '192x192', type: 'image/png' }],
            },
            {
              name: 'خزانه‌داری و چک (F7)',
              short_name: 'چک‌ها',
              url: './?view=treasury',
              icons: [{ src: './pwa-192x192.png', sizes: '192x192', type: 'image/png' }],
            },
          ],
        },
        workbox: {
          cleanupOutdatedCaches: true,
          maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
          globPatterns: ['**/*.{js,css,html,ico,png,jpg,jpeg,webp,svg,woff,woff2,json}'],
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/^\/__\/auth/, /^\/api\//],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/(firestore|identitytoolkit|securetoken)\.googleapis\.com\/.*/i,
              handler: 'NetworkOnly',
            },
            {
              urlPattern: /\/api\/live-fx/i,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'apex-live-fx-cache-v1',
                expiration: {
                  maxEntries: 8,
                  maxAgeSeconds: 60 * 60 * 24 * 7,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /\/src\/assets\/.*\.(?:png|jpg|jpeg|svg|webp)$/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'apex-local-assets-cache-v1',
                expiration: {
                  maxEntries: 40,
                  maxAgeSeconds: 60 * 60 * 24 * 90,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
      // Copies src/assets into dist/ so subpath-relative URLs like
      // "src/assets/images/..." still resolve cleanly in production builds.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, { recursive: true, force: true });
          }
        },
      },
    ],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/firebase')) return 'vendor-firebase';
            if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) return 'vendor-charts';
            if (id.includes('node_modules/jspdf') || id.includes('node_modules/html2canvas')) return 'vendor-pdf';
            if (id.includes('node_modules/xlsx')) return 'vendor-excel';
            if (id.includes('node_modules/peerjs')) return 'vendor-p2p';
            if (id.includes('node_modules/dexie')) return 'vendor-dexie';
            if (id.includes('node_modules/framer-motion') || id.includes('node_modules/motion')) return 'vendor-motion';
            return undefined;
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
