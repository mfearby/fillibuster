/**
 * Component tests for the export dialog (task 12.4).
 *
 * Runs under the jsdom Vitest project with @testing-library/preact. As with the
 * other options tests we mock the RPC seam (`../platform/rpc`) so `sendUi`
 * returns scripted {@link OrchestratorResult}s, and we stub
 * `navigator.clipboard.writeText` to observe the copy.
 *
 * Coverage:
 *   - a plaintext config exports on open and copies the envelope to the
 *     clipboard, showing a confirmation (Req 7.1, 7.2);
 *   - an encrypted config shows the plaintext warning first and only exports /
 *     copies after the user confirms (Req 7.7);
 *   - a `locked` export surfaces the message to unlock.
 *
 * Requirements: 7.1, 7.2, 7.7
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorResult } from '../background/orchestrator';
import { MessageType, type ConfigSummary, type UiRequest } from '../platform/messages';

const { sendUi } = vi.hoisted(() => ({ sendUi: vi.fn() }));
vi.mock('../platform/rpc', () => ({ sendUi }));

import { ExportDialog } from './ExportDialog';

const ok = <T,>(value: T): OrchestratorResult<T> => ({ ok: true, value });

const PLAIN: ConfigSummary = { id: 'c1', name: 'Login form', encrypted: false };
const ENCRYPTED: ConfigSummary = { id: 'c2', name: 'Secret form', encrypted: true };

const ENVELOPE = '{"app":"fillibuster","schemaVersion":1,"config":{}}';

const writeText = vi.fn(async () => undefined);

beforeEach(() => {
  sendUi.mockReset();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

describe('ExportDialog', () => {
  it('exports a plaintext config on open and copies the envelope to the clipboard', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ExportConfig) {
        expect(msg.configId).toBe('c1');
        return ok(ENVELOPE);
      }
      throw new Error('unexpected');
    });

    render(<ExportDialog config={PLAIN} onClose={() => undefined} />);

    // The envelope is copied to the clipboard and a confirmation appears.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ENVELOPE));
    expect(await screen.findByText('Copied to clipboard.')).toBeTruthy();

    // The envelope is also rendered in the readonly textarea as a fallback.
    const textarea = screen.getByLabelText('Exported config (JSON)') as HTMLTextAreaElement;
    expect(textarea.value).toBe(ENVELOPE);
  });

  it('warns before exporting an encrypted config and only copies after confirmation (Req 7.7)', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ExportConfig) return ok(ENVELOPE);
      throw new Error('unexpected');
    });

    render(<ExportDialog config={ENCRYPTED} onClose={() => undefined} />);

    // The warning is shown; nothing exported/copied yet.
    expect(screen.getByText(/include its values in\s+plain text/)).toBeTruthy();
    expect(sendUi).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();

    // Confirm the plaintext warning -> export runs and copies.
    fireEvent.click(screen.getByText('Export in plain text'));

    await waitFor(() =>
      expect(
        sendUi.mock.calls.some(([m]) => (m as UiRequest).type === MessageType.ExportConfig),
      ).toBe(true),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ENVELOPE));
    expect(await screen.findByText('Copied to clipboard.')).toBeTruthy();
  });

  it('surfaces a locked error so the user knows to unlock', async () => {
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ExportConfig) {
        return {
          ok: false,
          code: 'locked',
          error: 'Unlock with your master passphrase to continue.',
        } as OrchestratorResult<never>;
      }
      throw new Error('unexpected');
    });

    render(<ExportDialog config={ENCRYPTED} onClose={() => undefined} />);
    fireEvent.click(screen.getByText('Export in plain text'));

    expect(
      await screen.findByText('Unlock with your master passphrase to continue.'),
    ).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to the readonly textarea when the clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.ExportConfig) return ok(ENVELOPE);
      throw new Error('unexpected');
    });

    render(<ExportDialog config={PLAIN} onClose={() => undefined} />);

    const textarea = (await screen.findByLabelText(
      'Exported config (JSON)',
    )) as HTMLTextAreaElement;
    expect(textarea.value).toBe(ENVELOPE);
    // No "copied" claim when the clipboard wasn't used.
    expect(screen.queryByText('Copied to clipboard.')).toBeNull();
  });
});
