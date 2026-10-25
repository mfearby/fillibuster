/**
 * DOM tests for the fill executor, run under the jsdom Vitest project.
 *
 * Each control type asserts BOTH that the value/state is set AND that the
 * expected native events fire (attached via listeners), covering Req 3.1–3.4
 * and Req 5b.1/5b.2. The element-not-found path is exercised under both error
 * strategies (Req 5.5, 9.2, 9.3): `stop` halts and leaves later steps
 * un-attempted, `continue` attempts every step and reports failures.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { FieldStep } from '../core/schema';
import { NOT_FOUND_REASON, applySteps, resolveTarget } from './fill';

/** Replace the document body with `html` and return it for querying. */
function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/** Record the event types dispatched at `el` for the given names. */
function recordEvents(el: EventTarget, types: string[]): string[] {
  const seen: string[] = [];
  for (const type of types) {
    el.addEventListener(type, () => seen.push(type));
  }
  return seen;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('resolveTarget', () => {
  it('resolves by id, name, and css', () => {
    mount(`
      <input id="byId" />
      <input name="byName" />
      <input class="byCss" />
    `);
    expect(resolveTarget({ by: 'id', value: 'byId' }, document)).toBe(
      document.getElementById('byId'),
    );
    expect(resolveTarget({ by: 'name', value: 'byName' }, document)).toBe(
      document.getElementsByName('byName')[0],
    );
    expect(resolveTarget({ by: 'css', value: '.byCss' }, document)).toBe(
      document.querySelector('.byCss'),
    );
  });

  it('returns null when nothing matches', () => {
    mount('<input id="present" />');
    expect(resolveTarget({ by: 'id', value: 'absent' }, document)).toBeNull();
    expect(resolveTarget({ by: 'name', value: 'absent' }, document)).toBeNull();
    expect(resolveTarget({ by: 'css', value: '#absent' }, document)).toBeNull();
  });

  it('id: tries a comma-list of ids in order, first present wins', () => {
    mount('<input id="second" />');
    // First candidate is absent; resolution falls through to the second.
    expect(
      resolveTarget({ by: 'id', value: 'first, second' }, document),
    ).toBe(document.getElementById('second'));
  });

  it('id: honors list order, not document order, when several match', () => {
    // Both present; the one listed first wins even though it is second in the DOM.
    mount('<input id="beta" /><input id="alpha" />');
    expect(
      resolveTarget({ by: 'id', value: 'alpha, beta' }, document),
    ).toBe(document.getElementById('alpha'));
  });

  it('id: trims whitespace around candidates', () => {
    mount('<input id="target" />');
    expect(
      resolveTarget({ by: 'id', value: '  missing ,   target  ' }, document),
    ).toBe(document.getElementById('target'));
  });

  it('name: tries a comma-list of names in order', () => {
    mount('<input name="contact2" />');
    expect(
      resolveTarget({ by: 'name', value: 'contact1, contact2' }, document),
    ).toBe(document.getElementsByName('contact2')[0]);
  });

  it('single id with no comma behaves as before', () => {
    mount('<input id="solo" />');
    expect(resolveTarget({ by: 'id', value: 'solo' }, document)).toBe(
      document.getElementById('solo'),
    );
  });
});

describe('applySteps — text', () => {
  it('sets the value and dispatches input then change (Req 3.1, 5b.1)', async () => {
    mount('<input id="first" type="text" />');
    const el = document.getElementById('first') as HTMLInputElement;
    const events = recordEvents(el, ['input', 'change']);

    const steps: FieldStep[] = [
      { id: 's1', type: 'text', target: { by: 'id', value: 'first' }, value: 'Ada' },
    ];
    const summary = await applySteps(steps, 'continue');

    expect(el.value).toBe('Ada');
    expect(events).toEqual(['input', 'change']);
    expect(summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
    expect(summary.results[0]).toEqual({ index: 0, ok: true });
  });

  it('fills a textarea via the native setter (Req 5b.1)', async () => {
    mount('<textarea name="bio"></textarea>');
    const el = document.getElementsByName('bio')[0] as HTMLTextAreaElement;
    const events = recordEvents(el, ['input', 'change']);

    const summary = await applySteps(
      [{ id: 's1', type: 'text', target: { by: 'name', value: 'bio' }, value: 'hi' }],
      'continue',
    );

    expect(el.value).toBe('hi');
    expect(events).toEqual(['input', 'change']);
    expect(summary.succeeded).toBe(1);
  });

  it('writes via the native prototype setter, bypassing an instance override (Req 5b.1)', async () => {
    mount('<input id="react" type="text" />');
    const el = document.getElementById('react') as HTMLInputElement;

    // Simulate a framework shadowing the instance `value` setter so a plain
    // `el.value = x` assignment would be swallowed. Reading `.value` still goes
    // through the native slot (mirroring how React's tracker delegates), so the
    // native prototype setter our executor uses is what actually updates it.
    const swallowed: string[] = [];
    const nativeGetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.get;
    Object.defineProperty(el, 'value', {
      configurable: true,
      get() {
        return nativeGetter?.call(this) ?? '';
      },
      set(v: string) {
        // A naive assignment would land here and be dropped.
        swallowed.push(v);
      },
    });
    const events = recordEvents(el, ['input']);

    await applySteps(
      [{ id: 's1', type: 'text', target: { by: 'id', value: 'react' }, value: 'x' }],
      'continue',
    );

    // Our executor bypassed the instance setter (nothing swallowed) and wrote
    // through the native slot, and `input` fired.
    expect(swallowed).toEqual([]);
    expect(el.value).toBe('x');
    expect(events).toEqual(['input']);
  });
});

describe('applySteps — select', () => {
  const optionsHtml = `
    <select id="state">
      <option value="ca">California</option>
      <option value="ny">New York</option>
    </select>`;

  it('selects by option value and dispatches change (Req 3.2)', async () => {
    mount(optionsHtml);
    const el = document.getElementById('state') as HTMLSelectElement;
    const events = recordEvents(el, ['change']);

    const summary = await applySteps(
      [
        {
          id: 's1',
          type: 'select',
          target: { by: 'id', value: 'state' },
          value: 'ny',
          matchBy: 'value',
        },
      ],
      'continue',
    );

    expect(el.value).toBe('ny');
    expect(el.selectedIndex).toBe(1);
    expect(events).toEqual(['change']);
    expect(summary.succeeded).toBe(1);
  });

  it('selects by visible text (Req 3.2)', async () => {
    mount(optionsHtml);
    const el = document.getElementById('state') as HTMLSelectElement;

    await applySteps(
      [
        {
          id: 's1',
          type: 'select',
          target: { by: 'id', value: 'state' },
          value: 'California',
          matchBy: 'text',
        },
      ],
      'continue',
    );

    expect(el.value).toBe('ca');
    expect(el.selectedIndex).toBe(0);
  });

  it('fails when no option matches', async () => {
    mount(optionsHtml);
    const summary = await applySteps(
      [
        {
          id: 's1',
          type: 'select',
          target: { by: 'id', value: 'state' },
          value: 'tx',
          matchBy: 'value',
        },
      ],
      'continue',
    );
    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.ok).toBe(false);
    expect(summary.results[0]?.reason).toContain('no option matching');
  });
});

describe('applySteps — check', () => {
  it('sets checked and dispatches click and change (Req 3.3, 5b.2)', async () => {
    mount('<input id="agree" type="checkbox" />');
    const el = document.getElementById('agree') as HTMLInputElement;
    const events = recordEvents(el, ['click', 'change']);

    const summary = await applySteps(
      [{ id: 's1', type: 'check', target: { by: 'id', value: 'agree' }, checked: true }],
      'continue',
    );

    expect(el.checked).toBe(true);
    expect(events).toEqual(['click', 'change']);
    expect(summary.succeeded).toBe(1);
  });

  it('can uncheck a checked box', async () => {
    mount('<input id="agree" type="checkbox" checked />');
    const el = document.getElementById('agree') as HTMLInputElement;
    expect(el.checked).toBe(true);

    await applySteps(
      [{ id: 's1', type: 'check', target: { by: 'id', value: 'agree' }, checked: false }],
      'continue',
    );

    expect(el.checked).toBe(false);
  });
});

describe('applySteps — radio', () => {
  const groupHtml = `
    <form>
      <input type="radio" name="contact" value="email" />
      <input type="radio" name="contact" value="phone" />
      <input type="radio" name="contact" value="mail" />
    </form>`;

  it('selects the group member matching the value and fires click + change (Req 3.3)', async () => {
    mount(groupHtml);
    const members = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="contact"]'),
    );
    const phone = members[1] as HTMLInputElement;
    const events = recordEvents(phone, ['click', 'change']);

    const summary = await applySteps(
      [{ id: 's1', type: 'radio', target: { by: 'name', value: 'contact' }, value: 'phone' }],
      'continue',
    );

    expect(phone.checked).toBe(true);
    // Siblings are deselected.
    expect(members[0]!.checked).toBe(false);
    expect(members[2]!.checked).toBe(false);
    expect(events).toEqual(['click', 'change']);
    expect(summary.succeeded).toBe(1);
  });

  it('moves the selection off a previously-checked sibling', async () => {
    mount(`
      <form>
        <input type="radio" name="contact" value="email" checked />
        <input type="radio" name="contact" value="phone" />
      </form>`);
    const members = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="contact"]'),
    );
    expect(members[0]!.checked).toBe(true);

    await applySteps(
      [{ id: 's1', type: 'radio', target: { by: 'name', value: 'contact' }, value: 'phone' }],
      'continue',
    );

    expect(members[0]!.checked).toBe(false);
    expect(members[1]!.checked).toBe(true);
  });

  it('fails when no member matches the value', async () => {
    mount(groupHtml);
    const summary = await applySteps(
      [{ id: 's1', type: 'radio', target: { by: 'name', value: 'contact' }, value: 'fax' }],
      'continue',
    );
    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.ok).toBe(false);
    expect(summary.results[0]?.reason).toContain('no radio option matching value "fax"');
    // Nothing was selected.
    const anyChecked = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="contact"]'),
    ).some((r) => r.checked);
    expect(anyChecked).toBe(false);
  });
});

