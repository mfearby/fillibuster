/**
 * Fillibuster message protocol.
 *
 * A single, typed vocabulary for the `runtime.sendMessage` / `onMessage`
 * traffic that flows between the content script, the background service worker,
 * and the popup/options UIs. Defining it in one shared module (rather than
 * per-caller inline shapes) means the content script's handlers and the
 * background/popup senders agree on the wire format at compile time, and the
 * orchestration API (task 10.2) can build on the same union.
 *
 * Two directions are modelled:
 *   - {@link ContentRequest}  — messages the CONTENT SCRIPT handles (sent by
 *     the background/popup): `applySteps` and `capturePage`.
 *   - {@link BackgroundNotification} — messages the CONTENT SCRIPT sends to the
 *     BACKGROUND: `urlChanged` (SPA navigation, Req 4.4).
 *   - {@link UiRequest} — messages the POPUP/OPTIONS send to the BACKGROUND
 *     orchestrator: list/run/CRUD/import/export/lock-unlock (task 10.2, Req 5-9).
 *
 * Each content request type is paired with its response type via
 * {@link ResponseFor} so senders get a typed result back from `sendMessage`; the
 * orchestrator's responses are modelled by its own result union.
 *
 * Requirements: 2.2, 4.4, 5.1, 5.2, 5.3, 5.4, 6.5, 7.1, 7.3, 8.8, 8.9, 9.1, 9.4
 */

import type { FieldStep, FillConfig } from '../core/schema';
import type { CaptureCandidate } from '../content/capture';
import type { ErrorStrategy, FillSummary } from '../content/fill';

/** Discriminant strings, centralised so senders/handlers can't drift. */
export const MessageType = {
  ApplySteps: 'applySteps',
  CapturePage: 'capturePage',
  UrlChanged: 'urlChanged',
  // Popup/options → background orchestration API (task 10.2). Grouped under a
  // single `UiRequest` union so the background can dispatch UI traffic to the
  // orchestrator while `urlChanged` still routes to match evaluation.
  ListMatchingConfigs: 'listMatchingConfigs',
  RunFill: 'runFill',
  CaptureTab: 'captureTab',
  ListConfigs: 'listConfigs',
  GetConfig: 'getConfig',
  SaveConfig: 'saveConfig',
  DeleteConfig: 'deleteConfig',
  ExportConfig: 'exportConfig',
  ImportConfig: 'importConfig',
  EnableEncryption: 'enableEncryption',
  DisableEncryption: 'disableEncryption',
  EncryptionStatus: 'encryptionStatus',
  Unlock: 'unlock',
  Lock: 'lock',
  IsUnlocked: 'isUnlocked',
} as const;

/**
 * Run an ordered list of steps against the page (Req 5.3). Handled by the
 * content script; resolves to a {@link FillSummary} (Req 5.4, 9.1).
 */
export interface ApplyStepsMessage {
  type: typeof MessageType.ApplySteps;
  steps: FieldStep[];
  errorStrategy: ErrorStrategy;
}

/**
 * Scan the page for fillable controls (Req 2.2). Handled by the content script;
 * resolves to the list of {@link CaptureCandidate}s for the UI to review.
 */
export interface CapturePageMessage {
  type: typeof MessageType.CapturePage;
}

/**
 * Sent by the content script to the background when the page URL changes,
 * including SPA navigations, so matches re-evaluate (Req 4.4).
 */
export interface UrlChangedMessage {
  type: typeof MessageType.UrlChanged;
  url: string;
}

/**
 * The messages the content script HANDLES (a request it receives and answers).
 */
export type ContentRequest = ApplyStepsMessage | CapturePageMessage;

/**
 * The messages the content script SENDS to the background.
 */
export type BackgroundNotification = UrlChangedMessage;

// ---------------------------------------------------------------------------
// UI orchestration requests (popup/options → background, task 10.2, Req 5-9)
// ---------------------------------------------------------------------------

/**
 * A lightweight config summary the popup lists without touching (or decrypting)
 * a config's steps. `encrypted` lets the popup decide whether to prompt for the
 * passphrase before running (Req 5.1, 5.2).
 */
export interface ConfigSummary {
  id: string;
  name: string;
  encrypted: boolean;
}

/** List the saved configs matching a tab's current URL (Req 5.1, 5.2). */
export interface ListMatchingConfigsMessage {
  type: typeof MessageType.ListMatchingConfigs;
  tabId: number;
}

/**
 * Run a config's fill against a tab: load it, decrypt if needed (using the
 * in-session key), ensure the content script is injected, relay `applySteps`,
 * and return the {@link FillSummary} (Req 5.3, 5.4, 5.5, 9.1, 9.4).
 */
export interface RunFillMessage {
  type: typeof MessageType.RunFill;
  configId: string;
  tabId: number;
}

/**
 * Run an assisted capture against a tab (Req 2.2). This is the UI-facing
 * request the options page sends to the BACKGROUND: the options page runs in
 * its own tab and cannot inject a content script into the page under test, so
 * it asks the background to guard the URL, ensure the content script is
 * injected, relay a {@link CapturePageMessage} to the tab, and return the
 * {@link CaptureCandidate}s for review.
 *
 * This is deliberately distinct from {@link CapturePageMessage} (`capturePage`),
 * which the CONTENT SCRIPT itself handles. Reusing that discriminant for the
 * UI→background hop would let the content script's own `onMessage` double-handle
 * it; a separate `captureTab` type keeps the two directions cleanly separated.
 */
export interface CaptureTabMessage {
  type: typeof MessageType.CaptureTab;
  tabId: number;
}

/** List every stored config as a summary (Req 6.1). */
export interface ListConfigsMessage {
  type: typeof MessageType.ListConfigs;
}

