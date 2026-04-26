import { describe, expect, it } from 'vitest';

import {
  AgentResponseSchema,
  BROWSER_IPC_ACTIONS,
  BrowserProfileResponseSchema,
  CreateJobRequestSchema,
  MEMORY_IPC_ACTIONS,
  MemoryItemResponseSchema,
  PageRequestSchema,
  StreamEventSchema,
} from '@contracts-src/index.js';

describe('contracts package', () => {
  it('exports memory IPC actions from the canonical memory module', () => {
    expect(MEMORY_IPC_ACTIONS).toEqual([
      'memory_search',
      'memory_save',
      'memory_patch',
      'memory_consolidate',
      'memory_dream',
      'procedure_save',
      'procedure_patch',
    ]);
  });

  it('exports browser IPC actions from the canonical browser module', () => {
    expect(BROWSER_IPC_ACTIONS).toEqual([
      'browser_profile_list',
      'browser_launch',
      'browser_close',
      'browser_status',
    ]);
  });

  it('validates representative canonical DTOs', () => {
    expect(
      AgentResponseSchema.parse({
        id: 'agent-1',
        appId: 'app-1',
        name: 'Operator',
        status: 'active',
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
      }),
    ).toMatchObject({ id: 'agent-1', appId: 'app-1' });

    expect(
      CreateJobRequestSchema.parse({
        appId: 'app-1',
        name: 'Daily summary',
        prompt: 'Summarize open work',
        schedule: { type: 'manual' },
      }),
    ).toMatchObject({ name: 'Daily summary' });

    expect(
      MemoryItemResponseSchema.parse({
        id: 'memory-1',
        appId: 'app-1',
        subject: { type: 'common', id: 'common' },
        kind: 'fact',
        key: 'timezone',
        value: 'Asia/Kolkata',
        confidence: 1,
        status: 'active',
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
      }),
    ).toMatchObject({ key: 'timezone' });

    expect(
      BrowserProfileResponseSchema.parse({
        id: 'browser-1',
        appId: 'app-1',
        name: 'default',
        status: 'active',
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
      }),
    ).toMatchObject({ name: 'default' });
  });

  it('validates pagination and stream event contracts', () => {
    expect(PageRequestSchema.parse({ page: 1, pageSize: 25 })).toEqual({
      page: 1,
      pageSize: 25,
    });

    expect(
      StreamEventSchema.parse({
        type: 'heartbeat',
        id: 'event-1',
        createdAt: '2026-04-27T00:00:00.000Z',
      }),
    ).toMatchObject({ type: 'heartbeat' });
  });
});