describe('applySteps — contenteditable', () => {
  it('sets textContent and dispatches input (Req 3.4)', async () => {
    mount('<div id="editor" contenteditable="true"></div>');
    const el = document.getElementById('editor') as HTMLElement;
    const events = recordEvents(el, ['input']);

    await applySteps(
      [
        {
          id: 's1',
          type: 'contenteditable',
          target: { by: 'id', value: 'editor' },
          html: '<b>bold</b>',
        },
      ],
      'continue',
    );

    // Without allowHtml the markup is set as literal text, not parsed.
    expect(el.textContent).toBe('<b>bold</b>');
    expect(el.querySelector('b')).toBeNull();
    expect(events).toEqual(['input']);
  });

  it('sets innerHTML when allowHtml is true (Req 3.4)', async () => {
    mount('<div id="editor" contenteditable="true"></div>');
    const el = document.getElementById('editor') as HTMLElement;

    await applySteps(
      [
        {
          id: 's1',
          type: 'contenteditable',
          target: { by: 'id', value: 'editor' },
          html: '<b>bold</b>',
          allowHtml: true,
        },
      ],
      'continue',
    );

    expect(el.querySelector('b')?.textContent).toBe('bold');
  });
});

describe('applySteps — element not found', () => {
  function twoStepMix(): FieldStep[] {
    return [
      { id: 's1', type: 'text', target: { by: 'id', value: 'missing' }, value: 'x' },
      { id: 's2', type: 'text', target: { by: 'id', value: 'present' }, value: 'y' },
    ];
  }

  it('stop: halts at the failure and leaves later steps un-attempted (Req 9.2)', async () => {
    mount('<input id="present" type="text" />');
    const present = document.getElementById('present') as HTMLInputElement;

    const summary = await applySteps(twoStepMix(), 'stop');

    expect(summary.total).toBe(2);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(1);
    // Only the first step was recorded; the second never ran.
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]).toEqual({
      index: 0,
      ok: false,
      reason: NOT_FOUND_REASON,
    });
    expect(present.value).toBe('');
  });

  it('continue: attempts every step and reports the failure (Req 9.3)', async () => {
    mount('<input id="present" type="text" />');
    const present = document.getElementById('present') as HTMLInputElement;

    const summary = await applySteps(twoStepMix(), 'continue');

    expect(summary.total).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results).toHaveLength(2);
    expect(summary.results[0]).toEqual({
      index: 0,
      ok: false,
      reason: NOT_FOUND_REASON,
    });
    expect(summary.results[1]).toEqual({ index: 1, ok: true });
    // The reachable step still applied.
    expect(present.value).toBe('y');
  });
});

