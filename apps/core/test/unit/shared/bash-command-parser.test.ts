import { describe, expect, it } from 'vitest';

import { formatBashArgv } from '@core/shared/bash-command-parser.js';

describe('bash command parser', () => {
  it('quotes wildcard argv when formatting shell-safe commands', () => {
    expect(formatBashArgv(['gog', 'sheets', 'get', '*'])).toBe(
      "gog sheets get '*'",
    );
  });
});
