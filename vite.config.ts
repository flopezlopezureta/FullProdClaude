import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import fs from 'fs'

const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Makes the app shell (HTML/JS/CSS) load even from a cold start with zero connectivity —
    // distinct from the offline action queue (services/offlineQueue.ts), which handles losing
    // connection mid-session. Without this, a driver opening the app with no signal at all just
    // gets a failed network request and a blank/error screen, since nothing was ever cached.
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false, // public/manifest.json is already hand-maintained and linked in index.html
      workbox: {
        // Never precache or runtime-cache API responses — those are live data (packages,
        // settings, auth) that must go through the existing offline-queue/cached-settings logic
        // in services/api.ts and contexts/AuthContext.tsx, not get silently served stale by the SW.
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
        // Marketing/landing-page screenshots — not needed for a driver to work offline, and one
        // of them exceeds Workbox's default 2 MiB precache limit.
        globIgnores: ['**/assets/landing/**'],
      },
    }),
  ],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(packageJson.version),
    'import.meta.env.VITE_BUILD_DATE': JSON.stringify(new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' }))
  },
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('recharts') || id.includes('d3')) {
              return 'vendor-charts';
            }
            if (id.includes('exceljs') || id.includes('xlsx') || id.includes('fast-csv')) {
              return 'vendor-excel';
            }
            if (id.includes('framer-motion')) {
              return 'vendor-motion';
            }
            return 'vendor-core'; // other third-party dependencies
          }
        }
      }
    }
  }
})