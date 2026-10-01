/**
 * Encryption settings view (task 12.5).
 *
 * The home for the opt-in master-passphrase feature (Req 8). Everything here is
 * deliberately explicit and low-friction so the default experience stays
 * password-free (Req 8.3, 8.4, 8.5): the extension never prompts for a
 * passphrase during normal use, and this screen only ever changes behaviour
 * when the user chooses to.
 *
 * On mount it reads the current {@link EncryptionStatus} (enabled? unlocked?)
 * and renders one of three states:
 *
 *   - DISABLED (the default) — a short explainer plus a "set master passphrase"
 *     form that is gated behind an explicit, unmissable no-recovery warning: if
 *     the passphrase is forgotten the encrypted data is gone for good, with no
 *     recovery and no backdoor (Req 8.10). The user must acknowledge that
 *     warning before the passphrase field is usable. Setting the passphrase
 *     enables encryption and unlocks the session in one step (Req 8.4).
 *   - ENABLED + LOCKED — encryption is on but this session has no key. An unlock
 *     form derives + verifies the passphrase against the stored verifier; a
 *     wrong passphrase is reported without touching stored data (Req 8.8, 8.9).
 *     A "turn off encryption" action is offered with a warning.
 *   - ENABLED + UNLOCKED — the session holds the key. The user can lock again
 *     (forget the in-session key) or disable encryption entirely.
 *
 * Throughout, a standing note communicates that non-encrypted stored data is
 * only as protected as the browser profile (Req 8.11), so the user understands
 * what "off" means.
 *
 * Like the rest of the options UI this component never touches storage or crypto
 * directly: it sends {@link UiRequest}s via {@link sendUi} and branches on the
 * typed result. The privileged work — deriving keys, writing the verifier,
 * holding the session key — lives in the background orchestrator (task 10.2).
 *
 * Requirements: 8.3, 8.4, 8.5, 8.6, 8.8, 8.10, 8.11
 */

import { useEffect, useState } from 'preact/hooks';

import { MessageType, type EncryptionStatus } from '../platform/messages';
import { sendUi } from '../platform/rpc';

export interface EncryptionSettingsProps {
  /** Return to the config list. */
  onBack: () => void;
}

