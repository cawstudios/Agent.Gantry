import { describe, expect, it } from 'vitest';

import { parseRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';

// Build a minimal settings YAML for one agent, injecting an optional plugins
// block. Indentation: agent fields at 4 spaces, plugins children at 6/8.
function agentYaml(pluginsBlock = ''): string {
  return [
    'agents:',
    '  boondi_support:',
    '    name: Boondi',
    ...(pluginsBlock ? pluginsBlock.split('\n') : []),
  ].join('\n');
}

describe('agent plugins settings (plugins.*)', () => {
  it('parses guardrail, memory_extraction, and folder skills declarations', () => {
    const parsed = parseRuntimeSettings(
      agentYaml(
        [
          '    plugins:',
          '      guardrail:',
          '        file: guardrail.ts',
          '        model: haiku',
          '        mode: deterministic',
          '      memory_extraction: MEMORY_EXTRACTION.md',
          '      skills:',
          '        - boondi-kb',
          '        - returns-kb',
        ].join('\n'),
      ),
    );
    expect(parsed.agents.boondi_support.plugins).toEqual({
      guardrail: {
        file: 'guardrail.ts',
        model: 'haiku',
        mode: 'deterministic',
      },
      memoryExtraction: 'MEMORY_EXTRACTION.md',
      skills: ['boondi-kb', 'returns-kb'],
    });
  });

  it('leaves plugins undefined when the block is absent (no implicit activation)', () => {
    const parsed = parseRuntimeSettings(agentYaml());
    expect(parsed.agents.boondi_support.plugins).toBeUndefined();
  });

  it('round-trips plugins (incl. guardrail) through render → parse', () => {
    const parsed = parseRuntimeSettings(
      agentYaml(
        [
          '    plugins:',
          '      guardrail:',
          '        file: guardrail.ts',
          '        model: haiku',
          '        mode: classifier',
          '      memory_extraction: MEMORY_EXTRACTION.md',
          '      skills:',
          '        - boondi-kb',
        ].join('\n'),
      ),
    );
    const yaml = renderRuntimeSettingsYaml(parsed);
    expect(yaml).toContain('plugins:');
    expect(yaml).toContain('guardrail:');
    expect(yaml).toContain('file: guardrail.ts');
    expect(yaml).toContain('mode: classifier');
    expect(yaml).toContain('memory_extraction: MEMORY_EXTRACTION.md');
    expect(yaml).toContain('- boondi-kb');

    const reparsed = parseRuntimeSettings(yaml);
    expect(reparsed.agents.boondi_support.plugins).toEqual({
      guardrail: { file: 'guardrail.ts', model: 'haiku', mode: 'classifier' },
      memoryExtraction: 'MEMORY_EXTRACTION.md',
      skills: ['boondi-kb'],
    });
  });

  it('defaults guardrail mode to both when omitted', () => {
    const parsed = parseRuntimeSettings(
      agentYaml(
        [
          '    plugins:',
          '      guardrail:',
          '        file: guardrail.ts',
          '        model: haiku',
        ].join('\n'),
      ),
    );
    expect(parsed.agents.boondi_support.plugins?.guardrail).toEqual({
      file: 'guardrail.ts',
      model: 'haiku',
      mode: 'both',
    });
  });

  it('rejects invalid guardrail modes', () => {
    expect(() =>
      parseRuntimeSettings(
        agentYaml(
          [
            '    plugins:',
            '      guardrail:',
            '        file: guardrail.ts',
            '        model: haiku',
            '        mode: random',
          ].join('\n'),
        ),
      ),
    ).toThrow(/guardrail\.mode must be one of/);
  });

  it('activates the exact guardrail file named (an agent may keep several)', () => {
    const parsed = parseRuntimeSettings(
      agentYaml(
        [
          '    plugins:',
          '      guardrail:',
          '        file: guardrail-strict.ts',
          '        model: haiku',
        ].join('\n'),
      ),
    );
    expect(parsed.agents.boondi_support.plugins?.guardrail).toEqual({
      file: 'guardrail-strict.ts',
      model: 'haiku',
      mode: 'both',
    });
  });

  it('rejects an invalid guardrail model', () => {
    expect(() =>
      parseRuntimeSettings(
        agentYaml(
          [
            '    plugins:',
            '      guardrail:',
            '        file: guardrail.ts',
            '        model: claude-haiku-4-5-20251001',
          ].join('\n'),
        ),
      ),
    ).toThrow(/guardrail\.model is invalid/);
  });

  it('rejects unknown plugin keys', () => {
    expect(() =>
      parseRuntimeSettings(
        agentYaml(['    plugins:', '      bogus: nope'].join('\n')),
      ),
    ).toThrow(/plugins\.bogus is not supported/);
  });

  it('parses a commands list', () => {
    const parsed = parseRuntimeSettings(
      agentYaml(
        [
          '    plugins:',
          '      commands:',
          '        - extract-leads-queries',
          '        - reindex-knowledge',
        ].join('\n'),
      ),
    );
    expect(parsed.agents.boondi_support.plugins?.commands).toEqual([
      'extract-leads-queries',
      'reindex-knowledge',
    ]);
  });

  it('rejects a command name that collides with a built-in', () => {
    expect(() =>
      parseRuntimeSettings(
        agentYaml(
          ['    plugins:', '      commands:', '        - new'].join('\n'),
        ),
      ),
    ).toThrow(/built-in/i);
  });

  it('rejects a command name that is not kebab-case', () => {
    expect(() =>
      parseRuntimeSettings(
        agentYaml(
          [
            '    plugins:',
            '      commands:',
            '        - Extract_Leads',
          ].join('\n'),
        ),
      ),
    ).toThrow(/kebab/i);
  });

  it('rejects path-escaping plugin references (defense in depth)', () => {
    // memory_extraction + guardrail.file allow sub-folders but never traversal.
    expect(() =>
      parseRuntimeSettings(
        agentYaml(
          ['    plugins:', '      memory_extraction: ../../etc/passwd'].join(
            '\n',
          ),
        ),
      ),
    ).toThrow(/must be a relative path inside the agent folder/);

    expect(() =>
      parseRuntimeSettings(
        agentYaml(
          [
            '    plugins:',
            '      guardrail:',
            '        file: ../evil.ts',
            '        model: haiku',
          ].join('\n'),
        ),
      ),
    ).toThrow(/must be a relative path inside the agent folder/);

    expect(() =>
      parseRuntimeSettings(
        agentYaml(
          ['    plugins:', '      skills:', '        - ../escape'].join('\n'),
        ),
      ),
    ).toThrow(/must be a plain name/);
  });
});
