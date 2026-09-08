/** Commit hash and date, injected by vite.config.ts. */
declare const __BUILD__: string;

/** Provided by the inlinedAssets plugin in vite.config.ts. */
declare module 'virtual:inlined-assets' {
  /** The parsed art pack when baked into the bundle, else null. */
  export const art: unknown | null;
  /** Asset path (e.g. `bitmaps/logo.png`) to data URL, for baked-in files. */
  export const files: Record<string, string>;
}
