/**
 * Theme preference control shared by the popup and options UIs.
 *
 * Renders a small labelled `<select>` offering Light / Dark / System and
 * persists the choice via {@link savePreference}, applying it immediately so
 * the change is visible without a reload. "System" follows the OS scheme and is
 * re-watched on every change so switching back to it resumes live tracking.
 *
 * The component is self-contained: it loads the current preference on mount and
 * owns its own state, so a host just drops `<ThemeToggle />` wherever a theme
 * control belongs.
 */

import { useEffect, useState } from 'preact/hooks';

import {
  applyMode,
  loadPreference,
  resolveMode,
  savePreference,
  watchSystem,
  type ThemePreference,
} from '../platform/theme';

const OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPreference().then((p) => {
      if (!cancelled) setPreference(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function change(next: ThemePreference) {
    setPreference(next);
    applyMode(resolveMode(next));
    watchSystem(next);
    await savePreference(next);
  }

  return (
    <div class="theme-toggle">
      <label for="theme-select">Theme</label>
      <select
        id="theme-select"
        value={preference ?? 'system'}
        disabled={preference === null}
        onChange={(e) =>
          void change((e.target as HTMLSelectElement).value as ThemePreference)
        }
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
