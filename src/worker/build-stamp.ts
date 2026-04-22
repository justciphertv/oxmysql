// Build-time constant injected via esbuild `define` in build.js. When the
// code runs outside an esbuild bundle (vitest, direct node execution) the
// identifier is undefined, so we fall back to 'dev'. Import this everywhere
// instead of referencing the global directly so TS knows about the type.

declare const __BUILD_STAMP__: string | undefined;

export const BUILD_STAMP: string =
  typeof __BUILD_STAMP__ !== 'undefined' ? __BUILD_STAMP__ : 'dev';
