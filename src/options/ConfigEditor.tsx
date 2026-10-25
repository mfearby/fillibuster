/**
 * The options editor view (task 12.2 — the full typed, reorderable editor).
 *
 * Grown from the 12.1 name-only shell: it still loads the config via GetConfig
 * (unless handed a freshly-created draft), keeps its own draft {@link FillConfig}
 * in local state so edits are cheap and only committed on Save (SaveConfig),
 * and offers Back. On top of that foundation it now edits everything a config
 * exposes (Req 6.2):
 *
 *   - name (the "Name" field, unchanged) and error strategy (stop/continue);
 *   - match rules, via {@link MatchRuleEditor} (Req 6.2);
 *   - the ordered, typed step list, via {@link StepEditor} — add a step of any
 *     type (id generated with `crypto.randomUUID()`), edit its common + type-
 *     specific fields, reorder with move up/down, and remove (Req 6.3, 6.4, 2.1).
 *
 * Save bumps `updatedAt` and sends the full edited {@link FillConfig} (Req 6.5).
 *
 * Encrypted configs (task 12.5): an encrypted stored config carries no plaintext
 * `steps` (they live in a cipher that needs the session key). The background
 * `GetConfig` handler decrypts on open when the session is unlocked, so the
 * editor receives a plaintext {@link FillConfig} and edits its steps normally;
 * on save they are re-encrypted. When the session is LOCKED, opening an
 * encrypted config returns `locked` and the editor prompts for the master
 * passphrase (Req 8.8) before loading. An "Encrypted" toggle lets the user mark
 * a config as sensitive (Req 8.6) — only offered once encryption is enabled and
 * the session is unlocked, since encrypting requires the key.
 *
 * Requirements: 2.1, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 8.6, 8.8
 */

import { useEffect, useState } from 'preact/hooks';

import type { FieldStep, FillConfig } from '../core/schema';
import { MessageType, type EncryptionStatus } from '../platform/messages';
import { sendUi } from '../platform/rpc';
import { MatchRuleEditor } from './MatchRuleEditor';
import { StepEditor } from './StepEditor';

export interface ConfigEditorProps {
  /** Existing config id to load, or undefined when opening a fresh `draft`. */
  configId?: string;
  /** A freshly-created config to edit without loading from storage. */
  draft?: FillConfig;
  /** Called after a successful save so the parent can refresh + return. */
  onSaved: () => void;
  /** Called to leave the editor without saving. */
  onBack: () => void;
}

/** Build a fresh step of the given type with a generated id (Req 2.1, 6.3). */
function newStep(type: FieldStep['type']): FieldStep {
  const base = { id: crypto.randomUUID(), target: { by: 'id' as const, value: '' } };
  switch (type) {
    case 'text':
      return { ...base, type: 'text', value: '' };
    case 'select':
      return { ...base, type: 'select', value: '', matchBy: 'value' };
    case 'check':
      return { ...base, type: 'check', checked: false };
    case 'radio':
      return { ...base, type: 'radio', value: '' };
    case 'contenteditable':
      return { ...base, type: 'contenteditable', html: '', allowHtml: false };
    case 'autocomplete':
      return {
        ...base,
        type: 'autocomplete',
        value: '',
        optionTarget: { by: 'css', value: '[role="option"]' },
        optionMatch: '',
        timeoutMs: 2000,
      };
    case 'button':
      return { ...base, type: 'button', matchBy: 'selector', text: '' };
  }
}

