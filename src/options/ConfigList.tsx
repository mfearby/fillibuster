/**
 * The options list view (task 12.1).
 *
 * Renders every saved config as a row (name + encrypted indicator) with "Edit"
 * and "Delete" actions (Req 6.1). Delete is a two-step affordance: the first
 * click swaps the row's actions for an inline "Delete? / Cancel" confirmation so
 * a config is never removed on a single accidental click (Req 6.6). Only when
 * the user confirms does the parent's {@link ConfigListProps.onDelete} fire.
 *
 * This component is presentational: it owns only the transient
 * "which row is awaiting confirmation" state and delegates the actual
 * ListConfigs/DeleteConfig calls to {@link App} via callbacks, so later
 * subtasks can reuse the same list without duplicating the RPC plumbing.
 *
 * Task 12.4 adds an "Import config" action to the toolbar and an "Export"
 * action per row; both delegate to {@link App}, which opens the respective
 * dialog (Req 7.1, 7.2, 7.3).
 *
 * Requirements: 6.1, 6.6, 7.1, 7.2, 7.3
 */

import { useState } from 'preact/hooks';

import type { ConfigSummary } from '../platform/messages';

export interface ConfigListProps {
  configs: ConfigSummary[];
  /** True while a refresh/delete round-trip is in flight (disables actions). */
  busy: boolean;
  onNew: () => void;
  onOpen: (configId: string) => void;
  onDelete: (configId: string) => void;
  /** Export a config as a shareable JSON envelope (Req 7.1, 7.2). */
  onExport: (config: ConfigSummary) => void;
  /** Open the import dialog (file, drag-and-drop, or paste) (Req 7.3). */
  onImport: () => void;
  /** Download every config as one backup file. */
  onBackup: () => void;
  /** Success message (e.g. after a backup), shown under the toolbar. */
  notice?: string | null;
  /** Error message, shown under the toolbar where it can't be missed. */
  error?: string | null;
  /** Open the encryption settings view (Req 8.4, 8.8, 8.10). */
  onEncryption: () => void;
}

export function ConfigList(props: ConfigListProps) {
  const {
    configs,
    busy,
    onNew,
    onOpen,
    onDelete,
    onExport,
    onImport,
    onBackup,
    onEncryption,
    notice,
    error,
  } = props;

  // Which row (if any) is showing its inline delete confirmation (Req 6.6).
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  function confirmDelete(configId: string) {
    setConfirmingId(null);
    onDelete(configId);
  }

  return (
    <section>
      <h1>Fillibuster</h1>
      <p class="subtitle">Manage your saved fill configs.</p>

      <div class="toolbar">
        <button class="primary" disabled={busy} onClick={onNew}>
          New config
        </button>
        <button disabled={busy} onClick={onImport}>
          Import
        </button>
        <button
          disabled={busy || configs.length === 0}
          title="Download every config as one file you can import later"
          onClick={onBackup}
        >
          Back up all
        </button>
        <button disabled={busy} onClick={onEncryption}>
          Encryption
        </button>
      </div>

      {notice ? (
        <p class="ok list-message" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p class="error list-message" role="alert">
          {error}
        </p>
      ) : null}

      {configs.length === 0 ? (
        <div class="empty">
          No configs yet. Create one to get started.
        </div>
      ) : (
        <ul class="config-list">
          {configs.map((config) => (
            <li key={config.id} class="config-row">
              <span class="config-name">
                {config.name || 'Untitled config'}
                {config.encrypted ? (
                  <span
                    class="lock-icon"
                    title="Encrypted at rest"
                    aria-label="Encrypted at rest"
                  >
                    {' '}
                    🔒
                  </span>
                ) : (
                  // Explicit plaintext marker so an un-encrypted config (e.g. a
                  // freshly imported one) is obvious rather than silent.
                  <span
                    class="plain-tag"
                    title="Stored unencrypted. Open the config and tick 'Encrypt this config's values at rest' to protect it."
                  >
                    not encrypted
                  </span>
                )}
              </span>

              {confirmingId === config.id ? (
                <span class="confirm">
                  <span class="confirm-text">Delete this config?</span>
                  <button
                    class="danger"
                    disabled={busy}
                    onClick={() => confirmDelete(config.id)}
                  >
                    Delete
                  </button>
                  <button disabled={busy} onClick={() => setConfirmingId(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <span class="row-actions">
                  <button disabled={busy} onClick={() => onOpen(config.id)}>
                    Edit
                  </button>
                  <button disabled={busy} onClick={() => onExport(config)}>
                    Export
                  </button>
                  <button
                    class="danger"
                    disabled={busy}
                    onClick={() => setConfirmingId(config.id)}
                  >
                    Delete
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
