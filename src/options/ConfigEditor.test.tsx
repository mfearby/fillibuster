/**
 * Component tests for the typed, reorderable ConfigEditor (task 12.2).
 *
 * These run under the jsdom Vitest project with @testing-library/preact and
 * mock the RPC seam (`../platform/rpc`) so `sendUi` returns scripted
 * {@link OrchestratorResult}s and we can inspect the SaveConfig payload without
 * a real background. The editor is driven directly (not via App) with a fresh
 * `draft` so no GetConfig round-trip is needed.
 *
 * Coverage:
 *   - error strategy edit;
 *   - add/remove/edit match rules;
 *   - add a step of each type renders its type-specific fields;
 *   - editing step fields;
 *   - reorder (move up/down changes order) and remove;
 *   - Save sends a SaveConfig whose config includes the edited steps/rules/strategy;
 *   - an encrypted config shows the locked note instead of the step editor.
 *
 * Requirements: 2.1, 6.2, 6.3, 6.4, 6.5
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorResult } from '../background/orchestrator';
import type { FieldStep, FillConfig, StoredConfig } from '../core/schema';
import { MessageType, type UiRequest } from '../platform/messages';

const { sendUi } = vi.hoisted(() => ({ sendUi: vi.fn() }));
vi.mock('../platform/rpc', () => ({ sendUi }));

import { ConfigEditor } from './ConfigEditor';

const ok = <T,>(value: T): OrchestratorResult<T> => ({ ok: true, value });

function draft(overrides: Partial<FillConfig> = {}): FillConfig {
  return {
    id: 'draft-1',
    name: 'Draft',
    match: [],
    steps: [],
    errorStrategy: 'stop',
    encrypted: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** Capture the config from the most recent SaveConfig call. */
function lastSavedConfig(): FillConfig {
  const call = sendUi.mock.calls
    .map(([m]) => m as UiRequest)
    .reverse()
    .find((m) => m.type === MessageType.SaveConfig);
  if (!call || call.type !== MessageType.SaveConfig) {
    throw new Error('SaveConfig was not called');
  }
  return call.config;
}

beforeEach(() => {
  sendUi.mockReset();
  sendUi.mockImplementation(async (msg: UiRequest) => {
    if (msg.type === MessageType.SaveConfig) return ok(msg.config as StoredConfig);
    return ok(null);
  });
});

const noop = () => {};

