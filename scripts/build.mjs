#!/usr/bin/env node
// Fillibuster build orchestrator (Task 13.2).
//
// Builds the extension for one or both browser targets from the single `src/`
// tree, merges the shared + per-target manifest fragments into each
// `dist/<target>/manifest.json`, and (with --package) produces distributable
// zips — `web-ext build` for Firefox, a plain zip for Chrome.
//
// Usage:
//   node scripts/build.mjs                 # build both targets
//   node scripts/build.mjs firefox         # build Firefox only
//   node scripts/build.mjs chrome          # build Chrome only
//   node scripts/build.mjs --package       # build both, then zip artifacts
//   node scripts/build.mjs firefox --watch # rebuild Firefox on change (dev)
//
// npm scripts: build:firefox, build:chrome, build, package, dev.
//
// --- Design notes on cross-browser wiring ---------------------------------
//
// The whole codebase reaches the WebExtension API through
// `src/platform/browser.ts`, which imports `webextension-polyfill`. Because we
// bundle with Vite/Rollup, that dependency is inlined into every output bundle
// — so the polyfill is "wired" into each context (background, content, popup,
// options) for both targets without any runtime `importScripts`/`<script>`
// plumbing. Firefox is the API baseline (native promise-based `browser`); the
// Chrome target layers in the service-worker manifest and the same bundled
// polyfill.
//
// Three kinds of entry need three different output shapes:
//   * popup + options  — HTML pages. Vite's multi-page build emits the pages
//     with hashed module chunks; page `<script type="module">` works in both
//     Chrome and Firefox.
//   * background        — emitted as a single self-contained IIFE at
//     `background/index.js`. A classic self-contained script is valid as a
//     Chrome MV3 service worker AND as a Firefox `background.scripts` entry
//     (which are NOT modules), so one output shape serves both manifests.
//   * content           — content scripts cannot be ES modules, so it is
//     emitted as a single self-contained IIFE at the dist root as `content.js`
//     (the path the background injects via `scripting.executeScript`).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import preact from '@preact/preset-vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');
const MANIFEST_DIR = resolve(ROOT, 'manifest');
const DIST = resolve(ROOT, 'dist');

const TARGETS = ['chrome', 'firefox'];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));

const requested = positional.length > 0 ? positional : TARGETS;
const targets = requested.filter((t) => TARGETS.includes(t));

if (targets.length !== requested.length) {
  const unknown = requested.filter((t) => !TARGETS.includes(t));
  console.error(
    `Unknown target(s): ${unknown.join(', ')}. Expected one of: ${TARGETS.join(', ')}`,
  );
  process.exit(1);
}

const doPackage = flags.includes('--package');
const doWatch = flags.includes('--watch');

