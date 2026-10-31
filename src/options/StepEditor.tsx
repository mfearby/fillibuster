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

import { useEffect, useRef, useState } from 'preact/hooks';

import { STEP_TYPE_LABELS } from '../core/schema';

import type {
  AutocompleteStep,
  ButtonStep,
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
  /**
   * When true, this step scrolls into view and focuses its first field on
   * mount — set by the parent for a freshly-added step so the cursor lands
   * where the user will type.
   */
  autoFocus?: boolean;
  onChange: (step: FieldStep) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  /** When provided, shows a "+" that inserts a new step directly below this one. */
  onAddAfter?: () => void;
  /** Ask "Delete this step?" inline before calling {@link StepEditorProps.onRemove}. */
  confirmRemove?: boolean;
  /**
   * Heading level for the step's "Step N" heading, so it nests under the
   * surrounding page's headings. Defaults to 4 (under the editor's "Steps" h3).
   */
  headingLevel?: 3 | 4;
  /** Called once the one-shot {@link StepEditorProps.autoFocus} has been honored. */
  onFocused?: () => void;
}

const STEP_TYPES: FieldStep['type'][] = [
  'text',
  'select',
  'check',
  'radio',
  'contenteditable',
  'autocomplete',
  'button',
];



/** Default wait (ms) for a newly-created autocomplete step. */
const DEFAULT_AUTOCOMPLETE_TIMEOUT_MS = 2000;

const SELECTOR_BYS: Selector['by'][] = ['id', 'name', 'label', 'css'];

/** Placeholder text for the target value input, per selector kind. */
function targetPlaceholder(by: Selector['by']): string {
  switch (by) {
    case 'id':
      return 'emailField  (or a comma list of fallback ids)';
    case 'name':
      return 'user[email]  (or a comma list of fallback names)';
    case 'label':
      return 'Mobile number  (the field\'s label text)';
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
    case 'label':
      return 'The field\'s label (aria-label, <label>, or a group\'s legend), ignoring case. Good when ids look random. If the full text matches nothing, it is tried as a comma list of fallbacks.';
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
    case 'autocomplete':
      return {
        ...base,
        type: 'autocomplete',
        value: '',
        optionTarget: { by: 'css', value: '[role="option"]' },
        optionMatch: '',
        timeoutMs: DEFAULT_AUTOCOMPLETE_TIMEOUT_MS,
      } satisfies AutocompleteStep;
    case 'button':
      return {
        ...base,
        type: 'button',
        matchBy: 'selector',
        text: '',
      } satisfies ButtonStep;
  }
}

