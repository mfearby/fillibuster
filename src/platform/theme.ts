/**
 * Theme preference: light / dark / system (follow the OS).
 *
 * The theme is a cosmetic UI preference, deliberately kept OUT of
 * {@link StoredState.settings} and the orchestrator RPC surface: it is not
 * security- or config-state, and storing it alongside the encryption settings
 * would both over-couple a toggle to that surface and risk being wiped when
 * `setEncryptionEnabled(false)` rebuilds `settings`. Instead it lives under its
 * own `storage.local` key, read/written directly by the popup and options UIs.
 *
 * Applying the theme sets `data-theme="light" | "dark"` on the document root;
 * the stylesheets key their token overrides off that attribute (and off
 * `prefers-color-scheme` when the preference is "system"). To avoid a
 * flash-of-wrong-theme before the async `storage.local` read resolves — and
 * because the extension CSP forbids inline bootstrap scripts — the resolved
 * mode is mirrored to synchronous `localStorage` and read back at startup.
 */

import browser from './browser';

/** The stored preference. `system` tracks `prefers-color-scheme` live. */
export type ThemePreference = 'light' | 'dark' | 'system';

/** The concrete mode actually applied to the document. */
export type ThemeMode = 'light' | 'dark';

/** `storage.local` key holding the durable {@link ThemePreference}. */
export const THEME_KEY = 'fillibuster:theme';

/** Synchronous `localStorage` cache key, used only to avoid a startup flash. */
const THEME_CACHE_KEY = 'fillibuster:theme';

const PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

/** Narrow an unknown value to a {@link ThemePreference}, defaulting to `system`. */
export function coercePreference(value: unknown): ThemePreference {
  return PREFERENCES.includes(value as ThemePreference)
    ? (value as ThemePreference)
    : 'system';
}

/** True when the OS currently prefers a dark color scheme. */
export function systemPrefersDark(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Resolve a preference to the concrete {@link ThemeMode} to apply. */
export function resolveMode(preference: ThemePreference): ThemeMode {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return preference;
}

/**
 * Apply `mode` to the document by setting `data-theme` on `<html>`. No-ops
 * safely when there is no DOM (e.g. a non-UI context importing this module).
 */
export function applyMode(mode: ThemeMode): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.setAttribute('data-theme', mode);
}

/**
 * Read the preference synchronously from the `localStorage` cache. Returns
 * `null` when nothing is cached (first run) or `localStorage` is unavailable,
 * so the caller can fall back to the async source of truth.
 */
export function readCachedPreference(): ThemePreference | null {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    return raw === null ? null : coercePreference(raw);
  } catch {
    return null;
  }
}

/** Write the preference to the synchronous `localStorage` cache (best-effort). */
function writeCachedPreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, preference);
  } catch {
    // Private-mode / disabled storage: the async store remains the source of truth.
  }
}

/** Read the durable preference from `storage.local` (defaults to `system`). */
export async function loadPreference(): Promise<ThemePreference> {
  const stored = await browser.storage.local.get(THEME_KEY);
  return coercePreference(stored[THEME_KEY]);
}

/** Persist the preference to `storage.local` and refresh the synchronous cache. */
export async function savePreference(preference: ThemePreference): Promise<void> {
  writeCachedPreference(preference);
  await browser.storage.local.set({ [THEME_KEY]: preference });
}

/**
 * Startup bootstrap for a UI entry point: apply the cached preference
 * synchronously (avoiding a flash), then reconcile against the durable store
 * and apply the authoritative value. Returns the resolved preference.
 *
 * When the preference is "system", a `change` listener on the media query keeps
 * the applied mode in sync with live OS changes for the life of the page.
 */
export async function initTheme(): Promise<ThemePreference> {
  const cached = readCachedPreference();
  if (cached) applyMode(resolveMode(cached));

  const preference = await loadPreference();
  writeCachedPreference(preference);
  applyMode(resolveMode(preference));
  watchSystem(preference);
  return preference;
}

/** Track OS scheme changes while the preference is "system". */
let mediaListenerBound: ((e: MediaQueryListEvent) => void) | null = null;
let boundQuery: MediaQueryList | null = null;

export function watchSystem(preference: ThemePreference): void {
  if (typeof matchMedia !== 'function') return;
  const query = matchMedia('(prefers-color-scheme: dark)');

  if (mediaListenerBound && boundQuery) {
    boundQuery.removeEventListener('change', mediaListenerBound);
    mediaListenerBound = null;
    boundQuery = null;
  }

  if (preference !== 'system') return;

  const listener = (e: MediaQueryListEvent) => {
    applyMode(e.matches ? 'dark' : 'light');
  };
  query.addEventListener('change', listener);
  mediaListenerBound = listener;
  boundQuery = query;
}
