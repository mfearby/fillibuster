/**
 * Component tests for the options ConfigList (task 12.1 + encryption markers).
 *
 * Runs under the jsdom Vitest project with @testing-library/preact. Covers that
 * each config row shows the right at-rest encryption marker: a lock for an
 * encrypted config, and an explicit "not encrypted" tag for a plaintext one so
 * the state is never silent (the gap that let an imported, still-plaintext
 * config look protected).
 */

import { render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';

import type { ConfigSummary } from '../platform/messages';
import { ConfigList } from './ConfigList';

const CONFIGS: ConfigSummary[] = [
  { id: 'enc', name: 'Encrypted one', encrypted: true },
  { id: 'plain', name: 'Plain one', encrypted: false },
];

function renderList(overrides: Partial<Parameters<typeof ConfigList>[0]> = {}) {
  const props = {
    configs: CONFIGS,
    busy: false,
    onNew: vi.fn(),
    onOpen: vi.fn(),
    onDelete: vi.fn(),
    onCapture: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(),
    onEncryption: vi.fn(),
    ...overrides,
  };
  render(<ConfigList {...props} />);
  return props;
}

describe('ConfigList encryption markers', () => {
  it('shows a lock on an encrypted config', () => {
    renderList();
    const encrypted = screen.getByLabelText('Encrypted at rest');
    expect(encrypted).toBeTruthy();
  });

  it('shows an explicit "not encrypted" tag on a plaintext config', () => {
    renderList();
    const tag = screen.getByText(/not encrypted/i);
    expect(tag).toBeTruthy();
    // The lock and the plain tag are distinct: exactly one of each for two rows.
    expect(screen.queryAllByText(/not encrypted/i)).toHaveLength(1);
    expect(screen.queryAllByLabelText('Encrypted at rest')).toHaveLength(1);
  });
});
