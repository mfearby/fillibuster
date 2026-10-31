/**
 * DOM tests for assisted capture, run under the jsdom Vitest project.
 *
 * Covers the selector preference order (id → name → css, Req 2.3), reading the
 * current value/checked/selected state as the default (Req 2.4), classifying
 * each control into the right step type (Req 2.2), and the fragile flag being
 * set only when a positional CSS fallback is used and cleared when a stable
 * id/name/attribute exists (Req 2.6).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type {
  CheckStep,
  ContentEditableStep,
  RadioStep,
  SelectStep,
  TextStep,
} from '../core/schema';
import {
  type CaptureCandidate,
  capturePage,
  deriveSelector,
  looksGenerated,
} from './capture';

/** Replace the document body with `html` and return it. */
function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/** The single candidate produced for a one-control fixture. */
function only(candidates: CaptureCandidate[]): CaptureCandidate {
  expect(candidates).toHaveLength(1);
  return candidates[0] as CaptureCandidate;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('deriveSelector — preference order (Req 2.3)', () => {
  it('prefers id over name and css', () => {
    mount('<input id="theId" name="theName" placeholder="p" />');
    const el = document.getElementById('theId') as HTMLInputElement;
    const { selector, fragile } = deriveSelector(el, document);
    expect(selector).toEqual({ by: 'id', value: 'theId' });
    expect(fragile).toBe(false);
  });

  it('falls back to name when there is no id', () => {
    mount('<input name="theName" placeholder="p" />');
    const el = document.getElementsByName('theName')[0] as HTMLInputElement;
    const { selector, fragile } = deriveSelector(el, document);
    expect(selector).toEqual({ by: 'name', value: 'theName' });
    expect(fragile).toBe(false);
  });

  it('uses a stable attribute css path when there is no id or name', () => {
    mount('<input data-testid="email-field" type="email" />');
    const el = document.querySelector('input') as HTMLInputElement;
    const { selector, fragile } = deriveSelector(el, document);
    expect(selector.by).toBe('css');
    expect(selector.value).toBe('input[data-testid="email-field"]');
    expect(fragile).toBe(false);
  });

  it('falls back to a positional css path and flags it fragile (Req 2.6)', () => {
    mount(`
      <div>
        <input type="text" />
        <input type="text" />
      </div>
    `);
    const el = document.querySelectorAll('input')[1] as HTMLInputElement;
    const { selector, fragile } = deriveSelector(el, document);
    expect(selector.by).toBe('css');
    expect(selector.value).toContain('nth-of-type');
    expect(fragile).toBe(true);
    // The derived positional selector actually resolves back to the element.
    expect(document.querySelector(selector.value)).toBe(el);
  });

  it('ignores a non-unique id and name and treats them as unstable', () => {
    // Two elements sharing an id/name: neither uniquely identifies the target.
    mount(`
      <input id="dup" name="dupname" type="text" />
      <input id="dup" name="dupname" type="text" />
    `);
    const el = document.querySelectorAll('input')[1] as HTMLInputElement;
    const { selector } = deriveSelector(el, document);
    expect(selector.by).toBe('css');
  });
});

describe('capturePage — classification (Req 2.2)', () => {
  it('captures text inputs, textareas, selects, checks, and contenteditable', () => {
    mount(`
      <input id="name" type="text" />
      <textarea id="bio"></textarea>
      <select id="state"><option value="ca">CA</option></select>
      <input id="agree" type="checkbox" />
      <div id="notes" contenteditable="true"></div>
    `);
    const candidates = capturePage(document);
    const types = candidates.map((c) => c.step.type).sort();
    expect(types).toEqual(['check', 'contenteditable', 'select', 'text', 'text']);
  });

  it('skips hidden, submit, button, reset, file, and image inputs', () => {
    mount(`
      <input type="hidden" name="csrf" value="x" />
      <input type="submit" value="Go" />
      <input type="button" value="Click" />
      <input type="reset" value="Reset" />
      <input type="file" />
      <input type="image" />
    `);
    expect(capturePage(document)).toHaveLength(0);
  });

  it('treats an input with no type as text', () => {
    mount('<input id="plain" />');
    const candidate = only(capturePage(document));
    expect(candidate.step.type).toBe('text');
  });

  it('skips contenteditable="false"', () => {
    mount('<div contenteditable="false">nope</div>');
    expect(capturePage(document)).toHaveLength(0);
  });
});

describe('capturePage — default state extraction (Req 2.4)', () => {
  it('reads the current text input value', () => {
    mount('<input id="name" type="text" value="Ada" />');
    const step = only(capturePage(document)).step as TextStep;
    expect(step.type).toBe('text');
    expect(step.value).toBe('Ada');
  });

  it('reads the current textarea value', () => {
    mount('<textarea id="bio">hello</textarea>');
    const step = only(capturePage(document)).step as TextStep;
    expect(step.value).toBe('hello');
  });

  it('reads the selected option value and derives matchBy "value"', () => {
    mount(`
      <select id="state">
        <option value="ca">California</option>
        <option value="ny" selected>New York</option>
      </select>
    `);
    const step = only(capturePage(document)).step as SelectStep;
    expect(step.type).toBe('select');
    expect(step.value).toBe('ny');
    expect(step.matchBy).toBe('value');
  });

  it('reads the checked state of a checkbox', () => {
    mount('<input id="agree" type="checkbox" checked />');
    const step = only(capturePage(document)).step as CheckStep;
    expect(step.type).toBe('check');
    expect(step.checked).toBe(true);
  });

  it('reads unchecked state', () => {
    mount('<input id="agree" type="checkbox" />');
    const step = only(capturePage(document)).step as CheckStep;
    expect(step.checked).toBe(false);
  });

  it('reads contenteditable innerHTML', () => {
    mount('<div id="notes" contenteditable="true"><b>hi</b></div>');
    const step = only(capturePage(document)).step as ContentEditableStep;
    expect(step.type).toBe('contenteditable');
    expect(step.html).toBe('<b>hi</b>');
  });
});

describe('capturePage — radio groups (Req 2.2, 2.4, 3.3)', () => {
  it('captures a radio group as a single step targeted by name', () => {
    mount(`
      <form>
        <input type="radio" name="contact" value="email" />
        <input type="radio" name="contact" value="phone" />
        <input type="radio" name="contact" value="mail" />
      </form>
    `);
    const candidates = capturePage(document);
    expect(candidates).toHaveLength(1);
    const step = candidates[0]!.step as RadioStep;
    expect(step.type).toBe('radio');
    expect(step.target).toEqual({ by: 'name', value: 'contact' });
    expect(candidates[0]!.fragile).toBe(false);
  });

  it('defaults the value to the currently-checked member', () => {
    mount(`
      <form>
        <input type="radio" name="contact" value="email" />
        <input type="radio" name="contact" value="phone" checked />
      </form>
    `);
    const step = only(capturePage(document)).step as RadioStep;
    expect(step.value).toBe('phone');
  });

  it('defaults the value to "" when no member is checked', () => {
    mount(`
      <form>
        <input type="radio" name="contact" value="email" />
        <input type="radio" name="contact" value="phone" />
      </form>
    `);
    const step = only(capturePage(document)).step as RadioStep;
    expect(step.value).toBe('');
  });

  it('captures two differently-named groups as two steps', () => {
    mount(`
      <form>
        <input type="radio" name="contact" value="email" />
        <input type="radio" name="contact" value="phone" />
        <input type="radio" name="size" value="s" />
        <input type="radio" name="size" value="m" checked />
      </form>
    `);
    const candidates = capturePage(document);
    expect(candidates).toHaveLength(2);
    const byName = Object.fromEntries(
      candidates.map((c) => [(c.step as RadioStep).target.value, c.step as RadioStep]),
    );
    expect(byName['contact']!.value).toBe('');
    expect(byName['size']!.value).toBe('m');
  });

  it('still classifies a checkbox as a check step, not radio', () => {
    mount('<input id="agree" type="checkbox" checked />');
    const step = only(capturePage(document)).step as CheckStep;
    expect(step.type).toBe('check');
  });
});

describe('capturePage — fragile flag (Req 2.6)', () => {
  it('is false when a stable id exists', () => {
    mount('<input id="name" type="text" />');
    expect(only(capturePage(document)).fragile).toBe(false);
  });

  it('is false when only a stable name exists', () => {
    mount('<input name="name" type="text" />');
    expect(only(capturePage(document)).fragile).toBe(false);
  });

  it('is true when only a positional selector is possible', () => {
    mount(`
      <form>
        <input type="text" />
        <input type="text" />
      </form>
    `);
    const candidates = capturePage(document);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.fragile)).toBe(true);
  });
});

