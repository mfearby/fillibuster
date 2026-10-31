/**
 * Component tests for the import dialog.
 *
 * Runs under the jsdom Vitest project with @testing-library/preact and mocks the
 * RPC seam (`../platform/rpc`) so `sendUi` returns scripted results for the
 * `ImportConfigs` round-trip.
 *
 * Coverage:
 *   - pasted text imports and shows the resolved "Added as <name>" (Req 7.3, 7.5);
 *   - a backup lists every imported config, noting renames;
 *   - picking a file with Browse imports it straight away;
 *   - dropping a file on the drop zone imports it straight away;
 *   - invalid input shows the error and never notifies the parent (Req 7.4).
 *
 * Requirements: 7.3, 7.4, 7.5
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorResult } from '../background/orchestrator';
import {
  MessageType,
  type ImportConfigsResult,
  type UiRequest,
} from '../platform/messages';

const { sendUi } = vi.hoisted(() => ({ sendUi: vi.fn() }));
vi.mock('../platform/rpc', () => ({ sendUi }));

import { ImportDialog } from './ImportDialog';

const ok = <T,>(value: T): OrchestratorResult<T> => ({ ok: true, value });

const ONE: ImportConfigsResult = {
  imported: [
    { id: 'new1', name: 'Login form (2)', originalName: 'Login form', renamed: true },
  ],
};

const MANY: ImportConfigsResult = {
  imported: [
    { id: 'a', name: 'Alpha', originalName: 'Alpha', renamed: false },
    { id: 'b', name: 'Beta (2)', originalName: 'Beta', renamed: true },
  ],
};

/** Every text payload sent with ImportConfigs, in order. */
function importedTexts(): string[] {
  return sendUi.mock.calls
    .map(([m]) => m as UiRequest)
    .filter((m) => m.type === MessageType.ImportConfigs)
    .map((m) => (m as { text: string }).text);
}

beforeEach(() => {
  sendUi.mockReset();
});

describe('ImportDialog', () => {
  it('imports pasted text and shows the resolved name (Req 7.3, 7.5)', async () => {
    const onImported = vi.fn();
    sendUi.mockResolvedValue(ok(ONE));

    render(<ImportDialog onImported={onImported} onClose={() => undefined} />);

    fireEvent.input(screen.getByLabelText(/paste a config or backup/i), {
      target: { value: '{"app":"fillibuster"}' },
    });
    fireEvent.click(screen.getByText('Import pasted text'));

    expect(
      await screen.findByText('Added as "Login form (2)". (renamed from "Login form")'),
    ).toBeTruthy();
    expect(importedTexts()).toEqual(['{"app":"fillibuster"}']);
    expect(onImported).toHaveBeenCalledTimes(1);
    // Reminds the user imports are stored unencrypted.
    expect(screen.getByText(/stored/i).textContent).toMatch(/unencrypted/i);
  });

  it('lists every config imported from a backup, noting renames', async () => {
    sendUi.mockResolvedValue(ok(MANY));
    render(<ImportDialog onImported={() => undefined} onClose={() => undefined} />);

    fireEvent.input(screen.getByLabelText(/paste a config or backup/i), {
      target: { value: '{"kind":"backup"}' },
    });
    fireEvent.click(screen.getByText('Import pasted text'));

    expect(await screen.findByText('Imported 2 configs.')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText(/renamed from "Beta"/)).toBeTruthy();
  });

  it('imports a file chosen with Browse straight away', async () => {
    const onImported = vi.fn();
    sendUi.mockResolvedValue(ok(ONE));
    render(<ImportDialog onImported={onImported} onClose={() => undefined} />);

    const file = new File(['{"from":"file"}'], 'backup.json', {
      type: 'application/json',
    });
    fireEvent.change(screen.getByLabelText('Choose a file to import'), {
      target: { files: [file] },
    });

    await waitFor(() => expect(importedTexts()).toEqual(['{"from":"file"}']));
    expect(await screen.findByText(/^Added as/)).toBeTruthy();
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('imports a file dropped on the drop zone straight away', async () => {
    sendUi.mockResolvedValue(ok(ONE));
    render(<ImportDialog onImported={() => undefined} onClose={() => undefined} />);

    const zone = screen.getByText(/Drop a Fillibuster \.json file here/).parentElement!;
    const file = new File(['{"from":"drop"}'], 'backup.json', {
      type: 'application/json',
    });

    fireEvent.dragOver(zone, { dataTransfer: { files: [file], dropEffect: 'none' } });
    expect(zone.classList.contains('dragging')).toBe(true);

    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(importedTexts()).toEqual(['{"from":"drop"}']));
    expect(await screen.findByText(/^Added as/)).toBeTruthy();
  });

  it('shows an error and does not notify the parent on invalid input (Req 7.4)', async () => {
    const onImported = vi.fn();
    sendUi.mockResolvedValue({
      ok: false,
      code: 'error',
      error: 'not valid JSON',
    } as OrchestratorResult<never>);

    render(<ImportDialog onImported={onImported} onClose={() => undefined} />);

    fireEvent.input(screen.getByLabelText(/paste a config or backup/i), {
      target: { value: 'not json' },
    });
    fireEvent.click(screen.getByText('Import pasted text'));

    expect(await screen.findByText('not valid JSON')).toBeTruthy();
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Added as/)).toBeNull();
  });

  it('disables the paste import until text is entered', () => {
    render(<ImportDialog onImported={() => undefined} onClose={() => undefined} />);

    expect((screen.getByText('Import pasted text') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(screen.getByLabelText(/paste a config or backup/i), {
      target: { value: '{}' },
    });
    expect((screen.getByText('Import pasted text') as HTMLButtonElement).disabled).toBe(false);
  });
});
