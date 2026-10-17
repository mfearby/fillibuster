/**
 * Fillibuster fill executor.
 *
 * Runs in the content script (page context). Given an ordered list of
 * {@link FieldStep}s and an error strategy, it resolves each step's target
 * element, applies the value per control type, and dispatches the native
 * `input`/`change`/`click` events that framework-bound forms (React, Vue,
 * Angular) listen for (Req 5b.1, 5b.2). It returns a per-step result list and a
 * summary so the popup can report which steps succeeded and which failed
 * (Req 5.4, 9.1).
 *
 * The key subtlety (Req 5b.1): React installs a value tracker on inputs and
 * ignores plain `element.value = x` assignments. Setting the value through the
 * prototype's native setter (`Object.getOwnPropertyDescriptor(
 * HTMLInputElement.prototype, 'value').set`) bypasses React's overridden
 * instance property so the subsequent `input` event is seen as a real change.
 *
 * Error strategy (Req 9.2, 9.3): `stop` halts at the first failed step and
 * leaves the remaining steps un-attempted; `continue` attempts every step and
 * reports the failures in the summary.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 5.3, 5.4, 5.5, 5b.1, 5b.2, 9.1, 9.2, 9.3
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

/** Outcome of applying a single step. */
export interface StepResult {
  /** Zero-based index of the step in the input list. */
  index: number;
  /** Whether the step was applied successfully. */
  ok: boolean;
  /** Human-readable reason when `ok` is false (Req 9.1). */
  reason?: string;
}

/** Aggregate outcome of a fill run (Req 5.4, 9.1). */
export interface FillSummary {
  total: number;
  succeeded: number;
  failed: number;
  results: StepResult[];
}

export type ErrorStrategy = 'stop' | 'continue';

/** Reason string recorded when a target element cannot be resolved. */
export const NOT_FOUND_REASON = 'element not found';

/**
 * Resolve a {@link Selector} to an element within `root`, following the capture
 * preference order (Req 2.3): `id` → `name` → `css`.
 *
 * `getElementById`/`getElementsByName` live on `Document`, so when `root` is an
 * element (or otherwise lacks them) we fall back to attribute-based
 * `querySelector` lookups that behave equivalently.
 *
 * Fallback lists (`id` and `name` only): the value may be a comma-separated
 * list of candidates, tried IN LIST ORDER with the first present element
 * winning. This lets one step target pages that use different ids/names for the
 * same logical control — e.g. a Yes/No radio whose id varies across otherwise
 * identical pages — without writing CSS. A value with no comma is a single
 * candidate and behaves exactly as before. `css` is left untouched: it already
 * supports comma lists natively (though matched in document, not list, order).
 */
export function resolveTarget(
  selector: Selector,
  root: Document | Element,
): Element | null {
  switch (selector.by) {
    case 'id': {
      for (const value of splitCandidates(selector.value)) {
        const el =
          typeof (root as Document).getElementById === 'function'
            ? (root as Document).getElementById(value)
            : (root as Element).querySelector(`#${cssEscape(value)}`);
        if (el) return el;
      }
      return null;
    }
    case 'name': {
      for (const value of splitCandidates(selector.value)) {
        const el =
          typeof (root as Document).getElementsByName === 'function'
            ? ((root as Document).getElementsByName(value)[0] ?? null)
            : (root as Element).querySelector(
                `[name="${cssAttrEscape(value)}"]`,
              );
        if (el) return el;
      }
      return null;
    }
    case 'css':
      return root.querySelector(selector.value);
    default:
      // Unknown selector kind — treat as unresolvable rather than throwing.
      return null;
  }
}

/**
 * Split an `id`/`name` selector value into ordered candidates on commas,
 * trimming each and dropping empties. A value without a comma yields a single
 * candidate, so the common single-id/name case is unchanged. (Literal commas in
 * an id/name attribute are effectively nonexistent in real HTML, so comma is
 * always treated as the separator.)
 */
