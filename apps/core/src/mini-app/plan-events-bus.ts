import { EventEmitter } from 'events';

import { Plan } from './types.js';

const PLAN_UPDATED_EVENT = 'plan-updated';

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export interface PlanUpdatedEvent {
  plan: Plan;
  source: string;
}

export function emitPlanUpdated(plan: Plan, source: string): void {
  emitter.emit(PLAN_UPDATED_EVENT, { plan, source } satisfies PlanUpdatedEvent);
}

export function onPlanUpdated(
  listener: (event: PlanUpdatedEvent) => void,
): () => void {
  emitter.on(PLAN_UPDATED_EVENT, listener);
  return () => {
    emitter.off(PLAN_UPDATED_EVENT, listener);
  };
}
