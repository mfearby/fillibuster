/**
 * Typed RPC helper for the popup/options UIs.
 *
 * The popup and options pages talk to the background orchestrator over a single
 * channel: they post a {@link UiRequest} with `runtime.sendMessage` and get back
 * an {@link OrchestratorResult} they branch on (never a thrown/rejected promise
 * across the message boundary — see the orchestrator's module doc). This module
 * wraps that round-trip in one typed function so every UI caller shares the same
 * import rather than re-typing the `sendMessage` cast at each call site.
 *
 * `sendUi` is generic over the expected success payload `T`, so callers write
 * `await sendUi<ConfigSummary[]>({ type: MessageType.ListMatchingConfigs, tabId })`
 * and get an `OrchestratorResult<T>` to switch on. Should `sendMessage` itself
 * reject (background asleep, channel closed), we normalise that into a
 * serialisable `{ ok: false, code: 'error' }` so the UI has a single failure
 * shape to render.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 8.8, 9.1, 9.4
 */

import type { OrchestratorResult } from '../background/orchestrator';
import browser from './browser';
import type { UiRequest } from './messages';

/**
 * Send a {@link UiRequest} to the background orchestrator and resolve to its
 * typed {@link OrchestratorResult}. A rejected `sendMessage` (rare — e.g. the
 * background worker is unreachable) is converted into an `error` result so the
 * caller only ever handles the discriminated union, never a throw.
 */
export async function sendUi<T = unknown>(
  message: UiRequest,
): Promise<OrchestratorResult<T>> {
  try {
    const result = (await browser.runtime.sendMessage(
      message,
    )) as OrchestratorResult<T>;
    // Defensive: a well-behaved orchestrator always answers with a result, but
    // a missing/stripped response would otherwise surface as `undefined`.
    if (result && typeof result === 'object' && 'ok' in result) {
      return result;
    }
    return { ok: false, code: 'error', error: 'No response from background.' };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, code: 'error', error };
  }
}
