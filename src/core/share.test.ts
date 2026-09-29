import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from './schema';
import type { FillConfig } from './schema';
import { exportConfig, exportConfigJson, importEnvelope, suggestName } from './share';

/** A minimal-but-complete valid config, fresh per call so tests can mutate. */
function validConfig(): FillConfig {
  return {
    id: 'cfg-1',
    name: 'DMV apply',
    match: [{ kind: 'glob', pattern: 'https://dmv.example.com/*' }],
    steps: [
      { id: 's1', type: 'text', target: { by: 'id', value: 'first' }, value: 'Ada' },
      { id: 's2', type: 'check', target: { by: 'css', value: '#agree' }, checked: true },
    ],
    errorStrategy: 'continue',
    encrypted: false,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('exportConfig', () => {
  it('wraps the config in the versioned envelope', () => {
    const cfg = validConfig();
    const env = exportConfig(cfg);
    expect(env).toEqual({
      app: 'fillibuster',
      schemaVersion: SCHEMA_VERSION,
      config: cfg,
    });
  });

  it('emits plaintext steps as-is', () => {
    const env = exportConfig(validConfig());
    expect(env.config.steps).toEqual(validConfig().steps);
  });
});

describe('exportConfigJson', () => {
  it('produces JSON that parses back to the envelope', () => {
    const cfg = validConfig();
    const json = exportConfigJson(cfg);
    expect(JSON.parse(json)).toEqual(exportConfig(cfg));
  });
});

describe('suggestName', () => {
  it('returns the name unchanged when it is free', () => {
    expect(suggestName('DMV apply', ['Other'])).toBe('DMV apply');
  });

  it('appends " (2)" on the first collision', () => {
    expect(suggestName('DMV apply', ['DMV apply'])).toBe('DMV apply (2)');
  });

  it('skips already-taken suffixed names', () => {
    expect(suggestName('DMV apply', ['DMV apply', 'DMV apply (2)', 'DMV apply (3)'])).toBe(
      'DMV apply (4)',
    );
  });
});

describe('importEnvelope', () => {
  it('round-trips an exported config (export -> import)', () => {
    const cfg = validConfig();
    const json = exportConfigJson(cfg);
    const res = importEnvelope(json, []);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.config).toEqual(cfg);
      expect(res.value.resolvedName).toBe('DMV apply');
      expect(res.value.renamed).toBe(false);
    }
  });

  it('rejects malformed JSON without throwing (Req 7.4)', () => {
    const res = importEnvelope('{ not json', []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not valid JSON/);
  });

  it('rejects a wrong app marker (Req 7.4)', () => {
    const env = { ...exportConfig(validConfig()), app: 'someotherapp' };
    const res = importEnvelope(JSON.stringify(env), []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/app must be "fillibuster"/);
  });

  it('rejects an unknown schemaVersion (Req 7.6)', () => {
    const env = { ...exportConfig(validConfig()), schemaVersion: 2 };
    const res = importEnvelope(JSON.stringify(env), []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unsupported schemaVersion 2/);
  });

  it('rejects an envelope whose config is invalid (Req 7.3)', () => {
    const env = exportConfig({ ...validConfig(), name: '' });
    const res = importEnvelope(JSON.stringify(env), []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/config\.name/);
  });

  it('keeps both on a name collision by suggesting a new name (Req 7.5)', () => {
    const json = exportConfigJson(validConfig());
    const res = importEnvelope(json, ['DMV apply']);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.renamed).toBe(true);
      expect(res.value.resolvedName).toBe('DMV apply (2)');
      expect(res.value.config.name).toBe('DMV apply (2)');
      // The rest of the config is untouched.
      expect(res.value.config.id).toBe('cfg-1');
      expect(res.value.config.steps).toEqual(validConfig().steps);
    }
  });

  it('does not mutate the parsed config when no collision occurs', () => {
    const cfg = validConfig();
    const res = importEnvelope(exportConfigJson(cfg), ['Unrelated']);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.config.name).toBe('DMV apply');
  });

  it('defaults existingNames to empty (no collision) when omitted', () => {
    const res = importEnvelope(exportConfigJson(validConfig()));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.renamed).toBe(false);
  });
});