describe('capturePage — step metadata', () => {
  it('assigns a unique generated id to each candidate step', () => {
    mount(`
      <input id="a" type="text" />
      <input id="b" type="text" />
    `);
    const ids = capturePage(document).map((c) => c.step.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toEqual(ids[1]);
  });

  it('derives a label from an associated <label> element', () => {
    mount(`
      <label for="name">Full name</label>
      <input id="name" type="text" />
    `);
    const step = only(capturePage(document)).step;
    expect(step.label).toBe('Full name');
  });
});

describe('looksGenerated', () => {
  it.each([
    'phone-number-input-0.8075095940726259',
    ':r16:',
    '«r1»',
    'field-3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    'input-a3f9c2e1b4',
    'mui-12',
    'react-select-3-input',
    'headlessui-listbox-button-5',
    'ts-1730412345678',
  ])('flags %s as generated', (value) => {
    expect(looksGenerated(value)).toBe(true);
  });

  it.each(['email', 'first-name', 'user[email]', 'address-line-2', 'number', 'dob2024', 'step-10'])(
    'treats %s as stable',
    (value) => {
      expect(looksGenerated(value)).toBe(false);
    },
  );
});

describe('deriveSelector — generated ids', () => {
  it('skips a random id and targets the label instead, with a note', () => {
    mount(
      '<input id="phone-number-input-0.8075095940726259" name="number" aria-label="Mobile number" />',
    );
    const el = document.querySelector('input')!;
    const { selector, fragile, note } = deriveSelector(el, document);
    expect(selector).toEqual({ by: 'label', value: 'Mobile number' });
    expect(fragile).toBe(false);
    expect(note).toMatch(/looks auto-generated, so it is targeted by its label instead/);
  });

  it('uses the name when a random id has no usable label', () => {
    mount('<input id=":r16:" name="number" />');
    const el = document.querySelector('input')!;
    const { selector, note } = deriveSelector(el, document);
    expect(selector).toEqual({ by: 'name', value: 'number' });
    expect(note).toMatch(/by its name instead/);
  });

  it('does not use a label shared by two fields', () => {
    mount(`
      <input id=":r1:" aria-label="Phone" data-testid="home" />
      <input id=":r2:" aria-label="Phone" data-testid="work" />`);
    const el = document.querySelectorAll('input')[1]!;
    const { selector } = deriveSelector(el, document);
    expect(selector).toEqual({ by: 'css', value: 'input[data-testid="work"]' });
  });

  it('skips a generated name too', () => {
    mount('<input name="field-0.55512345678" aria-label="Postcode" />');
    const { selector, note } = deriveSelector(document.querySelector('input')!, document);
    expect(selector).toEqual({ by: 'label', value: 'Postcode' });
    expect(note).toMatch(/Its name .* looks auto-generated/);
  });

  it('keeps a stable id first, with no note', () => {
    mount('<input id="email" aria-label="Email address" />');
    const { selector, note } = deriveSelector(document.querySelector('input')!, document);
    expect(selector).toEqual({ by: 'id', value: 'email' });
    expect(note).toBeUndefined();
  });

  it('does not anchor a positional path at a generated parent id', () => {
    mount('<div id="wrap-0.123456789"><input /><input /></div>');
    const el = document.querySelectorAll('input')[1]!;
    const { selector, fragile } = deriveSelector(el, document);
    expect(fragile).toBe(true);
    expect(selector.value).not.toContain('wrap-0.123456789');
    expect(document.querySelector(selector.value)).toBe(el);
  });

  it('passes the note through to the capture candidate', () => {
    mount('<input id="x-0.8075095940726259" aria-label="Mobile number" />');
    const candidate = only(capturePage(document));
    expect(candidate.step.target).toEqual({ by: 'label', value: 'Mobile number' });
    expect(candidate.note).toMatch(/auto-generated/);
  });
});
