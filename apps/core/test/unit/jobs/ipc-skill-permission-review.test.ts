import { describe, expect, it, vi } from 'vitest';

import { startSkillPermissionReview } from '@core/jobs/ipc-skill-permission-review.js';
import { skillNameForReceipt } from '@core/jobs/skill-install-assets.js';
import { withSkillMaterializationLock } from '@core/shared/skill-install-lock.js';
import { materializedSkillDirectoryNameFor } from '@core/domain/skills/skills.js';

describe('skill permission review install sequence', () => {
  it('holds the materialization lock across install, bind failure, and rollback', async () => {
    const order: string[] = [];
    const key = materializedSkillDirectoryNameFor(
      skillNameForReceipt([], 'demo-skill'),
    ).toLowerCase();
    const rollbackInstalledSkillBinding = vi.fn(async () => {
      order.push('rollback');
    });
    const service = {
      installSkill: vi.fn(async () => {
        order.push('install');
        // A same-key writer queued mid-sequence must wait for the full
        // install→bind→rollback compensation, not just the install step.
        void withSkillMaterializationLock(key, async () => {
          order.push('concurrent');
        });
        return { id: 'skill:1', name: 'demo-skill' };
      }),
      bindSkillToAgent: vi.fn(async () => {
        order.push('bind');
        throw new Error('bind failed');
      }),
      rollbackInstalledSkillBinding,
    };
    const reject = vi.fn();
    const onBlocked = vi.fn(async () => undefined);

    await new Promise<void>((resolve) => {
      startSkillPermissionReview({
        deps: {
          requestPermissionApproval: vi.fn(async () => ({
            approved: true,
            decidedBy: 'user:approver',
          })),
          sendMessage: vi.fn(async () => undefined),
        },
        responder: { acceptData: vi.fn(), reject },
        service,
        syncApprovedCapabilitySettings: vi.fn(async () => undefined),
        appId: 'app:test',
        agentId: 'agent:test',
        sourceAgentFolder: 'main_agent',
        targetJid: 'chat:one',
        skill: { name: 'demo-skill' },
        assets: [],
        fileSummaries: [],
        skillMarkdownPreview: {
          path: 'SKILL.md',
          content: '',
          truncated: false,
        },
        totalSizeBytes: 0,
        reason: 'test install',
        requestToolName: 'request_skill_install',
        onBlocked,
        onSettled: resolve,
      } as never);
    });
    await withSkillMaterializationLock(key, async () => {
      order.push('after-settle');
    });

    expect(order).toEqual([
      'install',
      'bind',
      'rollback',
      'concurrent',
      'after-settle',
    ]);
    expect(rollbackInstalledSkillBinding).toHaveBeenCalledWith({
      appId: 'app:test',
      agentId: 'agent:test',
      skillId: 'skill:1',
    });
    expect(onBlocked).toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      'bind failed',
      'permission_review_failed',
    );
  });
});
