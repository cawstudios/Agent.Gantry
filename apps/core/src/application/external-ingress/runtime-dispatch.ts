import type {
  SessionInteractionModule,
  SessionQueueIntent,
} from '../sessions/session-interaction-module.js';
import type { ConversationMessageQueueIntent } from './conversation-message-ingress.js';

export type SessionGroupRegistration = Awaited<
  ReturnType<SessionInteractionModule['ensureSession']>
>['registerGroup'];

export const EXTERNAL_INGRESS_RUNTIME_DISPATCH = Symbol(
  'externalIngressRuntimeDispatch',
);

export type ExternalIngressRuntimeDispatch = {
  enqueue?: ConversationMessageQueueIntent | SessionQueueIntent;
  localEnqueue?: boolean;
};

export function toPublicSessionQueueIntent(enqueue: SessionQueueIntent) {
  return {
    conversationJid: enqueue.conversationJid,
    threadId: enqueue.threadId,
    queueKey: enqueue.queueKey,
  };
}
