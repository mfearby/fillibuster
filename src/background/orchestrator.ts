/**
 * Fillibuster background orchestration API (task 10.2).
 *
 * The popup and options pages never touch storage, crypto, or the content
 * script directly. They send a {@link UiRequest} over `runtime.sendMessage`;
 * the background worker routes it here, and {@link handleUiMessage} performs the
 * privileged work — reading/writing storage, deriving/holding the encryption
 * key in `storage.session`, injecting the content script, and relaying
 * `applySteps` to the tab — then returns a typed {@link OrchestratorResult} the
 * UI can branch on.
 *
 * Everything the UI needs to distinguish is a discriminated result, never a
 * thrown error: success, `locked` (an encrypted config was run while the
 * session had no key, so the popup should prompt), `wrong-passphrase` (unlock
 * failed; stored data untouched — Req 8.9), `restricted` (a browser-internal or
 * extension-gallery page where a content script can't run — Req 9.4), `no-tab`
 * (no active/known tab — Req 9.4), `not-found`, and a generic `error`. This
 * keeps the wire format serialisable (a rejected promise across `sendMessage`
 * loses its type) and lets the popup show the right affordance for each case.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.5, 7.1, 7.3, 8.8, 8.9, 9.1, 9.4
 */

import { decryptSteps, deriveKey, encryptSteps, generateSalt, makeVerifier, checkVerifier, DEFAULT_ITERATIONS } from '../core/crypto';
import { matchingConfigIds } from '../core/match';
import type { FillConfig, MatchRule, StoredConfig } from '../core/schema';
import {
  exportBackupJson,
  exportConfigJson,
  importConfigs,
  importEnvelope,
} from '../core/share';
import browser from '../platform/browser';
import {
  MessageType,
  type BackupResult,
  type ConfigSummary,
  type ImportConfigsResult,
  type ImportedConfigSummary,
  type UiRequest,
} from '../platform/messages';
import {
  clearSessionKey,
  deleteConfig,
  getConfig,
  getSessionKey,
  getSettings,
  listConfigs,
  putConfig,
  setEncryptionEnabled,
  setKdf,
  setSessionKey,
  setVerifier,
  updateSettings,
} from '../platform/store';
import type { FillSummary } from '../content/fill';
import type { CaptureCandidate } from '../content/capture';

/**
 * Reasons an orchestration request can fail in a way the UI must distinguish.
 * `locked` and `wrong-passphrase` drive the passphrase prompt; `restricted` and
 * `no-tab` drive the "can't run here" messaging (Req 9.4).
 */
export type OrchestratorErrorCode =
  | 'locked'
  | 'wrong-passphrase'
  | 'restricted'
  | 'no-tab'
  | 'not-found'
  | 'error';

/**
 * The discriminated result every handler returns. Success carries a
 * payload-specific `value`; failure carries a machine-branchable `code` plus a
 * human-readable `error`. Serialisable end to end so it survives `sendMessage`.
 */
export type OrchestratorResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; code: OrchestratorErrorCode; error: string };

const success = <T>(value: T): OrchestratorResult<T> => ({ ok: true, value });
const failure = (
  code: OrchestratorErrorCode,
  error: string,
): OrchestratorResult<never> => ({ ok: false, code, error });

/**
 * URL schemes/prefixes where content scripts can't run — browser-internal
 * pages and the extension galleries (Req 9.4). A fill against one of these
 * surfaces a clear `restricted` error rather than failing silently when the
 * `scripting.executeScript` call is rejected by the browser.
 */
const RESTRICTED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'about:',
  'edge://',
  'brave://',
  'opera://',
  'vivaldi://',
  'moz-extension://',
  'view-source:',
  'devtools://',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com',
  'https://addons.mozilla.org',
  'https://microsoftedge.microsoft.com/addons',
];

/** True when `url` points at a page where a content script cannot be injected. */
function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return RESTRICTED_URL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Project a stored config to a {@link ConfigSummary}, exposing only the fields
 * the popup lists (id, name, encrypted) so encrypted configs need no decryption
 * to appear in the menu (Req 5.1, 5.2).
 */
function toSummary(config: StoredConfig): ConfigSummary {
  return { id: config.id, name: config.name, encrypted: config.encrypted };
}

/**
 * Resolve a stored config's plaintext steps, decrypting with the in-session key
 * when the config is encrypted. Returns a `locked` failure when no session key
 * is available (Req 8.8) and a `wrong-passphrase`-adjacent `error` if the cipher
 * can't be decrypted with the current key.
 */