if (doWatch && targets.length !== 1) {
  console.error('--watch requires exactly one target (e.g. `dev` → firefox/chrome).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Vite build configs
// ---------------------------------------------------------------------------

/**
 * Shared build options. `emptyOutDir` is left to the first sub-build of each
 * target (see build order below) so later sub-builds don't wipe earlier output.
 */
function baseBuild(outDir, extra = {}) {
  return {
    root: ROOT,
    configFile: false,
    plugins: [preact()],
    build: {
      outDir,
      target: 'es2022',
      minify: 'esbuild', // minify, not obfuscate — keeps AMO/CWS review happy
      emptyOutDir: false,
      ...extra,
    },
  };
}

/** Multi-page build for the popup + options HTML entries. */
function pagesConfig(outDir) {
  const cfg = baseBuild(outDir, {
    // Clear the target dir once, at the start of the per-target build.
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(SRC, 'popup/popup.html'),
        options: resolve(SRC, 'options/options.html'),
      },
      output: {
        // Shared chunks/assets land in assets/; pages stay under popup/, options/.
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  });
  // Relative asset URLs so pages load their JS/CSS regardless of how the
  // extension origin resolves absolute paths.
  cfg.base = './';
  return cfg;
}

/**
 * Single self-contained IIFE bundle. Used for both the background worker and
 * the content script: no code-splitting, no imports left unresolved, so the
 * output is a lone classic script.
 */
function iifeConfig(outDir, entry, fileName) {
  return baseBuild(outDir, {
    lib: {
      entry,
      formats: ['iife'],
      name: '__fillibuster__',
      fileName: () => fileName,
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  });
}

// ---------------------------------------------------------------------------
// Manifest merge
// ---------------------------------------------------------------------------

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Merge `manifest.base.json` with the per-target fragment and write the result
 * to `dist/<target>/manifest.json`. Shallow merge is enough: fragments add
 * top-level keys (`background`, `browser_specific_settings`) that the base does
 * not define, so there are no nested-key collisions to reconcile.
 */
function writeManifest(target, outDir) {
  const base = readJson(resolve(MANIFEST_DIR, 'manifest.base.json'));
  const fragment = readJson(resolve(MANIFEST_DIR, `manifest.${target}.json`));
  const merged = { ...base, ...fragment };
  const dest = resolve(outDir, 'manifest.json');
  writeFileSync(dest, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`[build] wrote ${rel(dest)}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rel(p) {
  return p.replace(`${ROOT}/`, '');
}

// ---------------------------------------------------------------------------
// Per-target build
// ---------------------------------------------------------------------------

async function buildTarget(target) {
  const outDir = resolve(DIST, target);
  console.log(`\n[build] === ${target} → ${rel(outDir)} ===`);

  // 1. Pages (popup + options). Root = src so HTML emits at popup/… options/…
  //    This sub-build clears the target dir first (emptyOutDir).
  await build({
    ...pagesConfig(outDir),
    root: SRC,
  });

  // 2. Background — single IIFE at background/index.js.
  await build(iifeConfig(outDir, resolve(SRC, 'background/index.ts'), 'background/index.js'));

  // 3. Content — single IIFE at content.js (dist root; injected by name).
  await build(iifeConfig(outDir, resolve(SRC, 'content/index.ts'), 'content.js'));

  // 4. Manifest.
  writeManifest(target, outDir);

  console.log(`[build] ${target} done.`);
}

// ---------------------------------------------------------------------------
// Watch build (dev)
// ---------------------------------------------------------------------------

async function watchTarget(target) {
  const outDir = resolve(DIST, target);
  console.log(`[dev] watching ${target} → ${rel(outDir)} (Ctrl-C to stop)`);

  // Initial full build so the manifest + all bundles exist before watching.
  // The manifest is static (merged fragments), so it needs writing only once.
  await buildTarget(target);

  // Then start each sub-build in watch mode. Setting `build.watch` makes Vite
  // hand back a rollup watcher and keep the process alive. emptyOutDir is off
  // everywhere here so the watchers don't wipe each other's output on rebuild.
  const withWatch = (cfg) => {
    cfg.build.watch = {};
    cfg.build.emptyOutDir = false;
    return cfg;
  };

  const configs = [
    { ...pagesConfig(outDir), root: SRC },
    iifeConfig(outDir, resolve(SRC, 'background/index.ts'), 'background/index.js'),
    iifeConfig(outDir, resolve(SRC, 'content/index.ts'), 'content.js'),
  ];
  for (const cfg of configs) {
    await build(withWatch(cfg));
  }
}

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

/** Zip a built target directory. Firefox uses web-ext; Chrome uses `zip`. */
function packageTarget(target) {
  const outDir = resolve(DIST, target);
  if (!existsSync(resolve(outDir, 'manifest.json'))) {
    console.error(`[package] ${target}: no build found at ${rel(outDir)} — run the build first.`);
    process.exit(1);
  }
  const artifacts = resolve(ROOT, 'web-ext-artifacts');
  ensureDir(artifacts);

  if (target === 'firefox') {
    console.log(`[package] firefox → web-ext build`);
    execFileSync(
      resolve(ROOT, 'node_modules/.bin/web-ext'),
      ['build', '--source-dir', outDir, '--artifacts-dir', artifacts, '--overwrite-dest'],
      { stdio: 'inherit' },
    );
  } else {
    const version = readJson(resolve(MANIFEST_DIR, 'manifest.base.json')).version;
    const zipPath = resolve(artifacts, `fillibuster-chrome-${version}.zip`);
    rmSync(zipPath, { force: true });
    console.log(`[package] chrome → ${rel(zipPath)}`);
    // `zip -r <zip> .` from within outDir so paths are relative to the dist root.
    execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: outDir, stdio: 'inherit' });
    console.log(`[package] wrote ${rel(zipPath)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (doWatch) {
    await watchTarget(targets[0]);
    return; // watcher keeps the process alive
  }

  for (const target of targets) {
    await buildTarget(target);
  }

  if (doPackage) {
    for (const target of targets) {
      packageTarget(target);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