export function StepEditor(props: StepEditorProps) {
  const {
    step,
    index,
    isFirst,
    isLast,
    disabled,
    autoFocus,
    onChange,
    onMoveUp,
    onMoveDown,
    onRemove,
    onAddAfter,
    confirmRemove,
    headingLevel,
    onFocused,
  } = props;

  const idp = `step-${index}`;

  // Accessible step heading: visually just the number, read as
  // "Step 2, text, Email field" (type, then the description when there is one).
  const Heading = `h${headingLevel ?? 4}` as 'h3' | 'h4';
  const headingId = `${idp}-heading`;
  const headingText = `Step ${index + 1}, ${STEP_TYPE_LABELS[step.type]}${
    step.label ? `, ${step.label}` : ''
  }`;

  // A button step matched by visible text ignores the target selector, so the
  // "Target by / Target value" row is hidden in that mode.
  const buttonByText = step.type === 'button' && (step.matchBy ?? 'selector') === 'text';

  const rowRef = useRef<HTMLLIElement>(null);
  const typeRef = useRef<HTMLSelectElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);

  // Inline delete confirmation (only used when `confirmRemove` is set).
  const [confirming, setConfirming] = useState(false);

  // Focus Delete when the confirmation opens, so the common case (the user
  // meant to delete) is one Enter away. Tab moves to Cancel.
  useEffect(() => {
    if (confirming) deleteRef.current?.focus();
  }, [confirming]);

  // When the parent adds this step, scroll it into view and focus its first
  // field (the Type selector) so typing can begin immediately. One-shot:
  // `onFocused` tells the parent to clear its request so a later re-render
  // doesn't re-scroll.
  useEffect(() => {
    if (!autoFocus) return;
    const row = rowRef.current;
    // `scrollIntoView` is absent in some environments (e.g. jsdom); guard it so
    // the focus still happens and tests don't throw.
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    typeRef.current?.focus();
    onFocused?.();
    // Run once on mount for an auto-focused step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateTarget(patch: Partial<Selector>) {
    onChange({ ...step, target: { ...step.target, ...patch } });
  }

  return (
    <li class="step-row" ref={rowRef}>
      {/* A named group, so a screen reader says e.g. "Step 2, text, group"
          when focus moves into this step. The heading also lists each step in
          VoiceOver's Rotor (VO+U) for jumping straight to it. */}
      <div role="group" aria-labelledby={headingId}>
      <div class="step-head">
        {/* tabIndex -1: focusable by script and by VoiceOver's cursor (with
            "keyboard focus follows VoiceOver cursor"), so after a Rotor jump
            to this heading the next Tab goes into this step. Not in the normal
            Tab order, so keyboard-only users are unaffected. */}
        <Heading class="step-num" id={headingId} tabIndex={-1}>
          {/* One hidden string carries the full spoken name, so it is read
              identically everywhere; the visible number is hidden from AT. */}
          <span class="visually-hidden">{headingText}</span>
          <span aria-hidden="true">{index + 1}</span>
        </Heading>

        <label class="step-type" for={`${idp}-type`}>
          <span>Type</span>
          <select
            id={`${idp}-type`}
            ref={typeRef}
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
                {STEP_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        <input
          class="step-description grow"
          type="text"
          placeholder="Description"
          aria-label={`Step ${index + 1} description`}
          value={step.label ?? ''}
          disabled={disabled}
          onInput={(e) =>
            onChange({
              ...step,
              label: (e.target as HTMLInputElement).value || undefined,
            })
          }
        />

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
          {onAddAfter ? (
            <button
              type="button"
              class="icon-button"
              disabled={disabled}
              aria-label={`Add step after step ${index + 1}`}
              title="Add step below"
              onClick={onAddAfter}
            >
              <span aria-hidden="true">+</span>
            </button>
          ) : null}
          <button
            type="button"
            class="icon-button danger"
            disabled={disabled}
            aria-label={`Remove step ${index + 1}`}
            title="Remove step"
            onClick={() => (confirmRemove ? setConfirming(true) : onRemove())}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </div>

      {confirming ? (
        <div
          class="step-confirm"
          role="group"
          aria-label={`Confirm removing step ${index + 1}`}
        >
          <span class="confirm-text">Delete this step?</span>
          <button
            type="button"
            class="danger"
            ref={deleteRef}
            disabled={disabled}
            onClick={() => {
              setConfirming(false);
              onRemove();
            }}
          >
            Delete
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {step.type === 'button' && (
        <div class="field">
          <label for={`${idp}-btn-matchby`}>Find button by</label>
          <select
            id={`${idp}-btn-matchby`}
            value={step.matchBy ?? 'selector'}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...step,
                matchBy: (e.target as HTMLSelectElement)
                  .value as ButtonStep['matchBy'],
              })
            }
          >
            <option value="selector">selector (id / name / css)</option>
            <option value="text">button text</option>
          </select>
        </div>
      )}

      {!buttonByText && (
      <div class="field-row target-row">
        <label class="field-inline-left" for={`${idp}-by`}>
          <span>Target by</span>
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
        </label>

        <div class="field grow">
          <label class="field-inline-left" for={`${idp}-target`}>
            <span>Target value</span>
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
          </label>
          <small id={`${idp}-target-hint`} class="field-hint muted">
            {targetHint(step.target.by)}
          </small>
        </div>
      </div>
      )}

      <StepTypeFields step={step} idp={idp} disabled={disabled} onChange={onChange} />
      </div>
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
          <label class="field-inline-left" for={`${idp}-value`}>
            <span>Value</span>
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
          </label>
        </div>
      );

    case 'select':
      return (
        <div class="field-row">
          <div class="field grow">
            <label class="field-inline-left" for={`${idp}-value`}>
              <span>Value</span>
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
            </label>
          </div>
          <label class="field-inline-left" for={`${idp}-matchby`}>
            <span>Match by</span>
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
          </label>
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
          <label class="field-inline-left" for={`${idp}-value`}>
            <span>Value</span>
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
          </label>
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

    case 'autocomplete':
      return (
        <>
          <div class="field">
            <label class="field-inline-left" for={`${idp}-value`}>
              <span>Text to type</span>
              <input
                id={`${idp}-value`}
                type="text"
                placeholder="e.g. 1600 Pennsylvania Ave"
                value={step.value}
                disabled={disabled}
                onInput={(e) =>
                  onChange({
                    ...step,
                    value: (e.target as HTMLInputElement).value,
                  })
                }
              />
            </label>
          </div>

          <div class="field-row">
            <label class="field-inline-left" for={`${idp}-opt-by`}>
              <span>Options by</span>
              <select
                id={`${idp}-opt-by`}
                value={step.optionTarget.by}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    ...step,
                    optionTarget: {
                      ...step.optionTarget,
                      by: (e.target as HTMLSelectElement).value as Selector['by'],
                    },
                  })
                }
              >
                {SELECTOR_BYS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>

            <div class="field grow">
              <label class="field-inline-left" for={`${idp}-opt-target`}>
                <span>Options selector</span>
                <input
                  id={`${idp}-opt-target`}
                  type="text"
                  placeholder='[role="option"]'
                  value={step.optionTarget.value}
                  disabled={disabled}
                  aria-describedby={`${idp}-opt-target-hint`}
                  onInput={(e) =>
                    onChange({
                      ...step,
                      optionTarget: {
                        ...step.optionTarget,
                        value: (e.target as HTMLInputElement).value,
                      },
                    })
                  }
                />
              </label>
              <div class="field-inline-hint">
                <span class="field-inline-spacer" aria-hidden="true">
                  Options selector
                </span>
                <small id={`${idp}-opt-target-hint`} class="field-hint muted">
                  Locates the rendered suggestion items that appear after typing.
                </small>
              </div>
            </div>
          </div>

          <div class="field-row">
            <div class="field grow">
              <label class="field-inline-left" for={`${idp}-opt-match`}>
                <span>Option text contains</span>
                <input
                  id={`${idp}-opt-match`}
                  type="text"
                  placeholder="Text of the option to click"
                  value={step.optionMatch}
                  disabled={disabled}
                  aria-describedby={`${idp}-opt-match-hint`}
                  onInput={(e) =>
                    onChange({
                      ...step,
                      optionMatch: (e.target as HTMLInputElement).value,
                    })
                  }
                />
              </label>
              <div class="field-inline-hint">
                <span class="field-inline-spacer" aria-hidden="true">
                  Option text contains
                </span>
                <small id={`${idp}-opt-match-hint`} class="field-hint muted">
                  Case-insensitive substring; the first matching option is clicked.
                </small>
              </div>
            </div>

            <label class="field-inline-left" for={`${idp}-timeout`}>
              <span>Wait (ms)</span>
              <input
                id={`${idp}-timeout`}
                class="timeout-input"
                type="number"
                min={0}
                step={100}
                value={step.timeoutMs}
                disabled={disabled}
                onInput={(e) => {
                  const n = Number((e.target as HTMLInputElement).value);
                  onChange({
                    ...step,
                    timeoutMs: Number.isFinite(n) && n >= 0 ? n : 0,
                  });
                }}
              />
            </label>
          </div>

          <div class="field field-inline">
            <input
              id={`${idp}-simulate-typing`}
              type="checkbox"
              checked={step.simulateTyping ?? false}
              disabled={disabled}
              aria-describedby={`${idp}-simulate-typing-hint`}
              onChange={(e) =>
                onChange({
                  ...step,
                  simulateTyping: (e.target as HTMLInputElement).checked,
                })
              }
            />
            <label for={`${idp}-simulate-typing`}>Simulate typing</label>
          </div>
          <small id={`${idp}-simulate-typing-hint`} class="field-hint muted">
            Types one character at a time (focus + key events). Enable if the
            field ignores the filled value and only reacts when you type by hand.
          </small>
        </>
      );

    case 'button': {
      // The "Find button by" selector is rendered above (next to Type/Label);
      // here we only render the mode-specific detail.
      const matchBy = step.matchBy ?? 'selector';
      return matchBy === 'text' ? (
        <div class="field">
          <label class="field-inline-left" for={`${idp}-btn-text`}>
            <span>Button text</span>
            <input
              id={`${idp}-btn-text`}
              type="text"
              placeholder="e.g. Accept, Submit, Continue"
              value={step.text ?? ''}
              disabled={disabled}
              aria-describedby={`${idp}-btn-text-hint`}
              onInput={(e) =>
                onChange({
                  ...step,
                  text: (e.target as HTMLInputElement).value,
                })
              }
            />
          </label>
          <small id={`${idp}-btn-text-hint`} class="field-hint muted">
            Matches the button's visible text exactly (case-insensitive).
          </small>
        </div>
      ) : (
        <small class="field-hint muted">
          The button is located using the Target above. Tip: React ids like{' '}
          <code>:r16:</code> work by id but change between renders — match by
          button text for stability.
        </small>
      );
    }
  }
}
