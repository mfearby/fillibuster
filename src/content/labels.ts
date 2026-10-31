/**
 * Label lookup shared by the fill executor (`Target by: label`) and capture.
 *
 * A control's "labels" are the human-readable names a person or screen reader
 * would use for it. We collect them from, in order:
 *
 *   1. `aria-label`
 *   2. `aria-labelledby` — the text of every referenced element, space-joined
 *   3. `<label for="id">` elements pointing at it
 *   4. a `<label>` wrapped around it (the control's own text is excluded)
 *   5. for a `<fieldset>`, its `<legend>` — so a radio group can be targeted by
 *      its question text
 *
 * This is a pragmatic subset of the full accessible-name algorithm: enough to
 * cover how real forms label fields, without trying to reproduce every rule.
 * Matching is exact after normalising case and whitespace.
 */

/** Elements that can be targeted by label: form controls and their ARIA kin. */
const LABELLED_CONTROLS = [
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'button',
  'fieldset',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[role="spinbutton"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="radiogroup"]',
  '[role="listbox"]',
  '[role="button"]',
].join(', ');

/** Collapse runs of whitespace and trim, so "  Mobile\n number " === "Mobile number". */
export function normalizeLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Lower-cased {@link normalizeLabel}, for comparisons. */
function labelKey(text: string): string {
  return normalizeLabel(text).toLowerCase();
}

/**
 * Every non-empty label of `el`, normalised, in the order listed in the module
 * comment. The first entry is the "primary" label capture suggests.
 */
export function labelsOf(el: Element): string[] {
  const doc = el.ownerDocument;
  const out: string[] = [];
  const add = (text: string | null | undefined) => {
    const t = normalizeLabel(text ?? '');
    if (t && !out.includes(t)) out.push(t);
  };

  add(el.getAttribute('aria-label'));

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy && doc) {
    const text = labelledBy
      .split(/\s+/)
      .map((ref) => doc.getElementById(ref)?.textContent ?? '')
      .join(' ');
    add(text);
  }

  const id = el.getAttribute('id');
  if (id && doc) {
    for (const label of Array.from(doc.querySelectorAll('label'))) {
      if (label.getAttribute('for') === id) add(textWithoutControls(label));
    }
  }

  const wrapping = el.closest('label');
  if (wrapping && wrapping !== el) add(textWithoutControls(wrapping));

  if (el.tagName.toLowerCase() === 'fieldset') {
    const legend = el.querySelector(':scope > legend');
    if (legend) add(legend.textContent);
  }

  return out;
}

/**
 * A label's text with any form controls inside it removed — otherwise a label
 * wrapping a `<select>` would include every option's text.
 */
function textWithoutControls(label: Element): string {
  const copy = label.cloneNode(true) as Element;
  for (const control of Array.from(
    copy.querySelectorAll('input, select, textarea, button'),
  )) {
    control.remove();
  }
  return copy.textContent ?? '';
}

/** Every labelled control in `root` (document order) with a label equal to `label`. */
export function findAllByLabel(
  label: string,
  root: Document | Element,
): Element[] {
  const want = labelKey(label);
  if (!want) return [];
  return Array.from(root.querySelectorAll(LABELLED_CONTROLS)).filter((el) =>
    labelsOf(el).some((l) => labelKey(l) === want),
  );
}

/**
 * Resolve a `Target by: label` value to its matching controls.
 *
 * The whole value is tried first, because labels can contain commas ("Phone,
 * mobile"). Only if that matches nothing is it treated as a comma-separated
 * fallback list, tried in order with the first label that matches anything
 * winning — the same fallback behaviour as `id` and `name`.
 */
export function resolveAllByLabel(
  value: string,
  root: Document | Element,
): Element[] {
  const whole = findAllByLabel(value, root);
  if (whole.length > 0 || !value.includes(',')) return whole;

  for (const candidate of value.split(',')) {
    const found = findAllByLabel(candidate, root);
    if (found.length > 0) return found;
  }
  return [];
}
