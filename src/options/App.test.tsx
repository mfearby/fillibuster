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
import type { FillConfig, StoredConfig } from '../core/schema';
import { MessageType, type ConfigSummary, type UiRequest } from '../platform/messages';

// --- Mocks -----------------------------------------------------------------

const { sendUi } = vi.hoisted(() => ({ sendUi: vi.fn() }));

vi.mock('../platform/rpc', () => ({ sendUi }));

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

import type { CaptureCandidate } from '../content/capture';

const CANDIDATES: CaptureCandidate[] = [
  {
    step: { id: 's1', type: 'text', target: { by: 'id', value: 'email' }, value: 'a@b.co' },
    fragile: false,
  },
  {
    step: { id: 's2', type: 'check', target: { by: 'css', value: 'form > input:nth-of-type(2)' }, checked: true },
    fragile: true,
  },
];

beforeEach(() => {
  sendUi.mockReset();
  tabsQuery.mockReset();
  tabsQuery.mockResolvedValue([{ id: 42 }]);
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
    expect(screen.getByLabelText('Encrypted')).toBeTruthy();
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

    fireEvent.click(screen.getAllByText('Open')[0] as HTMLElement);

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

  it('starts a capture, shows candidates and flags the fragile one (Req 2.2, 2.6)', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListConfigs) return ok(CONFIGS);
      if (msg.type === MessageType.CaptureTab) {
        expect(msg.tabId).toBe(42);
        return ok(CANDIDATES);
      }
      return fail('unexpected');
    });

    render(<App />);
    await screen.findByText('Login form');

    fireEvent.click(screen.getByText('Capture active tab'));

    // The review view appears with both candidates; the fragile one is flagged.
    expect(await screen.findByText('Review captured fields')).toBeTruthy();
    expect(screen.getByText(/Fragile selector/)).toBeTruthy();
    expect(screen.getAllByLabelText(/^Keep field/)).toHaveLength(2);
  });

  it('excludes an unchecked candidate from the created config (Req 2.5)', async () => {
    let savedConfig: FillConfig | undefined;
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListConfigs) return ok(CONFIGS);
      if (msg.type === MessageType.CaptureTab) return ok(CANDIDATES);
      if (msg.type === MessageType.SaveConfig) {
        savedConfig = msg.config;
        return ok({ ...msg.config, encrypted: false } as StoredConfig);
      }
      return fail('unexpected');
    });

    render(<App />);
    await screen.findByText('Login form');
    fireEvent.click(screen.getByText('Capture active tab'));
    await screen.findByText('Review captured fields');

    // Uncheck the second (fragile) candidate so only the first is kept.
    const keeps = screen.getAllByLabelText(/^Keep field/) as HTMLInputElement[];
    fireEvent.click(keeps[1] as HTMLInputElement);

    // Create the config from the single kept field, then save it.
    fireEvent.click(screen.getByText(/Create config from/));

    // Editor opens as a draft (no GetConfig). Save and assert the steps.
    fireEvent.click(await screen.findByText('Save'));

    await waitFor(() =>
      expect(
        sendUi.mock.calls.some(([m]) => (m as UiRequest).type === MessageType.SaveConfig),
      ).toBe(true),
    );
    expect(savedConfig).toBeDefined();
    expect(savedConfig?.steps).toHaveLength(1);
    expect(savedConfig?.steps[0]?.id).toBe('s1');
  });

  it('opens the editor with only kept steps (Req 2.5)', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListConfigs) return ok(CONFIGS);
      if (msg.type === MessageType.CaptureTab) return ok(CANDIDATES);
      return fail('unexpected');
    });

    render(<App />);
    await screen.findByText('Login form');
    fireEvent.click(screen.getByText('Capture active tab'));
    await screen.findByText('Review captured fields');

    // Keep both; create -> editor draft should render two steps.
    fireEvent.click(screen.getByText(/Create config from 2 fields/));

    // The editor's step list shows two steps (Step 1 / Step 2).
    expect(await screen.findByText('Step 1')).toBeTruthy();
    expect(screen.getByText('Step 2')).toBeTruthy();
    // Opened as a draft — no GetConfig round-trip.
    expect(
      sendUi.mock.calls.some(([m]) => (m as UiRequest).type === MessageType.GetConfig),
    ).toBe(false);
  });

  it('opens the export dialog for a config row and copies the envelope (Req 7.1, 7.2)', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const envelope = '{"app":"fillibuster","schemaVersion":1,"config":{}}';
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListConfigs) return ok(CONFIGS);
      if (msg.type === MessageType.ExportConfig) {
        expect(msg.configId).toBe('c1');
        return ok(envelope);
      }
      return fail('unexpected');
    });

    render(<App />);
    await screen.findByText('Login form');

    // The first (plaintext) row's Export action opens the dialog and exports.
    fireEvent.click(screen.getAllByText('Export')[0] as HTMLElement);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(envelope));
    expect(await screen.findByText('Copied to clipboard.')).toBeTruthy();
  });

  it('imports a pasted config, refreshes the list and shows the added name (Req 7.3, 7.5)', async () => {
    let imported = false;
    const newStored: StoredConfig = {
      ...STORED_C1,
      id: 'c3',
      name: 'Imported form',
    };
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListConfigs) {
        return ok(imported ? [...CONFIGS, { id: 'c3', name: 'Imported form', encrypted: false }] : CONFIGS);
      }
      if (msg.type === MessageType.ImportConfig) {
        expect(msg.text).toBe('{"app":"fillibuster"}');
        imported = true;
        return ok(newStored);
      }
      return fail('unexpected');
    });

    render(<App />);
    await screen.findByText('Login form');

    fireEvent.click(screen.getByText('Import config'));
    const textarea = (await screen.findByLabelText(
      'Exported config (JSON)',
    )) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: '{"app":"fillibuster"}' } });
    fireEvent.click(screen.getByText('Add config'));

    await waitFor(() =>
      expect(
        sendUi.mock.calls.some(([m]) => (m as UiRequest).type === MessageType.ImportConfig),
      ).toBe(true),
    );
    expect(await screen.findByText('Added as "Imported form".')).toBeTruthy();

    // Returning to the list reflects the newly-added config.
    fireEvent.click(screen.getByText('Done'));
    expect(await screen.findByText('Imported form')).toBeTruthy();
  });

  it('leaves the list unchanged when an import fails (Req 7.4)', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListConfigs) return ok(CONFIGS);
      if (msg.type === MessageType.ImportConfig) {
        return { ok: false, code: 'error', error: 'not valid JSON' } as OrchestratorResult<never>;
      }
      return fail('unexpected');
    });

    render(<App />);
    await screen.findByText('Login form');

    fireEvent.click(screen.getByText('Import config'));
    const textarea = (await screen.findByLabelText(
      'Exported config (JSON)',
    )) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'garbage' } });
    fireEvent.click(screen.getByText('Add config'));

    expect(await screen.findByText('not valid JSON')).toBeTruthy();
    // No confirmation, and the import call didn't add anything.
    expect(screen.queryByText(/^Added as/)).toBeNull();
  });

  it('surfaces a restricted error when capture is refused (Req 9.4)', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ListConfigs) return ok(CONFIGS);
      if (msg.type === MessageType.CaptureTab) {
        return { ok: false, code: 'restricted', error: "Can't capture here." } as OrchestratorResult<never>;
      }
      return fail('unexpected');
    });

    render(<App />);
    await screen.findByText('Login form');
    fireEvent.click(screen.getByText('Capture active tab'));

    expect(await screen.findByText("Can't capture here.")).toBeTruthy();
    // Stayed on the list view (no review shown).
    expect(screen.queryByText('Review captured fields')).toBeNull();
  });
});
