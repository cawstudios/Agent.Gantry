import { describe, expect, it } from 'vitest';

import {
  buildRequestableBrowserToolAccess,
  BROWSER_REQUEST_PERMISSION_ARGS,
} from '@core/shared/tool-access-view.js';

describe('tool access view', () => {
  it('lists Browser as requestable with exact persistent browser permission args when not selected', () => {
    expect(buildRequestableBrowserToolAccess({ configuredTools: [] })).toEqual([
      {
        tool: 'Browser',
        toolId: 'tool:Browser',
        requestPermission: BROWSER_REQUEST_PERMISSION_ARGS,
        note: expect.stringContaining('browser_* tools'),
      },
    ]);
    expect(BROWSER_REQUEST_PERMISSION_ARGS).toBe(
      'permissionKind=tool toolName=Browser toolCategory=browser temporaryOnly=false reason="<why this agent needs Browser>"',
    );
  });

  it('does not list Browser as requestable once the canonical capability is selected', () => {
    expect(
      buildRequestableBrowserToolAccess({ configuredTools: ['Browser'] }),
    ).toEqual([]);
    expect(
      buildRequestableBrowserToolAccess({
        externalMcpAllowedTools: ['mcp__agent_browser__*'],
      }),
    ).toHaveLength(1);
    expect(
      buildRequestableBrowserToolAccess({
        configuredTools: ['mcp__myclaw__browser_click'],
      }),
    ).toHaveLength(1);
  });
});
