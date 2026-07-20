import { sanitizeRetryTailProviderPayload } from '../../../../domain/messages/retry-tail-provider-payload.js';
import type { NewMessage } from '../../../../domain/repositories/domain-types.js';

export function externalRefForMessage(msg: NewMessage) {
  const retryTailPayload = sanitizeRetryTailProviderPayload(
    msg.delivery_retry_tail?.providerPayload,
  );
  const retryTail = msg.delivery_retry_tail
    ? {
        canonicalText: msg.delivery_retry_tail.canonicalText,
        ...(retryTailPayload !== undefined
          ? { providerPayload: retryTailPayload }
          : {}),
      }
    : undefined;
  return {
    kind: 'message',
    id: msg.id,
    chat_jid: msg.chat_jid,
    provider: msg.provider,
    provider_account_id: msg.providerAccountId,
    thread_id: msg.thread_id,
    external_message_id: msg.external_message_id,
    reply_to_message_id: msg.reply_to_message_id,
    reply_to_sender_name: msg.reply_to_sender_name,
    response_schema: msg.responseSchema,
    model_alias: msg.agentControls?.modelAlias,
    effort: msg.agentControls?.effort,
    thinking: msg.agentControls?.thinking,
    max_output_tokens: msg.agentControls?.maxOutputTokens,
    caller_resolved_tools: msg.callerResolvedTools,
    app_response_route: msg.appResponseRoute,
    continuity_mode: msg.continuityMode,
    delivery_retry_tail: retryTail,
  };
}
