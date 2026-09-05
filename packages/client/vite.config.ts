import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Extracted art lives outside the package (and outside git) but is served at
// the web root, so art.json is /art.json and bitmaps are /bitmaps/*.png.
export default defineConfig({
  base: './',
  publicDir: resolve(import.meta.dirname, '../../assets'),
  server: { port: 5173, open: false },
  build: { target: 'es2022', outDir: 'dist' },
});
