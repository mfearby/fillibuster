import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from './schema';
import type { FillConfig } from './schema';
import { validateConfig, validateEnvelope } from './validate';

/** A minimal-but-complete valid config, deep-cloned per call so tests can mutate. */
function validConfig(): FillConfig {
  return {
    id: 'cfg-1',
    name: 'DMV apply',
    match: [
      { kind: 'exact', pattern: 'https://dmv.example.com/apply' },
      { kind: 'glob', pattern: 'https://dmv.example.com/*' },
    ],
    steps: [
      { id: 's1', type: 'text', target: { by: 'id', value: 'first' }, value: 'Ada' },
      {
        id: 's2',
        type: 'select',
        label: 'state',
        target: { by: 'name', value: 'state' },
        value: 'CA',
        matchBy: 'value',
      },
      { id: 's3', type: 'check', target: { by: 'css', value: '#agree' }, checked: true },
      {
        id: 's4',
        type: 'contenteditable',
        target: { by: 'id', value: 'bio' },
        html: '<b>hi</b>',
        allowHtml: true,
      },
    ],
    errorStrategy: 'continue',
    encrypted: false,
    createdAt: 1,
    updatedAt: 2,
  };
}

function envelope(config: unknown = validConfig()) {
  return { app: 'fillibuster', schemaVersion: SCHEMA_VERSION, config };
}

/** Round-trip through JSON to mimic a value that crossed a trust boundary. */
function asUnknown(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

describe('validateConfig', () => {
  it('accepts a complete valid config', () => {
    const res = validateConfig(asUnknown(validConfig()));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(validConfig());
  });

  it('accepts a config with no steps and no rules', () => {
    const cfg = validConfig();
    cfg.match = [];
    cfg.steps = [];
    const res = validateConfig(asUnknown(cfg));
    expect(res.ok).toBe(true);
  });

  it('drops unknown extra properties from the output', () => {
    const cfg = { ...validConfig(), bogus: 'nope' };
    const res = validateConfig(asUnknown(cfg));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).not.toHaveProperty('bogus');
  });

  describe('top-level invalid fields', () => {
    const cases: Array<[string, (c: Record<string, unknown>) => void, RegExp]> = [
      ['non-object', () => {}, /must be an object/],
      ['missing id', (c) => delete c['id'], /id must be a non-empty string/],
      ['empty id', (c) => (c['id'] = ''), /id must be a non-empty string/],
      ['non-string name', (c) => (c['name'] = 5), /name must be a non-empty string/],
      ['match not array', (c) => (c['match'] = {}), /match must be an array/],
      ['steps not array', (c) => (c['steps'] = 'x'), /steps must be an array/],
      ['bad errorStrategy', (c) => (c['errorStrategy'] = 'halt'), /errorStrategy/],
      ['non-boolean encrypted', (c) => (c['encrypted'] = 'yes'), /encrypted must be a boolean/],
      ['non-number createdAt', (c) => (c['createdAt'] = '1'), /createdAt must be a finite number/],
      ['NaN updatedAt', (c) => (c['updatedAt'] = NaN), /updatedAt must be a finite number/],
    ];

    it.each(cases)('rejects %s', (_label, mutate, pattern) => {
      const cfg = asUnknown(validConfig()) as Record<string, unknown>;
      mutate(cfg);
      const res = validateConfig(_label === 'non-object' ? null : cfg);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(pattern);
    });
  });

  describe('invalid match rules', () => {
    it('rejects a rule with an unknown kind', () => {
      const cfg = validConfig();
      (cfg.match[0] as { kind: string }).kind = 'regex';
      const res = validateConfig(asUnknown(cfg));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/match\[0\]\.kind/);
    });

    it('rejects a rule with an empty pattern', () => {
      const cfg = validConfig();
      cfg.match[1]!.pattern = '';
      const res = validateConfig(asUnknown(cfg));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/match\[1\]\.pattern/);
    });
  });

  describe('invalid selectors', () => {
    it('rejects a bad selector.by', () => {
      const cfg = validConfig();
      (cfg.steps[0]!.target as { by: string }).by = 'xpath';
      const res = validateConfig(asUnknown(cfg));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/steps\[0\]\.target\.by/);
    });

    it('rejects an empty selector.value', () => {
      const cfg = validConfig();
      cfg.steps[0]!.target.value = '';
      const res = validateConfig(asUnknown(cfg));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/steps\[0\]\.target\.value/);
    });

    it('rejects a missing target', () => {
      const cfg = asUnknown(validConfig()) as { steps: Array<Record<string, unknown>> };
      delete cfg.steps[0]!['target'];
      const res = validateConfig(cfg);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/steps\[0\]\.target must be an object/);
    });
  });

  describe('invalid steps', () => {
    it('rejects an unknown step type', () => {
      const cfg = asUnknown(validConfig()) as { steps: Array<Record<string, unknown>> };
      cfg.steps[0]!['type'] = 'autocomplete';
      const res = validateConfig(cfg);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/steps\[0\]\.type must be one of/);
    });

    it('rejects a step missing its id', () => {
      const cfg = asUnknown(validConfig()) as { steps: Array<Record<string, unknown>> };
      delete cfg.steps[0]!['id'];
      const res = validateConfig(cfg);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/steps\[0\]\.id/);
    });

    it('rejects a text step with a non-string value', () => {
      const cfg = asUnknown(validConfig()) as { steps: Array<Record<string, unknown>> };
      cfg.steps[0]!['value'] = 42;
      const res = validateConfig(cfg);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/steps\[0\]\.value must be a string/);
    });

    it('rejects a select step with a bad matchBy', () => {
      const cfg = asUnknown(validConfig()) as { steps: Array<Record<string, unknown>> };
      cfg.steps[1]!['matchBy'] = 'label';
      const res = validateConfig(cfg);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/steps\[1\]\.matchBy/);
    });

    it('rejects a check step with a non-boolean checked', () => {
      const cfg = asUnknown(validConfig()) as { steps: Array<Record<string, unknown>> };
      cfg.steps[2]!['checked'] = 'true';
      const res = validateConfig(cfg);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/steps\[2\]\.checked/);
    });

    it('rejects a contenteditable step with a non-string html', () => {
      const cfg = asUnknown(validConfig()) as { steps: Array<Record<string, unknown>> };
      cfg.steps[3]!['html'] = null;
      const res = validateConfig(cfg);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/steps\[3\]\.html/);
    });

    it('rejects a contenteditable step with a non-boolean allowHtml', () => {
      const cfg = asUnknown(validConfig()) as { steps: Array<Record<string, unknown>> };
      cfg.steps[3]!['allowHtml'] = 'yes';
      const res = validateConfig(cfg);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/steps\[3\]\.allowHtml/);
    });

    it('rejects a non-string label', () => {
      const cfg = asUnknown(validConfig()) as { steps: Array<Record<string, unknown>> };
      cfg.steps[0]!['label'] = 7;
      const res = validateConfig(cfg);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/steps\[0\]\.label/);
    });
  });
});

