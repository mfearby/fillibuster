#!/usr/bin/env node
// Fillibuster build orchestrator.
//
// Placeholder scaffold (Task 1). The full implementation — per-target Vite
// builds, manifest merging, webextension-polyfill wiring, and zipping — lands
// in Task 13.2. For now this parses the target/flags and reports what it would
// do so the npm scripts (build, build:chrome, build:firefox, package, dev) are
// wired and runnable.

const TARGETS = ['chrome', 'firefox'];

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));

const requested = positional.length > 0 ? positional : TARGETS;
const targets = requested.filter((t) => TARGETS.includes(t));

if (targets.length === 0) {
  console.error(`Unknown target(s): ${requested.join(', ')}. Expected one of: ${TARGETS.join(', ')}`);
  process.exit(1);
}

const doPackage = flags.includes('--package');
const doWatch = flags.includes('--watch');

for (const target of targets) {
  console.log(`[build] target=${target} watch=${doWatch} package=${doPackage} (not yet implemented — see Task 13.2)`);
}
