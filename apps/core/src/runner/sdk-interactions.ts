import fs from 'fs';
import path from 'path';
import { timingSafeEqual } from 'crypto';

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

import { nowIso, nowMs, sleep } from '../core/datetime.js';
import { isPlainObject } from '../core/object.js';
import { sanitizePermissionUpdates } from '../core/permission-updates.js';

export type PermissionSuggestion = PermissionUpdate;

export interface PermissionDecision {
  approved: boolean;
  decidedBy?: string;
  reason?: string;
  updatedPermissions?: PermissionSuggestion[];
}

interface UserQuestionOptionInput {
  label: string;
  description: string;
  preview?: string;
}

export interface UserQuestionInputItem {
  question: string;
  header: string;
  options: UserQuestionOptionInput[];
  multiSelect: boolean;
}

interface UserQuestionResponse {
  requestId: string;
  answers: Record<string, string | string[]>;
  answeredBy?: string;
}

const PERMISSION_REQUEST_TIMEOUT_MS = Math.max(
  10_000,
  parseInt(process.env.MYCLAW_PERMISSION_TIMEOUT_MS || '300000', 10) || 300_000,
);
const SDK_INTERACTION_POLL_MS = 100;

function resolveGroupIpcDir(ipcBaseDir: string, groupFolder: string): string {
  if (path.basename(ipcBaseDir) === groupFolder) return ipcBaseDir;
  return path.join(ipcBaseDir, groupFolder);
}

function sanitizeString(
  value: unknown,
  maxLen: number,
  allowEmpty = false,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed && !allowEmpty) return undefined;
  return trimmed.slice(0, maxLen);
}

export function normalizePermissionSuggestions(
  value: unknown,
): PermissionSuggestion[] | undefined {
  const suggestions = sanitizePermissionUpdates(value);
  return suggestions as PermissionSuggestion[] | undefined;
}

function hasExpectedAuthToken(raw: unknown, expectedToken: string): boolean {
  if (!expectedToken) return true;
  if (!isPlainObject(raw) || typeof raw.authToken !== 'string') return false;
  if (raw.authToken.length !== expectedToken.length) return false;
  return timingSafeEqual(
    Buffer.from(raw.authToken),
    Buffer.from(expectedToken),
  );
}

export function parseAskUserQuestionInput(
  input: unknown,
): UserQuestionInputItem[] {
  if (!isPlainObject(input) || !Array.isArray(input.questions)) {
    throw new Error('AskUserQuestion input must include questions');
  }
  if (input.questions.length < 1 || input.questions.length > 4) {
    throw new Error('AskUserQuestion input must include 1-4 questions');
  }
  return input.questions.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`Question ${index + 1} is invalid`);
    }
    const question = sanitizeString(item.question, 500);
    const header = sanitizeString(item.header, 64);
    if (!question || !header) {
      throw new Error(`Question ${index + 1} needs a header and question`);
    }
    if (!Array.isArray(item.options)) {
      throw new Error(`Question ${index + 1} needs options`);
    }
    if (item.options.length < 2 || item.options.length > 4) {
      throw new Error(`Question ${index + 1} must include 2-4 options`);
    }
    const options = item.options.map((option, optionIndex) => {
      if (!isPlainObject(option)) {
        throw new Error(`Option ${optionIndex + 1} is invalid`);
      }
      const label = sanitizeString(option.label, 120);
      if (!label) {
        throw new Error(`Option ${optionIndex + 1} needs a label`);
      }
      return {
        label,
        description: sanitizeString(option.description, 500, true) || '',
        ...(sanitizeString(option.preview, 1200, true)
          ? { preview: sanitizeString(option.preview, 1200, true) }
          : {}),
      };
    });
    return {
      question,
      header,
      options,
      multiSelect: Boolean(item.multiSelect),
    };
  });
}

