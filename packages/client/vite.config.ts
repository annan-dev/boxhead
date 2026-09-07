import { defineConfig, type Plugin } from 'vite';
import { resolve, join, relative } from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { viteSingleFile } from 'vite-plugin-singlefile';

const ASSETS = resolve(import.meta.dirname, '../../assets');

/**
 * `virtual:inlined-assets` hands the client its art. In an ordinary build
 * it exports nothing useful and the client fetches from the web root. In the
 * single-file build it carries art.json and every bitmap and sound as data
 * URLs, so the finished page works from a double-click on the file, from a
 * GitHub Pages site, or served by the game server itself.
 */
function inlinedAssets(enabled: boolean): Plugin {
  const id = 'virtual:inlined-assets';
  const resolved = `\0${id}`;
  const mime: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.mp3': 'audio/mpeg',
    '.json': 'application/json',
  };
  return {
    name: 'boxhead-inlined-assets',
    resolveId(source) {
      return source === id ? resolved : null;
    },
    load(source) {
      if (source !== resolved) return null;
      if (!enabled) return 'export const art = null;\nexport const files = {};\n';
      if (!existsSync(join(ASSETS, 'art.json'))) {
        throw new Error(`single-file build needs the extracted art at ${ASSETS}`);
      }
      const files: Record<string, string> = {};
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) {
            walk(full);
            continue;
          }
          const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
          const type = mime[ext];
          if (!type) continue;
          const key = relative(ASSETS, full).split('\\').join('/');
          if (key === 'art.json') continue;
          files[key] = `data:${type};base64,${readFileSync(full).toString('base64')}`;
        }
      };
      walk(ASSETS);
      // The pack is embedded as a string and parsed at load: engines parse
      // JSON text far faster than they parse an object literal of that size.
      const art = JSON.stringify(readFileSync(join(ASSETS, 'art.json'), 'utf8'));
      return `export const art = JSON.parse(${art});\nexport const files = ${JSON.stringify(files)};\n`;
    },
  };
}

// Extracted art lives outside the package (and outside git) but is served at
// the web root, so art.json is /art.json and bitmaps are /bitmaps/*.png.
export default defineConfig(({ command, mode }) => {
  const single = mode === 'single';
  return {
    base: './',
    publicDir: single ? false : ASSETS,
    server: { port: 5173, open: false },
    build: {
      target: 'es2022',
      outDir: 'dist',
      // The single file is big by design; the size warning has nothing to add.
      chunkSizeWarningLimit: single ? 20000 : 500,
    },
    plugins: [inlinedAssets(single), ...(single ? [viteSingleFile()] : [])],
    // In development the simulation is resolved straight from its sources, so an
    // edit there hot-reloads without a `tsc -b`. The production build keeps the
    // compiled package so what ships is what the typechecker saw.
    resolve:
      command === 'serve'
        ? { alias: { '@boxhead/shared': resolve(import.meta.dirname, '../shared/src/index.ts') } }
        : {},
  };
});
