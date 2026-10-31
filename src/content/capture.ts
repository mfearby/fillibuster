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
 *   1. `id`    — when the element has a non-empty, unique `id`.
 *   2. `name`  — when the element has a non-empty, unique `name`.
 *   3. `label` — when one of its labels identifies it uniquely.
 *   4. `css`   — a path built from a unique stable attribute where possible, or
 *                an `nth-of-type` positional path as a last resort. Only the
 *                positional fallback is considered fragile.
 *
 * Ids and names that look generated at runtime (random numbers, UUIDs, React
 * `useId`, UI-library counters) are never used. When the id is skipped, the
 * label is tried before the name, and the candidate carries a `note` saying so.
 *
 * Requirements: 2.2, 2.3, 2.4, 2.6
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
import { findAllByLabel, labelsOf } from './labels';

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
  /**
   * Why capture chose a different target than the obvious one — e.g. the id
   * looked auto-generated, so the field is targeted by its label instead.
   * Shown to the developer on the review screen.
   */
  note?: string;
}

/**
 * Patterns for ids/names that are generated at runtime and so change between
 * page loads or renders — never safe to save in a config.
 */
const GENERATED_PATTERNS: RegExp[] = [
  // A long run of digits: Math.random() ("…-0.8075095940726259"), timestamps,
  // big counters.
  /\d{6,}/,
  // UUIDs.
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  // React useId(): ":r16:" (React 18) and "«r1»" (React 19).
  /^:[a-z0-9]+:$/i,
  /^«[a-z0-9]+»$/i,
  // A long hex-looking run mixing digits and letters ("input-a3f9c2e1b4").
  /(?:^|[^0-9a-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{10,}(?:$|[^0-9a-z])/i,
  // Prefixes UI libraries use for per-render counters ("mui-12",
  // "react-select-3-input", "headlessui-listbox-button-5", "radix-:r1:").
  /^(?:mui-|radix-|headlessui-|react-select-|downshift-|ember\d|rc[-_]|ext-gen|yui_)/i,
];

/** True when an id/name looks generated at runtime and so unstable. */
export function looksGenerated(value: string): boolean {
  return GENERATED_PATTERNS.some((re) => re.test(value));
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

/** Checkbox inputs map to a {@link CheckStep} (Req 3.3). */
const CHECKBOX_INPUT_TYPES = new Set(['checkbox']);

/** How we classify a candidate control into a step type. */
type ControlKind =
  | 'text'
  | 'select'
  | 'check'
  | 'radio'
  | 'contenteditable'
  | null;

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

  // Radio groups span multiple members sharing a `name`; emit each group once
  // (at its first member's position) rather than one candidate per button.
  const seenRadioGroups = new Set<string>();

  for (const el of Array.from(elements)) {
    const kind = classify(el);
    if (!kind) continue;

    if (kind === 'radio') {
      const name = el.getAttribute('name');
      if (name) {
        if (seenRadioGroups.has(name)) continue;
        seenRadioGroups.add(name);
      }
    }

    const { selector, fragile, note } = deriveRadioSelector(el, kind, doc);
    const step = buildStep(el, kind, selector);
    if (!step) continue;

    const candidate: CaptureCandidate = { step, fragile };
    if (note) candidate.note = note;
    candidates.push(candidate);
  }

  return candidates;
}

/**
 * Selector derivation that special-cases named radio groups. A radio group's
 * `name` is intentionally shared across members, so the usual uniqueness check
 * in {@link deriveSelector} would reject it; targeting the group `by: "name"`
 * is the correct, stable locator. Unnamed radios and all other controls fall
 * through to {@link deriveSelector}.
 */
function deriveRadioSelector(
  el: Element,
  kind: ControlKind,
  root: Document | Element,
): DerivedSelector {
  if (kind === 'radio') {
    const name = el.getAttribute('name');
    if (name) {
      return { selector: { by: 'name', value: name }, fragile: false };
    }
  }
  return deriveSelector(el, root);
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
  if (type === 'radio') return 'radio';
  if (CHECKBOX_INPUT_TYPES.has(type)) return 'check';
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

/** A derived selector, its fragility, and an optional explanation for the UI. */
export interface DerivedSelector {
  selector: Selector;
  fragile: boolean;
  note?: string;
}

/**
 * Derive the most stable selector for `el` and whether it is fragile (Req 2.3,
 * 2.6).
 *
 * Normal preference: unique `id` → unique `name` → unique label → a CSS path.
 * The CSS path first tries a unique stable attribute; failing that it builds an
 * `nth-of-type` positional path, which is the only case flagged fragile.
 *
 * Ids and names that look generated at runtime ({@link looksGenerated}) are
 * skipped. When the id was skipped, the label is preferred over the name: a
 * page that generates ids is often a component library whose names are generic
 * too (`name="number"`), while the label is what a person reads. A `note`
 * explains the choice.
 */
export function deriveSelector(
  el: Element,
  root: Document | Element = ownerDocument(el),
): DerivedSelector {
  const id = el.getAttribute('id');
  const idGenerated = !!id && looksGenerated(id);
  if (id && !idGenerated && isUnique(root, `#${cssEscape(id)}`)) {
    return { selector: { by: 'id', value: id }, fragile: false };
  }

  const name = el.getAttribute('name');
  const nameGenerated = !!name && looksGenerated(name);
  const nameUsable =
    !!name && !nameGenerated && isUnique(root, `[name="${cssAttrEscape(name)}"]`);
  const label = uniqueLabel(el, root);

  // Explain whatever we end up choosing when an obvious id/name was skipped.
  const skipped = idGenerated
    ? `Its id "${id}" looks auto-generated`
    : nameGenerated
      ? `Its name "${name}" looks auto-generated`
      : null;
  const because = (target: string) =>
    skipped ? { note: `${skipped}, so it is targeted by ${target} instead.` } : {};

  if (idGenerated && label) {
    return { selector: { by: 'label', value: label }, fragile: false, ...because('its label') };
  }
  if (nameUsable) {
    return { selector: { by: 'name', value: name! }, fragile: false, ...because('its name') };
  }
  if (label) {
    return { selector: { by: 'label', value: label }, fragile: false, ...because('its label') };
  }

  // Try a unique stable attribute (test hooks, placeholders, etc.) before
  // resorting to a positional path.
  const stable = stableAttributeSelector(el, root);
  if (stable) {
    return {
      selector: { by: 'css', value: stable },
      fragile: false,
      ...because('a CSS selector'),
    };
  }

  // Last resort: an nth-of-type positional path. This is brittle — page layout
  // changes break it — so it is flagged fragile (Req 2.6).
  return {
    selector: { by: 'css', value: positionalPath(el) },
    fragile: true,
    ...because('its position on the page'),
  };
}

/**
 * The first of `el`'s labels that identifies it uniquely on the page, or `null`
 * when it has no label or every label is shared with another control.
 */
function uniqueLabel(el: Element, root: Document | Element): string | null {
  for (const label of labelsOf(el)) {
    const matches = findAllByLabel(label, root);
    if (matches.length === 1 && matches[0] === el) return label;
  }
  return null;
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

    // Stop once we can anchor at an element with a stable id — that shortens
    // and stabilizes the path. A generated id would make the path break.
    const parentId = parent?.getAttribute('id');
    if (parent && parentId && !looksGenerated(parentId)) {
      segments.unshift(`#${cssEscape(parentId)}`);
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
    case 'radio': {
      // Default to the currently-checked member of the group, so re-filling
      // reproduces the page's initial selection (Req 2.4).
      const value = checkedRadioValue(el);
      const step: RadioStep = { id, type: 'radio', target: selector, value };
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
 * The `value` of the currently-checked member of `el`'s radio group, or `''`
 * when none is checked. Looks across the whole group (members sharing a
 * `name`) so capture records the group's selection regardless of which member
 * the scan reached first.
 */
function checkedRadioValue(el: Element): string {
  const input = el as HTMLInputElement;
  const name = input.getAttribute('name');
  const doc = ownerDocument(el);
  if (name && doc) {
    const members = doc.querySelectorAll<HTMLInputElement>(
      `input[type="radio"][name="${cssAttrEscape(name)}"]`,
    );
    for (const member of Array.from(members)) {
      if (member.checked) return member.value;
    }
    return '';
  }
  return input.checked ? input.value : '';
}

/**
 * Best-effort human label for the editor: an associated `<label>`, else the
 * `aria-label`, `placeholder`, or `name`. Purely informational.
 */
function deriveLabel(el: Element): string | undefined {
  // Prefer a real label (aria-label, aria-labelledby, <label>), shared with
  // `Target by: label` so the description matches what the field is called.
  const label = labelsOf(el)[0];
  if (label) return label;

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
