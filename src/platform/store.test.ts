/**
 * Tests for the storage repository (task 6.2).
 *
 * These run under the jsdom Vitest project (see vitest.workspace.ts). Rather
 * than touch a real browser, we mock `webextension-polyfill` with an in-memory
 * fake of `storage.local` and `storage.session` that implements the subset the
 * store uses (get/set/remove/getBytesInUse). `src/platform/browser` re-exports
 * the polyfill, so mocking the polyfill module covers the store's import too.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.8, 8.12
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FillConfig, StoredConfig } from '../core/schema';
import { SCHEMA_VERSION } from '../core/schema';

/**
 * A minimal in-memory storage area mirroring the WebExtension StorageArea API.
 * Declared inside `vi.hoisted` so the (hoisted) `vi.mock` factory below can
 * close over the same instances the tests inspect.
 */
const { local, session } = vi.hoisted(() => {
  class FakeArea {
    store = new Map<string, unknown>();
    /** Overridable so tests can force a high byte count for the threshold check. */
    bytesInUse = vi.fn(async (): Promise<number> => 0);

    get = vi.fn(async (key?: null | string | string[]): Promise<Record<string, unknown>> => {
      if (key == null) return Object.fromEntries(this.store);
      const keys = Array.isArray(key) ? key : [key];
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (this.store.has(k)) out[k] = this.store.get(k);
      }
      return out;
    });

    set = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
      for (const [k, v] of Object.entries(items)) this.store.set(k, v);
    });

    remove = vi.fn(async (key: string | string[]): Promise<void> => {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) this.store.delete(k);
    });

    getBytesInUse = vi.fn(async (_keys?: null | string | string[]): Promise<number> => {
      return this.bytesInUse();
    });
  }
  return { local: new FakeArea(), session: new FakeArea() };
});

// Mock the polyfill; browser.ts re-exports this same object.
vi.mock('webextension-polyfill', () => {
  const browser = { storage: { local, session } };
  return { __esModule: true, default: browser, browser };
});

// Import the module under test AFTER the mock is registered.
import {
  LOCAL_QUOTA_BYTES,
  SESSION_KEY,
  STATE_KEY,
  WARN_THRESHOLD,
  checkStorageUsage,
  clearSessionKey,
  deleteConfig,
  getConfig,
  getSessionKey,
  getSettings,
  listConfigs,
  loadState,
  putConfig,
  saveState,
  setEncryptionEnabled,
  setKdf,
  setSessionKey,
  setVerifier,
  updateSettings,
} from './store';

/** Build a plaintext (unencrypted) stored config with overridable fields. */
function makeConfig(id: string, name = id): StoredConfig {
  const config: FillConfig = {
    id,
    name,
    match: [{ kind: 'prefix', pattern: `https://example.com/${id}` }],
    steps: [{ id: 's1', type: 'text', target: { by: 'id', value: 'first' }, value: 'Ada' }],
    errorStrategy: 'stop',
    encrypted: false,
    createdAt: 1,
    updatedAt: 1,
  };
  return { ...config, encrypted: false };
}

beforeEach(() => {
  local.store.clear();
  session.store.clear();
  local.bytesInUse.mockResolvedValue(0);
  session.bytesInUse.mockResolvedValue(0);
  vi.clearAllMocks();
});

describe('loadState / saveState (Req 8.1, 8.3)', () => {
  it('returns a default empty state when nothing is stored', async () => {
    const state = await loadState();
    expect(state).toEqual({
      schemaVersion: SCHEMA_VERSION,
      settings: { encryptionEnabled: false },
      configs: {},
    });
    // First run works with encryption disabled and no prompt (Req 8.3, 8.5).
    expect(state.settings.encryptionEnabled).toBe(false);
  });

  it('persists to storage.local under the state key and reads it back', async () => {
    const state = await loadState();
    state.configs['a'] = makeConfig('a');
    await saveState(state);

    expect(local.set).toHaveBeenCalledWith({ [STATE_KEY]: state });
    const reloaded = await loadState();
    expect(reloaded.configs['a']).toEqual(makeConfig('a'));
  });

  it('backfills a partially-shaped stored object', async () => {
    local.store.set(STATE_KEY, { configs: { a: makeConfig('a') } });
    const state = await loadState();
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.settings).toEqual({ encryptionEnabled: false });
    expect(Object.keys(state.configs)).toEqual(['a']);
  });
});

