/**
 * The match-rules sub-editor for a config (task 12.2, Req 6.2).
 *
 * A config's `match` array is a list of URL {@link MatchRule}s — the page
 * matches if ANY rule matches (Req 4.1). This presentational component renders
 * one row per rule (a `kind` select of exact/prefix/glob plus a `pattern`
 * text input) with add/remove affordances, and reports every edit back to the
 * parent {@link ConfigEditor} via {@link MatchRuleEditorProps.onChange} so the
 * editor's single draft stays the source of truth.
 *
 * Requirements: 6.2
 */

import type { MatchRule } from '../core/schema';

export interface MatchRuleEditorProps {
  rules: MatchRule[];
  disabled?: boolean;
  /** Called with the full, updated rules array on any add/edit/remove. */
  onChange: (rules: MatchRule[]) => void;
}

const KINDS: MatchRule['kind'][] = ['exact', 'prefix', 'glob'];

export function MatchRuleEditor(props: MatchRuleEditorProps) {
  const { rules, disabled, onChange } = props;

  function addRule() {
    onChange([...rules, { kind: 'prefix', pattern: '' }]);
  }

  function removeRule(index: number) {
    onChange(rules.filter((_, i) => i !== index));
  }

  function updateRule(index: number, patch: Partial<MatchRule>) {
    onChange(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  // Button placement per row: the first row never gets Remove (so a lone rule
  // can't be removed); later rows do. Only the last row gets Add rule. With no
  // rules at all, Add rule lives in the header so there is still a way to start.
  return (
    <div class="subsection">
      <div class="subsection-head">
        <h3>Match rules</h3>
        {rules.length === 0 ? (
          <button
            type="button"
            class="icon-button"
            disabled={disabled}
            aria-label="Add rule"
            title="Add rule"
            onClick={addRule}
          >
            <span aria-hidden="true">+</span>
          </button>
        ) : null}
      </div>

      {rules.length === 0 ? (
        <p class="muted">
          No match rules. This config won't match any page until you add one.
        </p>
      ) : (
        <ul class="rule-list">
          {rules.map((rule, index) => (
            // Rules have no stable id; index is acceptable for a flat, reorderless list.
            <li key={index} class="rule-row">
              <label class="visually-hidden" for={`rule-kind-${index}`}>
                Rule {index + 1} kind
              </label>
              <select
                id={`rule-kind-${index}`}
                value={rule.kind}
                disabled={disabled}
                onChange={(e) =>
                  updateRule(index, {
                    kind: (e.target as HTMLSelectElement)
                      .value as MatchRule['kind'],
                  })
                }
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>

              <label class="visually-hidden" for={`rule-pattern-${index}`}>
                Rule {index + 1} pattern
              </label>
              <input
                id={`rule-pattern-${index}`}
                type="text"
                class="grow"
                placeholder="https://example.com/apply*"
                value={rule.pattern}
                disabled={disabled}
                onInput={(e) =>
                  updateRule(index, {
                    pattern: (e.target as HTMLInputElement).value,
                  })
                }
              />

              <div class="rule-actions">
                {index > 0 ? (
                  <button
                    type="button"
                    class="icon-button danger"
                    disabled={disabled}
                    aria-label={`Remove rule ${index + 1}`}
                    title="Remove rule"
                    onClick={() => removeRule(index)}
                  >
                    <span aria-hidden="true">✕</span>
                  </button>
                ) : null}
                {index === rules.length - 1 ? (
                  <button
                    type="button"
                    class="icon-button"
                    disabled={disabled}
                    aria-label="Add rule"
                    title="Add rule"
                    onClick={addRule}
                  >
                    <span aria-hidden="true">+</span>
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