async function resolveSteps(
  config: StoredConfig,
): Promise<OrchestratorResult<FillConfig['steps']>> {
  if (!config.encrypted) return success(config.steps);

  const key = await getSessionKey();
  if (!key) {
    return failure(
      'locked',
      'This config is encrypted. Unlock with your master passphrase to continue.',
    );
  }
  try {
    const steps = await decryptSteps(config.cipher, key);
    return success(steps);
  } catch {
    return failure('error', 'Could not decrypt this config with the current key.');
  }
}

/**
 * List the configs matching a tab's current URL as summaries (Req 5.1, 5.2).
 *
 * Matching re-reads the tab URL and evaluates it here rather than relying on the
 * badge cache, so the popup gets an authoritative list even if the cache is
 * cold; only `id`/`match` are read, so encrypted configs match without
 * decryption.
 */
async function handleListMatching(
  tabId: number,
): Promise<OrchestratorResult<ConfigSummary[]>> {
  const tab = await getTab(tabId);
  if (!tab) return failure('no-tab', 'No active tab to match against.');

  const configs = await listConfigs();
  const matchable = configs.map(({ id, match }) => ({ id, match: match as MatchRule[] }));
  const ids = new Set(
    matchingConfigIds(tab.url ?? '', matchable as unknown as FillConfig[]),
  );
  const summaries = configs.filter((c) => ids.has(c.id)).map(toSummary);
  return success(summaries);
}

/** Look up a tab, swallowing the "tab closed" rejection into `null`. */
async function getTab(tabId: number): Promise<{ url?: string } | null> {
  try {
    return await browser.tabs.get(tabId);
  } catch {
    return null;
  }
}

/**
 * Run a config's fill against a tab (Req 5.3, 5.4, 5.5, 9.1, 9.4).
 *
 * Steps:
 *  1. Resolve the tab; a missing tab is a clear `no-tab` error (Req 9.4).
 *  2. Refuse restricted pages up front with a `restricted` error so the user
 *     learns why rather than seeing a silent no-op (Req 9.4).
 *  3. Load the config; decrypt its steps if encrypted (surfacing `locked` when
 *     the session has no key — Req 8.8).
 *  4. Ensure the content script is injected (`scripting.executeScript`, guarded
 *     — a page that rejects injection is reported as `restricted`).
 *  5. Relay `applySteps` and return the {@link FillSummary} (Req 5.4, 9.1).
 */
async function handleRunFill(
  configId: string,
  tabId: number,
): Promise<OrchestratorResult<FillSummary>> {
  const tab = await getTab(tabId);
  if (!tab) return failure('no-tab', 'No active tab to run the fill against.');

  if (isRestrictedUrl(tab.url)) {
    return failure(
      'restricted',
      "Fillibuster can't run on this page (a browser page or extension gallery).",
    );
  }

  const config = await getConfig(configId);
  if (!config) return failure('not-found', `No config found with id ${configId}.`);

  const stepsResult = await resolveSteps(config);
  if (!stepsResult.ok) return stepsResult;

  const injected = await ensureContentScript(tabId);
  if (!injected.ok) return injected;

  try {
    const summary = (await browser.tabs.sendMessage(tabId, {
      type: MessageType.ApplySteps,
      steps: stepsResult.value,
      errorStrategy: config.errorStrategy,
    })) as FillSummary;
    return success(summary);
  } catch (e) {
    return failure('error', `Failed to run the fill: ${describe(e)}`);
  }
}

/**
 * Run an assisted capture against a tab and return its candidate steps (Req 2.2).
 *
 * Mirrors {@link handleRunFill}'s guards: resolve the tab (`no-tab`), refuse
 * restricted pages up front (`restricted`), ensure the content script is
 * injected (a rejected injection is reported `restricted`), then relay a
 * `capturePage` message to the content script and return the
 * {@link CaptureCandidate}s. Capture is a pure read — it never mutates the page
 * and never saves; the options UI reviews/prunes/edits the candidates and only
 * then explicitly saves (Req 2.5).
 */
