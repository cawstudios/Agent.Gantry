import { afterEach, describe, expect, it } from 'vitest';

import { applyTestCallerIdentityOverride } from '@core/application/mcp/test-caller-identity-override.js';

describe('applyTestCallerIdentityOverride', () => {
  afterEach(() => {
    delete process.env.GANTRY_TEST_CALLER_IDENTITY_PHONE;
    delete process.env.GANTRY_TEST_CALLER_IDENTITY_MCP_SERVERS;
    delete process.env.GANTRY_TEST_OPERATOR_PHONE;
  });

  it('is a no-op when the dev flag is unset', () => {
    delete process.env.GANTRY_TEST_CALLER_IDENTITY_PHONE;
    expect(applyTestCallerIdentityOverride('wa:919654405340')).toBe(
      'wa:919654405340',
    );
  });

  it('swaps the numeric suffix and preserves the channel prefix (unscoped)', () => {
    process.env.GANTRY_TEST_CALLER_IDENTITY_PHONE = '918097288633';
    expect(applyTestCallerIdentityOverride('wa:919654405340')).toBe(
      'wa:918097288633',
    );
  });

  it('leaves a JID without a numeric suffix unchanged', () => {
    process.env.GANTRY_TEST_CALLER_IDENTITY_PHONE = '918097288633';
    expect(applyTestCallerIdentityOverride('app:default')).toBe('app:default');
  });

  it('is independent of GANTRY_TEST_OPERATOR_PHONE (not scoped to the operator)', () => {
    process.env.GANTRY_TEST_CALLER_IDENTITY_PHONE = '918097288633';
    process.env.GANTRY_TEST_OPERATOR_PHONE = '919654405340';
    // Decoupled: the swap applies to EVERY conversation, not just the operator's.
    expect(applyTestCallerIdentityOverride('wa:919654405340')).toBe(
      'wa:918097288633',
    );
    expect(applyTestCallerIdentityOverride('wa:919999999999')).toBe(
      'wa:918097288633',
    );
  });

  it('only applies to configured MCP server names when serverName is supplied', () => {
    process.env.GANTRY_TEST_CALLER_IDENTITY_PHONE = '918097288633';

    expect(
      applyTestCallerIdentityOverride('wa:000000050', {
        serverName: 'shopify-api',
      }),
    ).toBe('wa:918097288633');
    expect(
      applyTestCallerIdentityOverride('wa:000000050', {
        serverName: 'boondi-crm',
      }),
    ).toBe('wa:000000050');
  });

  it('honors GANTRY_TEST_CALLER_IDENTITY_MCP_SERVERS', () => {
    process.env.GANTRY_TEST_CALLER_IDENTITY_PHONE = '918097288633';
    process.env.GANTRY_TEST_CALLER_IDENTITY_MCP_SERVERS =
      'shopify-api custom-store';

    expect(
      applyTestCallerIdentityOverride('wa:000000050', {
        serverName: 'custom-store',
      }),
    ).toBe('wa:918097288633');
    expect(
      applyTestCallerIdentityOverride('wa:000000050', {
        serverName: 'boondi-crm',
      }),
    ).toBe('wa:000000050');
  });
});
