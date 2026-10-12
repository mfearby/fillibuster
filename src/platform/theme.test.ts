/**
 * Tests for the theme preference module (light / dark / system).
 *
 * Run under the jsdom project. The WebExtension `storage.local` is mocked with
 * an in-memory fake (mirroring store.test.ts), and `matchMedia` is stubbed so
 * the "system" resolution and live-tracking paths are deterministic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { local } = vi.hoisted(() => {
  class FakeArea {
    store = new Map<string, unknown>();
    get = vi.fn(async (key?: null | string | string[]): Promise<Record<string, unknown>> => {
      if (key == null) return Object.fromEntries(this.store);
      const keys = Array.isArray(key) ? key : [key];
      const out: Record<string, unknown> = {};
      for (const k of keys) if (this.store.has(k)) out[k] = this.store.get(k);
      return out;
    });
    set = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
      for (const [k, v] of Object.entries(items)) this.store.set(k, v);
    });
  }
  return { local: new FakeArea() };
});

vi.mock('webextension-polyfill', () => {
  const browser = { storage: { local } };
  return { __esModule: true, default: browser, browser };
});

import {
  THEME_KEY,
  applyMode,
  coercePreference,
  initTheme,
  loadPreference,
  resolveMode,
  savePreference,
} from './theme';

/** Stub matchMedia to report a fixed dark/light preference. */
function stubMatchMedia(dark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_t: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
    removeEventListener: (_t: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
    // Expose for manual dispatch in the live-tracking test.
    _emit: (matches: boolean) =>
      listeners.forEach((l) => l({ matches } as MediaQueryListEvent)),
  };
  vi.stubGlobal('matchMedia', () => mql);
  return mql;
}

beforeEach(() => {
  local.store.clear();
  // `localStorage` is not available under this jsdom/Node setup; the module
  // accesses it defensively, so the test clears it only when present.
  try {
    localStorage.clear();
  } catch {
    /* no localStorage in this environment */
  }
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
});

describe('coercePreference', () => {
  it('passes through valid preferences', () => {
    expect(coercePreference('light')).toBe('light');
    expect(coercePreference('dark')).toBe('dark');
    expect(coercePreference('system')).toBe('system');
  });

  it('defaults anything else to system', () => {
    expect(coercePreference('bogus')).toBe('system');
    expect(coercePreference(undefined)).toBe('system');
    expect(coercePreference(42)).toBe('system');
  });
});

describe('resolveMode', () => {
  it('returns the explicit mode for light/dark', () => {
    stubMatchMedia(true);
    expect(resolveMode('light')).toBe('light');
    expect(resolveMode('dark')).toBe('dark');
  });

  it('follows the OS for system', () => {
    stubMatchMedia(true);
    expect(resolveMode('system')).toBe('dark');
    stubMatchMedia(false);
    expect(resolveMode('system')).toBe('light');
  });
});

describe('applyMode', () => {
  it('sets data-theme on the document root', () => {
    applyMode('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    applyMode('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('load/save preference', () => {
  it('defaults to system when nothing is stored', async () => {
    expect(await loadPreference()).toBe('system');
  });

  it('round-trips a saved preference through storage.local', async () => {
    stubMatchMedia(false);
    await savePreference('dark');
    expect(local.store.get(THEME_KEY)).toBe('dark');
    expect(await loadPreference()).toBe('dark');
  });

  it('persists the preference even when the localStorage cache is unavailable', async () => {
    // The synchronous cache is a best-effort anti-flash optimization; when it is
    // absent (as here), the durable storage.local write must still succeed.
    stubMatchMedia(false);
    await savePreference('light');
    expect(local.store.get(THEME_KEY)).toBe('light');
  });
});

describe('initTheme', () => {
  it('applies the stored preference and returns it', async () => {
    stubMatchMedia(false);
    await savePreference('dark');
    const pref = await initTheme();
    expect(pref).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('resolves system against the OS scheme', async () => {
    stubMatchMedia(true);
    await savePreference('system');
    await initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('live-tracks OS changes while on system', async () => {
    const mql = stubMatchMedia(false);
    await savePreference('system');
    await initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    // OS flips to dark.
    mql._emit(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