async function handleCaptureTab(
  tabId: number,
): Promise<OrchestratorResult<CaptureCandidate[]>> {
  const tab = await getTab(tabId);
  if (!tab) return failure('no-tab', 'No active tab to capture from.');

  if (isRestrictedUrl(tab.url)) {
    return failure(
      'restricted',
      "Fillibuster can't capture on this page (a browser page or extension gallery).",
    );
  }

  const injected = await ensureContentScript(tabId);
  if (!injected.ok) return injected;

  try {
    const candidates = (await browser.tabs.sendMessage(tabId, {
      type: MessageType.CapturePage,
    })) as CaptureCandidate[];
    return success(candidates);
  } catch (e) {
    return failure('error', `Failed to capture the page: ${describe(e)}`);
  }
}

/**
 * Ensure the content script is present in the tab by injecting it (idempotent —
 * the content script guards against double-install). A rejected injection means
 * the page forbids content scripts, which we report as `restricted` (Req 9.4).
 */
async function ensureContentScript(
  tabId: number,
): Promise<OrchestratorResult<null>> {
  const scripting = browser.scripting;
  if (!scripting || typeof scripting.executeScript !== 'function') {
    // No scripting API (e.g. a stripped test env): assume the content script is
    // already present and let the subsequent sendMessage surface any problem.
    return success(null);
  }
  try {
    await scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    return success(null);
  } catch (e) {
    return failure(
      'restricted',
      `Fillibuster can't run on this page: ${describe(e)}`,
    );
  }
}

/** List every stored config as a summary (Req 6.1). */
async function handleListConfigs(): Promise<OrchestratorResult<ConfigSummary[]>> {
  const configs = await listConfigs();
  return success(configs.map(toSummary));
}

/**
 * Fetch a single config for editing as a plaintext {@link FillConfig} (Req 6.2).
 *
 * A plaintext config is returned as-is. An encrypted config is decrypted first
 * using the in-session key so the editor can edit its steps; if the session has
 * no key this returns `locked` so the editor prompts for the passphrase before
 * opening (Req 8.8). The `encrypted` flag is preserved on the returned config so
 * the editor keeps its "this config is encrypted" affordances. Returning
 * plaintext steps here is safe — the value only lives in the editor's memory and
 * is re-encrypted on save (see {@link handleSaveConfig}).
 */
