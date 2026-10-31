/**
 * Import configs dialog (task 12.4, extended for whole-store backups).
 *
 * Opened from the list toolbar's "Import" action. Accepts either a backup file
 * (every config, from "Back up all") or a single exported config, three ways:
 *
 *   - Browse: a "Browse…" button opens the system file picker;
 *   - Drag and drop: drop a `.json` file anywhere on the drop zone;
 *   - Paste: paste the JSON text and press "Import pasted text".
 *
 * A picked or dropped file is imported straight away (no extra click). The text
 * goes to the background's `ImportConfigs`, which validates the WHOLE input
 * first — an invalid file stores nothing (Req 7.4) — and adds every config as
 * new, renaming on a name collision and re-iding on an id collision, so no
 * existing config is ever overwritten (Req 7.5).
 *
 * Requirements: 7.3, 7.4, 7.5
 */

import { useRef, useState } from 'preact/hooks';

import {
  MessageType,
  type ImportConfigsResult,
  type ImportedConfigSummary,
} from '../platform/messages';
import { sendUi } from '../platform/rpc';
import { readFileText } from './files';

/** Refuse anything implausibly large for a config file before reading it. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface ImportDialogProps {
  /** Called after a successful import so the parent can refresh its list. */
  onImported: () => void;
  /** Close the dialog and return to the list. */
  onClose: () => void;
}

export function ImportDialog(props: ImportDialogProps) {
  const { onImported, onClose } = props;

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [imported, setImported] = useState<ImportedConfigSummary[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Send import text to the background; show the result or the error. */
  async function runImport(input: string) {
    setBusy(true);
    setError(null);
    const result = await sendUi<ImportConfigsResult>({
      type: MessageType.ImportConfigs,
      text: input,
    });
    setBusy(false);
    if (result.ok) {
      setImported(result.value.imported);
      onImported();
    } else {
      setError(result.error);
    }
  }

  /** Read a picked or dropped file and import its contents. */
  async function importFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(`"${file.name}" is too large to be a Fillibuster file.`);
      return;
    }
    let contents: string;
    try {
      contents = await readFileText(file);
    } catch {
      setError(`Could not read "${file.name}".`);
      return;
    }
    await runImport(contents);
  }

  if (imported !== null) {
    return (
      <section aria-label="Import configs">
        <h2>Import configs</h2>
        <ImportSummary imported={imported} />
        <p class="muted">
          Imported configs are stored <strong>unencrypted</strong>. To protect a
          config's values at rest, open it and tick “Encrypt this config's
          values at rest”.
        </p>
        <div class="actions">
          <button class="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Import configs">
      <h2>Import configs</h2>
      <p class="subtitle">
        Import a backup file (all configs) or a single exported config. Every
        config is added as new; nothing you already have is overwritten.
      </p>

      <div
        class={`drop-zone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy) void importFile(e.dataTransfer?.files?.[0]);
        }}
      >
        <p>Drop a Fillibuster .json file here, or</p>
        <button
          type="button"
          class="primary"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          {busy ? 'Importing…' : 'Browse…'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          class="visually-hidden"
          accept=".json,application/json"
          aria-label="Choose a file to import"
          tabIndex={-1}
          disabled={busy}
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            void importFile(input.files?.[0]);
            // Allow picking the same file again after an error.
            input.value = '';
          }}
        />
      </div>

      <div class="field">
        <label for="import-text">Or paste a config or backup (JSON)</label>
        <textarea
          id="import-text"
          class="import-text"
          rows={8}
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
          disabled={busy || text.trim().length === 0}
          onClick={() => void runImport(text)}
        >
          Import pasted text
        </button>
        <button disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** What was added, noting any config renamed to avoid a clash. */
function ImportSummary(props: { imported: ImportedConfigSummary[] }) {
  const { imported } = props;
  if (imported.length === 1) {
    const only = imported[0]!;
    return (
      <p class="ok" role="status">
        Added as "{only.name}".
        {only.renamed ? ` (renamed from "${only.originalName}")` : ''}
      </p>
    );
  }
  return (
    <>
      <p class="ok" role="status">
        Imported {imported.length} configs.
      </p>
      <ul class="import-results">
        {imported.map((c) => (
          <li key={c.id}>
            {c.name}
            {c.renamed ? (
              <span class="muted"> (renamed from "{c.originalName}")</span>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