describe('validateEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    const res = validateEnvelope(asUnknown(envelope()));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.app).toBe('fillibuster');
      expect(res.value.schemaVersion).toBe(SCHEMA_VERSION);
      expect(res.value.config).toEqual(validConfig());
    }
  });

  it('rejects a non-object', () => {
    const res = validateEnvelope('not an object');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/envelope must be an object/);
  });

  it('rejects a wrong app marker', () => {
    const res = validateEnvelope(asUnknown({ ...envelope(), app: 'someotherapp' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/app must be "fillibuster"/);
  });

  it('rejects an incompatible schemaVersion (Req 7.6)', () => {
    const res = validateEnvelope(asUnknown({ ...envelope(), schemaVersion: 2 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unsupported schemaVersion 2/);
  });

  it('rejects a missing schemaVersion', () => {
    const bad = asUnknown(envelope()) as Record<string, unknown>;
    delete bad['schemaVersion'];
    const res = validateEnvelope(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unsupported schemaVersion/);
  });

  it('propagates an invalid nested config error', () => {
    const bad = envelope(asUnknown({ ...validConfig(), name: '' }));
    const res = validateEnvelope(asUnknown(bad));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/config\.name/);
  });

  it('rejects an envelope with a missing config', () => {
    const bad = asUnknown(envelope()) as Record<string, unknown>;
    delete bad['config'];
    const res = validateEnvelope(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/config must be an object/);
  });
});