async function handleGetConfig(
  configId: string,
): Promise<OrchestratorResult<FillConfig>> {
  const config = await getConfig(configId);
  if (!config) return failure('not-found', `No config found with id ${configId}.`);

  const stepsResult = await resolveSteps(config);
  if (!stepsResult.ok) return stepsResult;

  const editable: FillConfig = {
    id: config.id,
    name: config.name,
    match: config.match,
    steps: stepsResult.value,
    errorStrategy: config.errorStrategy,
    encrypted: config.encrypted,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
  return success(editable);
}

/**
 * Insert or replace a config (Req 6.5). The UI always sends plaintext steps.
 * When the config is flagged `encrypted` we require encryption to be enabled and
 * the session unlocked, encrypt the steps into a `cipher`, and store the
 * ciphertext arm; otherwise we store the plaintext arm as-is.
 */
async function handleSaveConfig(
  config: FillConfig,
): Promise<OrchestratorResult<StoredConfig>> {
  if (config.encrypted) {
    const settings = await getSettings();
    if (!settings.encryptionEnabled) {
      return failure(
        'error',
        'Encryption is not enabled; enable it before saving an encrypted config.',
      );
    }
    const key = await getSessionKey();
    if (!key) {
      return failure('locked', 'Unlock with your master passphrase to save an encrypted config.');
    }
    const cipher = await encryptSteps(config.steps, key);
    const { steps: _steps, ...rest } = config;
    const stored: StoredConfig = { ...rest, encrypted: true, cipher };
    await putConfig(stored);
    return success(stored);
  }

  const stored: StoredConfig = { ...config, encrypted: false };
  await putConfig(stored);
  return success(stored);
}

/** Delete a config by id (Req 6.5). Idempotent — a missing id is still success. */
async function handleDeleteConfig(
  configId: string,
): Promise<OrchestratorResult<null>> {
  await deleteConfig(configId);
  return success(null);
}

/**
 * Export a config as a JSON envelope with plaintext steps (Req 7.1). An
 * encrypted config is decrypted first (surfacing `locked` when the session has
 * no key); the plaintext-share warning is a UI concern (Req 7.7).
 */
async function handleExportConfig(
  configId: string,
): Promise<OrchestratorResult<string>> {
  const config = await getConfig(configId);
  if (!config) return failure('not-found', `No config found with id ${configId}.`);

  const stepsResult = await resolveSteps(config);
  if (!stepsResult.ok) return stepsResult;

  // Reconstruct a plaintext FillConfig for the envelope: drop the cipher arm's
  // extras and carry the decrypted steps with `encrypted: false` so the export
  // is portable plaintext (the recipient re-encrypts under their own key).
  const plain: FillConfig = {
    id: config.id,
    name: config.name,
    match: config.match,
    steps: stepsResult.value,
    errorStrategy: config.errorStrategy,
    encrypted: false,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
  return success(exportConfigJson(plain));
}

/**
 * Validate pasted export text and, on success, store it as a new config,
 * resolving name collisions by keeping both (Req 7.3, 7.5). Invalid input is
 * rejected with a clear error and leaves existing configs untouched (Req 7.4).
 */
async function handleImportConfig(
  text: string,
): Promise<OrchestratorResult<StoredConfig>> {
  const existing = await listConfigs();
  const names = existing.map((c) => c.name);
  const result = importEnvelope(text, names);
  if (!result.ok) return failure('error', result.error);

  // The store is keyed by id: never let an import replace an existing config.
  const ids = new Set(existing.map((c) => c.id));
  const config = result.value.config;
  const id = ids.has(config.id) ? crypto.randomUUID() : config.id;

  // Imported configs are stored as plaintext; marking one encrypted is a
  // separate, deliberate step the user takes in the editor (Req 8.6).
  const stored: StoredConfig = { ...config, id, encrypted: false };
  await putConfig(stored);
  return success(stored);
}

/**
 * Back up every config into one plaintext file. Encrypted configs are decrypted
 * first; if the session is locked the whole backup fails with `locked` rather
 * than silently leaving those configs out.
 */
async function handleBackupConfigs(): Promise<OrchestratorResult<BackupResult>> {
  const stored = await listConfigs();
  const plain: FillConfig[] = [];

  for (const config of stored) {
    const stepsResult = await resolveSteps(config);
    if (!stepsResult.ok) {
      if (stepsResult.code === 'locked') {
        return failure(
          'locked',
          'Some configs are encrypted. Unlock them in Encryption settings, then back up again.',
        );
      }
      return stepsResult;
    }
    plain.push({
      id: config.id,
      name: config.name,
      match: config.match,
      steps: stepsResult.value,
      errorStrategy: config.errorStrategy,
      encrypted: false,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    });
  }

  plain.sort((a, b) => a.name.localeCompare(b.name));
  return success({ json: exportBackupJson(plain), count: plain.length });
}

/**
 * Import a backup file or a single exported config, adding every config as new
 * (Req 7.3, 7.5). The input is fully validated first, so a bad file stores
 * nothing (Req 7.4). Colliding names are suffixed and colliding ids replaced, so
 * no existing config is ever overwritten.
 */
async function handleImportConfigs(
  text: string,
): Promise<OrchestratorResult<ImportConfigsResult>> {
  const existing = await listConfigs();
  const result = importConfigs(
    text,
    { names: existing.map((c) => c.name), ids: existing.map((c) => c.id) },
    () => crypto.randomUUID(),
  );
  if (!result.ok) return failure('error', result.error);

  const imported: ImportedConfigSummary[] = [];
  for (const item of result.value) {
    // Stored as plaintext, like single import (Req 8.6).
    const stored: StoredConfig = { ...item.config, encrypted: false };
    await putConfig(stored);
    imported.push({
      id: stored.id,
      name: stored.name,
      originalName: item.originalName,
      renamed: item.renamed,
    });
  }
  return success({ imported });
}

/**
 * Enable encryption by setting the master passphrase (Req 8.4, 8.7): generate a
 * salt, derive the key, make a verifier, persist `encryptionEnabled`/kdf/
 * verifier, and cache the key in-session so the user is immediately unlocked.
 */
async function handleEnableEncryption(
  passphrase: string,
): Promise<OrchestratorResult<null>> {
  if (passphrase.length === 0) {
    return failure('error', 'Passphrase must not be empty.');
  }
  const salt = generateSalt();
  const iterations = DEFAULT_ITERATIONS;
  const key = await deriveKey(passphrase, salt, iterations);
  const verifier = await makeVerifier(key);

  await updateSettings({ encryptionEnabled: true });
  await setKdf({ salt, iterations });
  await setVerifier(verifier);
  await setSessionKey(key);
  return success(null);
}

/**
 * Disable encryption (Req 8.4). Clears `encryptionEnabled`, the KDF params, and
 * the verifier via the store, and forgets the in-session key so no stale key
 * material lingers. Any config still marked encrypted keeps its ciphertext at
 * rest — disabling turns off the feature, it doesn't decrypt in place; the UI
 * warns that such configs can't be read again until encryption is re-enabled
 * with the same passphrase.
 */
async function handleDisableEncryption(): Promise<OrchestratorResult<null>> {
  await setEncryptionEnabled(false);
  await clearSessionKey();
  return success(null);
}

/**
 * Report the current encryption state for the settings UI (Req 8.3, 8.4, 8.8):
 * whether encryption is enabled at all, and whether the session currently holds
 * an unlocked key. Reads only settings + the presence of a session key, so it
 * never decrypts anything.
 */
async function handleEncryptionStatus(): Promise<
  OrchestratorResult<{ enabled: boolean; unlocked: boolean }>
> {
  const settings = await getSettings();
  const enabled = settings.encryptionEnabled === true;
  const key = enabled ? await getSessionKey() : null;
  return success({ enabled, unlocked: key !== null });
}

/**
 * Unlock the session with the master passphrase (Req 8.8, 8.9). Derives the key
 * from the stored kdf params, checks it against the stored verifier, and on
 * success caches the key in `storage.session`. A wrong passphrase returns a
 * typed `wrong-passphrase` failure and stores nothing, leaving data untouched.
 */
async function handleUnlock(
  passphrase: string,
): Promise<OrchestratorResult<null>> {
  const settings = await getSettings();
  if (!settings.encryptionEnabled || !settings.kdf || !settings.verifier) {
    return failure('error', 'Encryption is not enabled.');
  }
  const key = await deriveKey(passphrase, settings.kdf.salt, settings.kdf.iterations);
  const okPass = await checkVerifier(key, settings.verifier);
  if (!okPass) {
    return failure('wrong-passphrase', 'Incorrect passphrase.');
  }
  await setSessionKey(key);
  return success(null);
}

/** Lock the session by forgetting the in-session key (Req 8.8). */
async function handleLock(): Promise<OrchestratorResult<null>> {
  await clearSessionKey();
  return success(null);
}

/** Report whether the session currently holds an unlocked key. */
async function handleIsUnlocked(): Promise<OrchestratorResult<boolean>> {
  const key = await getSessionKey();
  return success(key !== null);
}

/** Render any thrown value as a short message for an `error` result. */
function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Dispatch a {@link UiRequest} to its handler and return a typed
 * {@link OrchestratorResult}. Registered by the background worker's
 * `runtime.onMessage` for UI traffic (see `background/index.ts`); `urlChanged`
 * and content-script messages are handled elsewhere.
 *
 * The whole body is wrapped so an unexpected throw becomes a generic `error`
 * result rather than a rejected `sendMessage` the popup can't branch on.
 */
export async function handleUiMessage(
  message: UiRequest,
  _sender?: unknown,
): Promise<OrchestratorResult> {
  try {
    switch (message.type) {
      case MessageType.ListMatchingConfigs:
        return await handleListMatching(message.tabId);
      case MessageType.RunFill:
        return await handleRunFill(message.configId, message.tabId);
      case MessageType.CaptureTab:
        return await handleCaptureTab(message.tabId);
      case MessageType.ListConfigs:
        return await handleListConfigs();
      case MessageType.GetConfig:
        return await handleGetConfig(message.configId);
      case MessageType.SaveConfig:
        return await handleSaveConfig(message.config);
      case MessageType.DeleteConfig:
        return await handleDeleteConfig(message.configId);
      case MessageType.ExportConfig:
        return await handleExportConfig(message.configId);
      case MessageType.ImportConfig:
        return await handleImportConfig(message.text);
      case MessageType.BackupConfigs:
        return await handleBackupConfigs();
      case MessageType.ImportConfigs:
        return await handleImportConfigs(message.text);
      case MessageType.EnableEncryption:
        return await handleEnableEncryption(message.passphrase);
      case MessageType.DisableEncryption:
        return await handleDisableEncryption();
      case MessageType.EncryptionStatus:
        return await handleEncryptionStatus();
      case MessageType.Unlock:
        return await handleUnlock(message.passphrase);
      case MessageType.Lock:
        return await handleLock();
      case MessageType.IsUnlocked:
        return await handleIsUnlocked();
      default:
        return failure('error', `Unknown request: ${describe((message as { type?: unknown }).type)}`);
    }
  } catch (e) {
    return failure('error', describe(e));
  }
}
