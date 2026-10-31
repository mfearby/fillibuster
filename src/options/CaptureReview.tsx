/**
 * The capture review view (task 12.3, Req 2.2, 2.4, 2.5, 2.6).
 *
 * After the options page asks the background to run an assisted capture on a
 * tab, the returned {@link CaptureCandidate}s land here for review BEFORE
 * anything is saved. Capture never auto-saves (Req 2.5): the developer prunes
 * (uncheck a candidate to drop it), edits (each kept candidate's step is a full
 * {@link FieldStep} editable through the shared {@link StepEditor}), and only
 * then builds a config from the fields they chose to keep.
 *
 * Each candidate carries the pre-populated step (its derived selector, control
 * type, and current value read at capture time — Req 2.4) plus a `fragile` flag
 * set when only a brittle positional selector could be built (Req 2.6). Fragile
 * candidates are visibly warned so the developer can fix the selector or remove
 * the step.
 *
 * "Create config from kept fields" builds a draft {@link FillConfig} whose
 * `steps` are ONLY the kept candidates' (edited) steps and hands it to the
 * parent, which opens it in the {@link ConfigEditor} as an unsaved draft — the
 * developer still explicitly Saves, honouring "review before save" (Req 2.5).
 *
 * Requirements: 2.2, 2.4, 2.5, 2.6
 */

import { useState } from 'preact/hooks';

import type { CaptureCandidate } from '../content/capture';
import type { FieldStep, FillConfig } from '../core/schema';
import { StepEditor } from './StepEditor';

export interface CaptureReviewProps {
  /** The candidates returned by the assisted capture (Req 2.2). */
  candidates: CaptureCandidate[];
  /**
   * Called with a draft config built from the kept, edited steps. The parent
   * opens it in the editor as an unsaved draft so the user still Saves (Req 2.5).
   */
  onCreate: (draft: FillConfig) => void;
  /** Called to discard the capture and return without saving. */
  onCancel: () => void;
}

/** Editable state for one candidate: its (mutable) step, kept flag, and fragility. */
interface ReviewItem {
  step: FieldStep;
  keep: boolean;
  fragile: boolean;
}

/** Build a fresh draft config whose steps are exactly `steps` (Req 2.5). */
function draftFromSteps(steps: FieldStep[]): FillConfig {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: 'Captured config',
    match: [],
    steps,
    errorStrategy: 'stop',
    encrypted: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function CaptureReview(props: CaptureReviewProps) {
  const { candidates, onCreate, onCancel } = props;

  // Seed one review item per candidate; every candidate is kept by default so
  // the developer prunes rather than opts in one by one (Req 2.5).
  const [items, setItems] = useState<ReviewItem[]>(() =>
    candidates.map((c) => ({ step: c.step, keep: true, fragile: c.fragile })),
  );

  function setItem(index: number, patch: Partial<ReviewItem>) {
    setItems((prev) =>
      prev.map((it, i) => (i === index ? { ...it, ...patch } : it)),
    );
  }

  const keptCount = items.filter((it) => it.keep).length;

  function create() {
    const steps = items.filter((it) => it.keep).map((it) => it.step);
    onCreate(draftFromSteps(steps));
  }

  return (
    <section>
      <h2>Review captured fields</h2>
      <p class="subtitle">
        Capture found {items.length}{' '}
        {items.length === 1 ? 'control' : 'controls'}. Keep only the fields you
        want, edit them if needed, then create a config. Nothing is saved until
        you save the config.
      </p>

      {items.length === 0 ? (
        <div class="empty">
          No fillable controls were found on that page.
        </div>
      ) : (
        <ul class="capture-list">
          {items.map((item, index) => (
            <li
              key={item.step.id}
              class={`capture-item${item.keep ? '' : ' dropped'}`}
            >
              <div class="capture-item-head">
                <label class="keep-toggle">
                  <input
                    type="checkbox"
                    checked={item.keep}
                    aria-label={`Keep field ${index + 1}`}
                    onChange={(e) =>
                      setItem(index, {
                        keep: (e.target as HTMLInputElement).checked,
                      })
                    }
                  />
                  <span>Keep</span>
                </label>
                {item.fragile ? (
                  <span class="fragile-warning" role="alert">
                    ⚠ Fragile selector — fix or remove this field before saving.
                  </span>
                ) : null}
              </div>

              {item.keep ? (
                <ul class="step-list">
                  <StepEditor
                    step={item.step}
                    index={index}
                    isFirst
                    isLast
                    onChange={(step) => setItem(index, { step })}
                    onMoveUp={() => undefined}
                    onMoveDown={() => undefined}
                    onRemove={() => setItem(index, { keep: false })}
                    headingLevel={3}
                  />
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div class="actions">
        <button class="primary" disabled={keptCount === 0} onClick={create}>
          Create config from {keptCount}{' '}
          {keptCount === 1 ? 'field' : 'fields'}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
