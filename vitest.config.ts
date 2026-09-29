import { defineConfig } from 'vitest/config';

// Base Vitest config. The two test projects (a `node` project for browser-free
// src/core/ logic and a `jsdom` project for DOM/component tests) are declared
// in vitest.workspace.ts, which Vitest picks up automatically.
export default defineConfig({
  test: {},
});
