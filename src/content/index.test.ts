/**
 * jsdom tests for the content-script entry (task 9).
 *
 * These run under the jsdom Vitest project. `webextension-polyfill` is mocked
 * with an in-memory fake exposing `runtime.onMessage.addListener` and
 * `runtime.sendMessage`, so we can assert (a) the SPA History patch and
 * `popstate` fire a single `urlChanged` notification per distinct URL, and
 * (b) inbound `applySteps` / `capturePage` messages route to the fill executor
 * and capture scanner respectively, while foreign messages are ignored.
 *
 * Requirements: 2.2, 4.4, 5.3, 5.4, 9.1
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory fake of the polyfill's runtime surface. Declared via vi.hoisted so
// the hoisted vi.mock factory and the tests share the same spies.
const { sendMessage, listeners } = vi.hoisted(() => {
  const listeners: Array<(msg: unknown) => unknown> = [];
  const sendMessage = vi.fn(async (_msg: unknown): Promise<unknown> => undefined);
  return { sendMessage, listeners };
});

vi.mock('webextension-polyfill', () => {
  const browser = {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: (fn: (msg: unknown) => unknown) => listeners.push(fn),
      },
    },
  };
  return { __esModule: true, default: browser, browser };
});

// Import AFTER the mock is registered. The module auto-installs on import.
import {
  __resetForTests,
  handleRequest,
  install,
  notifyUrlChanged,
} from './index';
import { MessageType } from '../platform/messages';

beforeEach(() => {
  listeners.length = 0;
  __resetForTests();
  document.body.innerHTML = '';
  // jsdom's History is patched once at import; normalise the address here (this
  // may itself trigger a notification), THEN clear the spy so each test starts
  // from a known-clean call count and a seeded debounce.
  history.replaceState(null, '', '/');
  vi.clearAllMocks();
});

describe('SPA URL-change detection (Req 4.4)', () => {
  it('notifies the background when history.pushState changes the URL', () => {
    install();
    history.pushState(null, '', '/step-2');
    expect(sendMessage).toHaveBeenCalledWith({
      type: MessageType.UrlChanged,
      url: expect.stringContaining('/step-2'),
    });
  });

  it('notifies on history.replaceState', () => {
    install();
    history.replaceState(null, '', '/replaced');
    expect(sendMessage).toHaveBeenCalledWith({
      type: MessageType.UrlChanged,
      url: expect.stringContaining('/replaced'),
    });
  });

  it('notifies on popstate when the URL differs from the last notification', () => {
    install();
    // Seed the debounce at the current URL via a notify (mirrors a prior nav),
    // then simulate the browser changing the URL and firing popstate — exactly
    // the back/forward sequence, where jsdom won't run our History patches.
    notifyUrlChanged(location.href); // no-op: matches seeded load URL
    sendMessage.mockClear();

    // Point location at a new URL WITHOUT going through our patched History
    // (use replaceState only to move the address, then clear the resulting
    // notification so we isolate the popstate-driven one).
    history.replaceState(null, '', '/pop-here');
    sendMessage.mockClear();
    // Now pretend the last notification was for a different URL, so popstate's
    // notify sees a change and fires.
    notifyUrlChanged('http://localhost/other'); // updates lastNotified
    sendMessage.mockClear();

    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(sendMessage).toHaveBeenCalledWith({
      type: MessageType.UrlChanged,
      url: expect.stringContaining('/pop-here'),
    });
  });

  it('debounces duplicate notifications for the same URL', () => {
    install();
    history.pushState(null, '', '/dupe');
    history.pushState(null, '', '/dupe');
    const urlChangedCalls = sendMessage.mock.calls.filter(
      ([m]) => (m as { type?: string }).type === MessageType.UrlChanged,
    );
    expect(urlChangedCalls).toHaveLength(1);
  });

  it('notifyUrlChanged is a no-op for the current (already notified) URL', () => {
    install();
    // install() seeds lastNotifiedUrl with location.href.
    notifyUrlChanged(location.href);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('install is idempotent — re-installing does not double-notify', () => {
    install();
    install(); // second call guarded by the installed flag
    history.pushState(null, '', '/once');
    const urlChangedCalls = sendMessage.mock.calls.filter(
      ([m]) => (m as { type?: string }).type === MessageType.UrlChanged,
    );
    expect(urlChangedCalls).toHaveLength(1);
  });
});

describe('message routing (Req 5.3, 5.4, 2.2, 9.1)', () => {
  it('routes applySteps to the fill executor and returns a summary', async () => {
    document.body.innerHTML = '<input id="first" />';
    const result = await handleRequest({
      type: MessageType.ApplySteps,
      steps: [
        { id: 's1', type: 'text', target: { by: 'id', value: 'first' }, value: 'Ada' },
      ],
      errorStrategy: 'continue',
    });

    expect(result).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
    expect((document.getElementById('first') as HTMLInputElement).value).toBe('Ada');
  });

  it('reports a failed step in the summary (Req 9.1)', async () => {
    const result = (await handleRequest({
      type: MessageType.ApplySteps,
      steps: [
        { id: 's1', type: 'text', target: { by: 'id', value: 'missing' }, value: 'x' },
      ],
      errorStrategy: 'continue',
    })) as { failed: number; results: Array<{ ok: boolean; reason?: string }> };

    expect(result.failed).toBe(1);
    expect(result.results[0]?.ok).toBe(false);
  });

  it('routes capturePage to the capture scanner and returns candidates', async () => {
    document.body.innerHTML = '<input id="email" type="email" value="a@b.c" />';
    const result = (await handleRequest({ type: MessageType.CapturePage })) as Array<{
      step: { target: { by: string; value: string } };
    }>;

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]?.step.target).toEqual({ by: 'id', value: 'email' });
  });

  it('ignores foreign / unknown messages (returns undefined)', async () => {
    expect(await handleRequest({ type: 'somethingElse' })).toBeUndefined();
    expect(await handleRequest(null)).toBeUndefined();
    expect(await handleRequest('nope')).toBeUndefined();
    // urlChanged is outbound-only; the content script does not handle it.
    expect(
      await handleRequest({ type: MessageType.UrlChanged, url: 'x' }),
    ).toBeUndefined();
  });
});
