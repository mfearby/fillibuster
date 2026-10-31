import { describe, expect, it } from 'vitest';

import { configProblems } from './problems';
import type { FillConfig } from './schema';

function config(overrides: Partial<FillConfig> = {}): FillConfig {
  return {
    id: 'c1',
    name: 'Example',
    match: [{ kind: 'prefix', pattern: 'https://example.com/' }],
    steps: [{ id: 's1', type: 'text', target: { by: 'id', value: 'email' }, value: '' }],
    errorStrategy: 'stop',
    encrypted: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('configProblems', () => {
  it('finds nothing wrong with a complete config', () => {
    expect(configProblems(config())).toEqual([]);
  });

  it('reports an empty name, pattern, and target in plain language', () => {
    const problems = configProblems(
      config({
        name: '  ',
        match: [{ kind: 'glob', pattern: '' }],
        steps: [{ id: 's1', type: 'check', target: { by: 'name', value: ' ' }, checked: true }],
      }),
    );
    expect(problems).toEqual([
      'Name is empty.',
      'Match rule 1: Pattern is empty.',
      'Step 1 (checkbox): Target value is empty.',
    ]);
  });

  it('checks autocomplete options and button text', () => {
    const problems = configProblems(
      config({
        steps: [
          {
            id: 'a',
            type: 'autocomplete',
            target: { by: 'id', value: 'addr' },
            value: 'Penn',
            optionTarget: { by: 'css', value: '' },
            optionMatch: '',
            timeoutMs: 2000,
          },
          { id: 'b', type: 'button', target: { by: 'id', value: '' }, matchBy: 'text', text: '' },
        ],
      }),
    );
    expect(problems).toEqual([
      'Step 1 (autocomplete): Options selector is empty.',
      'Step 1 (autocomplete): Option text contains is empty.',
      'Step 2 (button (click)): Button text is empty.',
    ]);
  });

  it('does not require a target for a button found by its text', () => {
    const problems = configProblems(
      config({
        steps: [{ id: 'b', type: 'button', target: { by: 'id', value: '' }, matchBy: 'text', text: 'Accept' }],
      }),
    );
    expect(problems).toEqual([]);
  });

  it('falls back to the validator for anything else the importer would reject', () => {
    const problems = configProblems(config({ errorStrategy: 'halt' as never }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/isn't valid: .*errorStrategy/);
  });
});
