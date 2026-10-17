/**
 * Persistence layer for Fillibuster: a thin repository over the WebExtension
 * storage APIs.
 *
 * Everything durable lives under a single top-level key in `storage.local`
 * (design "Storage layout"): a {@link StoredState} holding the schema version,
 * encryption settings, and the map of configs. Keeping it in one object matches
 * the design ("a single object is simplest") and keeps reads/writes atomic — a
 * save serializes the whole state at once.
 *
 * The unlocked encryption key lives in `storage.session` while a config is
 * unlocked (design "Encryption Design", Req 8.8). `storage.session` is
 * memory-only and clears on browser close, so the derived key survives
 * service-worker restarts within a session but is never written to disk, and
 * the passphrase itself is never stored anywhere.
 *
 * Local only (Req 8.2): this module makes NO network calls, and neither should
 * anything layered on top of it. Configs and field data never leave the
 * browser profile.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.8, 8.12
 */

import type { SchemaVersion, StoredConfig, StoredState } from '../core/schema';
import { SCHEMA_VERSION } from '../core/schema';
import browser from './browser';

/** The single `storage.local` key under which the whole state is persisted. */
export const STATE_KEY = 'fillibuster:state';

/** The `storage.session` key holding the derived AES-GCM key while unlocked. */
export const SESSION_KEY = 'fillibuster:sessionKey';

/**
 * Chrome's `storage.local` quota is ~10 MB (Req 8.12). We warn once usage
 * crosses 80% of that so the developer can prune configs before writes start
 * failing, rather than silently dropping data.
 */
export const LOCAL_QUOTA_BYTES = 10 * 1024 * 1024;

/** Fraction of {@link LOCAL_QUOTA_BYTES} at which {@link saveState} warns. */
export const WARN_THRESHOLD = 0.8;

/**
 * Settings shape read/written by the settings helpers. Mirrors
 * {@link StoredState.settings}.
 */
export type Settings = StoredState['settings'];

/** PBKDF2 parameters stored when encryption is enabled. */
export type Kdf = NonNullable<Settings['kdf']>;

/**
 * A byte-usage warning surfaced by {@link saveState} when storage is nearly
 * full (Req 8.12). `null` from `saveState` means usage is comfortably under the
 * threshold.
 */
export interface StorageWarning {
  bytesInUse: number;
  quota: number;
  /** `bytesInUse / quota`, in `[0, 1+]`. */
  ratio: number;
  message: string;
}

/** A fresh, empty state: encryption off, no configs (Req 8.3). */
function defaultState(): StoredState {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { encryptionEnabled: false },
    configs: {},
  };
}

/**
 * Read the persisted {@link StoredState} from `storage.local`, initializing a
 * default empty state (encryption disabled, no configs) when nothing is stored
 * yet (Req 8.1, 8.3). First run therefore works with no prompt or setup.
 */
export async function loadState(): Promise<StoredState> {
  const stored = await browser.storage.local.get(STATE_KEY);
  const state = stored[STATE_KEY] as StoredState | undefined;
  if (!state) return defaultState();
  // Be defensive about a partially-shaped object so callers always get a
  // usable state (the schema/version migration proper lives elsewhere).
  return {
    schemaVersion: (state.schemaVersion ?? SCHEMA_VERSION) as SchemaVersion,
    settings: state.settings ?? { encryptionEnabled: false },
    configs: state.configs ?? {},
  };
}

/**
 * Persist the whole {@link StoredState} to `storage.local` (Req 8.1) and run a
 * byte-usage check afterwards. Returns a {@link StorageWarning} when usage has
 * crossed {@link WARN_THRESHOLD} of the quota (Req 8.12), or `null` otherwise,
 * so callers can surface the warning in the UI rather than fail silently.
 */
export async function saveState(state: StoredState): Promise<StorageWarning | null> {
  await browser.storage.local.set({ [STATE_KEY]: state });
  return checkStorageUsage();
}

/**
 * Inspect current `storage.local` usage against the quota and return a
 * {@link StorageWarning} when it is at or above {@link WARN_THRESHOLD}, else
 * `null` (Req 8.12).
 *
 * If the engine doesn't implement `getBytesInUse` we treat usage as unknown and
 * return `null` — the warning is a courtesy, never a gate on saving.
 */
export async function checkStorageUsage(): Promise<StorageWarning | null> {
  const getBytesInUse = browser.storage.local.getBytesInUse;
  if (typeof getBytesInUse !== 'function') return null;

  const bytesInUse = await getBytesInUse.call(browser.storage.local, null);
  const ratio = bytesInUse / LOCAL_QUOTA_BYTES;
  if (ratio < WARN_THRESHOLD) return null;

  const pct = Math.round(ratio * 100);
  return {
    bytesInUse,
    quota: LOCAL_QUOTA_BYTES,
    ratio,
    message: `Storage is ${pct}% full (${bytesInUse} of ${LOCAL_QUOTA_BYTES} bytes). Consider exporting and removing configs you no longer need.`,
  };
}

