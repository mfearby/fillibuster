/**
 * jsdom tests for the background service worker (task 10.1).
 *
 * These run under the jsdom Vitest project. `webextension-polyfill` is mocked
 * with an in-memory fake exposing the tab/message event surfaces plus the
 * badge APIs (`action.setBadgeText` / `action.setBadgeBackgroundColor`), and
 * `../platform/store` is mocked so we control the configs matching sees.
 *
 * We assert that:
 *  - a URL matching one or more configs sets a badge with the match count and a
 *    colour (Req 4.1, 4.2),
 *  - a URL matching nothing clears the badge (Req 4.3),
 *  - the per-tab cache is populated with the matching ids,
 *  - a `urlChanged` message re-evaluates the sender's tab (Req 4.4).
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredState } from '../core/schema';

// In-memory fake of the polyfill surface the background uses. Declared via
// vi.hoisted so the hoisted vi.mock factory and the tests share the spies.
const {
  setBadgeText,
  setBadgeBackgroundColor,
  tabsGet,
  messageListeners,
  updatedListeners,
  activatedListeners,
} = vi.hoisted(() => ({
  setBadgeText: vi.fn(async (_arg: { tabId: number; text: string }) => undefined),
  setBadgeBackgroundColor: vi.fn(
    async (_arg: { tabId: number; color: string }) => undefined,
  ),
  tabsGet: vi.fn(async (_id: number): Promise<{ url?: string }> => ({ url: undefined })),
  messageListeners: [] as Array<
    (msg: unknown, sender: { tab?: { id?: number } }) => unknown
  >,
  updatedListeners: [] as Array<
    (tabId: number, changeInfo: { url?: string; status?: string }, tab: { url?: string }) => unknown
  >,
  activatedListeners: [] as Array<(info: { tabId: number }) => unknown>,
}));

vi.mock('webextension-polyfill', () => {
  const browser = {
    action: { setBadgeText, setBadgeBackgroundColor },
    tabs: {
      get: tabsGet,
      onUpdated: { addListener: (fn: (typeof updatedListeners)[number]) => updatedListeners.push(fn) },
      onActivated: { addListener: (fn: (typeof activatedListeners)[number]) => activatedListeners.push(fn) },
      onRemoved: { addListener: (_fn: (id: number) => unknown) => undefined },
    },
    runtime: {
      onMessage: {
        addListener: (fn: (typeof messageListeners)[number]) => messageListeners.push(fn),
      },
    },
  };
  return { __esModule: true, default: browser, browser };
});

// Control the configs matching sees.
const { loadState } = vi.hoisted(() => ({
  loadState: vi.fn(async (): Promise<StoredState> => ({
    schemaVersion: 1,
    settings: { encryptionEnabled: false },
    configs: {},
  })),
}));

vi.mock('../platform/store', () => ({ loadState }));

// Import AFTER mocks are registered. The module registers listeners on import.
import {
  __resetForTests,
  BADGE_COLOR,
  evaluateTab,
  getMatchesForTab,
} from './index';
import { MessageType } from '../platform/messages';

/** A config that matches example.com via a prefix rule. */
function exampleState(): StoredState {
  return {
    schemaVersion: 1,
    settings: { encryptionEnabled: false },
    configs: {
      a: {
        encrypted: false,
        id: 'a',
        name: 'Example',
        match: [{ kind: 'prefix', pattern: 'https://example.com/' }],
        steps: [],
        errorStrategy: 'continue',
        createdAt: 0,
        updatedAt: 0,
      },
    },
  };
}

beforeEach(() => {
  __resetForTests();
  vi.clearAllMocks();
  loadState.mockResolvedValue(exampleState());
});

describe('evaluateTab (Req 4.1, 4.2, 4.3)', () => {
  it('sets a badge with the match count and colour when a URL matches', async () => {
    const ids = await evaluateTab(7, 'https://example.com/apply');
    expect(ids).toEqual(['a']);
    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '1' });
    expect(setBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 7, color: BADGE_COLOR });
  });

  it('clears the badge when a URL matches nothing', async () => {
    const ids = await evaluateTab(7, 'https://other.example.org/');
    expect(ids).toEqual([]);
    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '' });
    expect(setBadgeBackgroundColor).not.toHaveBeenCalled();
  });

  it('clears the badge and cache for a tab with no URL', async () => {
    const ids = await evaluateTab(7, undefined);
    expect(ids).toEqual([]);
    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '' });
    expect(getMatchesForTab(7)).toEqual([]);
  });

  it('populates the per-tab cache with matching ids', async () => {
    await evaluateTab(7, 'https://example.com/apply');
    expect(getMatchesForTab(7)).toEqual(['a']);
    // A different tab is tracked independently.
    await evaluateTab(8, 'https://nope.test/');
    expect(getMatchesForTab(8)).toEqual([]);
    expect(getMatchesForTab(7)).toEqual(['a']);
  });

  it('matches encrypted configs too (only reads id + match)', async () => {
    loadState.mockResolvedValue({
      schemaVersion: 1,
      settings: { encryptionEnabled: true },
      configs: {
        e: {
          encrypted: true,
          id: 'e',
          name: 'Locked',
          match: [{ kind: 'exact', pattern: 'https://example.com/x' }],
          errorStrategy: 'continue',
          createdAt: 0,
          updatedAt: 0,
          cipher: { iv: 'aa', data: 'bb' },
        },
      },
    });
    const ids = await evaluateTab(3, 'https://example.com/x');
    expect(ids).toEqual(['e']);
  });
});

describe('urlChanged message (Req 4.4)', () => {
  it('re-evaluates the sender tab when a urlChanged message arrives', async () => {
    expect(messageListeners.length).toBeGreaterThan(0);
    const handler = messageListeners[0]!;
    await handler(
      { type: MessageType.UrlChanged, url: 'https://example.com/spa' },
      { tab: { id: 42 } },
    );
    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 42, text: '1' });
    expect(getMatchesForTab(42)).toEqual(['a']);
  });

  it('ignores messages without a sender tab id', async () => {
    const handler = messageListeners[0]!;
    const result = handler(
      { type: MessageType.UrlChanged, url: 'https://example.com/spa' },
      { tab: {} },
    );
    expect(result).toBeUndefined();
    expect(setBadgeText).not.toHaveBeenCalled();
  });

  it('ignores foreign messages', async () => {
    const handler = messageListeners[0]!;
    expect(handler({ type: 'somethingElse' }, { tab: { id: 1 } })).toBeUndefined();
    expect(setBadgeText).not.toHaveBeenCalled();
  });
});

describe('tab event listeners (Req 4.1)', () => {
  it('registers onUpdated / onActivated listeners at import', () => {
    expect(updatedListeners.length).toBeGreaterThan(0);
    expect(activatedListeners.length).toBeGreaterThan(0);
  });

  it('onUpdated re-evaluates on a URL change', async () => {
    const handler = updatedListeners[0]!;
    await handler(9, { url: 'https://example.com/page' }, { url: 'https://example.com/page' });
    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 9, text: '1' });
  });

  it('onUpdated ignores non-url, non-complete changes', async () => {
    const handler = updatedListeners[0]!;
    await handler(9, { status: 'loading' }, { url: 'https://example.com/page' });
    expect(setBadgeText).not.toHaveBeenCalled();
  });

  it('onActivated looks up the tab URL and evaluates it', async () => {
    tabsGet.mockResolvedValue({ url: 'https://example.com/active' });
    const handler = activatedListeners[0]!;
    await handler({ tabId: 5 });
    expect(tabsGet).toHaveBeenCalledWith(5);
    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 5, text: '1' });
  });
});
