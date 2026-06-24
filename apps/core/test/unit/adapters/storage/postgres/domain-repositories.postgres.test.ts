import { describe, expect, it } from 'vitest';

import {
  createPostgresDomainRepositories,
  parseRuntimeSecretRefsJson,
} from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import { PostgresOutboundDeliveryRepository } from '@core/adapters/storage/postgres/repositories/outbound-delivery-repository.postgres.js';

describe('createPostgresDomainRepositories', () => {
  it('wires outbound delivery repository into the domain bundle', () => {
    const repositories = createPostgresDomainRepositories({} as never);
    expect(repositories.outboundDeliveries).toBeInstanceOf(
      PostgresOutboundDeliveryRepository,
    );
  });
});

describe('parseRuntimeSecretRefsJson', () => {
  it('parses credential-keyed runtime secret refs', () => {
    expect(
      parseRuntimeSecretRefsJson(
        '{"bot_token":"env:SLACK_BOT_TOKEN"}',
        'slack',
      ),
    ).toEqual({ bot_token: 'env:SLACK_BOT_TOKEN' });
  });

  it('rejects array-shaped runtime secret refs', () => {
    expect(() =>
      parseRuntimeSecretRefsJson('["SLACK_BOT_TOKEN"]', 'slack'),
    ).toThrow(
      'provider connection slack runtimeSecretRefs must be a JSON object keyed by credential name',
    );
  });
});
