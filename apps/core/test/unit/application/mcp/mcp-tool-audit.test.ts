import { describe, expect, it } from 'vitest';
import { projectMcpEvidence } from '@core/application/mcp/mcp-tool-audit.js';

describe('MCP tool evidence projection', () => {
  it('projects URLs from JSON serialized MCP text results', () => {
    expect(
      projectMcpEvidence([
        {
          type: 'text',
          text: JSON.stringify({
            results: [
              { url: 'https://example.test/tenders', title: 'Tenders' },
            ],
          }),
        },
      ]),
    ).toEqual([
      {
        path: '[0].text.results[0].url',
        value: 'https://example.test/tenders',
      },
      { path: '[0].text.results[0].title', value: 'Tenders' },
    ]);
  });
});
