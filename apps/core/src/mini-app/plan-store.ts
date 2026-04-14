import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { DATA_DIR } from '../core/config.js';
import {
  isValidGroupFolder,
  resolveGroupIpcPath,
} from '../platform/group-folder.js';
import { emitPlanUpdated } from './plan-events-bus.js';
import {
  PLAN_SECTION_STATUS_VALUES,
  PLAN_STATUS_VALUES,
  Plan,
  PlanSection,
  PlanSectionInput,
  PlanSectionStatus,
  PlanStatus,
} from './types.js';

const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLAN_STATUS_SET = new Set<string>(PLAN_STATUS_VALUES);
const PLAN_SECTION_STATUS_SET = new Set<string>(PLAN_SECTION_STATUS_VALUES);
const PLANS_ROOT = path.join(DATA_DIR, 'plans');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toIsoNow(): string {
  return new Date().toISOString();
}

function assertGroupFolder(groupFolder: string): void {
  if (!isValidGroupFolder(groupFolder)) {
    throw new Error(`Invalid group folder: ${groupFolder}`);
  }
}

function assertPlanId(planId: string): void {
  if (!PLAN_ID_PATTERN.test(planId)) {
    throw new Error(`Invalid plan id: ${planId}`);
  }
}

function resolveGroupPlansDir(groupFolder: string): string {
  assertGroupFolder(groupFolder);
  return path.join(PLANS_ROOT, groupFolder);
}

function resolvePlanPath(groupFolder: string, planId: string): string {
  const groupDir = resolveGroupPlansDir(groupFolder);
  assertPlanId(planId);
  return path.join(groupDir, `${planId}.json`);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

function toTrimmedString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLen) return undefined;
  return trimmed;
}

function parsePlanStatus(value: unknown): PlanStatus | undefined {
  const parsed = toTrimmedString(value, 40);
  if (!parsed || !PLAN_STATUS_SET.has(parsed)) return undefined;
  return parsed as PlanStatus;
}

function parsePlanSectionStatus(value: unknown): PlanSectionStatus | undefined {
  const parsed = toTrimmedString(value, 40);
  if (!parsed || !PLAN_SECTION_STATUS_SET.has(parsed)) return undefined;
  return parsed as PlanSectionStatus;
}

function parsePlanSection(raw: unknown): PlanSection | null {
  if (!isPlainObject(raw)) return null;
  const index = typeof raw.index === 'number' ? Math.trunc(raw.index) : NaN;
  const title = toTrimmedString(raw.title, 400);
  const content = typeof raw.content === 'string' ? raw.content : undefined;
  const status = parsePlanSectionStatus(raw.status);
  if (!Number.isFinite(index) || index < 0 || !title || content === undefined) {
    return null;
  }
  return {
    index,
    title,
    content,
    status: status || 'pending',
    ...(toTrimmedString(raw.userFeedback, 20_000)
      ? { userFeedback: String(raw.userFeedback) }
      : {}),
    ...(toTrimmedString(raw.agentRevision, 20_000)
      ? { agentRevision: String(raw.agentRevision) }
      : {}),
    ...(toTrimmedString(raw.decidedAt, 128)
      ? { decidedAt: String(raw.decidedAt) }
      : {}),
    ...(toTrimmedString(raw.decidedBy, 255)
      ? { decidedBy: String(raw.decidedBy) }
      : {}),
  };
}

