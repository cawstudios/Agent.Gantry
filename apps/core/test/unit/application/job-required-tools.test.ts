import { describe, expect, it } from 'vitest';

import {
  evaluateRequiredTools,
  normalizeRequiredTools,
} from '@core/application/jobs/job-required-tools.js';

describe('job required tools', () => {
  it('accepts canonical observable required tool rules', () => {
    expect(
      normalizeRequiredTools([
        'Browser',
        'mcp__gantry__send_message',
        'capability:google_sheets',
        'RunCommand(npm test *)',
        'Browser',
      ]),
    ).toEqual([
      'Browser',
      'mcp__gantry__send_message',
      'capability:google_sheets',
      'RunCommand(npm test *)',
    ]);
  });

  it('rejects raw browser and broad wildcard required tool rules', () => {
    expect(() =>
      normalizeRequiredTools(['mcp__browser' + '_' + 'backend' + '__navigate']),
    ).toThrow(/canonical Browser/);
    expect(() =>
      normalizeRequiredTools([`${'mcp__agent'}_${'browser'}__navigate`]),
    ).toThrow(/canonical Browser/);
    expect(() =>
      normalizeRequiredTools([`mcp__${'play'}${'wright'}__click`]),
    ).toThrow(/canonical Browser/);
    expect(() =>
      normalizeRequiredTools([`mcp__${'pup'}${'peteer'}__screenshot`]),
    ).toThrow(/canonical Browser/);
    expect(() => normalizeRequiredTools(['mcp__gantry__browser_act'])).toThrow(
      /canonical Browser/,
    );
    expect(() => normalizeRequiredTools(['Bash'])).toThrow(/Provider-native/);
    expect(() => normalizeRequiredTools(['mcp__gantry__*'])).toThrow(
      /wildcard/,
    );
  });

  it.each([
    [[42], /non-empty strings/],
    [['   '], /non-empty strings/],
    [['Read(src/index.ts)'], /Only RunCommand supports persistent scoped/],
    [['mcp__thirdparty__tool'], /Use canonical Browser/],
    [['capability:GoogleSheets'], /Capability id must use lowercase/],
  ])('rejects unsupported required tool rule %j', (rules, message) => {
    expect(() => normalizeRequiredTools(rules)).toThrow(message);
  });

  it('reports missing required tools without granting permission', () => {
    expect(
      evaluateRequiredTools({
        requiredTools: ['Browser', 'RunCommand(npm test *)'],
        effectiveAllowedTools: ['Browser'],
      }),
    ).toEqual({
      requiredTools: ['Browser', 'RunCommand(npm test *)'],
      missingTools: ['RunCommand(npm test *)'],
    });
  });

  it('treats broader scoped RunCommand grants as satisfying narrower assertions', () => {
    expect(
      evaluateRequiredTools({
        requiredTools: ['RunCommand(npm test *)'],
        effectiveAllowedTools: ['RunCommand(npm *)'],
      }),
    ).toEqual({
      requiredTools: ['RunCommand(npm test *)'],
      missingTools: [],
    });
  });
});