function splitCandidates(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Apply an ordered list of steps against `root` (defaults to the ambient
 * `document`), honoring `errorStrategy`, and return a {@link FillSummary}.
 *
 * `root` is injectable so the executor can be exercised against a jsdom fixture
 * in tests; in production it operates on the page `document`.
 */
export function applySteps(
  steps: FieldStep[],
  errorStrategy: ErrorStrategy,
  root: Document | Element = document,
): FillSummary {
  const results: StepResult[] = [];

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (!step) continue;
    const result = applyStep(step, index, root);
    results.push(result);

    if (!result.ok && errorStrategy === 'stop') {
      // Halt immediately; remaining steps are not attempted (Req 9.2).
      break;
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return {
    total: steps.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

/** Apply a single step, catching any DOM error into a failure result. */
function applyStep(
  step: FieldStep,
  index: number,
  root: Document | Element,
): StepResult {
  const el = resolveTarget(step.target, root);
  if (!el) {
    return { index, ok: false, reason: NOT_FOUND_REASON };
  }

  try {
    switch (step.type) {
      case 'text':
        applyText(el, step);
        break;
      case 'select':
        return applySelect(el, step, index);
      case 'check':
        applyCheck(el, step);
        break;
      case 'radio':
        return applyRadio(el, step, index, root);
      case 'contenteditable':
        applyContentEditable(el, step);
        break;
      default:
        return {
          index,
          ok: false,
          reason: `unsupported step type: ${(step as FieldStep).type}`,
        };
    }
    return { index, ok: true };
  } catch (err) {
    return { index, ok: false, reason: describeError(err) };
  }
}

/**
 * text (Req 3.1, 5b.1): set the value via the native prototype setter so
 * React's value tracker registers the change, then dispatch `input` and
 * `change` (both bubbling).
 */
function applyText(el: Element, step: TextStep): void {
  setNativeValue(el, step.value);
  dispatchInput(el);
  dispatchChange(el);
}

/**
 * select (Req 3.2): find the matching `<option>` by value or visible text,
 * point the select at it, and dispatch `change`.
 */
function applySelect(el: Element, step: SelectStep, index: number): StepResult {
  const select = el as HTMLSelectElement;
  const options = Array.from(select.options);
  const optionIndex = options.findIndex((opt) =>
    step.matchBy === 'text'
      ? optionText(opt) === step.value
      : opt.value === step.value,
  );

  if (optionIndex === -1) {
    return {
      index,
      ok: false,
      reason: `no option matching ${step.matchBy} "${step.value}"`,
    };
  }

  select.selectedIndex = optionIndex;
  // Keep `.value` in sync for callers that read it directly.
  const matched = options[optionIndex];
  if (matched) select.value = matched.value;
  dispatchChange(select);
  return { index, ok: true };
}

/**
 * check (Req 3.3, 5b.2): set `.checked` and dispatch `click` and `change` so
 * both native handlers and framework bindings observe the toggle.
 */
function applyCheck(el: Element, step: CheckStep): void {
  const input = el as HTMLInputElement;
  input.checked = step.checked;
  dispatchEvent(input, 'click');
  dispatchChange(input);
}

/**
 * radio (Req 3.3): select the group member whose `value` matches `step.value`,
 * mirroring {@link applySelect}.
 *
 * `resolveTarget` returns a single element, but a radio group spans every
 * member sharing a `name`. We collect the whole group — by `name` when the
 * resolved element has one (the usual case), else just the resolved element —
 * then check the matching member and clear its siblings. The browser deselects
 * siblings automatically when the matched member is clicked, but we clear them
 * explicitly so the result is deterministic under jsdom. `click` and `change`
 * fire on the matched member so native and framework handlers observe it.
 */
function applyRadio(
  el: Element,
  step: RadioStep,
  index: number,
  root: Document | Element,
): StepResult {
  const resolved = el as HTMLInputElement;
  const group = radioGroup(resolved, root);

  const match = group.find((r) => r.value === step.value);
  if (!match) {
    return {
      index,
      ok: false,
      reason: `no radio option matching value "${step.value}"`,
    };
  }

  for (const member of group) {
    member.checked = member === match;
  }
  dispatchEvent(match, 'click');
  dispatchChange(match);
  return { index, ok: true };
}

/**
 * Collect every member of `el`'s radio group. Members share a `name`; when
 * `el` has one we look the group up within `root`, otherwise the group is just
 * `el` itself (an unnamed radio).
 */
function radioGroup(
  el: HTMLInputElement,
  root: Document | Element,
): HTMLInputElement[] {
  const name = el.getAttribute('name');
  if (!name) return [el];
  const selector = `input[type="radio"][name="${cssAttrEscape(name)}"]`;
  const found = Array.from(
    root.querySelectorAll<HTMLInputElement>(selector),
  );
  return found.length > 0 ? found : [el];
}

/**
 * contenteditable (Req 3.4): focus, set `textContent` (or `innerHTML` when the
 * step opts into HTML), and dispatch `input`.
 */
function applyContentEditable(el: Element, step: ContentEditableStep): void {
  if (typeof (el as HTMLElement).focus === 'function') {
    (el as HTMLElement).focus();
  }
  if (step.allowHtml) {
    el.innerHTML = step.html;
  } else {
    el.textContent = step.html;
  }
  dispatchInput(el);
}

/**
 * Set an input/textarea value through the native prototype setter, bypassing an
 * instance-level `value` override (as React installs) so the value tracker sees
 * the mutation (Req 5b.1).
 */
function setNativeValue(el: Element, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    // Fallback for element types without a prototype value setter.
    (el as HTMLInputElement | HTMLTextAreaElement).value = value;
  }
}

/** The visible text of an option, trimmed to match what a user would read. */
function optionText(opt: HTMLOptionElement): string {
  return (opt.textContent ?? '').trim();
}

function dispatchInput(el: Element): void {
  dispatchEvent(el, 'input');
}

function dispatchChange(el: Element): void {
  dispatchEvent(el, 'change');
}

function dispatchEvent(el: Element, type: string): void {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Minimal CSS identifier escape for building an `#id` selector. Uses the native
 * `CSS.escape` when available, else escapes a conservative set of characters.
 */
function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (css && typeof css.escape === 'function') {
    return css.escape(value);
  }
  return value.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}

/** Escape a value for use inside a double-quoted attribute selector. */
function cssAttrEscape(value: string): string {
  return value.replace(/(["\\])/g, '\\$1');
}
