import { describe, expect, it } from 'vitest';

import {
  filterTrustedOnecliEnv,
  ONECLI_FORBIDDEN_SECRET_ENV_KEYS,
} from '@core/adapters/credentials/onecli/env-policy.js';

describe('OneCLI env policy', () => {
  it('keeps only broker-safe model env keys', () => {
    expect(
      filterTrustedOnecliEnv({
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
        ANTHROPIC_MODEL: 'claude-haiku-4-5',
        ANTHROPIC_API_KEY: 'placeholder',
        CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
        HTTPS_PROXY: 'http://x:aoc_123@host.docker.internal:10255',
        HTTP_PROXY: 'http://x:aoc_123@host.docker.internal:10255',
        NODE_USE_ENV_PROXY: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
      }),
    ).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
        ANTHROPIC_MODEL: 'claude-haiku-4-5',
        ANTHROPIC_API_KEY: 'placeholder',
        CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
        HTTPS_PROXY: 'http://x:aoc_123@127.0.0.1:10255/',
        HTTP_PROXY: 'http://x:aoc_123@127.0.0.1:10255/',
        NODE_USE_ENV_PROXY: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
      },
      droppedKeys: [],
    });
  });

  it('drops empty, non-string, and unknown env keys', () => {
    expect(
      filterTrustedOnecliEnv({
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
        EMPTY_ALLOWED_KEY: '',
        ANTHROPIC_MODEL: '',
        CUSTOM_FLAG: 'value',
        NODE_EXTRA_CA_CERTS: '/tmp/onecli-gateway-ca.pem',
        NUMBER_VALUE: 1,
      }),
    ).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
      },
      droppedKeys: [
        'EMPTY_ALLOWED_KEY',
        'ANTHROPIC_MODEL',
        'CUSTOM_FLAG',
        'NODE_EXTRA_CA_CERTS',
        'NUMBER_VALUE',
      ],
    });
  });

  it('rejects database URLs and deployment encryption secrets from broker env', () => {
    for (const key of ONECLI_FORBIDDEN_SECRET_ENV_KEYS) {
      expect(() =>
        filterTrustedOnecliEnv({
          ANTHROPIC_BASE_URL: 'https://broker.example.com',
          [key]: 'secret',
        }),
      ).toThrow(`forbidden raw credential env key: ${key}`);
    }
  });

  it('rejects secret-looking and unknown proxy or certificate env keys by pattern', () => {
    for (const key of [
      'CUSTOM_API_KEY',
      'CUSTOM_TOKEN',
      'CUSTOM_DATABASE_URL',
      'CUSTOM_PROXY',
      'CUSTOM_CA_CERT',
    ]) {
      expect(() =>
        filterTrustedOnecliEnv({
          ANTHROPIC_BASE_URL: 'https://broker.example.com',
          [key]: 'secret',
        }),
      ).toThrow(`forbidden raw credential env key: ${key}`);
    }
  });

  it('rejects real provider keys and unexpected proxy values', () => {
    expect(() =>
      filterTrustedOnecliEnv({
        ANTHROPIC_API_KEY: 'sk-ant-secret',
      }),
    ).toThrow('forbidden raw credential env key: ANTHROPIC_API_KEY');

    expect(() =>
      filterTrustedOnecliEnv({
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret',
      }),
    ).toThrow('forbidden raw credential env key: CLAUDE_CODE_OAUTH_TOKEN');

    expect(() =>
      filterTrustedOnecliEnv({
        HTTPS_PROXY: 'http://proxy.example.com:8080',
      }),
    ).toThrow('forbidden raw credential env key: HTTPS_PROXY');
  });

  it('rejects secret-bearing values in allowed URL env keys', () => {
    for (const value of [
      'https://user:pass@broker.example.com/anthropic',
      'https://broker.example.com/anthropic?token=raw',
      'https://broker.example.com/anthropic#token',
      'http://broker.example.com/anthropic',
    ]) {
      expect(() =>
        filterTrustedOnecliEnv({
          ANTHROPIC_BASE_URL: value,
        }),
      ).toThrow(
        'forbidden raw credential env value for key: ANTHROPIC_BASE_URL',
      );
    }
  });

  it('rejects secret-shaped values in allowed model env keys', () => {
    const secretLikeValues = [
      'sk-ant-raw-provider-token',
      'github_pat_11AAAAAAAA0abcdefghijklmnopqrstuvwxyz',
      'ASIAABCDEFGHIJKLMNOP',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'Bearer abcdefghijklmnopqrstuvwxyz123456',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
      '-----BEGIN PRIVATE KEY-----',
    ];
    for (const key of [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    ]) {
      for (const value of secretLikeValues) {
        expect(() =>
          filterTrustedOnecliEnv({
            ANTHROPIC_BASE_URL: 'https://broker.example.com',
            [key]: value,
          }),
        ).toThrow(`forbidden raw credential env value for key: ${key}`);
      }
    }
  });
});
