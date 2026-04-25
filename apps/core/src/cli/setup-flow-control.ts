import * as p from '@clack/prompts';

import type { OnboardingStep } from './onboarding-state.js';

export type FlowAction =
  | { type: 'next' }
  | { type: 'start_now' }
  | { type: 'back' }
  | { type: 'resume' }
  | { type: 'cancel' }
  | { type: 'goto'; step: OnboardingStep };

export function toAction(value: unknown): FlowAction {
  if (p.isCancel(value)) return { type: 'resume' };
  if (value === 'next') return { type: 'next' };
  if (value === 'start_now') return { type: 'start_now' };
  if (value === 'back') return { type: 'back' };
  if (value === 'resume') return { type: 'resume' };
  if (value === 'cancel') return { type: 'cancel' };
  if (typeof value === 'string' && value.startsWith('goto:')) {
    const step = value.slice('goto:'.length) as OnboardingStep;
    return { type: 'goto', step };
  }
  return { type: 'next' };
}

export function isInputFlowControl(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === '/back' ||
    normalized === '/resume' ||
    normalized === '/cancel'
  );
}

export function parseInputFlowControl(value: unknown): FlowAction | null {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === '/back') return { type: 'back' };
  if (normalized === '/resume') return { type: 'resume' };
  if (normalized === '/cancel') return { type: 'cancel' };
  return null;
}