describe('applySteps — autocomplete (Req 3.6)', () => {
  /** A combobox input plus an (initially empty) listbox container. */
  const comboHtml = `
    <input id="place" type="text" role="combobox" />
    <ul id="listbox" role="listbox"></ul>`;

  /** Append an option with `text` to the listbox and return it. */
  function addOption(text: string): HTMLLIElement {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.textContent = text;
    (document.getElementById('listbox') as HTMLElement).appendChild(li);
    return li;
  }

  function autocompleteStep(overrides: Record<string, unknown> = {}): FieldStep {
    return {
      id: 's1',
      type: 'autocomplete',
      target: { by: 'id', value: 'place' },
      value: 'Penn',
      optionTarget: { by: 'css', value: '[role="option"]' },
      optionMatch: 'Pennsylvania',
      timeoutMs: 1000,
      ...overrides,
    } as FieldStep;
  }

  it('types the query and fires input/change on the field', async () => {
    mount(comboHtml);
    const field = document.getElementById('place') as HTMLInputElement;
    const events = recordEvents(field, ['input', 'change']);
    addOption('1600 Pennsylvania Ave'); // already present

    const summary = await applySteps([autocompleteStep()], 'continue');

    expect(field.value).toBe('Penn');
    expect(events).toEqual(['input', 'change']);
    expect(summary.succeeded).toBe(1);
  });

  it('clicks the first option whose text contains the match (already rendered)', async () => {
    mount(comboHtml);
    addOption('1600 Pennsylvania Ave NW'); // match
    const match = document.querySelectorAll('[role="option"]')[0] as HTMLElement;
    const events = recordEvents(match, ['pointerdown', 'mousedown', 'click']);

    const summary = await applySteps([autocompleteStep()], 'continue');

    expect(events).toEqual(['pointerdown', 'mousedown', 'click']);
    expect(summary.succeeded).toBe(1);
    expect(summary.results[0]).toEqual({ index: 0, ok: true });
  });

  it('matches case-insensitively as a substring', async () => {
    mount(comboHtml);
    const opt = addOption('123 PENNSYLVANIA AVENUE');
    const events = recordEvents(opt, ['click']);

    const summary = await applySteps(
      [autocompleteStep({ optionMatch: 'pennsylvania' })],
      'continue',
    );

    expect(events).toEqual(['click']);
    expect(summary.succeeded).toBe(1);
  });

  it('picks the first match when several options match', async () => {
    mount(comboHtml);
    const first = addOption('Pennsylvania Ave');
    const second = addOption('Pennsylvania Plaza');
    const firstEvents = recordEvents(first, ['click']);
    const secondEvents = recordEvents(second, ['click']);

    await applySteps([autocompleteStep()], 'continue');

    expect(firstEvents).toEqual(['click']);
    expect(secondEvents).toEqual([]);
  });

  it('waits for an option rendered asynchronously after typing', async () => {
    mount(comboHtml);
    // The option appears 120ms after the step starts typing.
    setTimeout(() => addOption('1600 Pennsylvania Ave'), 120);

    const summary = await applySteps(
      [autocompleteStep({ timeoutMs: 1000 })],
      'continue',
    );

    expect(summary.succeeded).toBe(1);
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  });

  it('fails with a timeout reason when no option matches in time', async () => {
    mount(comboHtml);
    addOption('Somewhere Else'); // present but non-matching

    const summary = await applySteps(
      [autocompleteStep({ timeoutMs: 150 })],
      'continue',
    );

    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.ok).toBe(false);
    expect(summary.results[0]?.reason).toContain('no autocomplete option matching');
    expect(summary.results[0]?.reason).toContain('150ms');
  });

  it('fails when the input field itself is not found', async () => {
    mount('<div></div>');
    const summary = await applySteps(
      [autocompleteStep({ target: { by: 'id', value: 'nope' } })],
      'continue',
    );
    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.reason).toBe(NOT_FOUND_REASON);
  });

  describe('simulateTyping', () => {
    it('fires focus and focusin before typing so focus-gated widgets open', async () => {
      mount(comboHtml);
      const field = document.getElementById('place') as HTMLInputElement;
      const order: string[] = [];
      field.addEventListener('focus', () => order.push('focus'));
      field.addEventListener('focusin', () => order.push('focusin'));
      field.addEventListener('input', () => order.push('input'));
      addOption('Pennsylvania Ave');

      await applySteps(
        [autocompleteStep({ value: 'a', simulateTyping: true })],
        'continue',
      );

      // Focus is established before the first input event.
      expect(order.indexOf('focus')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('focusin')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('focus')).toBeLessThan(order.indexOf('input'));
      expect(order.indexOf('focusin')).toBeLessThan(order.indexOf('input'));
    });

    it('focuses the field and dispatches a keystroke sequence per character', async () => {
      mount(comboHtml);
      const field = document.getElementById('place') as HTMLInputElement;

      const keydowns: string[] = [];
      const keyups: string[] = [];
      const inputs: string[] = [];
      field.addEventListener('keydown', (e) =>
        keydowns.push((e as KeyboardEvent).key),
      );
      field.addEventListener('keyup', (e) =>
        keyups.push((e as KeyboardEvent).key),
      );
      // Record the field's value at each input event (it should grow).
      field.addEventListener('input', () => inputs.push(field.value));

      addOption('1600 Pennsylvania Ave'); // already present so it resolves fast

      const summary = await applySteps(
        [autocompleteStep({ value: 'abn', simulateTyping: true })],
        'continue',
      );

      expect(document.activeElement).toBe(field);
      expect(keydowns).toEqual(['a', 'b', 'n']);
      expect(keyups).toEqual(['a', 'b', 'n']);
      // The value grows one character per input event.
      expect(inputs).toEqual(['a', 'ab', 'abn']);
      expect(field.value).toBe('abn');
      expect(summary.succeeded).toBe(1);
    });

    it('dispatches input as an InputEvent with inputType insertText', async () => {
      mount(comboHtml);
      const field = document.getElementById('place') as HTMLInputElement;
      const types: Array<string | undefined> = [];
      field.addEventListener('input', (e) => {
        types.push((e as InputEvent).inputType);
      });
      addOption('Pennsylvania Ave');

      await applySteps(
        [autocompleteStep({ value: 'ab', simulateTyping: true })],
        'continue',
      );

      // jsdom supports InputEvent, so each input carries insertText.
      expect(types).toEqual(['insertText', 'insertText']);
    });
  });
});
