import { describe, expect, it } from 'vitest';

// Smoke test confirming the Vitest `node` project runs against src/core/.
// Replaced/expanded by real core tests in later tasks.
describe('toolchain scaffold', () => {
  it('runs the node test project', () => {
    expect(1 + 1).toBe(2);
  });
});
