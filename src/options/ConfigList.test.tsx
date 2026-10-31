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
    onExport: vi.fn(),
    onImport: vi.fn(),
    onBackup: vi.fn(),
    onEncryption: vi.fn(),
    ...overrides,
  };
  render(<ConfigList {...props} />);
  return props;
}

describe('ConfigList messages', () => {
  it('shows the notice and error between the toolbar and the config list', () => {
    renderList({ notice: 'Downloaded 2 configs.', error: 'Something failed.' });

    const notice = screen.getByText('Downloaded 2 configs.');
    const error = screen.getByText('Something failed.');
    const list = document.querySelector('.config-list')!;
    const toolbar = document.querySelector('.toolbar')!;

    for (const msg of [notice, error]) {
      // Comes after the toolbar and before the list in document order.
      expect(toolbar.compareDocumentPosition(msg) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(msg.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe('ConfigList live regions', () => {
  it('keeps the status and alert regions mounted and fills them in place', () => {
    const props = {
      configs: CONFIGS,
      busy: false,
      onNew: vi.fn(),
      onOpen: vi.fn(),
      onDelete: vi.fn(),
      onExport: vi.fn(),
      onImport: vi.fn(),
      onBackup: vi.fn(),
      onEncryption: vi.fn(),
    };
    const { rerender } = render(<ConfigList {...props} notice={null} error={null} />);

    // Both regions exist, empty, before there is anything to announce.
    const status = screen.getByRole('status');
    const alert = screen.getByRole('alert');
    expect(status.textContent).toBe('');
    expect(alert.textContent).toBe('');

    rerender(<ConfigList {...props} notice="Downloaded 1 config." error="Unlock first." />);

    // The SAME elements now hold the text, so the change is announced.
    expect(screen.getByRole('status')).toBe(status);
    expect(screen.getByRole('alert')).toBe(alert);
    expect(status.textContent).toBe('Downloaded 1 config.');
    expect(alert.textContent).toBe('Unlock first.');
  });
});

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
