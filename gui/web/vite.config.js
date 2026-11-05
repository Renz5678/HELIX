import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/*
 * HELIX IDE front-end build.
 *  - base './'      -> relative asset paths so gui/dist/ can be served
 *                      by the C server from any mount point
 *  - outDir ../dist -> builds into gui/dist/, which helix-server serves
 *  - dev proxy      -> `npm run dev` hot-reloads while /api calls go to
 *                      the C server on :8080 (start helix-server first)
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
