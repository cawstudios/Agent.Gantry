# NestJS Quickstart

```ts
// gantry.client.ts
import { Injectable } from '@nestjs/common';
import { createClient } from '@gantry/sdk';

@Injectable()
export class GantryClientService {
  readonly client = createClient({
    socketPath: process.env.GANTRY_CONTROL_SOCKET_PATH,
    apiKey: process.env.GANTRY_SESSIONS_API_KEY!,
  });
}
```

```ts
// agent.service.ts
import { Injectable } from '@nestjs/common';
import { GantryClientService } from './gantry.client';

@Injectable()
export class AgentService {
  constructor(private readonly gantry: GantryClientService) {}

  async ask(conversationId: string, message: string) {
    const session = await this.gantry.client.sessions.ensure({
      conversationId,
      responseMode: 'sse',
    });

    const accepted = await this.gantry.client.sessions.sendMessage({
      sessionId: session.sessionId,
      message,
      senderId: 'backend',
      senderName: 'NestJS',
    });

    return this.gantry.client.sessions.wait(session.sessionId, {
      afterEventId: accepted.acceptedEventId,
      timeoutMs: 120_000,
    });
  }

  async createManualJob(sessionId: string) {
    return this.gantry.client.jobs.create({
      sessionId,
      name: 'manual-summary',
      kind: 'manual',
      prompt: 'Summarize the most recent session activity.',
    });
  }

  async triggerAndWait(jobId: string) {
    const trigger = await this.gantry.client.jobs.trigger(jobId);
    return this.gantry.client.jobs.wait(trigger.triggerId, 120_000);
  }
}
```

Normal sidecar calls derive `appId` from the API key. Pass `appId` only as an
advanced assertion when the caller intentionally verifies a known app scope.
