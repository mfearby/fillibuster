/**
 * Fillibuster assisted-capture scanner.
 *
 * Runs in the content script (page context). Given a DOM root, it scans for
 * fillable controls, derives the most stable {@link Selector} for each
 * (Req 2.3), reads the control's current value/checked/selected state as the
 * default (Req 2.4), maps the control to the matching {@link FieldStep} type
 * (Req 2.2), and flags controls where only a fragile positional selector could
 * be built (Req 2.6).
 *
 * Capture is a pure read of the DOM: it never mutates the page and never saves.
 * It returns {@link CaptureCandidate}s to the UI, which prunes/edits them before
 * anything is persisted (Req 2.5, handled later in task 12.3).
 *
 * Selector preference (Req 2.3):
 *   1. `id`   — when the element has a non-empty, unique `id`.
 *   2. `name` — when the element has a non-empty, unique `name`.
 *   3. `css`  — a path built from a unique stable attribute where possible, or
 *               an `nth-of-type` positional path as a last resort. Only the
 *               positional fallback is considered fragile.
 *
 * Requirements: 2.2, 2.3, 2.4, 2.6
 */

import type {
  CheckStep,
  ContentEditableStep,
  FieldStep,
  Selector,
  SelectStep,
  TextStep,
} from '../core/schema';

/**
 * A single capture result: the candidate step plus capture metadata. The UI
 * later reviews/edits these before saving; capture itself never persists.
 */
export interface CaptureCandidate {
  /** The pre-populated step (with a generated id and a best-effort label). */
  step: FieldStep;
  /**
   * True when only a fragile (positional / `nth-of-type`) selector could be
   * built, so the UI can prompt the developer to fix or remove it (Req 2.6).
   */
  fragile: boolean;
}

/**
 * `input[type=…]` values that hold a fillable free-text value (Req 2.2). Types
 * like `submit`, `button`, `reset`, `image`, `file`, and `hidden` are skipped
 * because they are not fillable in the text/value sense.
 */
const FILLABLE_TEXT_INPUT_TYPES = new Set([
  'text',
  'email',
  'tel',
  'url',
  'search',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
  'color',
  'range',
  // A bare/unknown type defaults to text; handled in `inputKind` below.
]);

/** Input types treated as checkable (checkbox / radio) (Req 3.3). */
const CHECKABLE_INPUT_TYPES = new Set(['checkbox', 'radio']);

/** How we classify a candidate control into a step type. */
type ControlKind = 'text' | 'select' | 'check' | 'contenteditable' | null;

/**
 * Scan `root` for fillable controls and return capture candidates (Req 2.2).
 *
 * `root` is injectable so capture can be exercised against a jsdom fixture in
 * tests; in production it operates on the page `document`.
 */
export function capturePage(
  root: Document | Element = document,
): CaptureCandidate[] {
  const doc = ownerDocument(root);
  const candidates: CaptureCandidate[] = [];

  const elements = root.querySelectorAll<HTMLElement>(
    'input, textarea, select, [contenteditable]',
  );

  for (const el of Array.from(elements)) {
    const kind = classify(el);
    if (!kind) continue;

    const { selector, fragile } = deriveSelector(el, doc);
    const step = buildStep(el, kind, selector);
    if (!step) continue;

    candidates.push({ step, fragile });
  }

  return candidates;
}

/**
 * Classify an element into a {@link ControlKind}, or `null` if it is not a
 * fillable control we support (Req 2.2). Hidden and non-fillable input types are
 * skipped here.
 */
function classify(el: Element): ControlKind {
  const tag = el.tagName.toLowerCase();

  if (tag === 'textarea') return 'text';
  if (tag === 'select') return 'select';

  if (tag === 'input') {
    return inputKind(el as HTMLInputElement);
  }

  // Anything else is only a candidate when it is actively contenteditable.
  if (isContentEditable(el)) return 'contenteditable';

  return null;
}

/** Classify an `<input>` by its (normalized) `type` attribute. */
function inputKind(input: HTMLInputElement): ControlKind {
  // `type` reflects to the IDL property, which normalizes unknown/absent to
  // "text"; read the attribute so a missing type is treated as text too.
  const type = (input.getAttribute('type') ?? 'text').toLowerCase();

  if (type === 'hidden') return null;
  if (CHECKABLE_INPUT_TYPES.has(type)) return 'check';
  if (FILLABLE_TEXT_INPUT_TYPES.has(type)) return 'text';

  // Non-fillable button-like types are skipped.
  if (type === 'submit' || type === 'button' || type === 'reset' ||
      type === 'image' || type === 'file') {
    return null;
  }

  // Unknown types render as a text field, so treat them as text.
  return 'text';
}

/**
 * True when an element opts into contenteditable. `[contenteditable]` matches
 * the attribute regardless of value, so exclude the explicit `"false"` opt-out.
 */
function isContentEditable(el: Element): boolean {
  const attr = el.getAttribute('contenteditable');
  if (attr === null) return false;
  return attr.toLowerCase() !== 'false';
}

/**
 * Derive the most stable selector for `el` and whether it is fragile (Req 2.3,
 * 2.6).
 *
 * Preference: unique `id` → unique `name` → a CSS path. The CSS path first
 * tries a unique stable attribute; failing that it builds an `nth-of-type`
 * positional path, which is the only case flagged fragile.
 */
