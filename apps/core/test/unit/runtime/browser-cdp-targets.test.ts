import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureBrowserTarget } from '@core/runtime/browser-cdp-targets.js';

function jsonResponse(data: unknown) {
  return {
    ok: true,
    json: vi.fn(async () => data),
    text: vi.fn(async () => 'ok'),
  };
}

function textResponse(data = 'ok') {
  return {
    ok: true,
    json: vi.fn(async () => ({})),
    text: vi.fn(async () => data),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser CDP target cleanup', () => {
  it('closes internal omnibox tabs before and after activating content', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'content', type: 'page', url: 'https://example.com' },
          { id: 'omnibox-1', type: 'page', url: 'chrome://omnibox-popup/' },
          { id: 'omnibox-2', type: 'page', url: 'chrome://omnibox-popup/2' },
        ]),
      )
      .mockResolvedValueOnce(textResponse())
      .mockResolvedValueOnce(textResponse())
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'content', type: 'page', url: 'https://example.com' },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'content', type: 'page', url: 'https://example.com' },
        ]),
      )
      .mockResolvedValueOnce(textResponse())
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'content', type: 'page', url: 'https://example.com' },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(ensureBrowserTarget(9222)).resolves.toBe('content');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9222/json/close/omnibox-1',
      { method: 'GET' },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9222/json/close/omnibox-2',
      { method: 'GET' },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9222/json/activate/content',
      { method: 'GET' },
    );
  });
});
