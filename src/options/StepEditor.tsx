/**
 * The single-step sub-editor for a config (task 12.2, Req 6.3, 6.4, 2.1).
 *
 * A config's `steps` is an ordered list of typed {@link FieldStep}s. This
 * presentational component renders ONE step: its common fields (a target
 * {@link Selector} — `by` id/name/css + `value` — and an optional label), a
 * type selector, and the fields specific to the current step type (Req 2.1,
 * 6.4). Reorder (move up/down) and remove are exposed as buttons and delegated
 * to the parent {@link ConfigEditor}, which owns the steps array and its
 * ordering (Req 6.3).
 *
 * Changing a step's `type` produces a valid step of the new type: id, target,
 * and label are preserved while the type-specific fields reset to defaults (see
 * {@link changeStepType}). This keeps the discriminated union sound so a saved
 * config always round-trips through {@link FieldStep}.
 *
 * Requirements: 2.1, 6.3, 6.4
 */

import type {
  CheckStep,
  ContentEditableStep,
  FieldStep,
  RadioStep,
  Selector,
  SelectStep,
  TextStep,
} from '../core/schema';

export interface StepEditorProps {
  step: FieldStep;
  index: number;
  /** True when this is the first step (disables "move up"). */
  isFirst: boolean;
  /** True when this is the last step (disables "move down"). */
  isLast: boolean;
  disabled?: boolean;
  onChange: (step: FieldStep) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

const STEP_TYPES: FieldStep['type'][] = [
  'text',
  'select',
  'check',
  'radio',
  'contenteditable',
];

const SELECTOR_BYS: Selector['by'][] = ['id', 'name', 'css'];

/** Placeholder text for the target value input, per selector kind. */
function targetPlaceholder(by: Selector['by']): string {
  switch (by) {
    case 'id':
      return 'emailField  (or a comma list of fallback ids)';
    case 'name':
      return 'user[email]  (or a comma list of fallback names)';
    case 'css':
      return '#email, input[name="x"], .selector';
  }
}

/**
 * Hint shown under the target value input. For `id`/`name`, document the
 * comma-separated fallback list (tried in order, first present wins) so one
 * step can cover pages that use different ids/names for the same control.
 */
function targetHint(by: Selector['by']): string {
  switch (by) {
    case 'id':
      return 'A single id, or several ids separated by commas — tried in order, first found is used.';
    case 'name':
      return 'A single name, or several names separated by commas — tried in order, first found is used.';
    case 'css':
      return 'A CSS selector. A comma list matches the first in page order.';
  }
}

/**
 * Rebuild a step under a new `type`, keeping the shared identity (id, target,
 * label) and resetting the type-specific fields to their defaults so the result
 * is always a valid member of the {@link FieldStep} union.
 */
export function changeStepType(
  step: FieldStep,
  type: FieldStep['type'],
): FieldStep {
  if (step.type === type) return step;
  const base = { id: step.id, label: step.label, target: step.target };
  switch (type) {
    case 'text':
      return { ...base, type: 'text', value: '' } satisfies TextStep;
    case 'select':
      return {
        ...base,
        type: 'select',
        value: '',
        matchBy: 'value',
      } satisfies SelectStep;
    case 'check':
      return { ...base, type: 'check', checked: false } satisfies CheckStep;
    case 'radio':
      return { ...base, type: 'radio', value: '' } satisfies RadioStep;
    case 'contenteditable':
      return {
        ...base,
        type: 'contenteditable',
        html: '',
        allowHtml: false,
      } satisfies ContentEditableStep;
  }
}

export function StepEditor(props: StepEditorProps) {
  const {
    step,
    index,
    isFirst,
    isLast,
    disabled,
    onChange,
    onMoveUp,
    onMoveDown,
    onRemove,
  } = props;

  const idp = `step-${index}`;

  function updateTarget(patch: Partial<Selector>) {
    onChange({ ...step, target: { ...step.target, ...patch } });
  }

  return (
    <li class="step-row">
      <div class="step-head">
        <span class="step-num">Step {index + 1}</span>
        <div class="step-head-actions">
          <button
            type="button"
            disabled={disabled || isFirst}
            aria-label={`Move step ${index + 1} up`}
            onClick={onMoveUp}
          >
            ↑
          </button>
          <button
            type="button"
            disabled={disabled || isLast}
            aria-label={`Move step ${index + 1} down`}
            onClick={onMoveDown}
          >
            ↓
          </button>
          <button
            type="button"
            class="danger"
            disabled={disabled}
            aria-label={`Remove step ${index + 1}`}
            onClick={onRemove}
          >
            Remove
          </button>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label for={`${idp}-type`}>Type</label>
          <select
            id={`${idp}-type`}
            value={step.type}
            disabled={disabled}
            onChange={(e) =>
              onChange(
                changeStepType(
                  step,
                  (e.target as HTMLSelectElement).value as FieldStep['type'],
                ),
              )
            }
          >
            {STEP_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div class="field grow">
          <label for={`${idp}-label`}>Label</label>
          <input
            id={`${idp}-label`}
            type="text"
            placeholder="Optional note"
            value={step.label ?? ''}
            disabled={disabled}
            onInput={(e) =>
              onChange({
                ...step,
                label: (e.target as HTMLInputElement).value || undefined,
              })
            }
          />
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label for={`${idp}-by`}>Target by</label>
          <select
            id={`${idp}-by`}
            value={step.target.by}
            disabled={disabled}
            onChange={(e) =>
              updateTarget({
                by: (e.target as HTMLSelectElement).value as Selector['by'],
              })
            }
          >
            {SELECTOR_BYS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>

        <div class="field grow">
          <label for={`${idp}-target`}>Target value</label>
          <input
            id={`${idp}-target`}
            type="text"
            placeholder={targetPlaceholder(step.target.by)}
            value={step.target.value}
            disabled={disabled}
            aria-describedby={`${idp}-target-hint`}
            onInput={(e) =>
              updateTarget({ value: (e.target as HTMLInputElement).value })
            }
          />
          <small id={`${idp}-target-hint`} class="field-hint muted">
            {targetHint(step.target.by)}
          </small>
        </div>
      </div>

      <StepTypeFields step={step} idp={idp} disabled={disabled} onChange={onChange} />
    </li>
  );
}

/** Render only the fields specific to the current step type (Req 2.1, 6.4). */
function StepTypeFields(props: {
  step: FieldStep;
  idp: string;
  disabled?: boolean;
  onChange: (step: FieldStep) => void;
}) {
  const { step, idp, disabled, onChange } = props;

  switch (step.type) {
    case 'text':
      return (
        <div class="field">
          <label for={`${idp}-value`}>Value</label>
          <input
            id={`${idp}-value`}
            type="text"
            value={step.value}
            disabled={disabled}
            onInput={(e) =>
              onChange({
                ...step,
                value: (e.target as HTMLInputElement).value,
              })
            }
          />
        </div>
      );

    case 'select':
      return (
        <div class="field-row">
          <div class="field grow">
            <label for={`${idp}-value`}>Value</label>
            <input
              id={`${idp}-value`}
              type="text"
              value={step.value}
              disabled={disabled}
              onInput={(e) =>
                onChange({
                  ...step,
                  value: (e.target as HTMLInputElement).value,
                })
              }
            />
          </div>
          <div class="field">
            <label for={`${idp}-matchby`}>Match by</label>
            <select
              id={`${idp}-matchby`}
              value={step.matchBy}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...step,
                  matchBy: (e.target as HTMLSelectElement)
                    .value as SelectStep['matchBy'],
                })
              }
            >
              <option value="value">value</option>
              <option value="text">text</option>
            </select>
          </div>
        </div>
      );

    case 'check':
      return (
        <div class="field field-inline">
          <input
            id={`${idp}-checked`}
            type="checkbox"
            checked={step.checked}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...step,
                checked: (e.target as HTMLInputElement).checked,
              })
            }
          />
          <label for={`${idp}-checked`}>Checked</label>
        </div>
      );

    case 'radio':
      return (
        <div class="field">
          <label for={`${idp}-value`}>Value</label>
          <input
            id={`${idp}-value`}
            type="text"
            placeholder="The value of the radio option to select"
            value={step.value}
            disabled={disabled}
            onInput={(e) =>
              onChange({
                ...step,
                value: (e.target as HTMLInputElement).value,
              })
            }
          />
        </div>
      );

    case 'contenteditable':
      return (
        <>
          <div class="field">
            <label for={`${idp}-html`}>Content</label>
            <textarea
              id={`${idp}-html`}
              rows={3}
              value={step.html}
              disabled={disabled}
              onInput={(e) =>
                onChange({
                  ...step,
                  html: (e.target as HTMLTextAreaElement).value,
                })
              }
            />
          </div>
          <div class="field field-inline">
            <input
              id={`${idp}-allowhtml`}
              type="checkbox"
              checked={step.allowHtml ?? false}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...step,
                  allowHtml: (e.target as HTMLInputElement).checked,
                })
              }
            />
            <label for={`${idp}-allowhtml`}>Allow HTML</label>
          </div>
        </>
      );
  }
}
