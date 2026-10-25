/**
 * Unit tests for {@link changeStepType}, the pure helper that rebuilds a step
 * under a new type while preserving its shared identity (id, target, label).
 *
 * Focused on the radio variant (and its transitions) added for radio-group
 * support, plus the invariant that identity survives every transition so a
 * config always round-trips through the {@link FieldStep} union.
 */

import { describe, expect, it } from 'vitest';

import type {
  AutocompleteStep,
  CheckStep,
  RadioStep,
  SelectStep,
} from '../core/schema';
import { changeStepType } from './StepEditor';

const base = {
  id: 'step-1',
  label: 'Contact method',
  target: { by: 'name' as const, value: 'contact' },
};

describe('changeStepType — radio', () => {
  it('produces a valid radio step with an empty value', () => {
    const check: CheckStep = { ...base, type: 'check', checked: true };
    const radio = changeStepType(check, 'radio') as RadioStep;
    expect(radio.type).toBe('radio');
    expect(radio.value).toBe('');
  });

  it('preserves id, target, and label across the transition', () => {
    const select: SelectStep = {
      ...base,
      type: 'select',
      value: 'x',
      matchBy: 'value',
    };
    const radio = changeStepType(select, 'radio');
    expect(radio.id).toBe('step-1');
    expect(radio.label).toBe('Contact method');
    expect(radio.target).toEqual({ by: 'name', value: 'contact' });
  });

  it('converts radio to another type, resetting type-specific fields', () => {
    const radio: RadioStep = { ...base, type: 'radio', value: 'email' };
    const check = changeStepType(radio, 'check') as CheckStep;
    expect(check.type).toBe('check');
    expect(check.checked).toBe(false);
    expect(check.id).toBe('step-1');
  });

  it('is a no-op when the type is unchanged', () => {
    const radio: RadioStep = { ...base, type: 'radio', value: 'email' };
    expect(changeStepType(radio, 'radio')).toBe(radio);
  });
});

describe('changeStepType — autocomplete', () => {
  it('produces a valid autocomplete step with sensible defaults', () => {
    const check: CheckStep = { ...base, type: 'check', checked: true };
    const auto = changeStepType(check, 'autocomplete') as AutocompleteStep;
    expect(auto.type).toBe('autocomplete');
    expect(auto.value).toBe('');
    expect(auto.optionMatch).toBe('');
    expect(auto.optionTarget).toEqual({ by: 'css', value: '[role="option"]' });
    expect(auto.timeoutMs).toBeGreaterThan(0);
  });

  it('preserves id, target, and label when switching to autocomplete', () => {
    const select: SelectStep = {
      ...base,
      type: 'select',
      value: 'x',
      matchBy: 'value',
    };
    const auto = changeStepType(select, 'autocomplete');
    expect(auto.id).toBe('step-1');
    expect(auto.label).toBe('Contact method');
    expect(auto.target).toEqual({ by: 'name', value: 'contact' });
  });

  it('converts autocomplete to another type, resetting type-specific fields', () => {
    const auto: AutocompleteStep = {
      ...base,
      type: 'autocomplete',
      value: 'Penn',
      optionTarget: { by: 'css', value: '[role="option"]' },
      optionMatch: 'Pennsylvania',
      timeoutMs: 2000,
    };
    const text = changeStepType(auto, 'text');
    expect(text.type).toBe('text');
    expect(text.id).toBe('step-1');
  });
});