describe('config CRUD (Req 8.1)', () => {
  it('putConfig then getConfig round-trips', async () => {
    await putConfig(makeConfig('a', 'Alpha'));
    const got = await getConfig('a');
    expect(got?.name).toBe('Alpha');
  });

  it('getConfig returns undefined for a missing id', async () => {
    expect(await getConfig('nope')).toBeUndefined();
  });

  it('putConfig replaces an existing config with the same id', async () => {
    await putConfig(makeConfig('a', 'Alpha'));
    await putConfig(makeConfig('a', 'Renamed'));
    const got = await getConfig('a');
    expect(got?.name).toBe('Renamed');
    expect(await listConfigs()).toHaveLength(1);
  });

  it('listConfigs returns every stored config', async () => {
    await putConfig(makeConfig('a'));
    await putConfig(makeConfig('b'));
    const ids = (await listConfigs()).map((c) => c.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('deleteConfig removes a config and is a no-op for a missing id', async () => {
    await putConfig(makeConfig('a'));
    await deleteConfig('a');
    expect(await getConfig('a')).toBeUndefined();
    // Idempotent: deleting again should not throw or write.
    local.set.mockClear();
    await deleteConfig('a');
    expect(local.set).not.toHaveBeenCalled();
  });
});

describe('encryption settings (Req 8.3, 8.4)', () => {
  it('getSettings reports encryption disabled by default', async () => {
    expect(await getSettings()).toEqual({ encryptionEnabled: false });
  });

  it('setEncryptionEnabled(true) flips the flag', async () => {
    await setEncryptionEnabled(true);
    expect((await getSettings()).encryptionEnabled).toBe(true);
  });

  it('setKdf and setVerifier store their values', async () => {
    await setEncryptionEnabled(true);
    await setKdf({ salt: 'c2FsdA==', iterations: 300_000 });
    await setVerifier('verifier-blob');

    const settings = await getSettings();
    expect(settings.encryptionEnabled).toBe(true);
    expect(settings.kdf).toEqual({ salt: 'c2FsdA==', iterations: 300_000 });
    expect(settings.verifier).toBe('verifier-blob');
  });

  it('updateSettings merges a partial patch without dropping other fields', async () => {
    await setEncryptionEnabled(true);
    await setKdf({ salt: 's', iterations: 1000 });
    await updateSettings({ verifier: 'v' });

    const settings = await getSettings();
    expect(settings.kdf).toEqual({ salt: 's', iterations: 1000 });
    expect(settings.verifier).toBe('v');
  });

  it('setEncryptionEnabled(false) clears kdf and verifier', async () => {
    await setEncryptionEnabled(true);
    await setKdf({ salt: 's', iterations: 1000 });
    await setVerifier('v');

    await setEncryptionEnabled(false);
    const settings = await getSettings();
    expect(settings.encryptionEnabled).toBe(false);
    expect(settings.kdf).toBeUndefined();
    expect(settings.verifier).toBeUndefined();
  });

  it('preserves configs when settings change', async () => {
    await putConfig(makeConfig('a'));
    await setEncryptionEnabled(true);
    expect(await getConfig('a')).toBeDefined();
  });
});

describe('session key (Req 8.8)', () => {
  // A real extractable AES-GCM key, so setSessionKey can export its raw bytes
  // and getSessionKey can re-import them (the round-trip the store now does to
  // work around CryptoKey not structured-cloning reliably into storage.session).
  async function realKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
  }

  it('getSessionKey returns null when locked', async () => {
    expect(await getSessionKey()).toBeNull();
  });

  it('stores the key as base64 bytes in storage.session, not storage.local', async () => {
    await setSessionKey(await realKey());
    // A base64 string is stored under the session key, not a CryptoKey object.
    const stored = session.store.get(SESSION_KEY);
    expect(typeof stored).toBe('string');
    expect(local.set).not.toHaveBeenCalled();
  });

  it('round-trips a usable key through set -> get', async () => {
    const key = await realKey();
    await setSessionKey(key);
    const restored = await getSessionKey();
    expect(restored).not.toBeNull();

    // The restored key must actually work for AES-GCM and agree with the
    // original: encrypt with one, decrypt with the other.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode('round-trip');
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext,
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      restored as CryptoKey,
      ciphertext,
    );
    expect(new TextDecoder().decode(decrypted)).toBe('round-trip');
  });

  it('clearSessionKey forgets the key', async () => {
    await setSessionKey(await realKey());
    await clearSessionKey();
    expect(await getSessionKey()).toBeNull();
  });
});

describe('storage byte-threshold warning (Req 8.12)', () => {
  it('returns null while usage is under the threshold', async () => {
    local.bytesInUse.mockResolvedValue(Math.floor(LOCAL_QUOTA_BYTES * 0.5));
    expect(await checkStorageUsage()).toBeNull();
  });

  it('warns once usage crosses the threshold', async () => {
    local.bytesInUse.mockResolvedValue(Math.ceil(LOCAL_QUOTA_BYTES * (WARN_THRESHOLD + 0.05)));
    const warning = await checkStorageUsage();
    expect(warning).not.toBeNull();
    expect(warning!.quota).toBe(LOCAL_QUOTA_BYTES);
    expect(warning!.ratio).toBeGreaterThanOrEqual(WARN_THRESHOLD);
    expect(warning!.message).toMatch(/storage is \d+% full/i);
  });

  it('saveState surfaces the warning from the write path', async () => {
    local.bytesInUse.mockResolvedValue(LOCAL_QUOTA_BYTES);
    const warning = await saveState(await loadState());
    expect(warning).not.toBeNull();
    expect(warning!.bytesInUse).toBe(LOCAL_QUOTA_BYTES);
  });

  it('saveState returns null when there is plenty of room', async () => {
    local.bytesInUse.mockResolvedValue(0);
    expect(await saveState(await loadState())).toBeNull();
  });
});
