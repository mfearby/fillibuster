# Requirements Document

## Introduction

Fillibuster is a cross-browser (Firefox and Chrome) extension that automatically fills in web forms. It is aimed at developers who repeatedly test web flows and are tired of re-entering the same data (names, driver license details, and other POI/test data).

The extension lets a developer define how to fill a specific page (primarily by identifying fields via HTML id or a stable selector and the value to set), save that as a reusable "fill config", and replay it later with a click. To make config creation easier, the extension can assist by capturing the fillable fields currently on the page as a starting point. When the developer visits a page that matches a saved config, the toolbar icon shows an indicator; clicking the icon reveals a menu of matching configs to run. Configs are editable and can be exported and shared with other users, who paste them into their own settings to add the config.

In this first version, fills are driven by explicitly specified fields (identified by HTML id or a stable selector) and their target values, targeting simple/native HTML form controls (text inputs, textareas, native `<select>` comboboxes such as a states list, checkboxes, radios). True live interaction recording and async autocomplete/search widgets are deferred to v2. Assisted capture is a convenience layered on top of the manual field-definition foundation.

### Terminology

- **Fill config**: A saved, named definition of how to fill a specific form/page. Includes a set of ordered field steps and page-matching rules.
- **Field step**: A single instruction within a config (e.g. set an input's value, type-then-wait-then-select for an autocomplete, click a checkbox).
- **Match**: The evaluation of whether the current page corresponds to one or more saved configs.

## Requirements

### Requirement 1: Cross-browser support

**User Story:** As a developer, I want the extension to work in both Firefox and Chrome, so that I can use the same tool regardless of which browser I test in.

#### Acceptance Criteria

1. WHEN the extension is loaded in Chrome (Manifest V3) THEN the extension SHALL function with all core features (define config, match, fill, manage, share).
2. WHEN the extension is loaded in Firefox THEN the extension SHALL function with all core features.
3. WHERE browser-specific APIs differ THEN the extension SHALL use a compatibility layer so that a single codebase serves both browsers.
4. THE extension SHALL package into distributable artifacts for both Chrome and Firefox from the same source.

### Requirement 2: Define fields to fill (manual and assisted capture)

**User Story:** As a developer, I want to specify which fields to fill (by HTML id or selector) and the values to set, so that I can create a fill config without needing full interaction recording.

#### Acceptance Criteria

1. THE extension SHALL allow the developer to define a field step by specifying a target (HTML id or stable CSS/attribute selector), a control type, and a value.
2. WHEN the developer triggers an assisted capture on the current page THEN the extension SHALL detect fillable form controls (text inputs, textareas, selects, checkboxes, radios, and contenteditable elements) and pre-populate candidate field steps.
3. FOR each detected control THE extension SHALL record a stable selector (preferring id, then name, then a robust CSS/attribute path) and the control type.
4. WHEN a control has a current value at capture time THEN the extension SHALL offer that value as the default for the corresponding field step.
5. WHEN capture completes THEN the extension SHALL present the candidate steps for review and editing before saving, so the developer can keep only the fields they want.
6. IF a stable selector cannot be determined for a control THEN the extension SHALL flag that step so the developer can fix or remove it.

### Requirement 3: Supported control types (v1)

**User Story:** As a developer, I want to fill the common native form controls, so that I can handle the forms I test most often without waiting for advanced widget support.

#### Acceptance Criteria

1. THE extension SHALL support setting the value of text inputs and textareas.
2. THE extension SHALL support selecting an option in a native `<select>` combobox (e.g. a list of states) by option value or visible text.
3. THE extension SHALL support setting the checked state of checkboxes and radio buttons.
4. THE extension SHALL support setting content on contenteditable elements.
5. THE async autocomplete/search step type (type a query, wait, then select a result) is OUT OF SCOPE for v1 and is deferred to v2; the v1 config format SHOULD be designed so such step types can be added later without breaking existing configs.

### Requirement 4: Page matching and toolbar indicator

**User Story:** As a developer, I want the extension to tell me when the current page has a saved config, so that I know a prefill is available without hunting for it.

#### Acceptance Criteria

1. THE extension SHALL match the current page against saved configs using URL pattern rules (exact, prefix, and wildcard/glob patterns).
2. WHEN one or more configs match the current page THEN the toolbar icon SHALL display an indicator (e.g. a badge) signalling availability.
3. WHEN no configs match THEN the toolbar icon SHALL show no availability indicator.
4. WHEN the page URL changes (SPA navigation included) THEN the extension SHALL re-evaluate matches and update the indicator.
5. Structural match conditions (requiring a given selector to be present) are OUT OF SCOPE for v1; URL pattern matching is sufficient.

### Requirement 5: Popup menu and running a fill

**User Story:** As a developer, I want to click the toolbar icon and pick from the available configs, so that the form gets filled in one action.

#### Acceptance Criteria

1. WHEN the developer clicks the toolbar icon THEN the extension SHALL open a popup listing the configs that match the current page.
2. WHEN multiple configs match THEN the popup SHALL list all of them so the developer can choose which to run.
3. WHEN the developer selects a config THEN the extension SHALL execute its field steps in order against the current page.
4. WHILE a fill is running THE extension SHALL provide progress/feedback and report per-step success or failure.
5. IF a step targets an element that is not present THEN the extension SHALL handle it per the config's error strategy (skip and continue, or stop) and surface the outcome.
6. WHEN no configs match THEN the popup SHALL still allow the developer to start a capture or open management.

### Requirement 5b: Filling triggers native input events

**User Story:** As a developer, I want filled values to behave as if I typed them, so that framework-driven forms (React, Vue, Angular) register the input correctly.

#### Acceptance Criteria

1. WHEN a field step sets a value THEN the extension SHALL dispatch the appropriate input/change events so that framework-bound forms recognise the change.
2. WHEN a step operates on checkboxes or radios THEN the extension SHALL set checked state and dispatch corresponding events.

### Requirement 6: Manage and edit configs

**User Story:** As a developer, I want to view, edit, reorder, and delete configs and their steps, so that I can maintain them as forms change.

#### Acceptance Criteria

1. THE extension SHALL provide a management/settings screen listing all saved configs.
2. WHEN the developer opens a config THEN the extension SHALL allow editing its name, match rules, error strategy, and ordered field steps.
3. THE extension SHALL allow adding, editing, reordering, and removing individual field steps within a config.
4. WHEN editing a step THE extension SHALL expose the fields relevant to that step type (target selector, value, type-and-select details, waits, timeouts).
5. WHEN the developer saves changes THEN the extension SHALL persist them and reflect them in subsequent matches and fills.
6. THE extension SHALL allow deleting a config with a confirmation step.

### Requirement 7: Export and share configs

**User Story:** As a developer, I want to export a config and share it with a teammate who can paste it into their settings, so that we don't each have to build the same config.

#### Acceptance Criteria

1. WHEN the developer chooses to export a config THEN the extension SHALL produce a portable, self-contained text representation (e.g. JSON) of that config.
2. THE extension SHALL allow copying the exported representation to the clipboard.
3. WHEN a developer pastes an exported representation into an "add config" input THEN the extension SHALL validate it and, IF valid, add it as a new config.
4. IF the pasted representation is invalid or from an incompatible version THEN the extension SHALL reject it with a clear error and not corrupt existing configs.
5. WHERE an imported config's name collides with an existing one THE extension SHALL let the developer keep both (rename/duplicate) rather than silently overwriting.
6. THE exported representation SHALL include a version identifier so future format changes can be handled.
7. WHERE a config is encrypted THE export SHALL warn the developer before including any decrypted values, so that sensitive data is not shared in plain text unintentionally.

### Requirement 8: Local storage and optional encryption

**User Story:** As a developer, I want my configs stored locally with no password required by default, and the option to turn on encryption behind a single master passphrase if I want it, so that the tool is frictionless out of the box but can protect data when it matters.

#### Acceptance Criteria

1. THE extension SHALL persist configs in browser extension storage local to the user's profile.
2. THE extension SHALL NOT transmit configs or field data to any external server as part of normal operation.
3. BY DEFAULT encryption SHALL be disabled; the extension SHALL store configs unencrypted and SHALL NOT prompt for any passphrase during normal use.
4. THE extension SHALL allow the developer to optionally enable encryption by setting a single master passphrase that protects all configs marked as encrypted.
5. WHILE encryption is disabled THE extension SHALL operate fully (define, match, fill, manage, share) without any passphrase.
6. WHEN encryption is enabled THEN the extension SHALL allow the developer to mark a config as sensitive/encrypted.
7. WHEN a config is marked encrypted THEN the extension SHALL encrypt its field values at rest using a key derived from the master passphrase via a standard KDF, with authenticated encryption.
8. WHEN the developer runs or edits an encrypted config in a session where the passphrase has not yet been provided THEN the extension SHALL prompt for the master passphrase to unlock, and SHALL NOT persist the passphrase in plain text.
9. IF the passphrase is incorrect THEN the extension SHALL refuse to decrypt and SHALL explain why, without corrupting the stored data.
10. IF the master passphrase is forgotten THEN the encrypted data is unrecoverable BY DESIGN; the extension SHALL provide no recovery mechanism or backdoor, and SHALL warn the developer of this when the passphrase is set.
11. THE extension SHALL clearly communicate that non-encrypted stored data is only as protected as the browser profile.
12. WHEN storage limits are approached THEN the extension SHALL warn the developer rather than silently dropping data.

### Requirement 9: Error handling and feedback

**User Story:** As a developer, I want clear feedback when a fill or import partially fails, so that I can diagnose why a form did not fill as expected.

#### Acceptance Criteria

1. WHEN a fill completes THEN the extension SHALL report which steps succeeded and which failed, with a reason for each failure.
2. WHEN a config's error strategy is "stop on error" THEN the fill SHALL halt at the first failed step and report it.
3. WHEN a config's error strategy is "continue on error" THEN the fill SHALL attempt all steps and report a summary.
4. WHEN an operation cannot proceed (e.g. no active tab, restricted page such as browser internal pages) THEN the extension SHALL explain why rather than failing silently.
