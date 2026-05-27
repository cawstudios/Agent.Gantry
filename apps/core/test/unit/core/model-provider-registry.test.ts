import { describe, expect, it } from 'vitest';

import {
  getModelProviderByGatewayPath,
  getModelProviderDefinition,
  listExecutableModelProviders,
  listModelRouteProviders,
} from '@core/shared/model-provider-registry.js';
import { listModelCatalogEntries } from '@core/shared/model-catalog.js';

describe('model provider registry', () => {
  it('indexes provider definitions for route lookup', () => {
    const routeProviders = listModelRouteProviders();

    expect(listModelRouteProviders()).toBe(routeProviders);
    expect(getModelProviderDefinition(' ANTHROPIC ')).toBe(
      routeProviders.find((provider) => provider.id === 'anthropic'),
    );
    expect(getModelProviderByGatewayPath(' openrouter ')).toBe(
      routeProviders.find((provider) => provider.id === 'openrouter'),
    );
  });

  it('keeps every executable catalog route backed by registry execution support', () => {
    const executableProviderIds = new Set(
      listExecutableModelProviders().map((provider) => provider.id),
    );

    for (const entry of listModelCatalogEntries()) {
      const provider = getModelProviderDefinition(entry.modelRoute.id);
      expect(provider, entry.id).toBeDefined();
      expect(executableProviderIds.has(entry.modelRoute.id), entry.id).toBe(
        true,
      );
      expect(provider?.modelRoute, entry.id).toBe(true);
      expect(provider?.executionProviderIds, entry.id).toContain(
        entry.executionProviderId,
      );
    }
  });

  it('declares provider-side cache support without a shared cache assumption', () => {
    expect(getModelProviderDefinition('anthropic')?.cacheSupport).toMatchObject(
      {
        prompt: {
          mode: 'anthropic_cache_control',
          automatic: false,
          requestControl: 'cache_control_blocks',
        },
        response: { mode: 'none', enabledByDefault: false },
      },
    );
    expect(
      getModelProviderDefinition('openrouter')?.cacheSupport,
    ).toMatchObject({
      prompt: {
        mode: 'openrouter_anthropic_cache_control',
        automatic: false,
        requestControl: 'cache_control_blocks',
      },
      response: {
        mode: 'openrouter_response_cache',
        enabledByDefault: false,
        requestControl: 'request_header',
        usageBehavior: 'zero_usage_on_hit',
      },
    });
    expect(getModelProviderDefinition('openai')?.cacheSupport).toMatchObject({
      prompt: {
        mode: 'openai_automatic_prefix',
        automatic: true,
        requestControl: 'provider_automatic_prefix',
        usageFields: {
          readTokens: 'prompt_tokens_details.cached_tokens',
        },
      },
      response: { mode: 'none', enabledByDefault: false },
    });
  });
});
