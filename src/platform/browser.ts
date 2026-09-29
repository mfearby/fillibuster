/**
 * Cross-browser WebExtension API entry point for Fillibuster.
 *
 * Chrome exposes extension APIs on `chrome.*` (largely callback-based) while
 * Firefox exposes a promise-based `browser.*`. Rather than sprinkle
 * feature-detection or `chrome.*`/`browser.*` branches throughout the engines
 * and UI, the whole codebase imports the WebExtension API from this single
 * module. It re-exports the promise-based `browser` object from
 * `webextension-polyfill`, which normalizes the two namespaces so one source
 * tree serves both browsers (Req 1.3).
 *
 * Any small per-browser adapters that don't warrant their own module live here
 * too (see {@link setBadge}), keeping the divergence isolated behind this
 * platform layer so `core/`, `content/`, and the UI stay browser-agnostic.
 *
 * Import it as:
 *   import browser from './platform/browser';        // default
 *   import { browser } from './platform/browser';    // named
 *
 * Requirements: 1.3
 */

import browser from 'webextension-polyfill';

export { browser };
export default browser;

/**
 * A per-tab toolbar badge is set by combining `action.setBadgeText` with an
 * optional background colour. Both APIs exist under MV3 in Chrome and Firefox
 * (via the polyfill), but they take separate calls; this helper bundles them
 * into one typed call so callers (the match engine) express intent — "show this
 * badge on this tab" — without repeating the two-step dance.
 *
 * Passing `text: ""` (or omitting it) clears the badge for the tab (Req 4.3).
 *
 * Requirements: 1.3, 4.2, 4.3
 */
export async function setBadge(
  tabId: number,
  text: string,
  color?: string,
): Promise<void> {
  await browser.action.setBadgeText({ tabId, text });
  if (color !== undefined) {
    await browser.action.setBadgeBackgroundColor({ tabId, color });
  }
}
