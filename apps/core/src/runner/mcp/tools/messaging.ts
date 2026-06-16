import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  nowIso,
  nowMs as currentTimeMs,
} from '../../../shared/time/datetime.js';
import {
  agentId,
  appId,
  groupFolder,
  IPC_AUTH_TOKEN,
  IPC_RESPONSE_KEY_ID,
  jobId,
} from '../context.js';
// Warm-pool (F4): route outbound messages / questions to the BOUND customer
// identity (bind-delivered) so a generic worker never replies to a stale or
// blank jid. Cold path: the accessor returns the spawn-env constant unchanged.
import { getBoundChatJid, getBoundThreadId } from '../bound-identity.js';
import { truncateText } from '../formatting.js';
import {
  buildSignedTaskEnvelope,
  classifyUserQuestionSocketError,
  ensureMcpSocketConnected,
  getMcpSocketClient,
  hasValidIpcResponseSignature,
} from '../ipc.js';
import { createSignedIpcRequestEnvelope } from '../signing.js';
import { makeIpcId } from '../ipc-ids.js';
import { buildUserQuestionRequestPayload } from './user-question-payload.js';

const USER_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
const USER_QUESTION_MAX_ANSWER_LENGTH = 500;
const USER_QUESTION_MAX_ANSWERED_BY_LENGTH = 120;

type UserQuestionToolResult = {
  content: Array<{ type: 'text'; text: string }>;
};

