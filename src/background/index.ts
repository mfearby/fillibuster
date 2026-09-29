/**
 * Fillibuster background service worker: match evaluation and toolbar badge.
 *
 * This module is the browser-facing half of the matching engine (design
 * "Matching Engine", Req 4). The pure decision — does a URL match a config? —
 * lives in `core/match.ts`; here we wire it to the WebExtension event loop:
 *
 *  - On `tabs.onUpdated` (a page navigates or finishes loading),
 *    `tabs.onActivated` (the user switches to a different tab), and
 *    `urlChanged` messages from the content script (SPA navigation, Req 4.4),
 *    we take the tab's URL and evaluate it against every saved config.
 *  - The set of matching config ids is cached per tab (Map<tabId, string[]>),
 *    both to drive the badge and so the orchestration API (task 10.2) can reuse
 *    the already-computed matches for a tab without re-scanning storage.
 *  - The badge (Req 4.2, 4.3) shows the match count in a distinct colour when
 *    the set is non-empty, and is cleared (empty text) when nothing matches.
 *    Badge state is per-tab via `setBadgeText({ tabId })`.
 *
 * Restricted pages (browser-internal, extension gallery) still match on URL for
 * the badge — matching only reads the URL string, so it works even where a
 * content script can't run; the "can't run here" surface belongs to the fill
 * path (Req 9.4), not here.
 *
 * The module is import-safe: listeners are registered at load via
 * {@link registerListeners}, and the pure-ish {@link evaluateTab} is factored
 * out so it can be unit-tested without dispatching real tab events.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */

import { matchingConfigIds } from '../core/match';
import type { FillConfig, MatchRule } from '../core/schema';
import browser, { setBadge } from '../platform/browser';
import { isMessage, isUiRequest, MessageType } from '../platform/messages';
import { loadState } from '../platform/store';
import { handleUiMessage } from './orchestrator';

/**
 * Badge background colour used when a page has one or more matching configs
 * (Req 4.2). A distinct, high-contrast colour so the availability indicator
 * reads clearly against the toolbar icon.
 */
export const BADGE_COLOR = '#2563eb';

/**
 * Per-tab cache of matching config ids, keyed by tab id (design "Matching
 * Engine": "The set of matching config IDs per tab is cached"). Populated by
 * {@link evaluateTab}; read by {@link getMatchesForTab} so the orchestration
 * API (task 10.2) can reuse a tab's matches without recomputing.
 */
const matchesByTab = new Map<number, string[]>();

/**
 * Read the matching config ids last computed for a tab, or `undefined` if the
 * tab hasn't been evaluated yet. Exposed for reuse by the orchestration message
 * API (task 10.2) rather than having callers re-scan storage.
 */
export function getMatchesForTab(tabId: number): string[] | undefined {
  return matchesByTab.get(tabId);
}

/**
 * Matching only ever reads a config's `id` and `match` rules — never its steps
 * — so we can evaluate encrypted and plaintext configs alike without
 * decrypting. A {@link StoredConfig} carries `id` and `match` on both union
 * arms (the match rules are never encrypted), so we project each stored config
 * to the minimal `{ id, match }` shape `matchingConfigIds` accepts. This keeps
 * the badge working for encrypted configs while the session is locked.
 */
type MatchableConfig = Pick<FillConfig, 'id' | 'match'>;

/**
 * Build the lightweight list of `{ id, match }` used for matching from the
 * persisted state. Reads `configs` directly (both arms expose `id`/`match`),
 * avoiding any decryption of steps.
 */
async function loadMatchableConfigs(): Promise<MatchableConfig[]> {
  const state = await loadState();
  return Object.values(state.configs).map(({ id, match }) => ({
    id,
    match: match as MatchRule[],
  }));
}

/**
 * Evaluate a tab's URL against all saved configs, cache the matching ids for
 * the tab, and update the toolbar badge accordingly (Req 4.1, 4.2, 4.3).
 *
 * A falsy/undefined URL (a tab with no committed URL yet, or a URL we weren't
 * handed) is treated as "no matches": the cache is cleared for the tab and the
 * badge is cleared, so a tab never shows a stale indicator.
 *
 * Returns the matching config ids so callers/tests can assert on the result.
 */
