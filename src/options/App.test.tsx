/**
 * Component tests for the options App (task 12.1).
 *
 * These run under the jsdom Vitest project with @testing-library/preact. As in
 * the popup tests we mock the RPC seam (`../platform/rpc`) so `sendUi` returns
 * scripted {@link OrchestratorResult}s per request type, driving the
 * list / create / open→save / delete-with-confirm flows without a real
 * background.
 *
 * Coverage:
 *   - the list renders every saved config;
 *   - "New config" opens the editor on a fresh draft;
 *   - Delete asks for confirmation first, then sends DeleteConfig and refreshes;
 *   - open → edit name → Save sends SaveConfig.
 *
 * Requirements: 6.1, 6.6
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorResult } from '../background/orchestrator';
import type { StoredConfig } from '../core/schema';
import { MessageType, type ConfigSummary, type UiRequest } from '../platform/messages';

// --- Mocks -----------------------------------------------------------------

const { sendUi } = vi.hoisted(() => ({ sendUi: vi.fn() }));

vi.mock('../platform/rpc', () => ({ sendUi }));

const { takePendingEdit } = vi.hoisted(() => ({
  takePendingEdit: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock('../platform/store', () => ({ takePendingEdit }));

const { tabsQuery } = vi.hoisted(() => ({
  tabsQuery: vi.fn(async () => [{ id: 42 }] as Array<{ id?: number }>),
}));

vi.mock('../platform/browser', () => ({
  __esModule: true,
  default: {
    tabs: { query: tabsQuery },
    // ThemeToggle (rendered by App) reads the theme preference from
    // storage.local on mount; a no-op in-memory area keeps it from throwing.
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    },
  },
}));

import { App } from './App';

const ok = <T,>(value: T): OrchestratorResult<T> => ({ ok: true, value });
const fail = (error: string): OrchestratorResult<never> => ({
  ok: false,
  code: 'error',
  error,
});

const CONFIGS: ConfigSummary[] = [
  { id: 'c1', name: 'Login form', encrypted: false },
  { id: 'c2', name: 'Secret form', encrypted: true },
];

const STORED_C1: StoredConfig = {
  id: 'c1',
  name: 'Login form',
  match: [],
  steps: [],
  errorStrategy: 'stop',
  encrypted: false,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  sendUi.mockReset();
  tabsQuery.mockReset();
  tabsQuery.mockResolvedValue([{ id: 42 }]);
  takePendingEdit.mockReset();
  takePendingEdit.mockResolvedValue(null);
});

describe('options App', () => {
  it('lists every saved config', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListConfigs) return ok(CONFIGS);
      return fail('unexpected');
    });

    render(<App />);

    expect(await screen.findByText('Login form')).toBeTruthy();
    expect(screen.getByText('Secret form')).toBeTruthy();
    // The encrypted row shows the lock indicator.
    expect(screen.getByLabelText('Encrypted at rest')).toBeTruthy();
  });

  it('opens the editor on a fresh draft when New config is clicked', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListConfigs) return ok(CONFIGS);
      return fail('unexpected');
    });

    render(<App />);
    await screen.findByText('Login form');

    fireEvent.click(screen.getByText('New config'));

    // Editor shows with the default draft name; no GetConfig round-trip needed.
    const input = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(input.value).toBe('New config');
    expect(
      sendUi.mock.calls.some(([m]) => (m as UiRequest).type === MessageType.GetConfig),
    ).toBe(false);
  });

  it('asks for confirmation before deleting, then calls DeleteConfig and refreshes', async () => {
    let deleted = false;
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListConfigs) {
        return ok(deleted ? [CONFIGS[1]] : CONFIGS);
      }
      if (msg.type === MessageType.DeleteConfig) {
        expect(msg.configId).toBe('c1');
        deleted = true;
        return ok(null);
      }
      return fail('unexpected');
    });

    render(<App />);
    await screen.findByText('Login form');

    // First click reveals the inline confirmation — nothing deleted yet.
    fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);
    const confirmText = screen.getByText('Delete this config?');
    expect(confirmText).toBeTruthy();
    expect(
      sendUi.mock.calls.some(([m]) => (m as UiRequest).type === MessageType.DeleteConfig),
    ).toBe(false);

    // Confirm -> DeleteConfig sent, list refreshes without the deleted row.
    // Scope to the confirmation row's Delete button (other rows still show one).
    const confirmDelete = confirmText.parentElement?.querySelector(
      'button.danger',
    ) as HTMLElement;
    fireEvent.click(confirmDelete);

    await waitFor(() =>
      expect(
        sendUi.mock.calls.some(([m]) => (m as UiRequest).type === MessageType.DeleteConfig),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText('Login form')).toBeNull());
    expect(screen.getByText('Secret form')).toBeTruthy();
  });

  it('cancels a delete without calling DeleteConfig', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListConfigs) return ok(CONFIGS);
      return fail('unexpected');
    });

    render(<App />);
    await screen.findByText('Login form');

    fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByText('Delete this config?')).toBeNull();
    expect(
      sendUi.mock.calls.some(([m]) => (m as UiRequest).type === MessageType.DeleteConfig),
    ).toBe(false);
  });

  it('opens straight into the editor when the popup handed off a config to edit (Req 6.2)', async () => {
    takePendingEdit.mockResolvedValue('c1');
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListConfigs) return ok(CONFIGS);
      if (msg.type === MessageType.GetConfig) {
        expect(msg.configId).toBe('c1');
        return ok(STORED_C1);
      }
      return fail('unexpected');
    });

    render(<App />);

    // The editor opens for the handed-off config without any click.
    const input = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(input.value).toBe('Login form');
  });

  it('opens an existing config and saves an edited name via SaveConfig', async () => {
    let savedName: string | null = null;
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListConfigs) return ok(CONFIGS);
      if (msg.type === MessageType.GetConfig) {
        expect(msg.configId).toBe('c1');
        return ok(STORED_C1);
      }
      if (msg.type === MessageType.SaveConfig) {
        savedName = msg.config.name;
        return ok({ ...STORED_C1, name: msg.config.name } as StoredConfig);
      }
      return fail('unexpected');
    });

    render(<App />);
    await screen.findByText('Login form');

    fireEvent.click(screen.getAllByText('Edit')[0] as HTMLElement);

    const input = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(input.value).toBe('Login form');

    fireEvent.input(input, { target: { value: 'Renamed form' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(
        sendUi.mock.calls.some(([m]) => (m as UiRequest).type === MessageType.SaveConfig),
      ).toBe(true),
    );
    expect(savedName).toBe('Renamed form');
  });
});