function textResult(text: string): UserQuestionToolResult {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Validate a user-question response object (from either the fs response file or
 * a socket `user_question` resp frame) and render it to the tool's text output.
 * The validation (requestId match + ed25519 signature) and the answer → text
 * formatting are byte-identical across transports, so both paths funnel through
 * here. Returns the rendered result, or an error-text result on a mismatch /
 * bad signature / malformed payload.
 */
function formatUserQuestionResponse(
  raw: {
    requestId?: unknown;
    answers?: Record<string, unknown>;
    answeredBy?: unknown;
    signature?: unknown;
  },
  requestId: string,
): UserQuestionToolResult {
  const payload: Record<string, unknown> = {
    requestId,
    answers: raw?.answers && typeof raw.answers === 'object' ? raw.answers : {},
    ...(typeof raw?.answeredBy === 'string' && raw.answeredBy.trim()
      ? { answeredBy: raw.answeredBy }
      : {}),
  };
  if (raw.requestId !== requestId) {
    return textResult('Answer request id mismatch.');
  }
  if (
    !hasValidIpcResponseSignature(
      raw as unknown as Record<string, unknown>,
      payload,
    )
  ) {
    return textResult('Answer verification failed.');
  }
  if (raw?.answers && typeof raw.answers === 'object') {
    const lines: string[] = [];
    for (const [q, answer] of Object.entries(raw.answers)) {
      const normalizedAnswer = Array.isArray(answer)
        ? answer.map((item) => String(item)).join(', ')
        : String(answer);
      lines.push(
        `${q}: ${truncateText(normalizedAnswer, USER_QUESTION_MAX_ANSWER_LENGTH)}`,
      );
    }
    if (typeof raw.answeredBy === 'string' && raw.answeredBy.trim()) {
      lines.push(
        `(answered by ${truncateText(raw.answeredBy.trim(), USER_QUESTION_MAX_ANSWERED_BY_LENGTH)})`,
      );
    }
    return textResult(lines.join('\n') || 'No answer received.');
  }
  return textResult('No answer received.');
}

export function registerMessagingTools(server: McpServer): void {
  server.tool(
    'send_message',
    "Send a message to the user or group immediately while you're still running. Use this for live progress updates or to send multiple messages. In scheduled jobs, the scheduler sends the completion notification, so do not use this for job results.",
    {
      text: z.string().describe('The message text to send'),
      sender: z
        .string()
        .optional()
        .describe(
          'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
        ),
    },
    async (
      args,
      _context?: {
        signal?: AbortSignal;
      },
    ) => {
      if (jobId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Scheduled job message suppressed. The scheduler will send one completion notification when the job finishes.',
            },
          ],
        };
      }
      const data: Record<string, string | undefined> = {
        type: 'message',
        chatJid: getBoundChatJid(),
        text: args.text,
        sender: args.sender || undefined,
        groupFolder,
        timestamp: nowIso(),
      };

      // Socket-only mode: deliver the message as a fire-and-forget `message`
      // frame over the same mcp-role connection.
      const client = getMcpSocketClient();
      if (client) {
        const connected = await ensureMcpSocketConnected(client);
        if (connected) {
          const signed = buildSignedTaskEnvelope(data);
          client.send('message', signed);
          return {
            content: [{ type: 'text' as const, text: 'Message sent.' }],
          };
        }
      }
      return textResult('Message delivery failed: IPC socket is not connected.');
    },
  );

  server.tool(
    'ask_user_question',
    'Ask the user a structured multiple-choice question. Shows interactive buttons in Telegram. Use when you need the user to pick between discrete options (e.g. which database, which approach, which config). Returns the selected option(s).',
    {
      questions: z
        .array(
          z.object({
            question: z
              .string()
              .describe('The question to ask (must end with ?)'),
            header: z
              .string()
              .max(12)
              .describe(
                'Short label displayed as tag, e.g. "Deploy", "Config"',
              ),
            options: z
              .array(
                z.object({
                  label: z.string().describe('Option text (1-5 words)'),
                  description: z.string().describe('What this option means'),
                }),
              )
              .min(2)
              .max(4),
            multiSelect: z
              .boolean()
              .default(false)
              .describe('Allow selecting multiple options'),
          }),
        )
        .min(1)
        .max(4),
    },
    async (
      args,
      context?: {
        signal?: AbortSignal;
      },
    ) => {
      const requestId = makeIpcId('userq');

      const payload = buildUserQuestionRequestPayload({
        requestId,
        sourceAgentFolder: groupFolder,
        // Stamp the asking conversation's jid so the host routes the question to
        // THIS customer, not a first-match-by-folder fallback (cross-conversation
        // bleed prevention — mirrors how send_message stamps chatJid).
        targetJid: getBoundChatJid(),
        questions: args.questions,
        appId,
        agentId,
        threadId: getBoundThreadId(),
        responseKeyId: IPC_RESPONSE_KEY_ID,
        nowMs: currentTimeMs(),
        timeoutMs: USER_QUESTION_TIMEOUT_MS,
      });
      const envelope = createSignedIpcRequestEnvelope(IPC_AUTH_TOKEN, payload);

      // Socket-only mode: route the question over the same mcp-role connection,
      // reusing the byte-identical signed envelope. The resp frame carries the
      // verified UserQuestionResponse. A socket timeout maps to the same
      // "timed out" outcome.
      const client = getMcpSocketClient();
      if (client) {
        if (context?.signal?.aborted) {
          return textResult(
            'Question cancelled before an answer was received.',
          );
        }
        const connected = await ensureMcpSocketConnected(client);
        if (connected) {
          try {
            const resp = await client.request('user_question', envelope, {
              id: requestId,
              timeoutMs: USER_QUESTION_TIMEOUT_MS,
            });
            return formatUserQuestionResponse(
              resp as {
                requestId?: unknown;
                answers?: Record<string, unknown>;
                answeredBy?: unknown;
                signature?: unknown;
              },
              requestId,
            );
          } catch (err) {
            const disposition = classifyUserQuestionSocketError(err);
            if (disposition.kind === 'timeout') {
              return textResult(
                'Question timed out — no answer received within 5 minutes.',
              );
            }
            if (disposition.kind === 'result') {
              return textResult(
                `Question delivery failed: ${disposition.text}`,
              );
            }
          }
        }
      }
      return textResult('Question delivery failed: IPC socket is not connected.');
    },
  );
}
