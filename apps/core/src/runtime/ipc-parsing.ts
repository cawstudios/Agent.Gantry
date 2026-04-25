import {
  BROWSER_IPC_ACTIONS,
  BrowserIpcAction,
  MEMORY_IPC_ACTIONS,
  MemoryIpcAction,
} from '@myclaw/contracts';

import {
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../domain/types.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import { validateIpcAuthRequest } from './ipc-auth-validation.js';

const MEMORY_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PERMISSION_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const BROWSER_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const USER_QUESTION_IPC_REQUEST_ID_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export interface ParsedIpcMessage {
  type: 'message';
  chatJid: string;
  text: string;
  sender?: string;
  threadId?: string;
}

export interface ParsedMemoryIpcRequest {
  requestId: string;
  action: MemoryIpcAction;
  payload: Record<string, unknown>;
  context?: { threadId?: string };
}

export interface ParsedBrowserIpcRequest {
  requestId: string;
  action: BrowserIpcAction;
  payload: Record<string, unknown>;
  threadId?: string;
}

const TOOL_INPUT_MAX_DEPTH = 2;
const TOOL_INPUT_MAX_STRING_LENGTH = 500;
const SECRET_KEY_PATTERN =
  /(secret|token|password|credential|api[_-]?key|key)/i;

function sanitizeToolInputValue(value: unknown, depth: number): unknown {
  if (depth > TOOL_INPUT_MAX_DEPTH) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') {
    if (value.length <= TOOL_INPUT_MAX_STRING_LENGTH) return value;
    return `${value.slice(0, TOOL_INPUT_MAX_STRING_LENGTH)}...[truncated]`;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((entry) => sanitizeToolInputValue(entry, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = sanitizeToolInputValue(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

function sanitizeToolInput(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  return sanitizeToolInputValue(value, 0) as Record<string, unknown>;
}

export function parseIpcMessage(
  raw: unknown,
  sourceGroup: string,
): ParsedIpcMessage {
  if (!isPlainObject(raw)) throw new Error('Invalid IPC message payload');
  const { authThreadId: threadId } = validateIpcAuthRequest(
    raw,
    sourceGroup,
    'IPC message',
  );
  const type = toTrimmedString(raw.type, { maxLen: 64 });
  if (type !== 'message') throw new Error('Invalid IPC message type');
  const chatJid = toTrimmedString(raw.chatJid, { maxLen: 255 });
  const text = toTrimmedString(raw.text, { maxLen: 20000 });
  if (!chatJid || !text) throw new Error('Invalid IPC message fields');
  const sender = toTrimmedString(raw.sender, { maxLen: 255 });
  return {
    type: 'message',
    chatJid,
    text,
    ...(sender ? { sender } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

export function parseMemoryIpcRequest(
  raw: unknown,
  sourceGroup: string,
): ParsedMemoryIpcRequest {
  if (!isPlainObject(raw)) throw new Error('Invalid memory IPC payload');
  const { authThreadId: threadId } = validateIpcAuthRequest(
    raw,
    sourceGroup,
    'memory IPC',
  );
  const requestId = toTrimmedString(raw.requestId, { maxLen: 128 });
  const action = toTrimmedString(raw.action, { maxLen: 64 });
  if (!requestId || !action) {
    throw new Error('Invalid memory IPC request envelope');
  }
  if (!MEMORY_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid memory IPC requestId');
  }
  if (!MEMORY_IPC_ACTIONS.includes(action as MemoryIpcAction)) {
    throw new Error(`Unsupported memory IPC action: ${action}`);
  }
  const payload = raw.payload === undefined ? {} : raw.payload;
  if (!isPlainObject(payload)) {
    throw new Error('Invalid memory IPC payload body');
  }
  return {
    requestId,
    action: action as MemoryIpcAction,
    payload,
    ...(threadId ? { context: { threadId } } : {}),
  };
}

export function parsePermissionIpcRequest(
  raw: unknown,
  sourceGroup: string,
): PermissionApprovalRequest {
  if (!isPlainObject(raw)) throw new Error('Invalid permission IPC payload');
  const { authThreadId: threadId } = validateIpcAuthRequest(
    raw,
    sourceGroup,
    'permission IPC',
  );
  const requestId = toTrimmedString(raw.requestId, { maxLen: 128 });
  if (!requestId || !PERMISSION_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid permission IPC requestId');
  }
  const toolName = toTrimmedString(raw.toolName, { maxLen: 120 });
  if (!toolName) throw new Error('Permission IPC toolName is required');
  const title = toTrimmedString(raw.title, { maxLen: 2000 });
  const displayName = toTrimmedString(raw.displayName, { maxLen: 200 });
  const description = toTrimmedString(raw.description, { maxLen: 4000 });
  const decisionReason = toTrimmedString(raw.decisionReason, { maxLen: 2000 });
  const blockedPath = toTrimmedString(raw.blockedPath, { maxLen: 2048 });
  const toolInput = sanitizeToolInput(raw.toolInput);

  return {
    requestId,
    sourceGroup,
    ...(threadId ? { threadId } : {}),
    toolName,
    ...(title ? { title } : {}),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(decisionReason ? { decisionReason } : {}),
    ...(blockedPath ? { blockedPath } : {}),
    ...(toolInput ? { toolInput } : {}),
  };
}

export function parseUserQuestionIpcRequest(
  raw: unknown,
  sourceGroup: string,
): UserQuestionRequest {
  if (!isPlainObject(raw)) throw new Error('Invalid user question IPC payload');
  const { authThreadId: threadId } = validateIpcAuthRequest(
    raw,
    sourceGroup,
    'user question IPC',
  );

  const requestId = toTrimmedString(raw.requestId, { maxLen: 128 });
  if (!requestId || !USER_QUESTION_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid user question IPC requestId');
  }

  if (!Array.isArray(raw.questions)) {
    throw new Error('User question IPC questions are required');
  }
  if (raw.questions.length < 1 || raw.questions.length > 4) {
    throw new Error('User question IPC must include 1-4 questions');
  }

  const questions: UserQuestionRequest['questions'] = raw.questions.map(
    (item, index) => {
      if (!isPlainObject(item)) {
        throw new Error(`Invalid question payload at index ${index}`);
      }
      const question = toTrimmedString(item.question, { maxLen: 500 });
      const header = toTrimmedString(item.header, { maxLen: 64 });
      if (!question || !header) {
        throw new Error(`Missing question/header at index ${index}`);
      }
      if (!Array.isArray(item.options)) {
        throw new Error(`Missing options at index ${index}`);
      }
      if (item.options.length < 2 || item.options.length > 4) {
        throw new Error(`Question at index ${index} must have 2-4 options`);
      }
      const options = item.options.map((option, optionIndex) => {
        if (!isPlainObject(option)) {
          throw new Error(
            `Invalid option payload at index ${index}:${optionIndex}`,
          );
        }
        const label = toTrimmedString(option.label, { maxLen: 120 });
        const description = toTrimmedString(option.description, {
          maxLen: 500,
          allowEmpty: true,
        });
        const preview = toTrimmedString(option.preview, {
          maxLen: 1200,
          allowEmpty: true,
        });
        if (!label) {
          throw new Error(
            `Option label missing at index ${index}:${optionIndex}`,
          );
        }
        return {
          label,
          description: description || '',
          ...(preview ? { preview } : {}),
        };
      });
      return {
        question,
        header,
        options,
        multiSelect: Boolean(item.multiSelect),
      };
    },
  );

  return {
    requestId,
    sourceGroup,
    ...(threadId ? { threadId } : {}),
    questions,
  };
}

export function parseBrowserIpcRequest(
  raw: unknown,
  sourceGroup: string,
): ParsedBrowserIpcRequest {
  if (!isPlainObject(raw)) throw new Error('Invalid browser IPC payload');
  const { authThreadId: threadId } = validateIpcAuthRequest(
    raw,
    sourceGroup,
    'browser IPC',
  );
  const requestId = toTrimmedString(raw.requestId, { maxLen: 128 });
  const action = toTrimmedString(raw.action, { maxLen: 64 });
  if (!requestId || !action) {
    throw new Error('Invalid browser IPC request envelope');
  }
  if (!BROWSER_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid browser IPC requestId');
  }
  if (!BROWSER_IPC_ACTIONS.includes(action as BrowserIpcAction)) {
    throw new Error(`Unsupported browser IPC action: ${action}`);
  }
  const payload = raw.payload === undefined ? {} : raw.payload;
  if (!isPlainObject(payload)) {
    throw new Error('Invalid browser IPC payload body');
  }
  return {
    requestId,
    action: action as BrowserIpcAction,
    payload,
    ...(threadId ? { threadId } : {}),
  };
}
