/**
 * Component tests for the capture review view (task 12.3, Req 2.2, 2.4, 2.5, 2.6).
 *
 * These run under the jsdom Vitest project with @testing-library/preact and
 * exercise {@link CaptureReview} in isolation (no RPC/background): given a set
 * of {@link CaptureCandidate}s, the view renders each candidate's step, warns on
 * fragile selectors (Req 2.6), lets the user prune by unchecking (Req 2.5), and
 * builds a draft {@link FillConfig} containing ONLY the kept steps — capture
 * never auto-saves, so the built draft is handed to `onCreate` for the editor to
 * name and explicitly save (Req 2.5).
 *
 * Requirements: 2.2, 2.4, 2.5, 2.6
 */

import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';

import type { CaptureCandidate } from '../content/capture';
import type { FillConfig } from '../core/schema';
import { CaptureReview } from './CaptureReview';

const CANDIDATES: CaptureCandidate[] = [
  {
    step: { id: 's1', type: 'text', target: { by: 'id', value: 'email' }, value: 'a@b.co' },
    fragile: false,
  },
  {
    step: {
      id: 's2',
      type: 'check',
      target: { by: 'css', value: 'form > input:nth-of-type(2)' },
      checked: true,
    },
    fragile: true,
  },
];

describe('CaptureReview', () => {
  it('renders every candidate step and flags the fragile one (Req 2.2, 2.6)', () => {
    render(
      <CaptureReview candidates={CANDIDATES} onCreate={vi.fn()} onCancel={vi.fn()} />,
    );

    // Both candidates render a keep toggle + their step editor.
    expect(screen.getAllByLabelText(/^Keep field/)).toHaveLength(2);
    // Each step header shows its (number-only) step number.
    const stepNums = document.querySelectorAll('.step-num');
    expect(Array.from(stepNums).map((n) => n.textContent)).toEqual(['1', '2']);
    // The fragile candidate shows the warning (Req 2.6).
    expect(screen.getByText(/Fragile selector/)).toBeTruthy();
  });

  it('shows an empty message when capture found nothing', () => {
    render(<CaptureReview candidates={[]} onCreate={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/No fillable controls/)).toBeTruthy();
  });

  it('builds a draft with only the kept steps when a candidate is unchecked (Req 2.5)', () => {
    const onCreate = vi.fn();
    render(
      <CaptureReview candidates={CANDIDATES} onCreate={onCreate} onCancel={vi.fn()} />,
    );

    // Drop the second (fragile) candidate.
    const keeps = screen.getAllByLabelText(/^Keep field/) as HTMLInputElement[];
    fireEvent.click(keeps[1] as HTMLInputElement);

    fireEvent.click(screen.getByText(/Create config from/));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const draft = onCreate.mock.calls[0]?.[0] as FillConfig;
    expect(draft).toBeDefined();
    // Only the kept step survives; capture never auto-saves — this is a draft.
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0]?.id).toBe('s1');
    expect(draft.encrypted).toBe(false);
    expect(draft.match).toEqual([]);
    expect(draft.errorStrategy).toBe('stop');
  });

  it('builds a draft with all steps when none are pruned (Req 2.5)', () => {
    const onCreate = vi.fn();
    render(
      <CaptureReview candidates={CANDIDATES} onCreate={onCreate} onCancel={vi.fn()} />,
    );

    fireEvent.click(screen.getByText(/Create config from 2 fields/));

    const draft = onCreate.mock.calls[0]?.[0] as FillConfig;
    expect(draft).toBeDefined();
    expect(draft.steps.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('disables create when every candidate is pruned', () => {
    render(
      <CaptureReview candidates={CANDIDATES} onCreate={vi.fn()} onCancel={vi.fn()} />,
    );

    const keeps = screen.getAllByLabelText(/^Keep field/) as HTMLInputElement[];
    fireEvent.click(keeps[0] as HTMLInputElement);
    fireEvent.click(keeps[1] as HTMLInputElement);

    const create = screen.getByText(/Create config from/).closest('button') as HTMLButtonElement;
    expect(create.disabled).toBe(true);
  });

  it('cancels without building a draft (Req 2.5)', () => {
    const onCreate = vi.fn();
    const onCancel = vi.fn();
    render(
      <CaptureReview candidates={CANDIDATES} onCreate={onCreate} onCancel={onCancel} />,
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });
});
