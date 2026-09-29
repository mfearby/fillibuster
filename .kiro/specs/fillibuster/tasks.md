# Implementation Plan

This plan builds Fillibuster bottom-up: the browser-free `core/` logic first (fully unit-testable), then the extension shell and platform layer, then the content-script engines, then the Preact UI, and finally cross-browser packaging. Each task is incremental and references the requirements it satisfies.

- [x] 1. Scaffold the project and toolchain
  - Initialize `package.json` (private), TypeScript, Vite with `@preact/preset-vite`, Vitest, `web-ext`, and `webextension-polyfill` as dependencies.
  - Create `tsconfig.json` (strict), a Vitest config with a `node` project for `core/` and a `jsdom` project for DOM/component tests, and the `src/` folder layout (`core/`, `platform/`, `background/`, `content/`, `popup/`, `options/`) plus `manifest/` and `scripts/`.
  - Add placeholder npm scripts: `test`, `test:watch`, `build:firefox`, `build:chrome`, `build`, `package`, `dev`.
  - _Requirements: 1.3_

- [x] 2. Define the config schema and runtime validation in `core/`
- [x] 2.1 Write the TypeScript types for the data model
  - Add `core/schema.ts` with `FillConfig`, `MatchRule`, the `FieldStep` discriminated union (`text`, `select`, `check`, `contenteditable`), `Selector`, `StoredState`, `StoredConfig`, `CipherEnvelope`, and `SchemaVersion = 1`.
  - _Requirements: 2.1, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 8.6, 9.2, 9.3_
- [x] 2.2 Implement runtime validation for configs and imports
  - Add `core/validate.ts`: functions that validate an unknown object as a `FillConfig` and as an export envelope, returning typed results or descriptive errors (no throws for expected-bad input).
  - Write Vitest unit tests covering valid configs, each invalid-field case, unknown step types, and malformed envelopes.
  - _Requirements: 7.3, 7.4, 7.6_

- [x] 3. Implement the matching engine in `core/`
  - Add `core/match.ts`: `ruleMatches(url, rule)` for `exact`/`prefix`/`glob` (escape regex metacharacters, translate `*` to `.*`, anchor), and `configMatches(url, config)` (any rule matches), and `matchingConfigIds(url, configs)`.
  - Write Vitest tests for each rule kind including edge cases (trailing slashes, query strings, wildcard spanning path segments, no-match).
  - _Requirements: 4.1, 4.5_

- [x] 4. Implement import/export in `core/`
  - Add `core/share.ts`: `exportConfig(config)` producing the `{ app, schemaVersion, config }` envelope with plaintext steps, and `importEnvelope(text, existingNames)` that parses, validates (via `core/validate.ts`), version-gates, and resolves name collisions by suggesting a non-colliding name.
  - Write Vitest tests: export→import round-trip, rejection of wrong `app`/unknown `schemaVersion`/malformed JSON, and collision handling ("keep both").
  - _Requirements: 7.1, 7.3, 7.4, 7.5, 7.6_

- [x] 5. Implement the encryption module in `core/`
- [x] 5.1 Key derivation and verifier
  - Add `core/crypto.ts` using Web Crypto: `deriveKey(passphrase, salt, iterations)` (PBKDF2/SHA-256), `makeVerifier(key)` / `checkVerifier(key, verifier)` (AES-GCM over a known constant), and salt/iteration generation for enabling encryption.
  - _Requirements: 8.7, 8.9_
- [x] 5.2 Encrypt/decrypt config steps
  - Add `encryptSteps(steps, key)` → `CipherEnvelope` (random IV, AES-GCM) and `decryptSteps(envelope, key)` → `FieldStep[]`, with base64 helpers.
  - Write Vitest tests: encrypt→decrypt round-trip, wrong-key rejection, and tamper detection (modified ciphertext/IV fails the auth tag).
  - _Requirements: 8.7, 8.9_

- [x] 6. Build the platform layer and storage repository
- [x] 6.1 Cross-browser API wrapper
  - Add `platform/browser.ts` re-exporting the `webextension-polyfill` `browser` object and any small adapters, so the rest of the code never touches `chrome.*`/`browser.*` directly.
  - _Requirements: 1.3_
- [x] 6.2 Storage repository over `storage.local` and `storage.session`
  - Add `platform/store.ts`: load/save `StoredState`, list/get/put/delete configs, read/write encryption settings (`encryptionEnabled`, `kdf`, `verifier`), and hold/read the derived key in `storage.session`.
  - Enforce local-only (no network) and add a `getBytesInUse` check that flags approaching the ~10 MB cap.
  - Write Vitest tests against a mocked `browser.storage` for CRUD, settings, and the byte-threshold warning.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.8, 8.12_

- [x] 7. Implement the content-script fill executor
  - Add `content/fill.ts`: resolve a `Selector` (`id`/`name`/`css`), apply per step type — text (native value setter + `input`/`change`), select (match option by value or visible text + `change`), check (set `.checked` + events), contenteditable (`textContent`/`innerHTML` + `input`) — and honor `errorStrategy` (`stop`/`continue`).
  - Return a per-step result list and a summary `{ total, succeeded, failed, results[] }`.
  - Write jsdom Vitest tests per control type asserting values set and events dispatched, plus the "element not found" path under both error strategies.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 5.3, 5.4, 5.5, 5b.1, 5b.2, 9.1, 9.2, 9.3_

