import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// Base Vite config shared by both browser targets. The per-target output
// directory (dist/chrome, dist/firefox) and entry points are supplied by
// scripts/build.mjs at build time; this file holds the common plugin setup.
export default defineConfig({
  plugins: [preact()],
  build: {
    minify: 'esbuild', // minify, not obfuscate — keeps AMO/CWS review happy
    target: 'es2022',
    emptyOutDir: true,
  },
});