function parsePlan(raw: unknown): Plan | null {
  if (!isPlainObject(raw)) return null;
  const id = toTrimmedString(raw.id, 128);
  const groupFolder = toTrimmedString(raw.groupFolder, 128);
  const title = toTrimmedString(raw.title, 400);
  const status = parsePlanStatus(raw.status);
  const createdAt = toTrimmedString(raw.createdAt, 128);
  const updatedAt = toTrimmedString(raw.updatedAt, 128);
  if (!id || !groupFolder || !title || !status || !createdAt || !updatedAt) {
    return null;
  }
  if (!isValidGroupFolder(groupFolder) || !PLAN_ID_PATTERN.test(id)) {
    return null;
  }

  const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
  const sections: PlanSection[] = [];
  for (const rawSection of rawSections) {
    const parsed = parsePlanSection(rawSection);
    if (!parsed) return null;
    sections.push(parsed);
  }

  return {
    id,
    groupFolder,
    title,
    status,
    sections: sections.sort((a, b) => a.index - b.index),
    createdAt,
    updatedAt,
    ...(toTrimmedString(raw.chatJid, 255)
      ? { chatJid: String(raw.chatJid) }
      : {}),
    ...(toTrimmedString(raw.agentSessionId, 255)
      ? { agentSessionId: String(raw.agentSessionId) }
      : {}),
  };
}

function readPlanFile(filePath: string): Plan | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return parsePlan(raw);
  } catch {
    return null;
  }
}

function listGroupFolders(): string[] {
  if (!fs.existsSync(PLANS_ROOT)) return [];
  return fs
    .readdirSync(PLANS_ROOT)
    .filter((entry) => isValidGroupFolder(entry))
    .filter(
      (entry) =>
        fs.existsSync(path.join(PLANS_ROOT, entry)) &&
        fs.statSync(path.join(PLANS_ROOT, entry)).isDirectory(),
    );
}

function writePlansSnapshot(groupFolder: string): void {
  const plans = listPlans(groupFolder);
  const ipcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(ipcDir, { recursive: true });
  writeJsonAtomic(path.join(ipcDir, 'current_plans.json'), plans);
}

function persistPlan(plan: Plan, source: string): Plan {
  const groupDir = resolveGroupPlansDir(plan.groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });
  const filePath = resolvePlanPath(plan.groupFolder, plan.id);
  writeJsonAtomic(filePath, plan);
  writePlansSnapshot(plan.groupFolder);
  emitPlanUpdated(plan, source);
  return plan;
}

function findPlanPath(
  planId: string,
): { groupFolder: string; filePath: string } | null {
  assertPlanId(planId);
  const groups = listGroupFolders();
  for (const groupFolder of groups) {
    const filePath = resolvePlanPath(groupFolder, planId);
    if (fs.existsSync(filePath)) {
      return { groupFolder, filePath };
    }
  }
  return null;
}

function clonePlan(plan: Plan): Plan {
  return {
    ...plan,
    sections: plan.sections.map((section) => ({ ...section })),
  };
}

