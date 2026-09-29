/**
 * Export-a-config dialog (task 12.4).
 *
 * Opened from a config row's "Export" action, this dialog turns a stored config
 * into a portable JSON envelope the user can share (Req 7.1, 7.2). The flow has
 * two safety-relevant shapes:
 *
 *   - For an ENCRYPTED config (its {@link ConfigSummary.encrypted} is true) the
 *     dialog FIRST shows a warning that the export will include the config's
 *     values in plain text, and only runs the export after the user explicitly
 *     confirms (Req 7.7). The actual decryption happens in the background
 *     (`ExportConfig` resolves the cipher to plaintext); the UI's job is the
 *     up-front warning + consent.
 *   - For a plaintext config the dialog exports immediately on open.
 *
 * On a successful `ExportConfig` the returned JSON envelope is copied to the
 * clipboard via `navigator.clipboard.writeText` (Req 7.2) and a "Copied to
 * clipboard" confirmation is shown. Because the clipboard API can be
 * unavailable (missing permission, insecure context, older engine), the
 * envelope is also rendered into a readonly textarea the user can select and
 * copy manually — so export never dead-ends.
 *
 * If the session is locked an encrypted export fails with code `locked`; we
 * surface that message so the user knows to unlock (the unlock UI itself is
 * task 12.5).
 *
 * The component is presentational + self-contained: it owns the transient
 * warning / copying / result state and delegates the privileged round-trip to
 * {@link sendUi}, mirroring the rest of the options UI.
 *
 * Requirements: 7.1, 7.2, 7.7
 */

import { useEffect, useState } from 'preact/hooks';

import { MessageType, type ConfigSummary } from '../platform/messages';
import { sendUi } from '../platform/rpc';

export interface ExportDialogProps {
  /** The config to export (id + name + whether it's encrypted). */
  config: ConfigSummary;
  /** Close the dialog and return to the list. */
  onClose: () => void;
}

/** Copy `text` to the clipboard, returning false when the API is unavailable. */
async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ExportDialog(props: ExportDialogProps) {
  const { config, onClose } = props;

  // An encrypted config requires explicit consent before we export plaintext
  // (Req 7.7); a plaintext config is exported straight away.
  const [confirmed, setConfirmed] = useState(!config.encrypted);
  const [busy, setBusy] = useState(false);
  const [envelope, setEnvelope] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Run the export: fetch the envelope, then try to copy it (Req 7.1, 7.2). */
  async function runExport() {
    setBusy(true);
    setError(null);
    const result = await sendUi<string>({
      type: MessageType.ExportConfig,
      configId: config.id,
    });
    if (result.ok) {
      setEnvelope(result.value);
      setCopied(await copyToClipboard(result.value));
    } else {
      setError(result.error);
    }
    setBusy(false);
  }

  // Auto-run the export for a plaintext config; an encrypted one waits for the
  // user to confirm the plaintext warning first.
  useEffect(() => {
    if (confirmed) void runExport();
    // Only re-run when consent flips to true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmed]);

  const heading = `Export "${config.name || 'Untitled config'}"`;

  return (
    <section aria-label={heading}>
      <h2>{heading}</h2>

      {!confirmed ? (
        <div class="warn-box" role="alert">
          <p>
            This config is encrypted. Exporting it will include its values in
            plain text, so anyone you share the exported config with can read
            them. Only continue if you intend to share these values.
          </p>
          <div class="actions">
            <button
              class="primary"
              disabled={busy}
              onClick={() => setConfirmed(true)}
            >
              Export in plain text
            </button>
            <button disabled={busy} onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {confirmed && busy ? <p class="spinner">Exporting…</p> : null}

      {error ? <p class="error">{error}</p> : null}

      {envelope !== null ? (
        <>
          <p class={copied ? 'ok' : 'muted'}>
            {copied
              ? 'Copied to clipboard.'
              : 'Copy the exported config below.'}
          </p>
          <div class="field">
            <label for="export-envelope">Exported config (JSON)</label>
            <textarea
              id="export-envelope"
              class="export-envelope"
              readOnly
              rows={12}
              value={envelope}
            />
          </div>
          <div class="actions">
            <button class="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : null}

      {confirmed && !busy && envelope === null && error !== null ? (
        <div class="actions">
          <button onClick={onClose}>Back</button>
        </div>
      ) : null}
    </section>
  );
}