describe('ConfigEditor (task 12.2)', () => {
  it('keeps the Name field and edits the error strategy, persisting on Save', async () => {
    render(<ConfigEditor draft={draft()} onSaved={noop} onBack={noop} />);

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(name.value).toBe('Draft');

    const strategy = screen.getByLabelText('Error strategy') as HTMLSelectElement;
    expect(strategy.value).toBe('stop');
    fireEvent.change(strategy, { target: { value: 'continue' } });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(lastSavedConfig().errorStrategy).toBe('continue'));
  });

  it('adds, edits, and removes match rules', async () => {
    render(<ConfigEditor draft={draft()} onSaved={noop} onBack={noop} />);
    await screen.findByLabelText('Name');

    fireEvent.click(screen.getByText('Add rule'));
    fireEvent.click(screen.getByText('Add rule'));

    // Edit the first rule's kind + pattern.
    fireEvent.change(screen.getByLabelText('Rule 1 kind'), {
      target: { value: 'glob' },
    });
    fireEvent.input(screen.getByLabelText('Rule 1 pattern'), {
      target: { value: 'https://a.example/*' },
    });
    fireEvent.input(screen.getByLabelText('Rule 2 pattern'), {
      target: { value: 'https://b.example/x' },
    });

    // Remove the second rule.
    fireEvent.click(screen.getByLabelText('Remove rule 2'));

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const cfg = lastSavedConfig();
      expect(cfg.match).toEqual([
        { kind: 'glob', pattern: 'https://a.example/*' },
      ]);
    });
  });

  it('adds steps (as text) and switches each via the per-step Type selector', async () => {
    render(<ConfigEditor draft={draft()} onSaved={noop} onBack={noop} />);
    await screen.findByLabelText('Name');

    // New steps are always created as `text`; the type is changed per step via
    // the step's own Type selector (the redundant 'new step type' dropdown was
    // removed).
    const addBtn = screen.getByText('Add step');

    // One step, default text -> shows the Value field.
    fireEvent.click(addBtn);
    expect(screen.getByLabelText('Type')).toBeTruthy();
    expect(screen.getByLabelText('Value')).toBeTruthy();

    // Switch it to select -> Match by appears.
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'select' } });
    expect(screen.getByLabelText('Match by')).toBeTruthy();

    // Switch it to check -> Checked checkbox appears.
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'check' } });
    expect(screen.getByLabelText('Checked')).toBeTruthy();

    // Switch it to contenteditable -> Content + Allow HTML appear.
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'contenteditable' } });
    expect(screen.getByLabelText('Content')).toBeTruthy();
    expect(screen.getByLabelText('Allow HTML')).toBeTruthy();

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      const types = lastSavedConfig().steps.map((s) => s.type);
      expect(types).toEqual(['contenteditable']);
    });
  });

  it('edits a step\'s common and type-specific fields', async () => {
    render(<ConfigEditor draft={draft()} onSaved={noop} onBack={noop} />);
    await screen.findByLabelText('Name');

    fireEvent.click(screen.getByText('Add step')); // default type: text

    fireEvent.input(screen.getByLabelText('Target value'), {
      target: { value: '#email' },
    });
    fireEvent.change(screen.getByLabelText('Target by'), {
      target: { value: 'name' },
    });
    fireEvent.input(screen.getByLabelText('Label'), {
      target: { value: 'Email field' },
    });
    fireEvent.input(screen.getByLabelText('Value'), {
      target: { value: 'test@example.com' },
    });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const step = lastSavedConfig().steps[0];
      expect(step).toMatchObject({
        type: 'text',
        label: 'Email field',
        target: { by: 'name', value: '#email' },
        value: 'test@example.com',
      } as Partial<FieldStep>);
    });
  });

  it('resets type-specific fields to defaults when a step type changes', async () => {
    render(<ConfigEditor draft={draft()} onSaved={noop} onBack={noop} />);
    await screen.findByLabelText('Name');

    fireEvent.click(screen.getByText('Add step')); // text
    fireEvent.input(screen.getByLabelText('Target value'), {
      target: { value: '#state' },
    });
    fireEvent.input(screen.getByLabelText('Value'), {
      target: { value: 'keep-target-not-value' },
    });

    // Change the step type to select; target should survive, value resets.
    fireEvent.change(screen.getByLabelText('Type'), {
      target: { value: 'select' },
    });

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      const step = lastSavedConfig().steps[0];
      expect(step?.type).toBe('select');
      expect(step?.target.value).toBe('#state');
      if (step?.type === 'select') {
        expect(step.value).toBe('');
        expect(step.matchBy).toBe('value');
      }
    });
  });

  it('reorders steps with move up/down and removes a step', async () => {
    render(<ConfigEditor draft={draft()} onSaved={noop} onBack={noop} />);
    await screen.findByLabelText('Name');

    const addBtn = screen.getByText('Add step');
    // Add three text steps and label them A, B, C so we can track order.
    for (const label of ['A', 'B', 'C']) {
      fireEvent.click(addBtn);
      const labels = screen.getAllByLabelText('Label') as HTMLInputElement[];
      const last = labels[labels.length - 1];
      if (!last) throw new Error('expected a Label input');
      fireEvent.input(last, { target: { value: label } });
    }

    // Move step 3 (C) up -> A, C, B.
    fireEvent.click(screen.getByLabelText('Move step 3 up'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(lastSavedConfig().steps.map((s) => s.label)).toEqual([
        'A',
        'C',
        'B',
      ]);
    });

    // Move step 1 (A) down -> C, A, B.
    fireEvent.click(screen.getByLabelText('Move step 1 down'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(lastSavedConfig().steps.map((s) => s.label)).toEqual([
        'C',
        'A',
        'B',
      ]);
    });

    // Remove the first step (C) -> A, B.
    fireEvent.click(screen.getByLabelText('Remove step 1'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(lastSavedConfig().steps.map((s) => s.label)).toEqual(['A', 'B']);
    });
  });

  it('lets an encrypted config edit its (decrypted) steps and shows the Encrypted toggle (Req 8.6)', async () => {
    // The background decrypts on open when unlocked, so the editor receives a
    // plaintext draft with `encrypted: true` — the step editor is available.
    render(
      <ConfigEditor
        draft={draft({ encrypted: true })}
        onSaved={noop}
        onBack={noop}
      />,
    );
    await screen.findByLabelText('Name');

    // The step editor is present (no longer a "locked, can't edit" note).
    expect(screen.getByText('Add step')).toBeTruthy();
    // The Encrypted toggle reflects the config's encrypted flag.
    const toggle = screen.getByLabelText(
      /Encrypt this config/i,
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it('marks a config encrypted when encryption is enabled + unlocked (Req 8.6)', async () => {
    sendUi.mockReset();
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.SaveConfig) return ok(msg.config as StoredConfig);
      if (msg.type === MessageType.EncryptionStatus)
        return ok({ enabled: true, unlocked: true });
      return ok(null);
    });

    render(<ConfigEditor draft={draft()} onSaved={noop} onBack={noop} />);
    await screen.findByLabelText('Name');

    const toggle = (await screen.findByLabelText(
      /Encrypt this config/i,
    )) as HTMLInputElement;
    // Enabled + unlocked -> the toggle is actionable.
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(lastSavedConfig().encrypted).toBe(true));
  });

  it('prompts to unlock when opening an encrypted config while locked (Req 8.8)', async () => {
    sendUi.mockReset();
    let unlocked = false;
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.EncryptionStatus)
        return ok({ enabled: true, unlocked });
      if (msg.type === MessageType.GetConfig) {
        return unlocked
          ? ok(draft({ id: 'enc1', name: 'Secret', encrypted: true }))
          : ({ ok: false, code: 'locked', error: 'locked' } as OrchestratorResult<never>);
      }
      if (msg.type === MessageType.Unlock) {
        unlocked = true;
        return ok(null);
      }
      return ok(null);
    });

    render(<ConfigEditor configId="enc1" onSaved={noop} onBack={noop} />);

    // The unlock prompt shows instead of the editor.
    const pass = (await screen.findByLabelText(
      'Master passphrase',
    )) as HTMLInputElement;
    fireEvent.input(pass, { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByText('Unlock'));

    // After unlock the editor loads the (now decrypted) config.
    expect(await screen.findByLabelText('Name')).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Secret',
    );
  });

  it('keeps the unlock prompt with an error on a wrong passphrase (Req 8.9)', async () => {
    sendUi.mockReset();
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.EncryptionStatus)
        return ok({ enabled: true, unlocked: false });
      if (msg.type === MessageType.GetConfig)
        return { ok: false, code: 'locked', error: 'locked' } as OrchestratorResult<never>;
      if (msg.type === MessageType.Unlock)
        return {
          ok: false,
          code: 'wrong-passphrase',
          error: 'Incorrect passphrase.',
        } as OrchestratorResult<never>;
      return ok(null);
    });

    render(<ConfigEditor configId="enc1" onSaved={noop} onBack={noop} />);

    const pass = (await screen.findByLabelText(
      'Master passphrase',
    )) as HTMLInputElement;
    fireEvent.input(pass, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByText('Unlock'));

    expect(await screen.findByText(/Incorrect passphrase/i)).toBeTruthy();
    // Still on the unlock prompt, editor not loaded.
    expect(screen.queryByLabelText('Name')).toBeNull();
  });
});
