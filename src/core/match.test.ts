import { describe, expect, it } from 'vitest';

import type { FillConfig, MatchRule } from './schema';
import { configMatches, matchingConfigIds, ruleMatches } from './match';

function rule(kind: MatchRule['kind'], pattern: string): MatchRule {
  return { kind, pattern };
}

/** A config with only the fields matching cares about; the rest are filler. */
function config(id: string, match: MatchRule[]): FillConfig {
  return {
    id,
    name: id,
    match,
    steps: [],
    errorStrategy: 'continue',
    encrypted: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('ruleMatches — exact', () => {
  const pattern = 'https://dmv.example.com/apply';

  it('matches an identical URL', () => {
    expect(ruleMatches(pattern, rule('exact', pattern))).toBe(true);
  });

  it('does not match when a query string is appended', () => {
    expect(ruleMatches(`${pattern}?step=2`, rule('exact', pattern))).toBe(false);
  });

  it('is sensitive to a trailing slash difference', () => {
    expect(ruleMatches(`${pattern}/`, rule('exact', pattern))).toBe(false);
    expect(ruleMatches(pattern, rule('exact', `${pattern}/`))).toBe(false);
  });

  it('does not match a different path', () => {
    expect(ruleMatches('https://dmv.example.com/renew', rule('exact', pattern))).toBe(false);
  });
});

describe('ruleMatches — prefix', () => {
  const prefix = 'https://dmv.example.com/apply';

  it('matches the exact prefix', () => {
    expect(ruleMatches(prefix, rule('prefix', prefix))).toBe(true);
  });

  it('matches when the URL extends the prefix with a sub-path', () => {
    expect(ruleMatches(`${prefix}/step/2`, rule('prefix', prefix))).toBe(true);
  });

  it('matches when the URL extends the prefix with a query string', () => {
    expect(ruleMatches(`${prefix}?step=2`, rule('prefix', prefix))).toBe(true);
  });

  it('does not match a URL that only shares part of the prefix', () => {
    expect(ruleMatches('https://dmv.example.com/app', rule('prefix', prefix))).toBe(false);
  });

  it('does not match a different origin', () => {
    expect(ruleMatches('https://evil.example.com/apply', rule('prefix', prefix))).toBe(false);
  });
});

describe('ruleMatches — glob', () => {
  it('matches any characters where * appears at the end', () => {
    const r = rule('glob', 'https://dmv.example.com/*');
    expect(ruleMatches('https://dmv.example.com/apply', r)).toBe(true);
    expect(ruleMatches('https://dmv.example.com/renew/2', r)).toBe(true);
  });

  it('matches zero characters for a trailing *', () => {
    const r = rule('glob', 'https://dmv.example.com/apply*');
    expect(ruleMatches('https://dmv.example.com/apply', r)).toBe(true);
  });

  it('lets a wildcard span path segments and query strings', () => {
    const r = rule('glob', 'https://dmv.example.com/*/confirm*');
    expect(ruleMatches('https://dmv.example.com/apply/step/confirm?id=9', r)).toBe(true);
  });

  it('supports a wildcard in the middle', () => {
    const r = rule('glob', 'https://*.example.com/apply');
    expect(ruleMatches('https://dmv.example.com/apply', r)).toBe(true);
    expect(ruleMatches('https://rmv.example.com/apply', r)).toBe(true);
  });

  it('requires a full-string (anchored) match, not a substring', () => {
    const r = rule('glob', 'https://dmv.example.com/apply');
    expect(ruleMatches('https://dmv.example.com/apply/extra', r)).toBe(false);
    expect(ruleMatches('prefix-https://dmv.example.com/apply', r)).toBe(false);
  });

  it('treats regex metacharacters in the pattern as literals', () => {
    // The dots and query char must match literally, not as regex wildcards.
    const r = rule('glob', 'https://dmv.example.com/a.b?x=1');
    expect(ruleMatches('https://dmv.example.com/a.b?x=1', r)).toBe(true);
    // A literal '.' must not match an arbitrary character.
    expect(ruleMatches('https://dmv-example-com/a.b?x=1', r)).toBe(false);
    // The literal '?' must not behave as a regex "optional" quantifier.
    expect(ruleMatches('https://dmv.example.com/a.bx=1', r)).toBe(false);
  });

  it('does not match when the fixed parts differ', () => {
    const r = rule('glob', 'https://dmv.example.com/apply/*');
    expect(ruleMatches('https://dmv.example.com/renew/1', r)).toBe(false);
  });
});

describe('configMatches', () => {
  it('matches when any single rule matches', () => {
    const cfg = config('c1', [
      rule('exact', 'https://dmv.example.com/apply'),
      rule('glob', 'https://dmv.example.com/renew/*'),
    ]);
    expect(configMatches('https://dmv.example.com/renew/1', cfg)).toBe(true);
  });

  it('does not match when no rule matches', () => {
    const cfg = config('c1', [
      rule('exact', 'https://dmv.example.com/apply'),
      rule('prefix', 'https://dmv.example.com/renew'),
    ]);
    expect(configMatches('https://other.example.com/', cfg)).toBe(false);
  });

  it('never matches a config with no rules', () => {
    expect(configMatches('https://dmv.example.com/apply', config('c1', []))).toBe(false);
  });
});

describe('matchingConfigIds', () => {
  const apply = config('apply', [rule('exact', 'https://dmv.example.com/apply')]);
  const renew = config('renew', [rule('glob', 'https://dmv.example.com/renew/*')]);
  const anyDmv = config('any-dmv', [rule('prefix', 'https://dmv.example.com/')]);

  it('returns ids of all matching configs from an array, in order', () => {
    const ids = matchingConfigIds('https://dmv.example.com/apply', [apply, renew, anyDmv]);
    expect(ids).toEqual(['apply', 'any-dmv']);
  });

  it('returns ids from a keyed record', () => {
    const ids = matchingConfigIds('https://dmv.example.com/renew/2', {
      apply,
      renew,
      anyDmv,
    });
    expect(ids).toEqual(['renew', 'any-dmv']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(matchingConfigIds('https://unrelated.example.org/', [apply, renew, anyDmv])).toEqual([]);
  });

  it('handles an empty collection', () => {
    expect(matchingConfigIds('https://dmv.example.com/apply', [])).toEqual([]);
    expect(matchingConfigIds('https://dmv.example.com/apply', {})).toEqual([]);
  });
});
