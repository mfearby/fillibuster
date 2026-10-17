/**
 * Fillibuster popup (task 11).
 *
 * Opens on the toolbar click. On mount it resolves the active tab, asks the
 * background orchestrator which saved configs match that tab's URL, and shows
 * them (Req 5.1, 5.2). Each config has a Run button that relays a `runFill` and
 * renders the returned per-step summary — succeeded/failed counts and a reason
 * for every failed step (Req 5.4, 9.1). A "running…" state during the await is
 * the popup's live feedback.
 *
 * The popup never touches storage, crypto, or the content script directly: it
 * only sends {@link UiRequest}s via {@link sendUi} and branches on the typed
 * {@link OrchestratorResult}. That keeps the passphrase/lock logic on the
 * background where the key lives — when a run returns `locked` (an encrypted
 * config, session with no key) the popup prompts for the master passphrase,
 * sends `unlock`, and retries the run on success (Req 8.8), showing a clear
 * message on a wrong passphrase (Req 8.9). `restricted`/`no-tab` results become
 * plain "can't run here" messages rather than silent failures (Req 9.4).
 *
 * When nothing matches, the popup offers "Capture this page" and "Open
 * settings", both routed through the options page via `openOptionsPage` (Req
 * 5.6).
 *
 * Requirements: 5.1, 5.2, 5.4, 5.6, 8.8, 8.9, 9.1, 9.4
 */

import { useEffect, useState } from 'preact/hooks';

import type { OrchestratorResult } from '../background/orchestrator';
import browser from '../platform/browser';
import { MessageType, type ConfigSummary } from '../platform/messages';
import { sendUi } from '../platform/rpc';
import { ThemeToggle } from '../ui/ThemeToggle';
import type { FillSummary } from '../content/fill';

/** Query the active tab in the current window and return its id (Req 5.1). */
async function getActiveTabId(): Promise<number | undefined> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

/** Which config, if any, is mid-run — drives the per-row "running…" state. */
interface RunState {
  configId: string;
}

/** A pending unlock prompt: the config the user was trying to run when locked. */
interface UnlockState {
  configId: string;
  error?: string;
}

export function App() {
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [running, setRunning] = useState<RunState | null>(null);
  const [summary, setSummary] = useState<FillSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [unlock, setUnlock] = useState<UnlockState | null>(null);

  // On mount: resolve the active tab and list its matching configs (Req 5.1, 5.2).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = await getActiveTabId();
      if (cancelled) return;
      setTabId(id);
      if (id === undefined) {
        setLoadError("Fillibuster can't find an active tab.");
        setLoading(false);
        return;
      }
      const result = await sendUi<ConfigSummary[]>({
        type: MessageType.ListMatchingConfigs,
        tabId: id,
      });
      if (cancelled) return;
      if (result.ok) {
        setConfigs(result.value);
      } else {
        setLoadError(result.error);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Run a config against the active tab. A `locked` result opens the passphrase
   * prompt instead of showing an error (Req 8.8); every other failure becomes a
   * displayed message (Req 9.4). Success renders the summary (Req 5.4, 9.1).
   */
  async function runConfig(configId: string) {
    if (tabId === undefined) return;
    setRunError(null);
    setSummary(null);
    setUnlock(null);
    setRunning({ configId });
    const result: OrchestratorResult<FillSummary> = await sendUi<FillSummary>({
      type: MessageType.RunFill,
      configId,
      tabId,
    });
    setRunning(null);
    if (result.ok) {
      setSummary(result.value);
      return;
    }
    if (result.code === 'locked') {
      // Encrypted config, session has no key — prompt for the passphrase (Req 8.8).
      setUnlock({ configId });
      return;
    }
    setRunError(result.error);
  }

  /**
   * Submit the master passphrase: unlock the session, and on success retry the
   * run that triggered the prompt (Req 8.8). A wrong passphrase keeps the prompt
   * open with an inline message and changes nothing stored (Req 8.9).
   */
  async function submitPassphrase(passphrase: string) {
    if (!unlock) return;
    const { configId } = unlock;
    const result = await sendUi({ type: MessageType.Unlock, passphrase });
    if (result.ok) {
      setUnlock(null);
      await runConfig(configId);
    } else if (result.code === 'wrong-passphrase') {
      setUnlock({ configId, error: 'Incorrect passphrase. Try again.' });
    } else {
      setUnlock({ configId, error: result.error });
    }
  }

  function openSettings() {
    void browser.runtime.openOptionsPage();
  }

  if (loading) {
    return (
      <main>
        <h1>Fillibuster</h1>
        <p class="muted">Loading…</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main>
        <h1>Fillibuster</h1>
        <p class="error">{loadError}</p>
        <div class="actions">
          <button onClick={openSettings}>Open settings</button>
        </div>
      </main>
    );
  }

  if (configs.length === 0) {
    // Nothing matches this page (Req 5.6).
    return (
      <main>
        <h1>Fillibuster</h1>
        <p class="muted">No saved configs match this page.</p>
        <div class="actions">
          <button class="primary" onClick={openSettings}>
            Capture this page
          </button>
          <button onClick={openSettings}>Open settings</button>
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Fillibuster</h1>
      <ul class="config-list">
        {configs.map((config) => (
          <li key={config.id} class="config-row">
            <span class="config-name">
              {config.name}
              {config.encrypted ? (
                <span class="lock-icon" title="Encrypted at rest" aria-label="Encrypted at rest">
                  {' '}
                  🔒
                </span>
              ) : null}
            </span>
            <button
              class="primary"
              disabled={running !== null}
              onClick={() => runConfig(config.id)}
            >
              {running?.configId === config.id ? 'Running…' : 'Run'}
            </button>
          </li>
        ))}
      </ul>

      {running ? <p class="spinner">Running fill…</p> : null}

      {unlock ? (
        <UnlockPrompt error={unlock.error} onSubmit={submitPassphrase} />
      ) : null}

      {runError ? <p class="error">{runError}</p> : null}

      {summary ? <SummaryView summary={summary} /> : null}

      <div class="actions">
        <button onClick={openSettings}>Open settings</button>
        <ThemeToggle />
      </div>
    </main>
  );
}

/** Passphrase entry shown when running an encrypted config while locked (Req 8.8). */
function UnlockPrompt(props: {
  error?: string;
  onSubmit: (passphrase: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <form
      class="unlock"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit(value);
      }}
    >
      <label>
        <div>This config is encrypted. Enter your master passphrase:</div>
        <input
          type="password"
          autoFocus
          value={value}
          aria-label="Master passphrase"
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
      </label>
      {props.error ? <p class="error">{props.error}</p> : null}
      <div>
        <button class="primary" type="submit">
          Unlock and run
        </button>
      </div>
    </form>
  );
}

/** Per-step result summary for a completed fill (Req 5.4, 9.1). */
function SummaryView(props: { summary: FillSummary }) {
  const { total, succeeded, failed, results } = props.summary;
  return (
    <section class="summary">
      <div class="summary-head">
        {failed === 0
          ? `All ${total} step${total === 1 ? '' : 's'} succeeded.`
          : `${succeeded} of ${total} succeeded, ${failed} failed.`}
      </div>
      <ul class="step-list">
        {results.map((step) => (
          <li
            key={step.index}
            class={step.ok ? 'step-ok' : 'step-fail'}
          >
            Step {step.index + 1}: {step.ok ? 'ok' : `failed — ${step.reason ?? 'unknown'}`}
          </li>
        ))}
      </ul>
    </section>
  );
}
