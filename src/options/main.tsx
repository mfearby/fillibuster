/**
 * Options page entry point.
 *
 * Mounts the Preact {@link App} into the `#root` element declared in
 * `options.html`. Kept deliberately thin — all behaviour lives in `App` and its
 * child components so the entry has nothing to test.
 *
 * Requirements: 6.1
 */

import { render } from 'preact';

import { initTheme } from '../platform/theme';
import { App } from './App';

// Apply the saved theme (cached value first to avoid a flash) before mounting.
void initTheme();

const root = document.getElementById('root');
if (root) {
  render(<App />, root);
}
