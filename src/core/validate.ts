/**
 * Runtime validation for Fillibuster configs and import envelopes.
 *
 * The data model in `schema.ts` gives us compile-time guarantees, but anything
 * crossing a trust boundary — a pasted export, a config read back from storage —
 * arrives as `unknown` and must be validated at runtime before we treat it as a
 * `FillConfig`. These validators never throw for expected-bad input; they return
 * a `Result` so callers can surface a clear message and leave existing data
 * untouched (Req 7.3, 7.4). The envelope validator also version-gates against
 * `SCHEMA_VERSION` so future format changes are rejected cleanly (Req 7.6).
 *
 * Requirements: 7.3, 7.4, 7.6
 */

import type {
  CheckStep,
  ContentEditableStep,
  FieldStep,
  FillConfig,
  MatchRule,
  Selector,
  SelectStep,
  TextStep,
} from './schema';
import { SCHEMA_VERSION } from './schema';

/**
 * A typed success/failure result. On success `value` carries the validated,
 * correctly-typed object; on failure `error` is a human-readable, path-prefixed
 * description of the first problem found.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** The export/import envelope wrapping a single config (see design "Export format"). */
export interface ExportEnvelope {
  app: 'fillibuster';
  schemaVersion: typeof SCHEMA_VERSION;
  config: FillConfig;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = (error: string): Result<never> => ({ ok: false, error });

/** True for a non-null, non-array plain object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const STEP_TYPES = ['text', 'select', 'check', 'contenteditable'] as const;
const SELECTOR_BY = ['id', 'name', 'css'] as const;
const RULE_KINDS = ['exact', 'prefix', 'glob'] as const;
const ERROR_STRATEGIES = ['stop', 'continue'] as const;

function validateSelector(v: unknown, path: string): Result<Selector> {
  if (!isRecord(v)) return err(`${path} must be an object`);
  if (!(SELECTOR_BY as readonly string[]).includes(v['by'] as string)) {
    return err(`${path}.by must be one of ${SELECTOR_BY.join(', ')}`);
  }
  if (typeof v['value'] !== 'string' || v['value'].length === 0) {
    return err(`${path}.value must be a non-empty string`);
  }
  return ok({ by: v['by'] as Selector['by'], value: v['value'] });
}

function validateStep(v: unknown, path: string): Result<FieldStep> {
  if (!isRecord(v)) return err(`${path} must be an object`);

  const type = v['type'];
  if (typeof type !== 'string' || !(STEP_TYPES as readonly string[]).includes(type)) {
    return err(`${path}.type must be one of ${STEP_TYPES.join(', ')}`);
  }

  if (typeof v['id'] !== 'string' || v['id'].length === 0) {
    return err(`${path}.id must be a non-empty string`);
  }
  if (v['label'] !== undefined && typeof v['label'] !== 'string') {
    return err(`${path}.label must be a string when present`);
  }

  const selector = validateSelector(v['target'], `${path}.target`);
  if (!selector.ok) return selector;

  const base = { id: v['id'] as string, target: selector.value } as {
    id: string;
    label?: string;
    target: Selector;
  };
  if (typeof v['label'] === 'string') base.label = v['label'];

  switch (type) {
    case 'text': {
      if (typeof v['value'] !== 'string') return err(`${path}.value must be a string`);
      const step: TextStep = { ...base, type: 'text', value: v['value'] };
      return ok(step);
    }
    case 'select': {
      if (typeof v['value'] !== 'string') return err(`${path}.value must be a string`);
      if (v['matchBy'] !== 'value' && v['matchBy'] !== 'text') {
        return err(`${path}.matchBy must be "value" or "text"`);
      }
      const step: SelectStep = {
        ...base,
        type: 'select',
        value: v['value'],
        matchBy: v['matchBy'],
      };
      return ok(step);
    }
    case 'check': {
      if (typeof v['checked'] !== 'boolean') return err(`${path}.checked must be a boolean`);
      const step: CheckStep = { ...base, type: 'check', checked: v['checked'] };
      return ok(step);
    }
    case 'contenteditable': {
      if (typeof v['html'] !== 'string') return err(`${path}.html must be a string`);
      if (v['allowHtml'] !== undefined && typeof v['allowHtml'] !== 'boolean') {
        return err(`${path}.allowHtml must be a boolean when present`);
      }
      const step: ContentEditableStep = { ...base, type: 'contenteditable', html: v['html'] };
      if (typeof v['allowHtml'] === 'boolean') step.allowHtml = v['allowHtml'];
      return ok(step);
    }
    // Unreachable: `type` is narrowed to STEP_TYPES above.
    default:
      return err(`${path}.type is not a supported step type`);
  }
}

function validateRule(v: unknown, path: string): Result<MatchRule> {
  if (!isRecord(v)) return err(`${path} must be an object`);
  if (typeof v['kind'] !== 'string' || !(RULE_KINDS as readonly string[]).includes(v['kind'])) {
    return err(`${path}.kind must be one of ${RULE_KINDS.join(', ')}`);
  }
  if (typeof v['pattern'] !== 'string' || v['pattern'].length === 0) {
    return err(`${path}.pattern must be a non-empty string`);
  }
  return ok({ kind: v['kind'] as MatchRule['kind'], pattern: v['pattern'] });
}

/**
 * Validate an unknown value as a {@link FillConfig}. Returns the correctly-typed
 * config on success or a descriptive, path-prefixed error on the first problem.
 */
export function validateConfig(v: unknown, path = 'config'): Result<FillConfig> {
  if (!isRecord(v)) return err(`${path} must be an object`);

  if (typeof v['id'] !== 'string' || v['id'].length === 0) {
    return err(`${path}.id must be a non-empty string`);
  }
  if (typeof v['name'] !== 'string' || v['name'].length === 0) {
    return err(`${path}.name must be a non-empty string`);
  }

  if (!Array.isArray(v['match'])) return err(`${path}.match must be an array`);
  const match: MatchRule[] = [];
  for (let i = 0; i < v['match'].length; i++) {
    const r = validateRule(v['match'][i], `${path}.match[${i}]`);
    if (!r.ok) return r;
    match.push(r.value);
  }

  if (!Array.isArray(v['steps'])) return err(`${path}.steps must be an array`);
  const steps: FieldStep[] = [];
  for (let i = 0; i < v['steps'].length; i++) {
    const s = validateStep(v['steps'][i], `${path}.steps[${i}]`);
    if (!s.ok) return s;
    steps.push(s.value);
  }

  if (!(ERROR_STRATEGIES as readonly string[]).includes(v['errorStrategy'] as string)) {
    return err(`${path}.errorStrategy must be "stop" or "continue"`);
  }
  if (typeof v['encrypted'] !== 'boolean') {
    return err(`${path}.encrypted must be a boolean`);
  }
  if (typeof v['createdAt'] !== 'number' || !Number.isFinite(v['createdAt'])) {
    return err(`${path}.createdAt must be a finite number`);
  }
  if (typeof v['updatedAt'] !== 'number' || !Number.isFinite(v['updatedAt'])) {
    return err(`${path}.updatedAt must be a finite number`);
  }

  return ok({
    id: v['id'],
    name: v['name'],
    match,
    steps,
    errorStrategy: v['errorStrategy'] as FillConfig['errorStrategy'],
    encrypted: v['encrypted'],
    createdAt: v['createdAt'],
    updatedAt: v['updatedAt'],
  });
}

/**
 * Validate an unknown value as an export {@link ExportEnvelope}. Checks the app
 * marker and version-gates against {@link SCHEMA_VERSION} (Req 7.6) before
 * validating the wrapped config (Req 7.3, 7.4).
 */
export function validateEnvelope(v: unknown): Result<ExportEnvelope> {
  if (!isRecord(v)) return err('envelope must be an object');

  if (v['app'] !== 'fillibuster') {
    return err('envelope.app must be "fillibuster"');
  }
  if (v['schemaVersion'] !== SCHEMA_VERSION) {
    return err(
      `unsupported schemaVersion ${JSON.stringify(v['schemaVersion'])}; expected ${SCHEMA_VERSION}`,
    );
  }

  const config = validateConfig(v['config']);
  if (!config.ok) return config;

  return ok({ app: 'fillibuster', schemaVersion: SCHEMA_VERSION, config: config.value });
}
