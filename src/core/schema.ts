/**
 * Fillibuster data model.
 *
 * These types define the shape of a saved "fill config", how configs are stored
 * in `storage.local`, and the export/at-rest envelopes. They are the heart of the
 * app: validated, imported/exported, and (optionally) encrypted. The `FieldStep`
 * discriminated union is intentionally open-ended so v2 step types (e.g. async
 * autocomplete) can be added without breaking v1 configs (Req 3.5).
 *
 * Requirements: 2.1, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 8.6, 9.2, 9.3
 */

/** Bumped when the persisted/exported schema changes incompatibly (Req 7.6). */
export type SchemaVersion = 1;

export const SCHEMA_VERSION: SchemaVersion = 1;

/**
 * A saved, named definition of how to fill a specific form/page.
 */
export interface FillConfig {
  /** uuid */
  id: string;
  name: string;
  /** URL rules; the page matches if ANY rule matches (Req 4.1). */
  match: MatchRule[];
  /** Ordered field steps (Req 5.3). */
  steps: FieldStep[];
  /** How to behave when a step fails (Req 9.2, 9.3). */
  errorStrategy: "stop" | "continue";
  /** Whether step values are stored as ciphertext (Req 8.6). */
  encrypted: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * A single URL-pattern rule used to match the current page against a config
 * (Req 4.1).
 */
export interface MatchRule {
  kind: "exact" | "prefix" | "glob";
  /** e.g. "https://dmv.example.com/apply*" */
  pattern: string;
}

/**
 * Discriminated union on `type` so v2 step types (e.g. "autocomplete") slot in
 * without breaking v1 configs (Req 3.5).
 */
export type FieldStep =
  | TextStep
  | SelectStep
  | CheckStep
  | RadioStep
  | ContentEditableStep;

export interface BaseStep {
  id: string;
  /** Human note shown in the editor. */
  label?: string;
  target: Selector;
}

/**
 * How to locate a target element. Resolution order mirrors capture preference
 * (Req 2.3): prefer `id`, then `name`, then a CSS path.
 */
export interface Selector {
  by: "id" | "name" | "css";
  value: string;
}

/** input[type=text|email|...], textarea (Req 3.1). */
export interface TextStep extends BaseStep {
  type: "text";
  value: string;
}

/** Native `<select>` combobox (Req 3.2). */
export interface SelectStep extends BaseStep {
  type: "select";
  value: string;
  /** Select the option by its value or by its visible text. */
  matchBy: "value" | "text";
}

/** Single checkbox (Req 3.3). */
export interface CheckStep extends BaseStep {
  type: "check";
  checked: boolean;
}

/**
 * Radio-button group (Req 3.3).
 *
 * A radio group is a set of `<input type="radio">` controls that share a
 * `name`; selecting one deselects its siblings. Unlike {@link CheckStep}, the
 * step does not toggle a single element — it selects the group member whose
 * `value` matches, mirroring how {@link SelectStep} picks an `<option>`. The
 * `target` identifies the group (typically `by: "name"`); `value` is the
 * desired member's `value` attribute.
 */
export interface RadioStep extends BaseStep {
  type: "radio";
  value: string;
}

/** contenteditable element (Req 3.4). */
export interface ContentEditableStep extends BaseStep {
  type: "contenteditable";
  /** Set as textContent unless `allowHtml` is true. */
  html: string;
  allowHtml?: boolean;
}

/**
 * Everything persisted under `storage.local`.
 */
export interface StoredState {
  schemaVersion: SchemaVersion;
  settings: {
    /** (Req 8.3, 8.4) */
    encryptionEnabled: boolean;
    /** Present only when encryption is enabled. */
    kdf?: {
      /** base64 */
      salt: string;
      /** PBKDF2 iterations */
      iterations: number;
    };
    /** AES-GCM of a known constant, to check the passphrase (Req 8.9). */
    verifier?: string;
  };
  configs: Record<string, StoredConfig>;
}

/**
 * A stored config. When `encrypted`, the per-step secret values are replaced by
 * a ciphertext envelope and the plaintext `steps` are not persisted.
 */
export type StoredConfig =
  | ({ encrypted: false } & FillConfig)
  | ({ encrypted: true } & Omit<FillConfig, "steps"> & { cipher: CipherEnvelope });

/**
 * AES-GCM ciphertext envelope for a config's serialized steps.
 */
export interface CipherEnvelope {
  /** base64, per-encryption random IV. */
  iv: string;
  /** base64 AES-GCM ciphertext of JSON.stringify(steps). */
  data: string;
}
