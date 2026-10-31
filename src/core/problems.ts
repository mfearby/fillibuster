/**
 * Plain-language "can't save yet" checks for a config being edited.
 *
 * The importer ({@link validateConfig}) rejects configs with, for example, an
 * empty target. If the editor saved such a config, a backup containing it could
 * never be restored. So before saving, the editor runs {@link configProblems}
 * and refuses to save while any problem remains.
 *
 * Each problem names where it is ("Step 3 (text): Target value is empty.") so
 * the user can find and fix it. The checks mirror the validator's rules, a
 * little stricter (whitespace-only counts as empty), and finish with the
 * validator itself as a safety net — so anything the editor saves will import.
 */

import type { FillConfig } from './schema';
import { STEP_TYPE_LABELS } from './schema';
import { validateConfig } from './validate';

const isBlank = (s: string | undefined) => (s ?? '').trim().length === 0;

/** Every reason `config` can't be saved yet, or `[]` when it is fine. */
export function configProblems(config: FillConfig): string[] {
  const problems: string[] = [];

  if (isBlank(config.name)) problems.push('Name is empty.');

  config.match.forEach((rule, i) => {
    if (isBlank(rule.pattern)) problems.push(`Match rule ${i + 1}: Pattern is empty.`);
  });

  config.steps.forEach((step, i) => {
    const where = `Step ${i + 1} (${STEP_TYPE_LABELS[step.type]})`;
    // A button found by its text doesn't use its target (the editor hides it).
    const targetUnused = step.type === 'button' && step.matchBy === 'text';
    if (!targetUnused && isBlank(step.target.value)) {
      problems.push(`${where}: Target value is empty.`);
    }
    if (step.type === 'autocomplete') {
      if (isBlank(step.optionTarget.value)) problems.push(`${where}: Options selector is empty.`);
      if (isBlank(step.optionMatch)) problems.push(`${where}: Option text contains is empty.`);
    }
    if (step.type === 'button' && step.matchBy === 'text' && isBlank(step.text)) {
      problems.push(`${where}: Button text is empty.`);
    }
  });

  // Safety net: anything else the importer would reject.
  if (problems.length === 0) {
    const valid = validateConfig(config);
    if (!valid.ok) problems.push(`This config isn't valid: ${valid.error}.`);
  }

  return problems;
}
