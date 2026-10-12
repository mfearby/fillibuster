import preact from '@preact/preset-vite';
import { defineWorkspace } from 'vitest/config';

// Two Vitest projects:
//  - node:  pure browser-free logic under src/core/ (matching, schema, crypto, share)
//  - jsdom: DOM-touching content-script code and Preact component tests
export default defineWorkspace([
  {
    test: {
      name: 'node',
      environment: 'node',
      include: ['src/core/**/*.{test,spec}.ts'],
    },
  },
  {
    plugins: [preact()],
    test: {
      name: 'jsdom',
      environment: 'jsdom',
      globals: true,
      include: [
        'src/content/**/*.{test,spec}.{ts,tsx}',
        'src/popup/**/*.{test,spec}.{ts,tsx}',
        'src/options/**/*.{test,spec}.{ts,tsx}',
        'src/ui/**/*.{test,spec}.{ts,tsx}',
        'src/platform/**/*.{test,spec}.{ts,tsx}',
        'src/background/**/*.{test,spec}.{ts,tsx}',
      ],
    },
  },
]);
