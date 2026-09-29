/**
 * URL matching engine for Fillibuster.
 *
 * A saved config names the page(s) it applies to via a list of {@link MatchRule}s.
 * When the active tab's URL matches one or more configs, the background worker
 * lights up the toolbar badge and the popup lists those configs. This module is
 * the pure, browser-free heart of that decision: given a URL and rule(s), does it
 * match? Keeping it free of any extension API means the exact/prefix/glob logic
 * is unit-testable in Node (Req 4.1, 4.5).
 *
 * Rule kinds (Req 4.1):
 *  - `exact`  — full URL string equality.
 *  - `prefix` — the URL starts with the pattern.
 *  - `glob`   — wildcard match where `*` stands for any run of characters
 *               (including none, and across path/query boundaries). Implemented
 *               by escaping regex metacharacters in the pattern, then translating
 *               `*` to `.*`, and anchoring for a full-string match.
 *
 * A config matches if ANY of its rules match (Req 4.1).
 *
 * Requirements: 4.1, 4.5
 */

import type { FillConfig, MatchRule } from './schema';

/**
 * Escape every regex metacharacter in `s` so it matches literally. `*` is a
 * metacharacter too and is escaped here; glob translation re-introduces it as a
 * wildcard afterwards (see {@link globToRegExp}).
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a glob pattern into an anchored {@link RegExp}. Metacharacters are
 * escaped first so only `*` carries wildcard meaning; each `*` becomes `.*`,
 * matching any run of characters (including none). The result is anchored with
 * `^`/`$` for a full-string match.
 */
function globToRegExp(pattern: string): RegExp {
  const body = escapeRegExp(pattern).replace(/\\\*/g, '.*');
  return new RegExp(`^${body}$`);
}

/**
 * Does `url` satisfy a single {@link MatchRule}?
 */
export function ruleMatches(url: string, rule: MatchRule): boolean {
  switch (rule.kind) {
    case 'exact':
      return url === rule.pattern;
    case 'prefix':
      return url.startsWith(rule.pattern);
    case 'glob':
      return globToRegExp(rule.pattern).test(url);
    // Unreachable for well-typed input; validated configs only carry known kinds.
    default:
      return false;
  }
}

/**
 * Does `url` match a config? True when ANY of the config's rules match (Req 4.1).
 * A config with no rules never matches.
 */
export function configMatches(url: string, config: FillConfig): boolean {
  return config.match.some((rule) => ruleMatches(url, rule));
}

/**
 * Given a URL and a collection of configs, return the ids of those that match.
 * Order follows iteration order of `configs`. Accepts either an array of configs
 * or a keyed record (as stored under `storage.local`).
 */
export function matchingConfigIds(
  url: string,
  configs: readonly FillConfig[] | Record<string, FillConfig>,
): string[] {
  const list = Array.isArray(configs) ? configs : Object.values(configs);
  return list.filter((config) => configMatches(url, config)).map((config) => config.id);
}
