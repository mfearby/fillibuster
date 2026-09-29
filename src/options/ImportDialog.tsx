/**
 * Import-a-config dialog (task 12.4).
 *
 * Opened from the list toolbar's "Import config" action, this dialog lets a
 * developer paste an exported JSON envelope (produced by {@link ExportDialog})
 * and add it as a NEW config (Req 7.3). The paste is handed to the background's
 * `ImportConfig`, which validates and version-gates the envelope and, on a name
 * collision, keeps both by renaming rather than overwriting (Req 7.5).
 *
 * Two outcomes are surfaced:
 *   - SUCCESS: the returned {@link StoredConfig} carries the resolved name (which
 *     may differ from the pasted one when a collision was kept-both). We show
 *     "Added as <name>" and ask the parent to refresh the list (Req 7.3, 7.5).
 *   - FAILURE: malformed / invalid / incompatible text is rejected with a clear
 *     error and the existing configs are left untouched — the background never
 *     stores anything on failure, so there's nothing to undo here (Req 7.4).
 *
 * Like the rest of the options UI this component is presentational: it owns the
 * transient paste / busy / result state and delegates the privileged round-trip
 * to {@link sendUi}.
 *
 * Requirements: 7.3, 7.4, 7.5
 */

import { useState } from 'preact/hooks';

import type { StoredConfig } from '../core/schema';
import { MessageType } from '../platform/messages';
import { sendUi } from '../platform/rpc';

export interface ImportDialogProps {
  /**
   * Called after a successful import so the parent can refresh the list and
   * reflect the newly-added config (Req 7.3).
   */
  onImported: (config: StoredConfig) => void;
  /** Close the dialog and return to the list. */
  onClose: () => void;
}

export function ImportDialog(props: ImportDialogProps) {
  const { onImported, onClose } = props;

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The resolved name of the config we just added, shown as confirmation.
  const [addedName, setAddedName] = useState<string | null>(null);

  /**
   * Validate + store the pasted envelope (Req 7.3). On success we surface the
   * resolved name and tell the parent to refresh; on failure we show the error
   * and leave the list untouched (Req 7.4).
   */
  async function runImport() {
    setBusy(true);
    setError(null);
    const result = await sendUi<StoredConfig>({
      type: MessageType.ImportConfig,
      text,
    });
    if (result.ok) {
      setAddedName(result.value.name);
      onImported(result.value);
    } else {
      setError(result.error);
    }
    setBusy(false);
  }

  return (
    <section aria-label="Import config">
      <h2>Import config</h2>

      {addedName !== null ? (
        <>
          <p class="ok">Added as "{addedName}".</p>
          <div class="actions">
            <button class="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <p class="subtitle">
            Paste an exported config below to add it as a new config.
          </p>
          <div class="field">
            <label for="import-text">Exported config (JSON)</label>
            <textarea
              id="import-text"
              class="import-text"
              rows={12}
              disabled={busy}
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            />
          </div>

          {error ? (
            <p class="error" role="alert">
              {error}
            </p>
          ) : null}

          <div class="actions">
            <button
              class="primary"
              disabled={busy || text.trim().length === 0}
              onClick={runImport}
            >
              {busy ? 'Importing…' : 'Add config'}
            </button>
            <button disabled={busy} onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}
