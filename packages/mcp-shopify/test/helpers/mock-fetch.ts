import { jsonResponse, tokenResponse } from '../fixtures/responses.js';

type ResponseSpec = Response | (() => Response | Promise<Response>);

export interface MockFetchOptions {
  graphqlResponses: ResponseSpec[];
  tokenResponse?: Response;
}

export interface MockFetch {
  fetch: typeof fetch;
  calls: Array<{ url: string; body: unknown }>;
  graphqlCallCount: () => number;
}

export function buildMockFetch(opts: MockFetchOptions): MockFetch {
  const calls: Array<{ url: string; body: unknown }> = [];
  let graphqlIndex = 0;
  let tokenServed = false;

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    let body: unknown;
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, body });

    if (url.includes('/oauth/access_token')) {
      if (!tokenServed) {
        tokenServed = true;
        return opts.tokenResponse ?? tokenResponse();
      }
      return opts.tokenResponse ?? tokenResponse();
    }

    const spec = opts.graphqlResponses[graphqlIndex];
    graphqlIndex += 1;
    if (!spec) {
      return jsonResponse({ errors: [{ message: 'no mock response queued' }] }, 500);
    }
    return typeof spec === 'function' ? await spec() : spec;
  }) as unknown as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    graphqlCallCount: () => graphqlIndex,
  };
}