- [x] 8. Implement the content-script capture
  - Add `content/capture.ts`: scan for fillable controls, derive the most stable selector (prefer `id`, then `name`, then a robust CSS path), read current value/checked/selected as defaults, and flag controls where only a fragile selector is possible.
  - Write jsdom Vitest tests for selector preference order, value/state extraction, and the fragile-selector flag.
  - _Requirements: 2.2, 2.3, 2.4, 2.6_

- [x] 9. Wire the content-script entry and messaging
  - Add `content/index.ts`: message handlers for `applySteps` (invoke fill executor, stream/return results) and `capturePage` (invoke capture), plus SPA URL-change detection (History API patch + `popstate`) that notifies the background.
  - _Requirements: 2.2, 4.4, 5.3, 5.4, 9.1_

- [x] 10. Implement the background service worker
- [x] 10.1 Match evaluation and toolbar badge
  - Add `background/index.ts`: on `tabs.onUpdated`, `tabs.onActivated`, and SPA-navigation messages, evaluate the active URL via `core/match.ts`, cache per-tab matches, and set/clear the per-tab badge.
  - _Requirements: 4.1, 4.2, 4.3, 4.4_
- [x] 10.2 Orchestration message API for popup/options
  - Handle messages: list matching configs for a tab, run a fill (load config, decrypt if needed using the in-session key, ensure content script injected, relay steps, return summary), CRUD configs, import/export, and encryption lock/unlock (derive key, verify, cache in `storage.session`).
  - Surface clear errors for restricted pages / no active tab.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.5, 7.1, 7.3, 8.8, 8.9, 9.1, 9.4_

- [x] 11. Build the popup UI (Preact)
  - Add `popup/` (`popup.html` + Preact TSX): list configs matching the current tab, run a selected config with live per-step progress and a success/failure summary, prompt for the master passphrase when running an encrypted config while locked, and offer "capture this page" / "open settings" when nothing matches.
  - _Requirements: 5.1, 5.2, 5.4, 5.6, 8.8, 9.1_

- [ ] 12. Build the options / management UI (Preact)
- [x] 12.1 Config list and CRUD shell
  - Add `options/` (`options.html` + Preact TSX): list all saved configs; create, open, and delete-with-confirmation.
  - _Requirements: 6.1, 6.6_
- [x] 12.2 Config editor with typed, reorderable step list
  - Edit name, match rules, and error strategy; add/edit/reorder/remove steps; render step-type-specific fields (text/select/check/contenteditable); persist changes.
  - _Requirements: 6.2, 6.3, 6.4, 6.5, 2.1_
- [x] 12.3 Capture-to-config flow
  - Trigger capture on the active tab, present candidate steps for review/pruning/editing, and save only the kept fields into a config (never auto-save).
  - _Requirements: 2.2, 2.4, 2.5, 2.6_
- [ ] 12.4 Import / export UI
  - Export a config (copy JSON envelope to clipboard) with a warning before including decrypted values; add-config-by-paste that validates and, on name collision, keeps both.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.7_
- [ ] 12.5 Encryption settings UI
  - Enable/disable encryption by setting the master passphrase (with an explicit no-recovery warning), mark a config as encrypted, prompt-to-unlock, and communicate that non-encrypted data is only as protected as the browser profile.
  - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.8, 8.10, 8.11_

- [ ] 13. Manifests and cross-browser build
- [ ] 13.1 Author manifests
  - Add `manifest/manifest.base.json` (shared: name, version, action/popup, options page, permissions incl. `storage`, `scripting`, `activeTab`), `manifest.chrome.json` (service-worker background), and `manifest.firefox.json` (`background.scripts` event page + `browser_specific_settings.gecko`).
  - _Requirements: 1.1, 1.2_
- [ ] 13.2 Build script and packaging
  - Add `scripts/build.mjs`: run Vite per target, merge base + per-target manifest into each `dist/<target>/manifest.json`, wire `webextension-polyfill` for Chrome (service worker `importScripts` + page `<script>`), and zip artifacts (`web-ext build` for Firefox). Confirm `build:firefox`, `build:chrome`, `build`, `package`, `dev` scripts work.
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [ ] 14. README with build and store-submission instructions
  - Document dev install (load unpacked in Chrome, temporary add-on in Firefox), the reproducible build commands, and an AMO-facing "How to build from source" section (Vite minifies, does not obfuscate).
  - _Requirements: 1.4_

- [ ] 15. End-to-end verification pass
  - Build both targets, load unpacked in Chrome and Firefox, and manually verify: badge on match, popup listing + fill on a sample form (including a states `<select>` and a checkbox), capture flow, export/import between profiles, and the encryption enable → unlock → wrong-passphrase flows. Fix any issues found.
  - _Requirements: 1.1, 1.2, 2.2, 3.2, 4.2, 5.4, 7.1, 8.8, 8.9, 9.1_
