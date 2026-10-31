# Fillibuster

Cross-browser (Firefox + Chrome) MV3 extension that fills web forms from saved,
reusable fill configs. Built for developers who repeatedly test web flows and
are tired of re-entering the same data.

One TypeScript + Preact source tree (`src/`) is bundled with Vite and packaged
into distributable artifacts for both browsers from the same code.

## Assisted capture (not yet wired up)

The project includes an **assisted capture** engine — `src/content/capture.ts`
scans a page for fillable controls and derives a stable selector plus current
value for each, and `src/options/CaptureReview.tsx` is a UI for reviewing and
pruning those candidates before saving them as a config. The background
`CaptureTab` message handler drives it, and all of this is covered by tests.

It is intentionally **not exposed in the UI yet.** The buttons that used to
trigger it ("Capture this page" in the popup, "Capture active tab" in the
options page) were removed because the flow was incomplete: from the options
page the capture targeted the options tab itself rather than the page under
test, and the popup button only opened the options page without capturing. Until
a correct entry point is designed (reliably identifying the web tab to capture
from, then opening review), configs are created manually in the options editor
or via import.

The engine, review component, and tests are kept in place deliberately so the
feature can be finished later without rebuilding it. The engine already skips
ids and names that look auto-generated (random numbers, UUIDs, React `useId`,
UI-library counters) and, when it skips an id, targets the field by its label
instead, with a note on the review screen explaining why. If you wire up a new entry
point, it should send a `CaptureTab` request for the target tab and render
`CaptureReview` with the returned candidates.

## Prerequisites

- **Node.js** 18 or newer (the build targets `es2022` and uses ESM tooling).
- **npm** (ships with Node).
- For Chrome packaging, the `zip` command must be available on your `PATH`
  (standard on macOS/Linux). Firefox packaging uses the bundled `web-ext` and
  needs no extra tools.

Install dependencies once:

```sh
npm install
```

## Build commands

All build/packaging is driven by `scripts/build.mjs` via these npm scripts
(defined in `package.json`):

| Command | What it does |
| --- | --- |
| `npm run build` | Build **both** targets into `dist/chrome/` and `dist/firefox/`. |
| `npm run build:chrome` | Build the Chrome target only → `dist/chrome/`. |
| `npm run build:firefox` | Build the Firefox target only → `dist/firefox/`. |
| `npm run package` | Build both targets, then produce distributable zips in `web-ext-artifacts/` (Firefox via `web-ext build`, Chrome via `zip`). |
| `npm run dev -- <target>` | Watch-rebuild a single target on change. A target is required, e.g. `npm run dev -- firefox` or `npm run dev -- chrome`. |
| `npm test` | Run the Vitest suite once. |

Each build merges the shared manifest (`manifest/manifest.base.json`) with the
per-target fragment (`manifest/manifest.chrome.json` or
`manifest/manifest.firefox.json`) and writes the result to
`dist/<target>/manifest.json`.

Packaged artifacts land in `web-ext-artifacts/`:

- Firefox: `fillibuster-<version>.zip` (produced by `web-ext build`)
- Chrome: `fillibuster-chrome-<version>.zip`

## Dev install (loading the unpacked build)

First build the target you want (`npm run build:chrome`, `npm run build:firefox`,
or `npm run build` for both).

### Chrome

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `dist/chrome` directory.

The extension reloads when you rebuild; use `npm run dev -- chrome` to rebuild
on change, then click the reload icon on the extension card in
`chrome://extensions`.

### Firefox

1. Go to `about:debugging`.
2. Click **This Firefox** in the left sidebar.
3. Click **Load Temporary Add-on…**.
4. Select the `dist/firefox/manifest.json` file.

Temporary add-ons are removed when Firefox restarts. Use
`npm run dev -- firefox` to rebuild on change, then click **Reload** on the
add-on in `about:debugging`.

## How to build from source (for AMO reviewers)

This section documents a reproducible build from source for Mozilla Add-ons
(AMO) review.

**Environment**

- Node.js 18+ and npm (any recent npm bundled with Node 18/20 works).
- No native build steps, no network access needed beyond `npm install`.

**Reproduce the Firefox artifact from source**

```sh
npm install
npm run build:firefox
```

This produces the reviewable, unpacked extension at `dist/firefox/`, containing
the merged `manifest.json` and the bundled scripts and pages.

To produce the exact distributable zip that is submitted:

```sh
npm run package
```

The Firefox zip is written to `web-ext-artifacts/fillibuster-<version>.zip`
(`<version>` matches the `version` field in `manifest/manifest.base.json` and
`package.json`).

**A note on the build output**

The bundler (Vite/Rollup with esbuild) **minifies** the JavaScript — it removes
whitespace and shortens local identifiers for size — but it does **not**
obfuscate. No control-flow flattening, string encoding, or other transforms
that hide intent are applied. The minified output corresponds directly to the
readable TypeScript in `src/`. The third-party runtime dependencies
(`preact`, `webextension-polyfill`) are bundled in from `node_modules`, at the
versions pinned in `package-lock.json`.

## Project layout

```
src/
  background/   MV3 background worker (bundled to background/index.js)
  content/      injected content script (bundled to content.js)
  core/         config schema, matching, crypto, share/validate logic
  platform/     WebExtension compatibility layer (webextension-polyfill)
  popup/        toolbar popup UI (Preact)
  options/      management/settings UI (Preact)
manifest/       manifest.base.json + per-target fragments
scripts/        build.mjs — build/package orchestrator
```

## Testing

```sh
npm test          # run once
npm run test:watch
```
```
