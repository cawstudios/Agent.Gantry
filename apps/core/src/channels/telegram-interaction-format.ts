import type {
  PermissionApprovalRequest,
  PermissionApprovalSuggestion,
  UserQuestionRequest,
} from '../core/types.js';

const TELEGRAM_INLINE_BUTTON_TEXT_MAX_BYTES = 56;

export const TELEGRAM_PERMISSION_CALLBACK_PATTERN =
  /^perm:(approve|deny|note|suggest):([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})(?::(\d+))?$/;

export const TELEGRAM_USER_QUESTION_CALLBACK_PATTERN =
  /^userq:(select|done|other):([a-zA-Z0-9][a-zA-Z0-9._-]{0,127}):(\d+)(?::(\d+))?$/;

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function truncateUtf8ToByteLimit(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffix = '...';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (maxBytes <= suffixBytes) return suffix.slice(0, maxBytes);
  let out = '';
  for (const char of text) {
    const next = out + char;
    if (Buffer.byteLength(next, 'utf8') + suffixBytes > maxBytes) break;
    out = next;
  }
  return `${out}${suffix}`;
}

export function pendingUserQuestionKey(
  requestId: string,
  questionIndex: number,
): string {
  return `${requestId}:${questionIndex}`;
}

export function pendingReplyKey(chatId: string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

export function formatPermissionPromptText(
  request: PermissionApprovalRequest,
  timeoutMs: number,
): string {
  const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
  const lines = [
    `Permission request: ${request.requestId}`,
    `Tool: ${request.displayName || request.toolName}`,
    `Source: ${request.sourceGroup}`,
  ];
  if (request.title) lines.push(`Action: ${request.title}`);
  if (request.blockedPath) lines.push(`Path: ${request.blockedPath}`);
  if (request.decisionReason) lines.push(`Reason: ${request.decisionReason}`);
  if (request.description) lines.push(`Details: ${request.description}`);
  lines.push(...formatPermissionToolInputLines(request));
  lines.push(`Reply timeout: ${timeoutMinutes} minute(s)`);
  return lines.join('\n');
}

function formatPermissionToolInputLines(
  request: PermissionApprovalRequest,
): string[] {
  if (!request.toolInput || typeof request.toolInput !== 'object') return [];
  const input = request.toolInput;
  if (
    request.toolName === 'Bash' &&
    typeof input.command === 'string' &&
    input.command.trim()
  ) {
    return [`Command: \`${truncateText(input.command.trim(), 300)}\``];
  }
  if (request.toolName === 'Edit' || request.toolName === 'Write') {
    const lines: string[] = [];
    if (typeof input.file_path === 'string' && input.file_path.trim()) {
      lines.push(`File: ${truncateText(input.file_path.trim(), 250)}`);
    }
    if (typeof input.old_string === 'string' && input.old_string.trim()) {
      lines.push(`Replacing: ${truncateText(input.old_string.trim(), 150)}`);
    }
    if (typeof input.new_string === 'string' && input.new_string.trim()) {
      lines.push(`With: ${truncateText(input.new_string.trim(), 150)}`);
    }
    if (lines.length > 0) return lines;
  }
  try {
    return [`Input: ${truncateText(JSON.stringify(input), 300)}`];
  } catch {
    return ['Input: [unserializable]'];
  }
}

export function formatUserQuestionPromptText(
  question: UserQuestionRequest['questions'][number],
  timeoutMs: number,
): string {
  const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
  const lines = [`? ${question.header}`, question.question, ''];
  question.options.forEach((option, optionIndex) => {
    const description = option.description
      ? ` - ${truncateText(option.description, 180)}`
      : '';
    const recommended = optionIndex === 0 ? ' (recommended)' : '';
    lines.push(
      `${optionIndex + 1}. ${option.label}${recommended}${description}`,
    );
    if (option.preview) {
      lines.push(`  Preview: ${truncateText(option.preview, 180)}`);
    }
  });
  lines.push('');
  lines.push(
    question.multiSelect
      ? 'Select one or more options, then tap Done.'
      : 'Select one option.',
  );
  lines.push(`Reply timeout: ${timeoutMinutes} minute(s)`);
  return lines.join('\n');
}

function formatUserQuestionButtonLabel(
  optionLabel: string,
  optionIndex: number,
  multiSelect: boolean,
  isSelected: boolean,
): string {
  const ordinal = `${optionIndex + 1}. `;
  const selectedPrefix = multiSelect && isSelected ? '* ' : '';
  const recommendedSuffix = optionIndex === 0 ? ' *' : '';
  const prefix = `${selectedPrefix}${ordinal}`;
  const availableBytes = Math.max(
    8,
    TELEGRAM_INLINE_BUTTON_TEXT_MAX_BYTES -
      Buffer.byteLength(prefix, 'utf8') -
      Buffer.byteLength(recommendedSuffix, 'utf8'),
  );
  const trimmedLabel = optionLabel.trim() || `Option ${optionIndex + 1}`;
  const safeLabel = truncateUtf8ToByteLimit(trimmedLabel, availableBytes);
  return `${prefix}${safeLabel}${recommendedSuffix}`;
}

export function buildUserQuestionKeyboard(
  requestId: string,
  questionIndex: number,
  question: UserQuestionRequest['questions'][number],
  selectedOptionIndexes: Set<number>,
): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> =
    question.options.map((option, optionIndex) => {
      const isSelected = selectedOptionIndexes.has(optionIndex);
      return [
        {
          text: formatUserQuestionButtonLabel(
            option.label,
            optionIndex,
            question.multiSelect,
            isSelected,
          ),
          callback_data: `userq:select:${requestId}:${questionIndex}:${optionIndex}`,
        },
      ];
    });
  if (question.multiSelect) {
    const selectedCount = selectedOptionIndexes.size;
    inline_keyboard.push([
      {
        text: selectedCount > 0 ? `Done (${selectedCount})` : 'Done',
        callback_data: `userq:done:${requestId}:${questionIndex}`,
      },
    ]);
  }
  inline_keyboard.push([
    {
      text: 'Other...',
      callback_data: `userq:other:${requestId}:${questionIndex}`,
    },
  ]);
  return { inline_keyboard };
}

export function formatPermissionSuggestionButton(
  suggestion: PermissionApprovalSuggestion,
  index: number,
): string {
  const raw =
    'rules' in suggestion
      ? `${suggestion.behavior} ${suggestion.rules
          .map((rule) => rule.toolName)
          .join(', ')}`
      : 'directories' in suggestion
        ? `${suggestion.type} ${suggestion.directories.length} dir(s)`
        : `mode ${suggestion.mode || index + 1}`;
  return truncateUtf8ToByteLimit(`Allow ${raw} this session`, 48);
}