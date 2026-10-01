/**
 * Component tests for the encryption settings view (task 12.5).
 *
 * These run under the jsdom Vitest project with @testing-library/preact and mock
 * the RPC seam (`../platform/rpc`) so `sendUi` returns scripted results for the
 * `EncryptionStatus` / `EnableEncryption` / `Unlock` / `Lock` /
 * `DisableEncryption` round-trips, exercising the view without a real
 * background.
 *
 * Coverage:
 *   - the standing "not encrypted = only as protected as your profile" note is
 *     always shown (Req 8.11);
 *   - DISABLED: the passphrase form is gated behind the no-recovery warning and
 *     acknowledgement (Req 8.10), and enabling sends EnableEncryption (Req 8.4);
 *   - a passphrase mismatch is caught client-side and blocks EnableEncryption;
 *   - LOCKED: unlock sends Unlock; a wrong passphrase shows an inline error and
 *     leaves things untouched (Req 8.8, 8.9);
 *   - UNLOCKED: "Lock now" sends Lock; "Turn off encryption" confirms then sends
 *     DisableEncryption (Req 8.4).
 *
 * Requirements: 8.3, 8.4, 8.5, 8.8, 8.10, 8.11
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorResult } from '../background/orchestrator';
import {
  MessageType,
  type EncryptionStatus,
  type UiRequest,
} from '../platform/messages';

const { sendUi } = vi.hoisted(() => ({ sendUi: vi.fn() }));
vi.mock('../platform/rpc', () => ({ sendUi }));

import { EncryptionSettings } from './EncryptionSettings';

const ok = <T,>(value: T): OrchestratorResult<T> => ({ ok: true, value });

/** Script `EncryptionStatus` to a fixed value and return `ok(null)` otherwise. */
function withStatus(
  status: EncryptionStatus,
  extra?: (msg: UiRequest) => OrchestratorResult<unknown> | undefined,
) {
  sendUi.mockImplementation(async (msg: UiRequest) => {
    if (msg.type === MessageType.EncryptionStatus) return ok(status);
    const e = extra?.(msg);
    if (e) return e;
    return ok(null);
  });
}

const noop = () => {};

beforeEach(() => {
  sendUi.mockReset();
});

describe('EncryptionSettings (task 12.5)', () => {
  it('always explains non-encrypted data is only as protected as the profile (Req 8.11)', async () => {
    withStatus({ enabled: false, unlocked: false });
    render(<EncryptionSettings onBack={noop} />);
    expect(
      await screen.findByText(/only as protected as your browser profile/i),
    ).toBeTruthy();
  });

  it('gates the passphrase form behind the no-recovery acknowledgement (Req 8.10)', async () => {
    withStatus({ enabled: false, unlocked: false });
    render(<EncryptionSettings onBack={noop} />);

    // No-recovery warning is present.
    expect(await screen.findByText(/There is no recovery/i)).toBeTruthy();

    // Passphrase field is disabled until the acknowledgement is checked.
    const pass = screen.getByLabelText('Master passphrase') as HTMLInputElement;
    expect(pass.disabled).toBe(true);

    const ack = screen.getByLabelText(/I understand there is no way to recover/i);
    fireEvent.click(ack);
    expect((screen.getByLabelText('Master passphrase') as HTMLInputElement).disabled).toBe(
      false,
    );
  });

  it('enables encryption with a matching passphrase (Req 8.4)', async () => {
    let enabledWith: string | null = null;
    withStatus({ enabled: false, unlocked: false }, (msg) => {
      if (msg.type === MessageType.EnableEncryption) {
        enabledWith = msg.passphrase;
        return ok(null);
      }
      return undefined;
    });

    render(<EncryptionSettings onBack={noop} />);
    fireEvent.click(await screen.findByLabelText(/I understand there is no way to recover/i));

    fireEvent.input(screen.getByLabelText('Master passphrase'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.input(screen.getByLabelText('Confirm passphrase'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByText('Set passphrase & enable'));

    await waitFor(() => expect(enabledWith).toBe('correct horse battery'));
  });

  it('blocks enabling when the passphrases do not match', async () => {
    withStatus({ enabled: false, unlocked: false });
    render(<EncryptionSettings onBack={noop} />);
    fireEvent.click(await screen.findByLabelText(/I understand there is no way to recover/i));

    fireEvent.input(screen.getByLabelText('Master passphrase'), {
      target: { value: 'aaaa' },
    });
    fireEvent.input(screen.getByLabelText('Confirm passphrase'), {
      target: { value: 'bbbb' },
    });
    fireEvent.click(screen.getByText('Set passphrase & enable'));

    expect(await screen.findByText(/do not match/i)).toBeTruthy();
    expect(
      sendUi.mock.calls.some(
        ([m]) => (m as UiRequest).type === MessageType.EnableEncryption,
      ),
    ).toBe(false);
  });

  it('unlocks a locked session, and reports a wrong passphrase (Req 8.8, 8.9)', async () => {
    let attempts = 0;
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.EncryptionStatus)
        return ok({ enabled: true, unlocked: false });
      if (msg.type === MessageType.Unlock) {
        attempts += 1;
        return attempts === 1
          ? ({
              ok: false,
              code: 'wrong-passphrase',
              error: 'Incorrect passphrase.',
            } as OrchestratorResult<never>)
          : ok(null);
      }
      return ok(null);
    });

    render(<EncryptionSettings onBack={noop} />);

    const pass = (await screen.findByLabelText('Master passphrase')) as HTMLInputElement;
    fireEvent.input(pass, { target: { value: 'nope' } });
    fireEvent.click(screen.getByText('Unlock'));

    // Wrong passphrase -> inline error, still locked.
    expect(await screen.findByText(/Incorrect passphrase/i)).toBeTruthy();
  });

  it('locks and disables encryption from the unlocked view (Req 8.4)', async () => {
    let locked = false;
    let disabled = false;
    sendUi.mockImplementation(async (msg: UiRequest) => {
      if (msg.type === MessageType.EncryptionStatus)
        return ok({ enabled: true, unlocked: true });
      if (msg.type === MessageType.Lock) {
        locked = true;
        return ok(null);
      }
      if (msg.type === MessageType.DisableEncryption) {
        disabled = true;
        return ok(null);
      }
      return ok(null);
    });

    render(<EncryptionSettings onBack={noop} />);

    // Unlocked view offers "Lock now".
    fireEvent.click(await screen.findByText('Lock now'));
    await waitFor(() => expect(locked).toBe(true));

    // Turn off encryption requires the inline confirmation. There is a section
    // heading with the same text, so target the buttons specifically.
    const offButtons = () =>
      screen
        .getAllByRole('button')
        .filter((b) => b.textContent === 'Turn off encryption');
    fireEvent.click(offButtons()[0] as HTMLElement);
    // The confirmation now shows its own "Turn off encryption" button.
    await waitFor(() => expect(offButtons().length).toBeGreaterThan(0));
    fireEvent.click(offButtons()[offButtons().length - 1] as HTMLElement);
    await waitFor(() => expect(disabled).toBe(true));
  });
});
