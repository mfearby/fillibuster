/**
 * Fillibuster content-script entry point.
 *
 * This is the module injected into the page. It does two things:
 *
 *  1. **Answers requests from the extension** (Req 5.3, 5.4, 9.1, 2.2). It
 *     registers a single `runtime.onMessage` listener that dispatches on the
 *     message `type`:
 *       - `applySteps`  → runs the fill executor ({@link applySteps}) and
 *         returns a {@link FillSummary}.
 *       - `capturePage` → runs the capture scanner ({@link capturePage}) and
 *         returns the {@link CaptureCandidate}s.
 *     Foreign or unknown messages are ignored so other extensions' traffic on
 *     the same channel is not mishandled.
 *
 *  2. **Notifies the background of SPA navigations** (Req 4.4). Single-page apps
 *     change the URL via the History API without a full page load, so
 *     `tabs.onUpdated` in the background may not fire. We patch
 *     `history.pushState`/`history.replaceState` and listen for `popstate`;
 *     on any resulting URL change we post `{ type: 'urlChanged', url }` to the
 *     background so it can re-evaluate matches and update the badge.
 *
 * The module is import-safe and idempotent: installing the listener and
 * patching History happen at most once per page, guarded by a marker on
 * `globalThis`, so re-injection (which extensions can do) doesn't stack
 * listeners or double-wrap History.
 *
 * Requirements: 2.2, 4.4, 5.3, 5.4, 9.1
 */

import browser from '../platform/browser';
import {
  type ContentRequest,
  MessageType,
  isMessage,
} from '../platform/messages';
import { capturePage } from './capture';
import { applySteps } from './fill';

/**
 * Marker key on `globalThis` recording that this content script already
 * installed its listeners/patches in this page. Guards against double-injection
 * (Req: idempotent, safe to import).
 */
const INSTALLED_FLAG = '__fillibusterContentInstalled__';

/**
 * Handle a single inbound request and produce its response. Split out from the
 * listener so it can be unit-tested directly.
 *
 * Returns `undefined` for messages that aren't ours or aren't content requests,
 * signalling the listener to abstain (so other listeners may respond).
 */
export async function handleRequest(
  message: unknown,
): Promise<unknown | undefined> {
  if (!isMessage(message)) return undefined;

  switch (message.type) {
    case MessageType.ApplySteps:
      // The fill executor is async (an `autocomplete` step waits for the page's
      // suggestion list), so await its summary before replying.
      return await applySteps(message.steps, message.errorStrategy);
    case MessageType.CapturePage:
      return capturePage();
    default:
      // `urlChanged` is a message we SEND, not one we handle here. Any other
      // type is not a content request — abstain.
      return undefined;
  }
}

/**
 * The `runtime.onMessage` listener. Returning a `Promise` (the polyfill
 * convention) asynchronously resolves the sender's `sendMessage`. Returning
 * `undefined` (not a promise) tells the runtime this listener won't respond, so
 * unknown/foreign messages fall through gracefully.
 */
function onMessage(message: unknown): Promise<unknown> | undefined {
  if (!isMessage(message)) return undefined;
  // Narrow to the requests we actually answer.
  if (
    message.type === MessageType.ApplySteps ||
    message.type === MessageType.CapturePage
  ) {
    return handleRequest(message as ContentRequest);
  }
  return undefined;
}

/**
 * The last URL we notified the background about, so History patches and
 * `popstate` don't emit duplicate `urlChanged` messages for the same URL.
 */
let lastNotifiedUrl: string | null = null;

/**
 * Notify the background of the current URL if it changed since the last
 * notification (Req 4.4). Debounced by value: repeated calls for the same URL
 * are no-ops. Best-effort — a rejected `sendMessage` (e.g. background asleep or
 * no receiver) is swallowed so page code is never disrupted.
 */
export function notifyUrlChanged(url: string = location.href): void {
  if (url === lastNotifiedUrl) return;
  lastNotifiedUrl = url;
  void Promise.resolve(
    browser.runtime.sendMessage({ type: MessageType.UrlChanged, url }),
  ).catch(() => {
    // Ignore: the background may be torn down (MV3) or not listening yet.
  });
}

/**
 * Patch `history.pushState`/`history.replaceState` so SPA navigations trigger a
 * URL-change notification, and listen for `popstate` (back/forward). Idempotent
 * via a wrapper marker on each patched function.
 */
function installHistoryHooks(): void {
  const h = history as History & {
    pushState: History['pushState'] & { __fillibusterPatched__?: boolean };
    replaceState: History['replaceState'] & { __fillibusterPatched__?: boolean };
  };

  if (!h.pushState.__fillibusterPatched__) {
    const originalPush = h.pushState.bind(history);
    const patchedPush = function patchedPushState(
      this: History,
      ...args: Parameters<History['pushState']>
    ): void {
      originalPush(...args);
      notifyUrlChanged();
    } as History['pushState'] & { __fillibusterPatched__?: boolean };
    patchedPush.__fillibusterPatched__ = true;
    h.pushState = patchedPush;
  }

  if (!h.replaceState.__fillibusterPatched__) {
    const originalReplace = h.replaceState.bind(history);
    const patchedReplace = function patchedReplaceState(
      this: History,
      ...args: Parameters<History['replaceState']>
    ): void {
      originalReplace(...args);
      notifyUrlChanged();
    } as History['replaceState'] & { __fillibusterPatched__?: boolean };
    patchedReplace.__fillibusterPatched__ = true;
    h.replaceState = patchedReplace;
  }

  window.addEventListener('popstate', () => notifyUrlChanged());
  window.addEventListener('hashchange', () => notifyUrlChanged());
}

/**
 * Install the message listener and SPA URL-change detection exactly once per
 * page. Safe to call repeatedly and safe to import (the module body invokes it,
 * but the guard makes re-injection a no-op).
 */
export function install(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[INSTALLED_FLAG]) return;
  g[INSTALLED_FLAG] = true;

  browser.runtime.onMessage.addListener(onMessage);
  installHistoryHooks();

  // Seed the debounce so the first real navigation (not the initial load) is
  // what gets reported; the background already knows the load URL via
  // tabs.onUpdated.
  lastNotifiedUrl = location.href;
}

/**
 * Reset internal state. Test-only seam so specs can re-exercise `install` and
 * the URL debounce without a fresh page.
 */
export function __resetForTests(): void {
  const g = globalThis as Record<string, unknown>;
  delete g[INSTALLED_FLAG];
  lastNotifiedUrl = null;
}

// Auto-install when injected into a page. Guarded so importing the module in a
// test (which then drives `install`/handlers explicitly) doesn't fire twice.
install();
