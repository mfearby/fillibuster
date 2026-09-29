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
 * Encrypted configs: an encrypted stored config carries no plaintext `steps`
 * (they live in a cipher that needs the session key). Decrypt-on-open in the
 * editor is task 12.5; until then this view stays graceful — it edits the
 * plaintext fields (name, match, error strategy) and shows a note that steps
 * can't be edited while locked, rather than silently dropping ciphertext.
 *
 * Requirements: 2.1, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { useEffect, useState } from 'preact/hooks';

import type { FieldStep, FillConfig, StoredConfig } from '../core/schema';
import { MessageType } from '../platform/messages';
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

/**
 * Normalise a {@link StoredConfig} into an editable {@link FillConfig}. An
 * encrypted stored config has no plaintext `steps` (they live in a cipher);
 * we edit around an empty step list and surface a "locked" note in the step
 * editor. Decrypt-on-open is task 12.5.
 */
function toEditable(stored: StoredConfig): FillConfig {
  if (stored.encrypted) {
    const { cipher: _cipher, ...rest } = stored;
    return { ...rest, steps: [] };
  }
  return stored;
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
    case 'contenteditable':
      return { ...base, type: 'contenteditable', html: '', allowHtml: false };
  }
}

export function ConfigEditor(props: ConfigEditorProps) {
  const { configId, draft, onSaved, onBack } = props;

  const [config, setConfig] = useState<FillConfig | null>(draft ?? null);
  const [loading, setLoading] = useState(draft === undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The type chosen in the "add step" control (independent of the draft).
  const [addType, setAddType] = useState<FieldStep['type']>('text');

  // Load the stored config when editing an existing one (no draft supplied).
  useEffect(() => {
    if (draft !== undefined || configId === undefined) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const result = await sendUi<StoredConfig>({
        type: MessageType.GetConfig,
        configId,
      });
      if (cancelled) return;
      if (result.ok) {
        setConfig(toEditable(result.value));
      } else {
        setError(result.error);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [configId, draft]);

  // An encrypted config's plaintext steps aren't available while locked.
  const stepsLocked = config?.encrypted ?? false;

  function patch(next: Partial<FillConfig>) {
    setConfig((c) => (c ? { ...c, ...next } : c));
  }

  function addStep() {
    if (!config) return;
    patch({ steps: [...config.steps, newStep(addType)] });
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
    const result = await sendUi<StoredConfig>({
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

      <MatchRuleEditor
        rules={config.match}
        disabled={saving}
        onChange={(match) => patch({ match })}
      />

      <div class="subsection">
        <div class="subsection-head">
          <h3>Steps</h3>
          {!stepsLocked ? (
            <span class="add-step">
              <label class="visually-hidden" for="add-step-type">
                New step type
              </label>
              <select
                id="add-step-type"
                value={addType}
                disabled={saving}
                onChange={(e) =>
                  setAddType(
                    (e.target as HTMLSelectElement).value as FieldStep['type'],
                  )
                }
              >
                <option value="text">text</option>
                <option value="select">select</option>
                <option value="check">check</option>
                <option value="contenteditable">contenteditable</option>
              </select>
              <button type="button" disabled={saving} onClick={addStep}>
                Add step
              </button>
            </span>
          ) : null}
        </div>

        {stepsLocked ? (
          <p class="muted">
            This config is encrypted. Its steps can't be edited while locked.
          </p>
        ) : config.steps.length === 0 ? (
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
                onChange={(s) => updateStep(index, s)}
                onMoveUp={() => moveStep(index, -1)}
                onMoveDown={() => moveStep(index, 1)}
                onRemove={() => removeStep(index)}
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