// ---------------------------------------------------------------------------
// Config CRUD (over state.configs)
// ---------------------------------------------------------------------------

/** List all stored configs (Req 8.1). */
export async function listConfigs(): Promise<StoredConfig[]> {
  const state = await loadState();
  return Object.values(state.configs);
}

/** Get a single stored config by id, or `undefined` if it doesn't exist. */
export async function getConfig(id: string): Promise<StoredConfig | undefined> {
  const state = await loadState();
  return state.configs[id];
}

/**
 * Insert or replace a config (keyed by its `id`) and persist. Returns any
 * {@link StorageWarning} raised by the write (Req 8.12).
 */
export async function putConfig(config: StoredConfig): Promise<StorageWarning | null> {
  const state = await loadState();
  state.configs[config.id] = config;
  return saveState(state);
}

/**
 * Delete a config by id and persist. A missing id is a no-op (idempotent).
 * Returns any {@link StorageWarning} raised by the write.
 */
export async function deleteConfig(id: string): Promise<StorageWarning | null> {
  const state = await loadState();
  if (!(id in state.configs)) return null;
  delete state.configs[id];
  return saveState(state);
}

// ---------------------------------------------------------------------------
// Encryption settings (Req 8.3, 8.4)
// ---------------------------------------------------------------------------

/** Read the current encryption settings (Req 8.3, 8.4). */
export async function getSettings(): Promise<Settings> {
  const state = await loadState();
  return state.settings;
}

/**
 * Merge a partial settings patch into the stored settings and persist. Used by
 * the more specific setters below; exposed for callers that need to update
 * several fields atomically (e.g. enabling encryption sets `encryptionEnabled`,
 * `kdf`, and `verifier` in one write).
 */
export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const state = await loadState();
  state.settings = { ...state.settings, ...patch };
  await saveState(state);
}

/**
 * Enable or disable encryption (Req 8.4). Disabling clears the KDF params and
 * verifier so no stale key material lingers; re-enabling must set fresh ones.
 */
export async function setEncryptionEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await updateSettings({ encryptionEnabled: true });
    return;
  }
  const state = await loadState();
  state.settings = { encryptionEnabled: false };
  delete state.settings.kdf;
  delete state.settings.verifier;
  await saveState(state);
}

/** Store the PBKDF2 salt/iterations chosen when encryption is enabled (Req 8.4). */
export async function setKdf(kdf: Kdf): Promise<void> {
  await updateSettings({ kdf });
}

/** Store the passphrase verifier used to check the master passphrase (Req 8.9). */
export async function setVerifier(verifier: string): Promise<void> {
  await updateSettings({ verifier });
}

// ---------------------------------------------------------------------------
// Session key (storage.session, Req 8.8)
// ---------------------------------------------------------------------------

/**
 * Hold the derived encryption key while a config is unlocked (Req 8.8).
 *
 * The key is stored as its raw 256-bit *bytes* (base64) in memory-only
 * `storage.session`, NOT as a `CryptoKey` object. A `CryptoKey` does not
 * round-trip through `storage.session` consistently across MV3 engines:
 * Firefox preserves it, but Chrome returns an inert object that fails
 * `crypto.subtle.encrypt`'s CryptoKey check (observed first-hand). Storing raw
 * bytes sidesteps the per-engine clone behavior entirely — they clone trivially
 * and are re-imported to a live AES-GCM key on read, so one code path is correct
 * on both. `storage.session` is memory-only and clears on browser close, so the
 * bytes never touch disk and the unlock naturally expires with the session; the
 * passphrase is never persisted.
 */
export async function setSessionKey(key: CryptoKey): Promise<void> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  let binary = '';
  for (let i = 0; i < raw.length; i++) binary += String.fromCharCode(raw[i]!);
  await browser.storage.session.set({ [SESSION_KEY]: btoa(binary) });
}

/**
 * Read the unlocked key from `storage.session`, re-importing the stored raw
 * bytes into a live non-extractable AES-GCM `CryptoKey`. Returns `null` when
 * the session is locked (no stored bytes).
 */
export async function getSessionKey(): Promise<CryptoKey | null> {
  const stored = await browser.storage.session.get(SESSION_KEY);
  const b64 = stored[SESSION_KEY] as string | undefined;
  if (!b64) return null;
  const binary = atob(b64);
  const raw = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Forget the unlocked key (lock the session). */
export async function clearSessionKey(): Promise<void> {
  await browser.storage.session.remove(SESSION_KEY);
}
