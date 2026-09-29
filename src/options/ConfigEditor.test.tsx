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

  it('adds a step of each type and renders its type-specific fields', async () => {
    render(<ConfigEditor draft={draft()} onSaved={noop} onBack={noop} />);
    await screen.findByLabelText('Name');

    const addType = screen.getByLabelText('New step type') as HTMLSelectElement;
    const addBtn = screen.getByText('Add step');

    // text
    fireEvent.click(addBtn);
    expect(screen.getByLabelText('Value')).toBeTruthy();

    // select -> value + match by
    fireEvent.change(addType, { target: { value: 'select' } });
    fireEvent.click(addBtn);
    expect(screen.getByLabelText('Match by')).toBeTruthy();

    // check -> Checked checkbox
    fireEvent.change(addType, { target: { value: 'check' } });
    fireEvent.click(addBtn);
    expect(screen.getByLabelText('Checked')).toBeTruthy();

    // contenteditable -> Content textarea + Allow HTML
    fireEvent.change(addType, { target: { value: 'contenteditable' } });
    fireEvent.click(addBtn);
    expect(screen.getByLabelText('Content')).toBeTruthy();
    expect(screen.getByLabelText('Allow HTML')).toBeTruthy();

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      const types = lastSavedConfig().steps.map((s) => s.type);
      expect(types).toEqual(['text', 'select', 'check', 'contenteditable']);
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

  it('shows a locked note and no step editor for an encrypted config', async () => {
    render(
      <ConfigEditor draft={draft({ encrypted: true })} onSaved={noop} onBack={noop} />,
    );
    await screen.findByLabelText('Name');

    expect(screen.getByText(/encrypted/i)).toBeTruthy();
    expect(screen.queryByText('Add step')).toBeNull();
  });
});
