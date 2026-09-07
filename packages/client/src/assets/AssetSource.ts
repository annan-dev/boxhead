/**
 * Where the art comes from.
 *
 * Served from a web root, assets are plain relative URLs: `art.json`,
 * `bitmaps/x.png`, `sounds/x.mp3`. The single-file build has no web root, so
 * the same files are baked into the bundle as data URLs by a Vite plugin (see
 * vite.config.ts) and looked up here. Everything that loads an asset asks
 * this module rather than assuming either layout, and a browser is happy to
 * `fetch` a data URL, so callers need not care which they got.
 */
import type { ArtPack } from '@boxhead/shared';
import { art, files } from 'virtual:inlined-assets';

/** A URL usable in `src=` or `fetch` for a path relative to the asset root. */
export function assetUrl(path: string): string {
  return files[path] ?? path;
}

/** True when the art is baked into this build, i.e. no server is needed. */
export function assetsInlined(): boolean {
  return art !== null;
}

/** The art pack, from the bundle if baked in, else fetched. Throws if neither works. */
export async function loadArtPack(): Promise<ArtPack> {
  if (art) return art as ArtPack;
  const response = await fetch('art.json');
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()) as ArtPack;
}

/** A JSON file by asset path, or null when it is absent. */
export async function loadJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(assetUrl(path));
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