export function ConfigEditor(props: ConfigEditorProps) {
  const { configId, draft, onSaved, onBack } = props;

  const [config, setConfig] = useState<FillConfig | null>(draft ?? null);
  const [loading, setLoading] = useState(draft === undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Current encryption status, so the "Encrypted" toggle is only offered when
  // encryption is enabled + unlocked (Req 8.6).
  const [encStatus, setEncStatus] = useState<EncryptionStatus | null>(null);
  // Set when opening an encrypted config while the session is locked: holds the
  // pending unlock prompt (Req 8.8).
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  // Id of a just-added step that should scroll into view and focus its first
  // field when it mounts; cleared once that StepEditor consumes it.
  const [focusStepId, setFocusStepId] = useState<string | null>(null);

  /**
   * Load the stored config for editing (Req 6.2). The background decrypts an
   * encrypted config on the way out when the session is unlocked, so we receive
   * a plaintext {@link FillConfig}; a `locked` result means the session has no
   * key, so we show the unlock prompt instead of loading (Req 8.8).
   */
  async function load(): Promise<void> {
    if (configId === undefined) return;
    setLoading(true);
    setNeedsUnlock(false);
    const result = await sendUi<FillConfig>({
      type: MessageType.GetConfig,
      configId,
    });
    if (result.ok) {
      setConfig(result.value);
    } else if (result.code === 'locked') {
      setNeedsUnlock(true);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }

  // Load the stored config when editing an existing one (no draft supplied).
  useEffect(() => {
    if (draft !== undefined || configId === undefined) return;
    void load();
    // load() is stable for a given configId; deps intentionally minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configId, draft]);

  // Read encryption status so the "Encrypted" toggle knows whether it can offer
  // to encrypt (needs encryption enabled + an unlocked session — Req 8.6).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await sendUi<EncryptionStatus>({
        type: MessageType.EncryptionStatus,
      });
      if (!cancelled && result.ok) setEncStatus(result.value);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Submit the passphrase to unlock, then (re)load the config (Req 8.8, 8.9). */
  async function submitUnlock(passphrase: string) {
    setUnlockError(null);
    const result = await sendUi({ type: MessageType.Unlock, passphrase });
    if (result.ok) {
      setEncStatus((s) => (s ? { ...s, unlocked: true } : s));
      await load();
    } else if (result.code === 'wrong-passphrase') {
      setUnlockError('Incorrect passphrase. Try again.');
    } else {
      setUnlockError(result.error);
    }
  }

  // Marking a config encrypted needs encryption enabled AND the session
  // unlocked (the background encrypts with the in-session key on save — Req 8.6).
  const canEncrypt = encStatus?.enabled === true && encStatus.unlocked === true;

  function patch(next: Partial<FillConfig>) {
    setConfig((c) => (c ? { ...c, ...next } : c));
  }

  function addStep() {
    if (!config) return;
    // New steps default to a text step; the per-step Type selector changes it.
    const step = newStep('text');
    patch({ steps: [...config.steps, step] });
    // Ask the matching StepEditor to scroll into view and focus its first field
    // once it mounts, so adding a step lands the cursor where the user types.
    setFocusStepId(step.id);
  }

  function updateStep(index: number, step: FieldStep) {
    if (!config) return;
    patch({ steps: config.steps.map((s, i) => (i === index ? step : s)) });
  }

  function removeStep(index: number) {
    if (!config) return;
    patch({ steps: config.steps.filter((_, i) => i !== index) });
  }

  /** Swap the step at `index` with its neighbour at `index + delta` (Req 6.3). */
  function moveStep(index: number, delta: -1 | 1) {
    if (!config) return;
    const target = index + delta;
    if (target < 0 || target >= config.steps.length) return;
    const steps = config.steps.slice();
    const a = steps[index];
    const b = steps[target];
    if (a === undefined || b === undefined) return;
    steps[index] = b;
    steps[target] = a;
    patch({ steps });
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    const result = await sendUi({
      type: MessageType.SaveConfig,
      config: { ...config, updatedAt: Date.now() },
    });
    setSaving(false);
    if (result.ok) {
      onSaved();
    } else {
      setError(result.error);
    }
  }

  if (loading) {
    return (
      <section>
        <p class="spinner">Loading…</p>
      </section>
    );
  }

  // The session is locked and this config is encrypted: prompt to unlock before
  // editing (Req 8.8).
  if (needsUnlock) {
    return (
      <section aria-label="Unlock encrypted config">
        <h2>Unlock to edit</h2>
        <p class="muted">
          This config is encrypted. Enter your master passphrase to edit it.
        </p>
        <UnlockPrompt error={unlockError} onSubmit={submitUnlock} onBack={onBack} />
      </section>
    );
  }

  if (!config) {
    return (
      <section>
        <p class="error">{error ?? 'Could not load this config.'}</p>
        <div class="actions">
          <button onClick={onBack}>Back</button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2>Edit config</h2>

      <div class="field">
        <label for="config-name">Name</label>
        <input
          id="config-name"
          type="text"
          value={config.name}
          disabled={saving}
          onInput={(e) =>
            patch({ name: (e.target as HTMLInputElement).value })
          }
        />
      </div>

      <div class="field">
        <label for="config-error-strategy">Error strategy</label>
        <select
          id="config-error-strategy"
          value={config.errorStrategy}
          disabled={saving}
          onChange={(e) =>
            patch({
              errorStrategy: (e.target as HTMLSelectElement)
                .value as FillConfig['errorStrategy'],
            })
          }
        >
          <option value="stop">Stop on first failure</option>
          <option value="continue">Continue past failures</option>
        </select>
      </div>

      {/* Mark a config as encrypted (Req 8.6). Only actionable once encryption
          is enabled and the session is unlocked; otherwise disabled with a hint
          pointing at the Encryption settings. */}
      <div class="field field-inline">
        <input
          id="config-encrypted"
          type="checkbox"
          checked={config.encrypted}
          disabled={saving || (!canEncrypt && !config.encrypted)}
          onChange={(e) =>
            patch({ encrypted: (e.target as HTMLInputElement).checked })
          }
        />
        <label for="config-encrypted">
          Encrypt this config's values at rest
        </label>
      </div>
      {!canEncrypt ? (
        <p class="muted">
          Enable encryption and unlock the session (Encryption settings) to
          store this config's values encrypted.
        </p>
      ) : null}

      <MatchRuleEditor
        rules={config.match}
        disabled={saving}
        onChange={(match) => patch({ match })}
      />

      <div class="subsection">
        <div class="subsection-head">
          <h3>Steps</h3>
          <button type="button" disabled={saving} onClick={addStep}>
            Add step
          </button>
        </div>

        {config.steps.length === 0 ? (
          <p class="muted">No steps yet. Add one to define what to fill.</p>
        ) : (
          <ul class="step-list">
            {config.steps.map((step, index) => (
              <StepEditor
                key={step.id}
                step={step}
                index={index}
                isFirst={index === 0}
                isLast={index === config.steps.length - 1}
                disabled={saving}
                autoFocus={step.id === focusStepId}
                onChange={(s) => updateStep(index, s)}
                onMoveUp={() => moveStep(index, -1)}
                onMoveDown={() => moveStep(index, 1)}
                onRemove={() => removeStep(index)}
                onFocused={() => setFocusStepId(null)}
              />
            ))}
          </ul>
        )}
      </div>

      {error ? <p class="error">{error}</p> : null}

      <div class="actions">
        <button class="primary" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button disabled={saving} onClick={onBack}>
          Back
        </button>
      </div>
    </section>
  );
}

/**
 * Master-passphrase entry shown when opening an encrypted config while the
 * session is locked (Req 8.8). Mirrors the popup's prompt: a wrong passphrase
 * keeps the form open with an inline message (Req 8.9) and never mutates
 * anything stored.
 */
function UnlockPrompt(props: {
  error: string | null;
  onSubmit: (passphrase: string) => void;
  onBack: () => void;
}) {
  const [value, setValue] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit(value);
      }}
    >
      <div class="field">
        <label for="editor-unlock">Master passphrase</label>
        <input
          id="editor-unlock"
          type="password"
          autoComplete="current-password"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
      </div>
      {props.error ? <p class="error">{props.error}</p> : null}
      <div class="actions">
        <button class="primary" type="submit">
          Unlock
        </button>
        <button type="button" onClick={props.onBack}>
          Back
        </button>
      </div>
    </form>
  );
}
