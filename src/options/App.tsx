/**
 * Fillibuster options / management UI (task 12).
 *
 * The options page is the home for full config management. This is the 12.1
 * shell: a list of every saved config with create / open / delete-with-confirm,
 * plus a minimal name-only editor. Later subtasks grow inside the same
 * structure — the typed step editor (12.2), capture (12.3), import/export
 * (12.4), and encryption settings (12.5) — so the view state and RPC plumbing
 * established here are the foundation.
 *
 * Navigation is a plain `useState` machine rather than a router: the app is
 * either in the `list` view (default) or the `editor` view for one config. The
 * editor receives either an existing config id (loaded via GetConfig) or a
 * freshly-created {@link FillConfig} draft, so "New config" opens immediately
 * without persisting an empty config first — it's only stored when the user
 * saves.
 *
 * Like the popup, this UI never touches storage/crypto directly: every action
 * is a {@link sendUi} call returning a typed {@link OrchestratorResult} we
 * branch on (Req 6.1, 6.6).
 *
 * Requirements: 6.1, 6.6
 */

import { useEffect, useState } from 'preact/hooks';

import type { FillConfig } from '../core/schema';
import { MessageType, type ConfigSummary } from '../platform/messages';
import { sendUi } from '../platform/rpc';
import { ConfigEditor } from './ConfigEditor';
import { ConfigList } from './ConfigList';
import { EncryptionSettings } from './EncryptionSettings';
import { ExportDialog } from './ExportDialog';
import { ImportDialog } from './ImportDialog';
import { ThemeToggle } from '../ui/ThemeToggle';

/**
 * The list view (default), the editor view for a specific config / new draft,
 * or the export / import dialogs for sharing configs (task 12.4).
 */
type View =
  | { kind: 'list' }
  | { kind: 'editor'; configId?: string; draft?: FillConfig }
  | { kind: 'export'; config: ConfigSummary }
  | { kind: 'import' }
  | { kind: 'encryption' };

/** Build a fresh, empty config with sensible defaults (Req 6.1). */
function newConfig(): FillConfig {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: 'New config',
    match: [],
    steps: [],
    errorStrategy: 'stop',
    encrypted: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function App() {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Fetch the full config list (Req 6.1). Shared by mount + post-mutation refresh. */
  async function refresh() {
    setError(null);
    const result = await sendUi<ConfigSummary[]>({
      type: MessageType.ListConfigs,
    });
    if (result.ok) {
      setConfigs(result.value);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  function openNew() {
    setView({ kind: 'editor', draft: newConfig() });
  }

  function openExisting(configId: string) {
    setView({ kind: 'editor', configId });
  }

  /** Delete a confirmed config, then refresh the list (Req 6.6). */
  async function deleteConfig(configId: string) {
    setBusy(true);
    setError(null);
    const result = await sendUi<null>({
      type: MessageType.DeleteConfig,
      configId,
    });
    if (!result.ok) {
      setError(result.error);
    }
    await refresh();
    setBusy(false);
  }

  /** Return to the list after a save and reflect the change (Req 6.5, shown here as list refresh). */
  async function backToList() {
    setView({ kind: 'list' });
    await refresh();
  }

  /** Open the export dialog for a config (Req 7.1, 7.2, 7.7). */
  function openExport(config: ConfigSummary) {
    setView({ kind: 'export', config });
  }

  /** Open the import-by-paste dialog (Req 7.3). */
  function openImport() {
    setView({ kind: 'import' });
  }

  /** Open the encryption settings view (Req 8.4, 8.8, 8.10, 8.11). */
  function openEncryption() {
    setView({ kind: 'encryption' });
  }

  /**
   * After a successful import, refresh the underlying list data so the new
   * config is reflected once the dialog closes, but keep the dialog open so it
   * can show its "Added as <name>" confirmation (Req 7.3, 7.5). The dialog's
   * own Done button returns to the list.
   */
  async function afterImport() {
    await refresh();
  }

  if (view.kind === 'editor') {
    return (
      <main>
        <ConfigEditor
          configId={view.configId}
          draft={view.draft}
          onSaved={backToList}
          onBack={() => setView({ kind: 'list' })}
        />
      </main>
    );
  }

  if (view.kind === 'export') {
    return (
      <main>
        <ExportDialog
          config={view.config}
          onClose={() => setView({ kind: 'list' })}
        />
      </main>
    );
  }

  if (view.kind === 'import') {
    return (
      <main>
        <ImportDialog
          onImported={() => void afterImport()}
          onClose={() => setView({ kind: 'list' })}
        />
      </main>
    );
  }

  if (view.kind === 'encryption') {
    // Encryption state can change whether configs are lockable, so refresh the
    // list on the way back (Req 8.4, 8.6).
    return (
      <main>
        <EncryptionSettings onBack={() => void backToList()} />
      </main>
    );
  }

  return (
    <main>
      <header class="app-header">
        <ThemeToggle />
      </header>
      {loading ? (
        <p class="spinner">Loading…</p>
      ) : (
        <ConfigList
          configs={configs}
          busy={busy}
          onNew={openNew}
          onOpen={openExisting}
          onDelete={deleteConfig}
          onExport={openExport}
          onImport={openImport}
          onEncryption={openEncryption}
        />
      )}
      {error ? <p class="error">{error}</p> : null}
    </main>
  );
}
