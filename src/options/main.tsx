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

import { App } from './App';

const root = document.getElementById('root');
if (root) {
  render(<App />, root);
}