export function EncryptionSettings(props: EncryptionSettingsProps) {
  const { onBack } = props;

  const [status, setStatus] = useState<EncryptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Re-read the current encryption status (Req 8.3, 8.4, 8.8). */
  async function refresh() {
    const result = await sendUi<EncryptionStatus>({
      type: MessageType.EncryptionStatus,
    });
    if (result.ok) {
      setStatus(result.value);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (loading) {
    return (
      <section>
        <h2>Encryption</h2>
        <p class="spinner">Loading…</p>
      </section>
    );
  }

  return (
    <section aria-label="Encryption settings">
      <h2>Encryption</h2>

      {/* Standing clarity about what "not encrypted" means (Req 8.11). */}
      <p class="muted">
        Encryption is optional and off by default. Fillibuster works fully
        without a passphrase. Configs that are not encrypted are stored in plain
        text and are only as protected as your browser profile — anyone with
        access to this profile can read them.
      </p>

      {status?.enabled === false ? (
        <DisabledView busy={busy} setBusy={setBusy} setError={setError} onChanged={refresh} />
      ) : status?.unlocked ? (
        <UnlockedView busy={busy} setBusy={setBusy} setError={setError} onChanged={refresh} />
      ) : (
        <LockedView busy={busy} setBusy={setBusy} setError={setError} onChanged={refresh} />
      )}

      {error ? <p class="error">{error}</p> : null}

      <div class="actions">
        <button disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
    </section>
  );
}

interface ViewProps {
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  /** Re-read status after a state change. */
  onChanged: () => Promise<void>;
}

/**
 * Encryption is OFF (the default). Explain what turning it on does, then gate a
 * "set master passphrase" form behind an explicit no-recovery acknowledgement
 * (Req 8.4, 8.10). Setting the passphrase enables encryption and unlocks the
 * session in one step.
 */
function DisabledView(props: ViewProps) {
  const { busy, setBusy, setError, onChanged } = props;

  // The no-recovery warning must be acknowledged before the passphrase can be
  // set (Req 8.10).
  const [acknowledged, setAcknowledged] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  async function enable(e: Event) {
    e.preventDefault();
    setLocalError(null);
    if (passphrase.length === 0) {
      setLocalError('Enter a passphrase.');
      return;
    }
    if (passphrase !== confirm) {
      setLocalError('The passphrases do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await sendUi({
      type: MessageType.EnableEncryption,
      passphrase,
    });
    setBusy(false);
    if (result.ok) {
      setPassphrase('');
      setConfirm('');
      setAcknowledged(false);
      await onChanged();
    } else {
      setError(result.error);
    }
  }

  return (
    <div class="subsection">
      <h3>Turn on encryption</h3>
      <p class="muted">
        Set a single master passphrase. You can then mark individual configs as
        encrypted; their field values are encrypted at rest with a key derived
        from your passphrase. The passphrase itself is never stored.
      </p>

      {/* Unmissable no-recovery warning, acknowledged before the form is usable
          (Req 8.10). */}
      <div class="warn-box" role="alert">
        <p>
          <strong>There is no recovery.</strong> If you forget this passphrase,
          any config you encrypt becomes permanently unreadable. Fillibuster has
          no recovery mechanism and no backdoor — by design.
        </p>
        <label class="keep-toggle">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={busy}
            onChange={(ev) =>
              setAcknowledged((ev.target as HTMLInputElement).checked)
            }
          />
          I understand there is no way to recover a forgotten passphrase.
        </label>
      </div>

      <form onSubmit={enable}>
        <div class="field">
          <label for="enc-passphrase">Master passphrase</label>
          <input
            id="enc-passphrase"
            type="password"
            autoComplete="new-password"
            value={passphrase}
            disabled={busy || !acknowledged}
            onInput={(ev) =>
              setPassphrase((ev.target as HTMLInputElement).value)
            }
          />
        </div>
        <div class="field">
          <label for="enc-passphrase-confirm">Confirm passphrase</label>
          <input
            id="enc-passphrase-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            disabled={busy || !acknowledged}
            onInput={(ev) => setConfirm((ev.target as HTMLInputElement).value)}
          />
        </div>
        {localError ? <p class="error">{localError}</p> : null}
        <div class="actions">
          <button
            class="primary"
            type="submit"
            disabled={busy || !acknowledged}
          >
            {busy ? 'Setting…' : 'Set passphrase & enable'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Encryption is ON but this session is LOCKED (no in-session key). Offer an
 * unlock form (Req 8.8, 8.9) and the ability to turn encryption off.
 */
function LockedView(props: ViewProps) {
  const { busy, setBusy, setError, onChanged } = props;

  const [passphrase, setPassphrase] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  async function unlock(e: Event) {
    e.preventDefault();
    setLocalError(null);
    setBusy(true);
    setError(null);
    const result = await sendUi({ type: MessageType.Unlock, passphrase });
    setBusy(false);
    if (result.ok) {
      setPassphrase('');
      await onChanged();
    } else if (result.code === 'wrong-passphrase') {
      setLocalError('Incorrect passphrase. Try again.');
    } else {
      setError(result.error);
    }
  }

  return (
    <div class="subsection">
      <h3>Locked</h3>
      <p class="muted">
        Encryption is on but this session is locked. Enter your master
        passphrase to work with encrypted configs.
      </p>
      <form onSubmit={unlock}>
        <div class="field">
          <label for="enc-unlock">Master passphrase</label>
          <input
            id="enc-unlock"
            type="password"
            autoComplete="current-password"
            value={passphrase}
            disabled={busy}
            onInput={(ev) =>
              setPassphrase((ev.target as HTMLInputElement).value)
            }
          />
        </div>
        {localError ? <p class="error">{localError}</p> : null}
        <div class="actions">
          <button class="primary" type="submit" disabled={busy}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </div>
      </form>

      <DisableEncryption {...props} onChanged={onChanged} />
    </div>
  );
}

/**
 * Encryption is ON and the session is UNLOCKED. Offer to lock (forget the
 * in-session key) or to disable encryption entirely.
 */
function UnlockedView(props: ViewProps) {
  const { busy, setBusy, setError, onChanged } = props;

  async function lock() {
    setBusy(true);
    setError(null);
    const result = await sendUi({ type: MessageType.Lock });
    setBusy(false);
    if (result.ok) {
      await onChanged();
    } else {
      setError(result.error);
    }
  }

  return (
    <div class="subsection">
      <h3>Unlocked</h3>
      <p class="ok">
        Encryption is on and this session is unlocked. You can mark configs as
        encrypted in the editor.
      </p>
      <div class="actions">
        <button disabled={busy} onClick={lock}>
          Lock now
        </button>
      </div>

      <DisableEncryption {...props} onChanged={onChanged} />
    </div>
  );
}

/**
 * Shared "turn off encryption" affordance, gated behind an inline confirmation
 * that warns any still-encrypted config can't be read until encryption is
 * re-enabled with the same passphrase (Req 8.4).
 */
function DisableEncryption(props: ViewProps) {
  const { busy, setBusy, setError, onChanged } = props;
  const [confirming, setConfirming] = useState(false);

  async function disable() {
    setBusy(true);
    setError(null);
    const result = await sendUi({ type: MessageType.DisableEncryption });
    setBusy(false);
    setConfirming(false);
    if (result.ok) {
      await onChanged();
    } else {
      setError(result.error);
    }
  }

  return (
    <div class="subsection">
      <h3>Turn off encryption</h3>
      {confirming ? (
        <div class="warn-box" role="alert">
          <p>
            Turning off encryption forgets your passphrase for this session. Any
            config you already encrypted stays encrypted at rest and will be
            unreadable until you turn encryption back on with the same
            passphrase. Continue?
          </p>
          <div class="actions">
            <button class="danger" disabled={busy} onClick={disable}>
              Turn off encryption
            </button>
            <button disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div class="actions">
          <button class="danger" disabled={busy} onClick={() => setConfirming(true)}>
            Turn off encryption
          </button>
        </div>
      )}
    </div>
  );
}