/** Fetch a single stored config by id (Req 6.2). */
export interface GetConfigMessage {
  type: typeof MessageType.GetConfig;
  configId: string;
}

/**
 * Insert or replace a config (Req 6.5). The config is sent with plaintext steps;
 * when encryption is enabled and `config.encrypted` is true the background
 * encrypts the steps into a cipher via the session key before storing.
 */
export interface SaveConfigMessage {
  type: typeof MessageType.SaveConfig;
  config: FillConfig;
}

/** Delete a config by id (Req 6.5). */
export interface DeleteConfigMessage {
  type: typeof MessageType.DeleteConfig;
  configId: string;
}

/**
 * Export a config as a JSON envelope, decrypting its steps first if needed so
 * the envelope carries plaintext (Req 7.1). The plaintext-share warning is a UI
 * concern (Req 7.7).
 */
export interface ExportConfigMessage {
  type: typeof MessageType.ExportConfig;
  configId: string;
}

/** Validate pasted export text and, on success, store it as a new config (Req 7.3). */
export interface ImportConfigMessage {
  type: typeof MessageType.ImportConfig;
  text: string;
}

/**
 * Enable encryption by setting the master passphrase: generate a salt, derive a
 * key, make a verifier, persist the settings, and cache the key in-session
 * (Req 8.4, 8.7).
 */
export interface EnableEncryptionMessage {
  type: typeof MessageType.EnableEncryption;
  passphrase: string;
}

/**
 * Disable encryption: clear `encryptionEnabled`, the KDF params, the verifier,
 * and the in-session key so no stale key material lingers (Req 8.4). Configs
 * that were marked encrypted keep their ciphertext at rest — disabling only
 * turns off the feature; the UI warns that any still-encrypted config can no
 * longer be read until encryption is re-enabled with the same passphrase.
 */
export interface DisableEncryptionMessage {
  type: typeof MessageType.DisableEncryption;
}

/**
 * The current encryption state the options settings UI renders: whether
 * encryption is `enabled` at all (Req 8.3, 8.4) and, when it is, whether the
 * session currently holds an unlocked key (Req 8.8). Read on mount so the UI
 * shows the right affordance (enable vs. lock/unlock vs. disable).
 */
export interface EncryptionStatus {
  enabled: boolean;
  unlocked: boolean;
}

/** Query the current {@link EncryptionStatus} for the settings UI (Req 8.3, 8.4, 8.8). */
export interface EncryptionStatusMessage {
  type: typeof MessageType.EncryptionStatus;
}

/**
 * Unlock the session with the master passphrase: derive the key, verify against
 * the stored verifier, and on success cache the key in `storage.session`
 * (Req 8.8, 8.9).
 */
export interface UnlockMessage {
  type: typeof MessageType.Unlock;
  passphrase: string;
}

/** Lock the session (forget the in-session key) (Req 8.8). */
export interface LockMessage {
  type: typeof MessageType.Lock;
}

/** Report whether the session currently holds an unlocked key. */
export interface IsUnlockedMessage {
  type: typeof MessageType.IsUnlocked;
}

/**
 * Every popup/options → background request. The background dispatches this
 * union to the orchestrator; `urlChanged` (a content-script notification) is
 * handled separately by the match engine.
 */
export type UiRequest =
  | ListMatchingConfigsMessage
  | RunFillMessage
  | CaptureTabMessage
  | ListConfigsMessage
  | GetConfigMessage
  | SaveConfigMessage
  | DeleteConfigMessage
  | ExportConfigMessage
  | ImportConfigMessage
  | EnableEncryptionMessage
  | DisableEncryptionMessage
  | EncryptionStatusMessage
  | UnlockMessage
  | LockMessage
  | IsUnlockedMessage;

/** The set of `type` discriminants that belong to the UI orchestration API. */
const UI_REQUEST_TYPES: ReadonlySet<string> = new Set([
  MessageType.ListMatchingConfigs,
  MessageType.RunFill,
  MessageType.CaptureTab,
  MessageType.ListConfigs,
  MessageType.GetConfig,
  MessageType.SaveConfig,
  MessageType.DeleteConfig,
  MessageType.ExportConfig,
  MessageType.ImportConfig,
  MessageType.EnableEncryption,
  MessageType.DisableEncryption,
  MessageType.EncryptionStatus,
  MessageType.Unlock,
  MessageType.Lock,
  MessageType.IsUnlocked,
]);

/**
 * Runtime guard: is `value` a UI orchestration request? Used by the background
 * to route UI traffic to the orchestrator distinctly from `urlChanged`.
 */
export function isUiRequest(value: unknown): value is UiRequest {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && UI_REQUEST_TYPES.has(type);
}

/** Every message shape on the wire, for exhaustive dispatch/guards. */
export type Message = ContentRequest | BackgroundNotification | UiRequest;

/**
 * Map each request `type` to the response shape its handler returns, so a sender
 * can write `const r: ResponseFor<ApplyStepsMessage> = await sendMessage(...)`.
 */
export type ResponseFor<M extends ContentRequest> = M extends ApplyStepsMessage
  ? FillSummary
  : M extends CapturePageMessage
    ? CaptureCandidate[]
    : never;

/**
 * A runtime type guard: is `value` one of our messages (a plain object with a
 * known `type` discriminant)? Handlers use this to ignore foreign traffic —
 * other extensions or the browser can dispatch on the same channel — rather
 * than assuming every message is ours.
 */
export function isMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === MessageType.ApplySteps ||
    type === MessageType.CapturePage ||
    type === MessageType.UrlChanged ||
    (typeof type === 'string' && UI_REQUEST_TYPES.has(type))
  );
}