export async function evaluateTab(
  tabId: number,
  url: string | undefined,
): Promise<string[]> {
  if (!url) {
    matchesByTab.set(tabId, []);
    await setBadge(tabId, '');
    return [];
  }

  const configs = await loadMatchableConfigs();
  // `matchingConfigIds` accepts FillConfig[]; our MatchableConfig[] carries the
  // only fields it reads (id + match), so the cast is sound.
  const ids = matchingConfigIds(url, configs as unknown as FillConfig[]);
  matchesByTab.set(tabId, ids);

  if (ids.length > 0) {
    await setBadge(tabId, String(ids.length), BADGE_COLOR);
  } else {
    await setBadge(tabId, '');
  }
  return ids;
}

/**
 * Re-evaluate a tab by first looking up its current URL. Used by the
 * `tabs.onActivated` path, where the event gives us only a tab id.
 */
async function evaluateTabById(tabId: number): Promise<void> {
  try {
    const tab = await browser.tabs.get(tabId);
    await evaluateTab(tabId, tab.url);
  } catch {
    // The tab may have closed between the event and the lookup; ignore.
  }
}

/**
 * Drop a tab's cached matches when it closes, so the map doesn't grow without
 * bound over a long session.
 */
function forgetTab(tabId: number): void {
  matchesByTab.delete(tabId);
}

/**
 * `tabs.onUpdated` handler: re-evaluate when the URL changes or the page
 * finishes loading. Both signals matter — `changeInfo.url` catches
 * same-document and cross-document URL changes, `status === 'complete'` catches
 * a load settling on a URL the initial event may not have carried (Req 4.1).
 */
async function onTabUpdated(
  tabId: number,
  changeInfo: { url?: string; status?: string },
  tab: { url?: string },
): Promise<void> {
  if (changeInfo.url === undefined && changeInfo.status !== 'complete') return;
  const url = changeInfo.url ?? tab.url;
  await evaluateTab(tabId, url);
}

/**
 * `tabs.onActivated` handler: the user switched tabs, so re-evaluate the
 * newly-active tab's URL to refresh the badge for what they're now looking at.
 */
async function onTabActivated(activeInfo: { tabId: number }): Promise<void> {
  await evaluateTabById(activeInfo.tabId);
}

/**
 * `runtime.onMessage` handler. Two distinct kinds of traffic arrive on this one
 * channel, so we route by shape:
 *
 *  - `urlChanged` notifications from the content script (SPA navigation, Req
 *    4.4): re-evaluate the sender's tab and update the badge. We return a
 *    `Promise<void>` (not the evaluation result) since the sender doesn't await
 *    a reply.
 *  - {@link UiRequest} traffic from the popup/options: delegate to the
 *    orchestrator (task 10.2) and return its typed {@link OrchestratorResult}
 *    so the UI's `sendMessage` resolves with it.
 *
 * Foreign or unrecognised messages return `undefined` so the runtime knows this
 * listener won't answer and other listeners may.
 */
function onMessage(
  message: unknown,
  sender: { tab?: { id?: number } },
): Promise<unknown> | undefined {
  if (isUiRequest(message)) {
    return handleUiMessage(message, sender);
  }
  if (!isMessage(message) || message.type !== MessageType.UrlChanged) {
    return undefined;
  }
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return undefined;
  return evaluateTab(tabId, message.url).then(() => undefined);
}

/**
 * Register all tab/message listeners. Called once at module load so the worker
 * starts evaluating as soon as it wakes; split out so tests can invoke it
 * against a mocked `browser`.
 */
export function registerListeners(): void {
  browser.tabs.onUpdated.addListener(onTabUpdated);
  browser.tabs.onActivated.addListener(onTabActivated);
  browser.tabs.onRemoved.addListener(forgetTab);
  browser.runtime.onMessage.addListener(onMessage);
}

/**
 * Test-only seam: clear the per-tab cache so specs can re-exercise evaluation
 * from a known-empty state.
 */
export function __resetForTests(): void {
  matchesByTab.clear();
}

registerListeners();
