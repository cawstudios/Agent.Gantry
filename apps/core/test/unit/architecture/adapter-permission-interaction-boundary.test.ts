import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('adapter permission interaction ownership', () => {
  it('keeps Slack permission handling outside the general interaction facade', () => {
    const facade = read('apps/core/src/channels/slack/channel-interactions.ts');
    const permissions = read(
      'apps/core/src/channels/slack/channel-permission-interactions.ts',
    );

    expect(facade).toContain('extends SlackChannelPermissionInteractions');
    expect(facade).not.toContain('resolvePermissionPrompt(');
    expect(permissions).toContain('resolvePermissionPrompt(');
    expect(permissions).toContain('registerSlackPermissionHandlers(');
  });

  it('keeps Discord permission handling outside the general interaction facade', () => {
    const facade = read('apps/core/src/channels/discord-interactions.ts');
    const permissions = read(
      'apps/core/src/channels/discord-permission-interactions.ts',
    );

    expect(facade).toContain('extends DiscordPermissionInteractions');
    expect(facade).not.toContain('requestPermissionApproval(');
    expect(permissions).toContain('requestPermissionApproval(');
    expect(permissions).toContain('handlePermissionInteraction(');
  });
});
