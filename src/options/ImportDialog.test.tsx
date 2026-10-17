/**
 * Component tests for the import dialog (task 12.4).
 *
 * Runs under the jsdom Vitest project with @testing-library/preact and mocks the
 * RPC seam (`../platform/rpc`) so `sendUi` returns scripted results for the
 * `ImportConfig` round-trip.
 *
 * Coverage:
 *   - valid pasted text calls ImportConfig, notifies the parent, and shows the
 *     resolved "Added as <name>" confirmation (Req 7.3, 7.5);
 *   - invalid text shows the error and does NOT notify the parent (the list is
 *     left unchanged — Req 7.4).
 *
 * Requirements: 7.3, 7.4, 7.5
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorResult } from '../background/orchestrator';
import type { StoredConfig } from '../core/schema';
import { MessageType, type UiRequest } from '../platform/messages';

const { sendUi } = vi.hoisted(() => ({ sendUi: vi.fn() }));
vi.mock('../platform/rpc', () => ({ sendUi }));

import { ImportDialog } from './ImportDialog';

const ok = <T,>(value: T): OrchestratorResult<T> => ({ ok: true, value });

const STORED: StoredConfig = {
  id: 'new1',
  name: 'Login form (2)',
  match: [],
  steps: [],
  errorStrategy: 'stop',
  encrypted: false,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  sendUi.mockReset();
});

describe('ImportDialog', () => {
  it('imports valid text, notifies the parent, and shows the resolved name (Req 7.3, 7.5)', async () => {
    let importedName: string | null = null;
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ImportConfig) {
        expect(msg.text).toBe('{"app":"fillibuster"}');
        return ok(STORED);
      }
      throw new Error('unexpected');
    });

    render(
      <ImportDialog
        onImported={(c) => {
          importedName = c.name;
        }}
        onClose={() => undefined}
      />,
    );

    const textarea = screen.getByLabelText('Exported config (JSON)') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: '{"app":"fillibuster"}' } });
    fireEvent.click(screen.getByText('Add config'));

    await waitFor(() =>
      expect(
        sendUi.mock.calls.some(([m]) => (m as UiRequest).type === MessageType.ImportConfig),
      ).toBe(true),
    );
    // Confirmation uses the resolved (kept-both) name from the returned config.
    expect(await screen.findByText('Added as "Login form (2)".')).toBeTruthy();
    expect(importedName).toBe('Login form (2)');
    // The confirmation reminds the user the import is stored unencrypted.
    expect(screen.getByText(/stored/i).textContent).toMatch(/unencrypted/i);
  });

  it('shows an error and does not notify the parent on invalid text (Req 7.4)', async () => {
    const onImported = vi.fn();
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ImportConfig) {
        return {
          ok: false,
          code: 'error',
          error: 'not valid JSON',
        } as OrchestratorResult<never>;
      }
      throw new Error('unexpected');
    });

    render(<ImportDialog onImported={onImported} onClose={() => undefined} />);

    const textarea = screen.getByLabelText('Exported config (JSON)') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'not json' } });
    fireEvent.click(screen.getByText('Add config'));

    expect(await screen.findByText('not valid JSON')).toBeTruthy();
    // Parent is never notified -> the list stays unchanged (Req 7.4).
    expect(onImported).not.toHaveBeenCalled();
    // Still on the paste view, not the confirmation.
    expect(screen.queryByText(/^Added as/)).toBeNull();
  });

  it('disables the submit until text is entered', () => {
    render(<ImportDialog onImported={() => undefined} onClose={() => undefined} />);

    const submit = screen.getByText('Add config') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const textarea = screen.getByLabelText('Exported config (JSON)') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: '{}' } });
    expect((screen.getByText('Add config') as HTMLButtonElement).disabled).toBe(false);
  });
});
