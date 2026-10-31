/**
 * Import/export of Fillibuster configs for sharing (Req 7).
 *
 * A config is shared as a small, self-contained JSON envelope — `{ app,
 * schemaVersion, config }` (see design "Export format") — that a teammate pastes
 * into their own settings. Export always emits plaintext steps: an encrypted
 * config is decrypted before it reaches here, and the UI warns the user first
 * (Req 7.7). This module is the pure, browser-free half of that flow:
 *
 *  - {@link exportConfig} wraps a config in the versioned envelope (Req 7.1, 7.6).
 *  - {@link exportConfigJson} is a convenience that stringifies it for the
 *    clipboard.
 *  - {@link importEnvelope} parses pasted text, validates and version-gates it via
 *    `validate.ts` (Req 7.3, 7.4, 7.6), and — because a fresh import must never
 *    silently overwrite an existing config — resolves a name collision by
 *    suggesting a non-colliding "keep both" name (Req 7.5).
 *
 * Nothing here throws for expected-bad input (malformed JSON, wrong app, unknown
 * version, schema mismatch); callers get a {@link Result} so existing configs are
 * left untouched (Req 7.4).
 *
 * Requirements: 7.1, 7.3, 7.4, 7.5, 7.6
 */

import type { FillConfig } from './schema';
import { SCHEMA_VERSION } from './schema';
import type { BackupEnvelope, ExportEnvelope, Result } from './validate';
import { validateBackup, validateEnvelope } from './validate';

/**
 * Wrap a config in the versioned export envelope (Req 7.1, 7.6). Steps are
 * emitted as-is; callers are responsible for decrypting an encrypted config
 * before export (Req 7.7). The returned object is a fresh envelope referencing
 * the given config.
 */
export function exportConfig(config: FillConfig): ExportEnvelope {
  return { app: 'fillibuster', schemaVersion: SCHEMA_VERSION, config };
}

/**
 * Convenience wrapper around {@link exportConfig} that produces the pretty-printed
 * JSON string the options UI copies to the clipboard (Req 7.2).
 */
export function exportConfigJson(config: FillConfig, space = 2): string {
  return JSON.stringify(exportConfig(config), null, space);
}

/** The outcome of a successful import: the config to add, plus its final name. */
export interface ImportResult {
  /**
   * The config to add. Its `name` is `resolvedName`, which may differ from the
   * pasted config's name when a collision was resolved (Req 7.5).
   */
  config: FillConfig;
  /** The name the config will be saved under (post collision-resolution). */
  resolvedName: string;
  /** True when the pasted name collided and was renamed to keep both (Req 7.5). */
  renamed: boolean;
}

/**
 * Suggest a non-colliding name by appending an incrementing " (n)" suffix.
 *
 * "DMV apply" → "DMV apply (2)" → "DMV apply (3)" … skipping any suffixed names
 * that already exist. Comparison is case-sensitive and exact, matching how the
 * store keys configs by their literal name for the "keep both" flow (Req 7.5).
 */
export function suggestName(name: string, existingNames: Iterable<string>): string {
  const taken = new Set(existingNames);
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Parse and validate pasted export text, returning the config to add.
 *
 * Steps:
 *  1. Parse `text` as JSON — malformed JSON is rejected with a clear message
 *     rather than thrown (Req 7.4).
 *  2. Validate and version-gate the envelope via {@link validateEnvelope}
 *     (Req 7.3, 7.4, 7.6). Wrong `app`, unknown `schemaVersion`, or a bad config
 *     shape all surface as a failure result.
 *  3. Resolve name collisions against `existingNames`: if the imported name is
 *     already taken, suggest a non-colliding name so the developer keeps both
 *     rather than overwriting (Req 7.5).
 *
 * On success the returned config carries the resolved name; existing data is
 * never touched by this function.
 */
export function importEnvelope(
  text: string,
  existingNames: Iterable<string> = [],
): Result<ImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }

  const validated = validateEnvelope(parsed);
  if (!validated.ok) return validated;

  const config = validated.value.config;
  const resolvedName = suggestName(config.name, existingNames);
  const renamed = resolvedName !== config.name;

  return {
    ok: true,
    value: {
      config: renamed ? { ...config, name: resolvedName } : config,
      resolvedName,
      renamed,
    },
  };
}

// ---------------------------------------------------------------------------
// Whole-store backup / restore
// ---------------------------------------------------------------------------

/**
 * Wrap every config in one {@link BackupEnvelope}. Like single export, steps are
 * emitted as-is, so callers must decrypt encrypted configs first.
 */
export function exportBackup(
  configs: FillConfig[],
  exportedAt: number = Date.now(),
): BackupEnvelope {
  return {
    app: 'fillibuster',
    kind: 'backup',
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    configs,
  };
}

/** Pretty-printed JSON for a backup file. */
export function exportBackupJson(
  configs: FillConfig[],
  exportedAt?: number,
  space = 2,
): string {
  return JSON.stringify(exportBackup(configs, exportedAt), null, space);
}

/** One config ready to be stored by {@link importConfigs}. */
export interface ImportedItem {
  /** The config to store: unique name and unique id against the store. */
  config: FillConfig;
  /** The name it had in the file, before any collision rename. */
  originalName: string;
  /** True when the name collided and was renamed to keep both (Req 7.5). */
  renamed: boolean;
}

/** What already exists in the store, so imports never overwrite it. */
export interface ExistingConfigs {
  names: Iterable<string>;
  ids: Iterable<string>;
}

/**
 * Parse an import file or pasted text — either a whole-store backup or a single
 * exported config — and return every config to add.
 *
 * Nothing already stored is ever overwritten:
 *  - a colliding NAME gets a " (n)" suffix, as single import always did (Req 7.5);
 *  - a colliding ID gets a fresh one from `newId`. The store is keyed by id, so
 *    without this, re-importing your own export would silently replace the
 *    original config.
 *
 * Collisions are also checked across the configs in the same file. The whole
 * input is validated up front; one bad config fails the lot (Req 7.4).
 */
export function importConfigs(
  text: string,
  existing: ExistingConfigs,
  newId: () => string,
): Result<ImportedItem[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }

  // A backup is marked `kind: "backup"`; anything else is treated as a single
  // exported config, so its validation errors stay the familiar ones.
  const isBackup =
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { kind?: unknown }).kind === 'backup';

  let configs: FillConfig[];
  if (isBackup) {
    const backup = validateBackup(parsed);
    if (!backup.ok) return backup;
    configs = backup.value.configs;
  } else {
    const single = validateEnvelope(parsed);
    if (!single.ok) return single;
    configs = [single.value.config];
  }

  const takenNames = new Set(existing.names);
  const takenIds = new Set(existing.ids);
  const items: ImportedItem[] = [];

  for (const config of configs) {
    const name = suggestName(config.name, takenNames);
    takenNames.add(name);

    let id = config.id;
    if (takenIds.has(id)) id = newId();
    takenIds.add(id);

    items.push({
      config: { ...config, id, name },
      originalName: config.name,
      renamed: name !== config.name,
    });
  }

  return { ok: true, value: items };
}
