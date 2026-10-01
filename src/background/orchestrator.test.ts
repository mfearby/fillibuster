/**
 * jsdom tests for the background orchestration API (task 10.2).
 *
 * These run under the jsdom Vitest project. `webextension-polyfill` is mocked
 * with an in-memory fake exposing the `tabs` (get/sendMessage), `scripting`
 * (executeScript), and `runtime` surfaces the orchestrator uses. `../platform/
 * store` is mocked with an in-memory state so we control the configs, settings,
 * and session key without real storage. Crypto is REAL (`crypto.subtle` under
 * Node/jsdom) with a low iteration count so the unlock round-trip and
 * encrypt/decrypt paths exercise the actual primitives.
 *
 * Coverage:
 *  - listMatchingConfigs returns matching summaries (Req 5.1, 5.2)
 *  - runFill happy path relays applySteps and returns the summary (Req 5.3, 5.4)
 *  - runFill on a restricted URL returns a `restricted` error (Req 9.4)
 *  - runFill of an encrypted config while locked returns `locked` (Req 8.8)
 *  - unlock with correct vs wrong passphrase (Req 8.8, 8.9)
 *  - CRUD round-trip (Req 6.5)
 *  - import/export round-trip (Req 7.1, 7.3)
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.5, 7.1, 7.3, 8.8, 8.9, 9.1, 9.4
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FillConfig, StoredConfig, StoredState } from '../core/schema';
import type { FillSummary } from '../content/fill';

// ---------------------------------------------------------------------------
// webextension-polyfill fake
// ---------------------------------------------------------------------------

const { tabsGet, tabsSendMessage, executeScript } = vi.hoisted(() => ({
  tabsGet: vi.fn(async (_id: number): Promise<{ url?: string }> => ({ url: 'https://example.com/' })),
  tabsSendMessage: vi.fn(async (_id: number, _msg: unknown): Promise<unknown> => undefined),
  executeScript: vi.fn(async (_arg: unknown): Promise<unknown> => []),
}));

vi.mock('webextension-polyfill', () => {
  const browser = {
    tabs: { get: tabsGet, sendMessage: tabsSendMessage },
    scripting: { executeScript },
    runtime: { onMessage: { addListener: () => undefined } },
  };
  return { __esModule: true, default: browser, browser };
});

// ---------------------------------------------------------------------------
// In-memory ../platform/store fake
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => {
  let state: StoredState = {
    schemaVersion: 1,
    settings: { encryptionEnabled: false },
    configs: {},
  };
  let sessionKey: CryptoKey | null = null;

  return {
    reset() {
      state = { schemaVersion: 1, settings: { encryptionEnabled: false }, configs: {} };
      sessionKey = null;
    },
    setState(next: StoredState) {
      state = next;
    },
    listConfigs: vi.fn(async () => Object.values(state.configs)),
    getConfig: vi.fn(async (id: string) => state.configs[id]),
    putConfig: vi.fn(async (config: StoredConfig) => {
      state.configs[config.id] = config;
      return null;
    }),
    deleteConfig: vi.fn(async (id: string) => {
      delete state.configs[id];
      return null;
    }),
    getSettings: vi.fn(async () => state.settings),
    updateSettings: vi.fn(async (patch: Partial<StoredState['settings']>) => {
      state.settings = { ...state.settings, ...patch };
    }),
    setEncryptionEnabled: vi.fn(async (enabled: boolean) => {
      if (enabled) {
        state.settings = { ...state.settings, encryptionEnabled: true };
        return;
      }
      state.settings = { encryptionEnabled: false };
    }),
    setKdf: vi.fn(async (kdf: { salt: string; iterations: number }) => {
      state.settings.kdf = kdf;
    }),
    setVerifier: vi.fn(async (verifier: string) => {
      state.settings.verifier = verifier;
    }),
    setSessionKey: vi.fn(async (key: CryptoKey) => {
      sessionKey = key;
    }),
    getSessionKey: vi.fn(async () => sessionKey),
    clearSessionKey: vi.fn(async () => {
      sessionKey = null;
    }),
  };
});

vi.mock('../platform/store', () => ({
  listConfigs: store.listConfigs,
  getConfig: store.getConfig,
  putConfig: store.putConfig,
  deleteConfig: store.deleteConfig,
  getSettings: store.getSettings,
  updateSettings: store.updateSettings,
  setEncryptionEnabled: store.setEncryptionEnabled,
  setKdf: store.setKdf,
  setVerifier: store.setVerifier,
  setSessionKey: store.setSessionKey,
  getSessionKey: store.getSessionKey,
  clearSessionKey: store.clearSessionKey,
}));

// Import AFTER mocks are registered.
import { handleUiMessage } from './orchestrator';
import { encryptSteps } from '../core/crypto';
import { MessageType } from '../platform/messages';
import { exportConfigJson } from '../core/share';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function plainConfig(overrides: Partial<FillConfig> = {}): FillConfig {
  return {
    id: 'cfg-1',
    name: 'Example',
    match: [{ kind: 'prefix', pattern: 'https://example.com/' }],
    steps: [
      { id: 's1', type: 'text', target: { by: 'id', value: 'name' }, value: 'Ada' },
    ],
    errorStrategy: 'continue',
    encrypted: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function summary(): FillSummary {
  return { total: 1, succeeded: 1, failed: 0, results: [{ index: 0, ok: true }] };
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
  tabsGet.mockResolvedValue({ url: 'https://example.com/apply' });
  tabsSendMessage.mockResolvedValue(undefined);
  executeScript.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// listMatchingConfigs (Req 5.1, 5.2)
// ---------------------------------------------------------------------------

describe('listMatchingConfigs (Req 5.1, 5.2)', () => {
  it('returns summaries of configs matching the tab URL', async () => {
    store.setState({
      schemaVersion: 1,
      settings: { encryptionEnabled: false },
      configs: {
        'cfg-1': { ...plainConfig(), encrypted: false },
        'cfg-2': {
          ...plainConfig({ id: 'cfg-2', name: 'Other', match: [{ kind: 'exact', pattern: 'https://nope.test/' }] }),
          encrypted: false,
        },
      },
    });

    const res = await handleUiMessage({ type: MessageType.ListMatchingConfigs, tabId: 1 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual([{ id: 'cfg-1', name: 'Example', encrypted: false }]);
    }
  });

  it('returns a no-tab error when the tab is gone', async () => {
    tabsGet.mockRejectedValue(new Error('No tab with id'));
    const res = await handleUiMessage({ type: MessageType.ListMatchingConfigs, tabId: 99 });
    expect(res).toMatchObject({ ok: false, code: 'no-tab' });
  });
});

// ---------------------------------------------------------------------------
// runFill (Req 5.3, 5.4, 5.5, 9.1, 9.4)
// ---------------------------------------------------------------------------

describe('runFill (Req 5.3, 5.4, 9.1, 9.4)', () => {
  it('relays applySteps and returns the summary on the happy path', async () => {
    store.setState({
      schemaVersion: 1,
      settings: { encryptionEnabled: false },
      configs: { 'cfg-1': { ...plainConfig(), encrypted: false } },
    });
    tabsSendMessage.mockResolvedValue(summary());

    const res = await handleUiMessage({ type: MessageType.RunFill, configId: 'cfg-1', tabId: 3 });

    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 3 }, files: ['content.js'] });
    expect(tabsSendMessage).toHaveBeenCalledWith(3, {
      type: MessageType.ApplySteps,
      steps: plainConfig().steps,
      errorStrategy: 'continue',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(summary());
  });

  it('returns a restricted error for a browser-internal URL (Req 9.4)', async () => {
    tabsGet.mockResolvedValue({ url: 'chrome://extensions' });
    store.setState({
      schemaVersion: 1,
      settings: { encryptionEnabled: false },
      configs: { 'cfg-1': { ...plainConfig(), encrypted: false } },
    });

    const res = await handleUiMessage({ type: MessageType.RunFill, configId: 'cfg-1', tabId: 3 });
    expect(res).toMatchObject({ ok: false, code: 'restricted' });
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });

  it('returns a no-tab error when there is no active tab (Req 9.4)', async () => {
    tabsGet.mockRejectedValue(new Error('gone'));
    const res = await handleUiMessage({ type: MessageType.RunFill, configId: 'cfg-1', tabId: 3 });
    expect(res).toMatchObject({ ok: false, code: 'no-tab' });
  });

  it('returns a locked error when running an encrypted config while locked (Req 8.8)', async () => {
    // Build an encrypted stored config using a real key we then discard, so the
    // session is "locked" (no session key).
    const salt = 'AAAAAAAAAAAAAAAAAAAAAA==';
    const { deriveKey } = await import('../core/crypto');
    const key = await deriveKey('pw', salt, 1000);
    const cipher = await encryptSteps(plainConfig().steps, key);
    store.setState({
      schemaVersion: 1,
      settings: { encryptionEnabled: true, kdf: { salt, iterations: 1000 }, verifier: 'x' },
      configs: {
        'enc-1': {
          encrypted: true,
          id: 'enc-1',
          name: 'Secret',
          match: [{ kind: 'prefix', pattern: 'https://example.com/' }],
          errorStrategy: 'continue',
          createdAt: 0,
          updatedAt: 0,
          cipher,
        },
      },
    });

    const res = await handleUiMessage({ type: MessageType.RunFill, configId: 'enc-1', tabId: 3 });
    expect(res).toMatchObject({ ok: false, code: 'locked' });
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });

  it('reports restricted when content-script injection is rejected (Req 9.4)', async () => {
    store.setState({
      schemaVersion: 1,
      settings: { encryptionEnabled: false },
      configs: { 'cfg-1': { ...plainConfig(), encrypted: false } },
    });
    executeScript.mockRejectedValue(new Error('Cannot access contents of the page'));

    const res = await handleUiMessage({ type: MessageType.RunFill, configId: 'cfg-1', tabId: 3 });
    expect(res).toMatchObject({ ok: false, code: 'restricted' });
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// captureTab (Req 2.2, 9.4)
// ---------------------------------------------------------------------------

describe('captureTab (Req 2.2, 9.4)', () => {
  it('relays capturePage and returns the candidates on the happy path', async () => {
    const candidates = [
      {
        step: { id: 's1', type: 'text', target: { by: 'id', value: 'name' }, value: 'Ada' },
        fragile: false,
      },
      {
        step: { id: 's2', type: 'check', target: { by: 'css', value: 'form > input:nth-of-type(2)' }, checked: true },
        fragile: true,
      },
    ];
    tabsSendMessage.mockResolvedValue(candidates);

    const res = await handleUiMessage({ type: MessageType.CaptureTab, tabId: 7 });

    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['content.js'] });
    expect(tabsSendMessage).toHaveBeenCalledWith(7, { type: MessageType.CapturePage });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(candidates);
  });

  it('returns a restricted error for a browser-internal URL (Req 9.4)', async () => {
    tabsGet.mockResolvedValue({ url: 'chrome://extensions' });
    const res = await handleUiMessage({ type: MessageType.CaptureTab, tabId: 7 });
    expect(res).toMatchObject({ ok: false, code: 'restricted' });
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });

  it('returns a no-tab error when the tab is gone (Req 9.4)', async () => {
    tabsGet.mockRejectedValue(new Error('gone'));
    const res = await handleUiMessage({ type: MessageType.CaptureTab, tabId: 7 });
    expect(res).toMatchObject({ ok: false, code: 'no-tab' });
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Encryption lock/unlock (Req 8.4, 8.7, 8.8, 8.9)
// ---------------------------------------------------------------------------

describe('encryption lock/unlock (Req 8.8, 8.9)', () => {
  it('enable → unlock round-trip: correct passphrase unlocks', async () => {
    // Enable encryption (uses real crypto; DEFAULT_ITERATIONS is fine but slow —
    // acceptable for a single call).
    const enable = await handleUiMessage({ type: MessageType.EnableEncryption, passphrase: 'correct horse' });
    expect(enable.ok).toBe(true);
    expect(store.setSessionKey).toHaveBeenCalled();

    // Lock, then unlock with the right passphrase.
    await handleUiMessage({ type: MessageType.Lock });
    const unlocked = await handleUiMessage({ type: MessageType.IsUnlocked });
    expect(unlocked).toMatchObject({ ok: true, value: false });

    const res = await handleUiMessage({ type: MessageType.Unlock, passphrase: 'correct horse' });
    expect(res.ok).toBe(true);
    const after = await handleUiMessage({ type: MessageType.IsUnlocked });
    expect(after).toMatchObject({ ok: true, value: true });
  });

  it('rejects a wrong passphrase without corrupting data (Req 8.9)', async () => {
    await handleUiMessage({ type: MessageType.EnableEncryption, passphrase: 'right' });
    await handleUiMessage({ type: MessageType.Lock });

    const res = await handleUiMessage({ type: MessageType.Unlock, passphrase: 'wrong' });
    expect(res).toMatchObject({ ok: false, code: 'wrong-passphrase' });
    // Settings (verifier/kdf) untouched.
    const settings = await store.getSettings();
    expect(settings.encryptionEnabled).toBe(true);
    expect(settings.verifier).toBeDefined();
    // Still locked.
    const unlocked = await handleUiMessage({ type: MessageType.IsUnlocked });
    expect(unlocked).toMatchObject({ ok: true, value: false });
  });
});

// ---------------------------------------------------------------------------
// Encryption status + disable (task 12.5, Req 8.3, 8.4, 8.8)
// ---------------------------------------------------------------------------

describe('encryption status + disable (Req 8.3, 8.4, 8.8)', () => {
  it('reports disabled by default (Req 8.3)', async () => {
    const res = await handleUiMessage({ type: MessageType.EncryptionStatus });
    expect(res).toMatchObject({ ok: true, value: { enabled: false, unlocked: false } });
  });

  it('reports enabled + unlocked after enabling (Req 8.4)', async () => {
    await handleUiMessage({ type: MessageType.EnableEncryption, passphrase: 'pw' });
    const res = await handleUiMessage({ type: MessageType.EncryptionStatus });
    expect(res).toMatchObject({ ok: true, value: { enabled: true, unlocked: true } });
  });

  it('reports enabled + locked after locking (Req 8.8)', async () => {
    await handleUiMessage({ type: MessageType.EnableEncryption, passphrase: 'pw' });
    await handleUiMessage({ type: MessageType.Lock });
    const res = await handleUiMessage({ type: MessageType.EncryptionStatus });
    expect(res).toMatchObject({ ok: true, value: { enabled: true, unlocked: false } });
  });

  it('disables encryption and clears the session key (Req 8.4)', async () => {
    await handleUiMessage({ type: MessageType.EnableEncryption, passphrase: 'pw' });
    const res = await handleUiMessage({ type: MessageType.DisableEncryption });
    expect(res.ok).toBe(true);

    const status = await handleUiMessage({ type: MessageType.EncryptionStatus });
    expect(status).toMatchObject({ ok: true, value: { enabled: false, unlocked: false } });
    const settings = await store.getSettings();
    expect(settings.encryptionEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CRUD (Req 6.5)
// ---------------------------------------------------------------------------

describe('config CRUD (Req 6.5)', () => {
  it('saves, lists, gets, and deletes a plaintext config', async () => {
    const config = plainConfig();
    const save = await handleUiMessage({ type: MessageType.SaveConfig, config });
    expect(save.ok).toBe(true);

    const list = await handleUiMessage({ type: MessageType.ListConfigs });
    expect(list).toMatchObject({ ok: true, value: [{ id: 'cfg-1', name: 'Example', encrypted: false }] });

    const get = await handleUiMessage({ type: MessageType.GetConfig, configId: 'cfg-1' });
    expect(get.ok).toBe(true);
    if (get.ok) expect((get.value as StoredConfig).id).toBe('cfg-1');

    const del = await handleUiMessage({ type: MessageType.DeleteConfig, configId: 'cfg-1' });
    expect(del.ok).toBe(true);
    const listAfter = await handleUiMessage({ type: MessageType.ListConfigs });
    expect(listAfter).toMatchObject({ ok: true, value: [] });
  });

  it('encrypts steps when saving an encrypted config while unlocked', async () => {
    await handleUiMessage({ type: MessageType.EnableEncryption, passphrase: 'pw' });
    const res = await handleUiMessage({
      type: MessageType.SaveConfig,
      config: plainConfig({ encrypted: true }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const stored = res.value as StoredConfig;
      expect(stored.encrypted).toBe(true);
      if (stored.encrypted) {
        expect(stored.cipher.iv).toBeTruthy();
        expect(stored.cipher.data).toBeTruthy();
      }
      // Plaintext steps are not persisted on the encrypted arm.
      expect('steps' in stored).toBe(false);
    }
  });

  it('returns locked when saving an encrypted config while locked', async () => {
    await handleUiMessage({ type: MessageType.EnableEncryption, passphrase: 'pw' });
    await handleUiMessage({ type: MessageType.Lock });
    const res = await handleUiMessage({
      type: MessageType.SaveConfig,
      config: plainConfig({ encrypted: true }),
    });
    expect(res).toMatchObject({ ok: false, code: 'locked' });
  });

  it('getConfig on a missing id returns not-found', async () => {
    const res = await handleUiMessage({ type: MessageType.GetConfig, configId: 'nope' });
    expect(res).toMatchObject({ ok: false, code: 'not-found' });
  });
});

// ---------------------------------------------------------------------------
// Import / export (Req 7.1, 7.3)
// ---------------------------------------------------------------------------

describe('import / export (Req 7.1, 7.3)', () => {
  it('exports a plaintext config as a JSON envelope', async () => {
    store.setState({
      schemaVersion: 1,
      settings: { encryptionEnabled: false },
      configs: { 'cfg-1': { ...plainConfig(), encrypted: false } },
    });
    const res = await handleUiMessage({ type: MessageType.ExportConfig, configId: 'cfg-1' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const parsed = JSON.parse(res.value as string);
      expect(parsed.app).toBe('fillibuster');
      expect(parsed.config.id).toBe('cfg-1');
      expect(parsed.config.steps).toEqual(plainConfig().steps);
    }
  });

  it('decrypts an encrypted config before export (Req 7.1)', async () => {
    await handleUiMessage({ type: MessageType.EnableEncryption, passphrase: 'pw' });
    await handleUiMessage({ type: MessageType.SaveConfig, config: plainConfig({ encrypted: true }) });

    const res = await handleUiMessage({ type: MessageType.ExportConfig, configId: 'cfg-1' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const parsed = JSON.parse(res.value as string);
      expect(parsed.config.encrypted).toBe(false);
      expect(parsed.config.steps).toEqual(plainConfig().steps);
    }
  });

  it('imports a valid envelope as a new config (Req 7.3)', async () => {
    const envelope = exportConfigJson(plainConfig({ id: 'import-1', name: 'Imported' }));
    const res = await handleUiMessage({ type: MessageType.ImportConfig, text: envelope });
    expect(res.ok).toBe(true);
    const list = await handleUiMessage({ type: MessageType.ListConfigs });
    expect(list).toMatchObject({ ok: true, value: [{ id: 'import-1', name: 'Imported', encrypted: false }] });
  });

  it('rejects malformed import text with an error and stores nothing (Req 7.4)', async () => {
    const res = await handleUiMessage({ type: MessageType.ImportConfig, text: 'not json' });
    expect(res).toMatchObject({ ok: false, code: 'error' });
    const list = await handleUiMessage({ type: MessageType.ListConfigs });
    expect(list).toMatchObject({ ok: true, value: [] });
  });
});