export async function requestPermissionApproval(options: {
  ipcBaseDir: string;
  ipcAuthToken: string;
  groupFolder: string;
  toolName: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  toolInput?: unknown;
  suggestions?: PermissionSuggestion[];
}): Promise<PermissionDecision> {
  try {
    const groupIpcDir = resolveGroupIpcDir(
      options.ipcBaseDir,
      options.groupFolder,
    );
    const permissionRequestsDir = path.join(groupIpcDir, 'permission-requests');
    const permissionResponsesDir = path.join(
      groupIpcDir,
      'permission-responses',
    );
    fs.mkdirSync(permissionRequestsDir, { recursive: true });
    fs.mkdirSync(permissionResponsesDir, { recursive: true });
    const requestId = `perm-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestPath = path.join(permissionRequestsDir, `${requestId}.json`);
    const requestTmpPath = `${requestPath}.tmp`;
    const envelope = {
      requestId,
      sourceGroup: options.groupFolder,
      toolName: options.toolName,
      ...(options.title ? { title: options.title } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.decisionReason
        ? { decisionReason: options.decisionReason }
        : {}),
      ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
      ...(isPlainObject(options.toolInput)
        ? { toolInput: options.toolInput }
        : {}),
      ...(options.suggestions?.length
        ? { suggestions: options.suggestions }
        : {}),
      ...(options.ipcAuthToken ? { authToken: options.ipcAuthToken } : {}),
      timestamp: nowIso(),
    };
    fs.writeFileSync(requestTmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(requestTmpPath, requestPath);

    const responsePath = path.join(permissionResponsesDir, `${requestId}.json`);
    const deadline = nowMs() + PERMISSION_REQUEST_TIMEOUT_MS;
    while (nowMs() < deadline) {
      if (fs.existsSync(responsePath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
          fs.unlinkSync(responsePath);
          if (
            raw &&
            typeof raw === 'object' &&
            (raw as { requestId?: string }).requestId === requestId &&
            hasExpectedAuthToken(raw, options.ipcAuthToken)
          ) {
            return {
              approved: Boolean((raw as { approved?: unknown }).approved),
              decidedBy:
                typeof (raw as { decidedBy?: unknown }).decidedBy === 'string'
                  ? (raw as { decidedBy: string }).decidedBy
                  : undefined,
              reason:
                typeof (raw as { reason?: unknown }).reason === 'string'
                  ? (raw as { reason: string }).reason
                  : undefined,
              updatedPermissions: normalizePermissionSuggestions(
                (raw as { updatedPermissions?: unknown }).updatedPermissions,
              ),
            };
          }
          return { approved: false, reason: 'Malformed permission response' };
        } catch (err) {
          return {
            approved: false,
            reason:
              err instanceof Error
                ? err.message
                : 'Failed to read permission response',
          };
        }
      }
      await sleep(SDK_INTERACTION_POLL_MS);
    }
    return {
      approved: false,
      reason: 'Timed out waiting for host permission approval',
    };
  } catch (err) {
    return {
      approved: false,
      reason:
        err instanceof Error
          ? `Permission request failed: ${err.message}`
          : 'Permission request failed',
    };
  }
}

export async function requestUserQuestion(options: {
  ipcBaseDir: string;
  ipcAuthToken: string;
  groupFolder: string;
  questions: UserQuestionInputItem[];
  signal: AbortSignal;
}): Promise<UserQuestionResponse> {
  const groupIpcDir = resolveGroupIpcDir(
    options.ipcBaseDir,
    options.groupFolder,
  );
  const userQuestionRequestsDir = path.join(groupIpcDir, 'user-questions');
  const userQuestionResponsesDir = path.join(groupIpcDir, 'user-answers');
  fs.mkdirSync(userQuestionRequestsDir, { recursive: true });
  fs.mkdirSync(userQuestionResponsesDir, { recursive: true });

  const requestId = `userq-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestPath = path.join(userQuestionRequestsDir, `${requestId}.json`);
  const requestTmpPath = `${requestPath}.tmp`;
  fs.writeFileSync(
    requestTmpPath,
    JSON.stringify(
      {
        requestId,
        sourceGroup: options.groupFolder,
        questions: options.questions,
        ...(options.ipcAuthToken ? { authToken: options.ipcAuthToken } : {}),
        timestamp: nowIso(),
      },
      null,
      2,
    ),
  );
  fs.renameSync(requestTmpPath, requestPath);

  const responsePath = path.join(userQuestionResponsesDir, `${requestId}.json`);
  const deadline = nowMs() + PERMISSION_REQUEST_TIMEOUT_MS;
  while (nowMs() < deadline) {
    if (options.signal.aborted) {
      return { requestId, answers: {} };
    }
    if (fs.existsSync(responsePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        if (
          !isPlainObject(raw) ||
          raw.requestId !== requestId ||
          !hasExpectedAuthToken(raw, options.ipcAuthToken)
        ) {
          return { requestId, answers: {} };
        }
        const rawAnswers = isPlainObject(raw.answers) ? raw.answers : {};
        const answers: Record<string, string | string[]> = {};
        for (const [question, value] of Object.entries(rawAnswers)) {
          if (typeof value === 'string') {
            const answer = value.trim().slice(0, 1000);
            if (answer) answers[question] = answer;
          } else if (Array.isArray(value)) {
            const answer = value
              .map((item) => String(item).trim().slice(0, 500))
              .filter(Boolean)
              .slice(0, 10);
            if (answer.length > 0) answers[question] = answer;
          }
        }
        return {
          requestId,
          answers,
          ...(typeof raw.answeredBy === 'string' && raw.answeredBy.trim()
            ? { answeredBy: raw.answeredBy.trim().slice(0, 120) }
            : {}),
        };
      } catch {
        return { requestId, answers: {} };
      }
    }
    await sleep(SDK_INTERACTION_POLL_MS);
  }
  return { requestId, answers: {} };
}

export function formatAskUserQuestionAnswers(
  answers: Record<string, string | string[]>,
): Record<string, string> {
  const formatted: Record<string, string> = {};
  for (const [question, answer] of Object.entries(answers)) {
    if (Array.isArray(answer)) {
      const joined = answer
        .map((item) => item.trim())
        .filter(Boolean)
        .join(', ');
      if (joined) formatted[question] = joined;
    } else {
      const trimmed = answer.trim();
      if (trimmed) formatted[question] = trimmed;
    }
  }
  return formatted;
}