export function deriveSelector(
  el: Element,
  root: Document | Element = ownerDocument(el),
): { selector: Selector; fragile: boolean } {
  const id = el.getAttribute('id');
  if (id && isUnique(root, `#${cssEscape(id)}`)) {
    return { selector: { by: 'id', value: id }, fragile: false };
  }

  const name = el.getAttribute('name');
  if (name && isUnique(root, `[name="${cssAttrEscape(name)}"]`)) {
    return { selector: { by: 'name', value: name }, fragile: false };
  }

  // Try a unique stable attribute (test hooks, ARIA labels, etc.) before
  // resorting to a positional path.
  const stable = stableAttributeSelector(el, root);
  if (stable) {
    return { selector: { by: 'css', value: stable }, fragile: false };
  }

  // Last resort: an nth-of-type positional path. This is brittle — page layout
  // changes break it — so it is flagged fragile (Req 2.6).
  return {
    selector: { by: 'css', value: positionalPath(el) },
    fragile: true,
  };
}

/**
 * Build a stable, unique CSS selector from a single distinctive attribute
 * (e.g. `data-testid`, `aria-label`, `placeholder`), or `null` if none uniquely
 * identifies the element.
 */
function stableAttributeSelector(
  el: Element,
  root: Document | Element,
): string | null {
  const tag = el.tagName.toLowerCase();
  const stableAttrs = [
    'data-testid',
    'data-test',
    'data-qa',
    'aria-label',
    'placeholder',
    'autocomplete',
    'title',
  ];

  for (const attr of stableAttrs) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    const selector = `${tag}[${attr}="${cssAttrEscape(value)}"]`;
    if (isUnique(root, selector)) return selector;
  }

  return null;
}

/**
 * Build a positional CSS path from the element up toward the root, using
 * `:nth-of-type` at each level. Fragile by nature (Req 2.6).
 */
function positionalPath(el: Element): string {
  const segments: string[] = [];
  let current: Element | null = el;

  while (current && current.nodeType === 1 && current.tagName.toLowerCase() !== 'html') {
    const tag = current.tagName.toLowerCase();
    const index = nthOfTypeIndex(current);
    segments.unshift(index > 0 ? `${tag}:nth-of-type(${index})` : tag);

    const parent: Element | null = current.parentElement;
    // Stop once we can anchor at an element with an id — that shortens and
    // stabilizes the path.
    if (parent && parent.getAttribute('id')) {
      segments.unshift(`#${cssEscape(parent.getAttribute('id') as string)}`);
      return segments.join(' > ');
    }
    current = parent;
  }

  return segments.join(' > ');
}

/** 1-based index of `el` among siblings sharing its tag, for `:nth-of-type`. */
function nthOfTypeIndex(el: Element): number {
  const parent = el.parentElement;
  if (!parent) return 0;
  const tag = el.tagName;
  let index = 0;
  for (const sibling of Array.from(parent.children)) {
    if (sibling.tagName === tag) {
      index++;
      if (sibling === el) return index;
    }
  }
  return index;
}

/** True when `selector` matches exactly one element within `root`. */
function isUnique(root: Document | Element, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    // An invalid selector can't be relied upon as a stable locator.
    return false;
  }
}

/**
 * Build a {@link FieldStep} for `el` given its classified `kind` and derived
 * `selector`, reading current state as the default value (Req 2.4). Returns
 * `null` if a step cannot be built.
 */
function buildStep(
  el: Element,
  kind: ControlKind,
  selector: Selector,
): FieldStep | null {
  const id = generateId();
  const label = deriveLabel(el);

  switch (kind) {
    case 'text': {
      const value = (el as HTMLInputElement | HTMLTextAreaElement).value ?? '';
      const step: TextStep = { id, type: 'text', target: selector, value };
      if (label) step.label = label;
      return step;
    }
    case 'select': {
      const select = el as HTMLSelectElement;
      const selected = select.options[select.selectedIndex];
      const value = selected ? selected.value : '';
      const step: SelectStep = {
        id,
        type: 'select',
        target: selector,
        value,
        matchBy: 'value',
      };
      if (label) step.label = label;
      return step;
    }
    case 'check': {
      const step: CheckStep = {
        id,
        type: 'check',
        target: selector,
        checked: (el as HTMLInputElement).checked,
      };
      if (label) step.label = label;
      return step;
    }
    case 'contenteditable': {
      const step: ContentEditableStep = {
        id,
        type: 'contenteditable',
        target: selector,
        html: el.innerHTML,
      };
      if (label) step.label = label;
      return step;
    }
    default:
      return null;
  }
}

/**
 * Best-effort human label for the editor: an associated `<label>`, else the
 * `aria-label`, `placeholder`, or `name`. Purely informational.
 */
function deriveLabel(el: Element): string | undefined {
  const id = el.getAttribute('id');
  const doc = ownerDocument(el);
  if (id && doc) {
    const label = doc.querySelector(`label[for="${cssAttrEscape(id)}"]`);
    const text = label?.textContent?.trim();
    if (text) return text;
  }

  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria;

  const placeholder = el.getAttribute('placeholder')?.trim();
  if (placeholder) return placeholder;

  const name = el.getAttribute('name')?.trim();
  if (name) return name;

  return undefined;
}

/** The owning document of a node, falling back to the ambient `document`. */
function ownerDocument(node: Document | Element): Document {
  if (typeof (node as Document).querySelectorAll === 'function' &&
      (node as Document).nodeType === 9) {
    return node as Document;
  }
  return (node as Element).ownerDocument ?? document;
}

/**
 * Generate a stable unique id for a candidate step. Uses `crypto.randomUUID`
 * when available (jsdom/Node both provide it), else a timestamp+random
 * fallback.
 */
function generateId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return `cand-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Minimal CSS identifier escape for building an `#id` selector, mirroring the
 * fill executor's helper. Uses native `CSS.escape` when available.
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