export function listPlans(groupFolder?: string): Plan[] {
  const groups = groupFolder ? [groupFolder] : listGroupFolders();
  const plans: Plan[] = [];
  for (const group of groups) {
    if (!isValidGroupFolder(group)) continue;
    const dir = resolveGroupPlansDir(group);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    for (const file of files) {
      const parsed = readPlanFile(path.join(dir, file));
      if (parsed) plans.push(parsed);
    }
  }
  return plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getPlanById(
  planId: string,
  opts: { groupFolder?: string } = {},
): Plan | null {
  assertPlanId(planId);
  if (opts.groupFolder) {
    const planPath = resolvePlanPath(opts.groupFolder, planId);
    if (!fs.existsSync(planPath)) return null;
    const parsed = readPlanFile(planPath);
    return parsed ? clonePlan(parsed) : null;
  }

  const located = findPlanPath(planId);
  if (!located) return null;
  const parsed = readPlanFile(located.filePath);
  return parsed ? clonePlan(parsed) : null;
}

function mutatePlan(
  planId: string,
  mutate: (plan: Plan) => void,
  source: string,
): Plan {
  const located = findPlanPath(planId);
  if (!located) {
    throw new Error(`Plan not found: ${planId}`);
  }
  const existing = readPlanFile(located.filePath);
  if (!existing) {
    throw new Error(`Plan is malformed: ${planId}`);
  }
  const plan = clonePlan(existing);
  mutate(plan);
  plan.updatedAt = toIsoNow();
  return persistPlan(plan, source);
}

export function createPlan(input: {
  planId?: string;
  groupFolder: string;
  chatJid?: string;
  title: string;
  sections: PlanSectionInput[];
  status?: PlanStatus;
  agentSessionId?: string;
}): Plan {
  assertGroupFolder(input.groupFolder);
  const title = input.title.trim();
  if (!title) throw new Error('Plan title is required');
  const planId = (input.planId || randomUUID()).trim();
  assertPlanId(planId);

  const createdAt = toIsoNow();
  const sections: PlanSection[] = input.sections.map((section, index) => {
    const sectionTitle = section.title.trim();
    if (!sectionTitle) {
      throw new Error(`Section ${index + 1} title is required`);
    }
    return {
      index,
      title: sectionTitle,
      content: section.content,
      status: 'pending',
    };
  });

  const plan: Plan = {
    id: planId,
    groupFolder: input.groupFolder,
    title,
    status: input.status || 'reviewing',
    sections,
    createdAt,
    updatedAt: createdAt,
    ...(input.chatJid?.trim() ? { chatJid: input.chatJid.trim() } : {}),
    ...(input.agentSessionId?.trim()
      ? { agentSessionId: input.agentSessionId.trim() }
      : {}),
  };

  return persistPlan(plan, 'create_plan');
}

export function updatePlanSection(input: {
  planId: string;
  sectionIndex: number;
  title?: string;
  content?: string;
  status?: PlanSectionStatus;
  userFeedback?: string;
  agentRevision?: string;
  decidedBy?: string;
}): Plan {
  return mutatePlan(
    input.planId,
    (plan) => {
      const index = Math.trunc(input.sectionIndex);
      const section = plan.sections.find((item) => item.index === index);
      if (!section) {
        throw new Error(`Section ${index} not found in plan ${plan.id}`);
      }
      if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title) throw new Error('Section title cannot be empty');
        section.title = title;
      }
      if (input.content !== undefined) section.content = input.content;
      if (input.status !== undefined) section.status = input.status;
      if (input.userFeedback !== undefined) {
        const feedback = input.userFeedback.trim();
        if (feedback) section.userFeedback = feedback;
        else delete section.userFeedback;
      }
      if (input.agentRevision !== undefined) {
        const revision = input.agentRevision.trim();
        if (revision) section.agentRevision = revision;
        else delete section.agentRevision;
      }
      if (input.decidedBy !== undefined) {
        const decidedBy = input.decidedBy.trim();
        if (decidedBy) section.decidedBy = decidedBy;
      }
      if (
        input.status === 'approved' ||
        input.status === 'rejected' ||
        input.status === 'done'
      ) {
        section.decidedAt = toIsoNow();
      }
    },
    'update_plan_section',
  );
}

export function setPlanStatus(planId: string, status: PlanStatus): Plan {
  return mutatePlan(
    planId,
    (plan) => {
      plan.status = status;
    },
    'set_plan_status',
  );
}

export function approveAllPlanSections(
  planId: string,
  decidedBy?: string,
): Plan {
  return mutatePlan(
    planId,
    (plan) => {
      const now = toIsoNow();
      for (const section of plan.sections) {
        if (section.status === 'approved' || section.status === 'done')
          continue;
        section.status = 'approved';
        section.decidedAt = now;
        if (decidedBy) section.decidedBy = decidedBy;
      }
      plan.status = 'approved';
    },
    'approve_all_plan_sections',
  );
}

export function rejectPlan(planId: string, decidedBy?: string): Plan {
  return mutatePlan(
    planId,
    (plan) => {
      plan.status = 'rejected';
      const now = toIsoNow();
      for (const section of plan.sections) {
        if (section.status === 'rejected') continue;
        section.status = 'rejected';
        section.decidedAt = now;
        if (decidedBy) section.decidedBy = decidedBy;
      }
    },
    'reject_plan',
  );
}

export function touchPlan(planId: string): Plan {
  return mutatePlan(
    planId,
    () => {
      // Touch updatedAt only.
    },
    'touch_plan',
  );
}
