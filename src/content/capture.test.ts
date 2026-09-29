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
  SelectStep,
  TextStep,
} from '../core/schema';
import { type CaptureCandidate, capturePage, deriveSelector } from './capture';

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
