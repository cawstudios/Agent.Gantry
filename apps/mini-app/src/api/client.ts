import { Plan } from '../types/plan';

export function resolveApiBase(): string {
  const url = new URL(window.location.href);
  const apiBase = url.searchParams.get('api');
  if (!apiBase) return '/api';
  return `${apiBase.replace(/\/+$/, '')}/api`;
}

function getInitDataHeader(initData?: string): Record<string, string> {
  return initData
    ? {
        'x-telegram-init-data': initData,
      }
    : {};
}

export async function fetchPlans(initData?: string): Promise<Plan[]> {
  const response = await fetch(`${resolveApiBase()}/plans`, {
    headers: {
      ...getInitDataHeader(initData),
    },
  });
  if (!response.ok)
    throw new Error(`Failed to load plans (${response.status})`);
  const payload = (await response.json()) as { plans?: Plan[] };
  return payload.plans || [];
}

export async function fetchPlan(
  planId: string,
  initData?: string,
): Promise<Plan> {
  const response = await fetch(`${resolveApiBase()}/plans/${planId}`, {
    headers: {
      ...getInitDataHeader(initData),
    },
  });
  if (!response.ok) throw new Error(`Failed to load plan (${response.status})`);
  const payload = (await response.json()) as { plan: Plan };
  return payload.plan;
}

async function postPlanAction(
  url: string,
  initData?: string,
  body?: Record<string, unknown>,
): Promise<Plan> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...getInitDataHeader(initData),
    },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`Action failed (${response.status})`);
  const payload = (await response.json()) as { plan: Plan };
  return payload.plan;
}

export function approveSection(
  planId: string,
  sectionIndex: number,
  initData?: string,
): Promise<Plan> {
  return postPlanAction(
    `${resolveApiBase()}/plans/${planId}/sections/${sectionIndex}/approve`,
    initData,
  );
}

export function rejectSection(
  planId: string,
  sectionIndex: number,
  reason: string,
  initData?: string,
): Promise<Plan> {
  return postPlanAction(
    `${resolveApiBase()}/plans/${planId}/sections/${sectionIndex}/reject`,
    initData,
    { reason },
  );
}

export function editSection(
  planId: string,
  sectionIndex: number,
  content: string,
  initData?: string,
): Promise<Plan> {
  return postPlanAction(
    `${resolveApiBase()}/plans/${planId}/sections/${sectionIndex}/edit`,
    initData,
    { content },
  );
}

export function approveAll(planId: string, initData?: string): Promise<Plan> {
  return postPlanAction(
    `${resolveApiBase()}/plans/${planId}/approve-all`,
    initData,
  );
}

export function rejectPlan(
  planId: string,
  reason: string,
  initData?: string,
): Promise<Plan> {
  return postPlanAction(
    `${resolveApiBase()}/plans/${planId}/reject`,
    initData,
    { reason },
  );
}
