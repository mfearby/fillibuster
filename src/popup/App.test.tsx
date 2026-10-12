/**
 * Component tests for the popup App (task 11).
 *
 * These run under the jsdom Vitest project with @testing-library/preact. Rather
 * than reach the real background, we mock two seams:
 *   - `../platform/rpc` — so `sendUi` returns scripted {@link OrchestratorResult}s
 *     per request type, letting us drive the list/run/locked/unlock flows.
 *   - `../platform/browser` — a fake `tabs.query` (active tab) and
 *     `runtime.openOptionsPage` spy for the no-match affordances.
 *
 * Coverage: matching configs are listed; Run shows the per-step summary; a
 * `locked` run opens the passphrase prompt and a correct unlock retries the run
 * and shows the summary; a no-match state shows the capture/settings buttons.
 *
 * Requirements: 5.1, 5.2, 5.4, 5.6, 8.8, 9.1
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorResult } from '../background/orchestrator';
import { MessageType, type ConfigSummary, type UiRequest } from '../platform/messages';
import type { FillSummary } from '../content/fill';

// --- Mocks -----------------------------------------------------------------

const { sendUi, openOptionsPage, tabsQuery } = vi.hoisted(() => ({
  sendUi: vi.fn(),
  openOptionsPage: vi.fn(async () => undefined),
  tabsQuery: vi.fn(async () => [{ id: 42 }]),
}));

vi.mock('../platform/rpc', () => ({ sendUi }));

vi.mock('../platform/browser', () => {
  const browser = {
    tabs: { query: tabsQuery },
    runtime: { openOptionsPage },
    // ThemeToggle (rendered by App) reads the theme preference from
    // storage.local on mount; a no-op in-memory area keeps it from throwing.
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    },
  };
  return { __esModule: true, default: browser, browser };
});

import { App } from './App';

const ok = <T,>(value: T): OrchestratorResult<T> => ({ ok: true, value });
const fail = (
  code: OrchestratorResult['ok'] extends true ? never : 'locked' | 'wrong-passphrase' | 'restricted' | 'no-tab' | 'not-found' | 'error',
  error: string,
): OrchestratorResult<never> => ({ ok: false, code, error });

const MATCHING: ConfigSummary[] = [
  { id: 'c1', name: 'Login form', encrypted: false },
  { id: 'c2', name: 'Secret form', encrypted: true },
];

const SUMMARY: FillSummary = {
  total: 2,
  succeeded: 1,
  failed: 1,
  results: [
    { index: 0, ok: true },
    { index: 1, ok: false, reason: 'element not found' },
  ],
};

beforeEach(() => {
  sendUi.mockReset();
  openOptionsPage.mockClear();
  tabsQuery.mockReset();
  tabsQuery.mockResolvedValue([{ id: 42 }]);
});

describe('popup App', () => {
  it('lists the configs matching the active tab', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListMatchingConfigs) {
        expect(msg.tabId).toBe(42);
        return ok(MATCHING);
      }
      return fail('error', 'unexpected');
    });

    render(<App />);

    expect(await screen.findByText('Login form')).toBeTruthy();
    expect(screen.getByText('Secret form')).toBeTruthy();
    expect(screen.getAllByText('Run')).toHaveLength(2);
  });

  it('runs a config and shows the per-step summary', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListMatchingConfigs) return ok(MATCHING);
      if (msg.type === MessageType.RunFill) {
        expect(msg.configId).toBe('c1');
        return ok(SUMMARY);
      }
      return fail('error', 'unexpected');
    });

    render(<App />);
    await screen.findByText('Login form');

    fireEvent.click(screen.getAllByText('Run')[0] as HTMLElement);

    expect(await screen.findByText(/1 of 2 succeeded, 1 failed/)).toBeTruthy();
    expect(screen.getByText(/Step 1: ok/)).toBeTruthy();
    expect(screen.getByText(/Step 2: failed — element not found/)).toBeTruthy();
  });

  it('prompts for the passphrase on a locked run, then unlocks and retries', async () => {
    let unlocked = false;
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListMatchingConfigs) return ok(MATCHING);
      if (msg.type === MessageType.Unlock) {
        unlocked = true;
        return ok(null);
      }
      if (msg.type === MessageType.RunFill) {
        return unlocked ? ok(SUMMARY) : fail('locked', 'This config is encrypted.');
      }
      return fail('error', 'unexpected');
    });

    render(<App />);
    await screen.findByText('Secret form');

    // Run the encrypted config -> triggers the locked prompt.
    fireEvent.click(screen.getAllByText('Run')[1] as HTMLElement);

    const input = await screen.findByLabelText('Master passphrase');
    fireEvent.input(input, { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByText('Unlock and run'));

    // After unlock + retry, the summary is shown.
    expect(await screen.findByText(/1 of 2 succeeded, 1 failed/)).toBeTruthy();
    expect(
      sendUi.mock.calls.some(([m]) => (m as UiRequest).type === MessageType.Unlock),
    ).toBe(true);
  });

  it('shows a wrong-passphrase message when unlock fails', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListMatchingConfigs) return ok(MATCHING);
      if (msg.type === MessageType.Unlock) return fail('wrong-passphrase', 'Incorrect passphrase.');
      if (msg.type === MessageType.RunFill) return fail('locked', 'This config is encrypted.');
      return fail('error', 'unexpected');
    });

    render(<App />);
    await screen.findByText('Secret form');
    fireEvent.click(screen.getAllByText('Run')[1] as HTMLElement);

    const input = await screen.findByLabelText('Master passphrase');
    fireEvent.input(input, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByText('Unlock and run'));

    expect(await screen.findByText(/Incorrect passphrase/)).toBeTruthy();
  });

  it('offers capture and settings when nothing matches', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListMatchingConfigs) return ok<ConfigSummary[]>([]);
      return fail('error', 'unexpected');
    });

    render(<App />);

    const capture = await screen.findByText('Capture this page');
    expect(capture).toBeTruthy();
    const settings = screen.getByText('Open settings');
    expect(settings).toBeTruthy();

    fireEvent.click(settings);
    await waitFor(() => expect(openOptionsPage).toHaveBeenCalled());
  });
});
