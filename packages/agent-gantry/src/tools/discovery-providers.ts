import type {
  FirecrawlCrawlProviderConfig,
  FirecrawlFetchProviderConfig,
  FirecrawlSearchProviderConfig,
  GantryFetchToolResult,
  HttpFetchProviderConfig,
  StructuredCrawlToolProvider,
  StructuredFetchToolProvider,
  StructuredSearchToolProvider,
  TavilySearchProviderConfig,
} from '../shared/types.js';
import {
  asNonEmptyString,
  asRecord,
  detectBlockedReason,
  extractHtmlTitle,
  fetchWithTimeout,
  htmlToReadableText,
  trimToBudget,
} from '../shared/helpers.js';

export function createTavilySearchProvider(
  config: TavilySearchProviderConfig,
): StructuredSearchToolProvider {
  if (!config.apiKey?.trim()) {
    throw new Error(
      'TAVILY_API_KEY is required to create the Tavily search provider.',
    );
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiKey = config.apiKey.trim();
  return {
    search: async (input) => {
      const maxResults = Math.min(
        input.limit ?? input.budget?.maxResults ?? config.maxResults ?? 5,
        config.maxResults ?? 10,
      );
      const response = await fetchWithTimeout(
        fetchImpl,
        'https://api.tavily.com/search',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query: input.query,
            search_depth: 'basic',
            include_answer: false,
            max_results: maxResults,
          }),
        },
        input.budget?.timeoutMs ?? config.timeoutMs ?? 15_000,
      );
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`Tavily search failed with HTTP ${response.status}.`);
      }
      const results = Array.isArray(payload.results) ? payload.results : [];
      return {
        provider: 'tavily',
        items: results
          .flatMap((item) => {
            const record = asRecord(item);
            const url = asNonEmptyString(record?.url);
            if (!url) return [];
            return [
              {
                url,
                title: asNonEmptyString(record?.title),
                snippet:
                  asNonEmptyString(record?.content) ??
                  asNonEmptyString(record?.snippet),
                source: 'tavily',
              },
            ];
          })
          .slice(0, maxResults),
      };
    },
  };
}

export function createFirecrawlSearchProvider(
  config: FirecrawlSearchProviderConfig,
): StructuredSearchToolProvider {
  if (!config.apiKey?.trim()) {
    throw new Error(
      'FIRECRAWL_API_KEY is required to create the Firecrawl search provider.',
    );
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiKey = config.apiKey.trim();
  return {
    search: async (input) => {
      const maxResults = Math.min(
        input.limit ?? input.budget?.maxResults ?? config.maxResults ?? 5,
        config.maxResults ?? 10,
      );
      const response = await fetchWithTimeout(
        fetchImpl,
        'https://api.firecrawl.dev/v2/search',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            query: input.query,
            limit: maxResults,
            scrapeOptions: { formats: ['markdown'] },
          }),
        },
        input.budget?.timeoutMs ?? config.timeoutMs ?? 20_000,
      );
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(
          `Firecrawl search failed with HTTP ${response.status}.`,
        );
      }
      const results = Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload.results)
          ? payload.results
          : [];
      return {
        provider: 'firecrawl-search',
        items: results
          .flatMap((item) => {
            const record = asRecord(item);
            const metadata = asRecord(record?.metadata);
            const url =
              asNonEmptyString(record?.url) ??
              asNonEmptyString(metadata?.sourceURL);
            if (!url) return [];
            return [
              {
                url,
                title:
                  asNonEmptyString(record?.title) ??
                  asNonEmptyString(metadata?.title),
                snippet:
                  asNonEmptyString(record?.description) ??
                  asNonEmptyString(record?.markdown) ??
                  asNonEmptyString(record?.content),
                source: 'firecrawl',
              },
            ];
          })
          .slice(0, maxResults),
      };
    },
  };
}

export function createHttpFetchProvider(
  config: HttpFetchProviderConfig = {},
): StructuredFetchToolProvider {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    fetch: async (input) => {
      const maxBytes = input.budget?.maxBytes ?? config.maxBytes ?? 256_000;
      const response = await fetchWithTimeout(
        fetchImpl,
        input.url,
        {
          method: 'GET',
          headers: {
            accept:
              'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.3',
            'user-agent':
              'Agent.Gantry source discovery (+public procurement source validation)',
          },
        },
        input.budget?.timeoutMs ?? config.timeoutMs ?? 12_000,
      );
      const contentType = response.headers.get('content-type');
      const text = trimToBudget(await response.text(), maxBytes);
      const isHtml = Boolean(contentType?.includes('html'));
      const readableText = isHtml ? htmlToReadableText(text) : text;
      return {
        url: response.url || input.url,
        statusCode: response.status,
        contentType,
        title: isHtml ? extractHtmlTitle(text) : null,
        text: trimToBudget(readableText, maxBytes),
        blockedReason: detectBlockedReason(
          response.status,
          contentType,
          readableText,
        ),
        provider: 'http-fetch',
        warnings:
          text.length >= maxBytes
            ? [`Response truncated at ${maxBytes} bytes.`]
            : [],
      };
    },
  };
}

export function createFirecrawlFetchProvider(
  config: FirecrawlFetchProviderConfig,
): StructuredFetchToolProvider {
  if (!config.apiKey?.trim()) {
    throw new Error(
      'FIRECRAWL_API_KEY is required to create the Firecrawl fetch provider.',
    );
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiKey = config.apiKey.trim();
  return {
    fetch: async (input) => {
      const maxBytes = input.budget?.maxBytes ?? config.maxBytes ?? 256_000;
      const response = await fetchWithTimeout(
        fetchImpl,
        'https://api.firecrawl.dev/v2/scrape',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            url: input.url,
            formats: ['markdown', 'html'],
          }),
        },
        input.budget?.timeoutMs ?? config.timeoutMs ?? 20_000,
      );
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(
          `Firecrawl scrape failed with HTTP ${response.status}.`,
        );
      }
      const data = asRecord(payload.data) ?? payload;
      const metadata = asRecord(data.metadata);
      const text =
        asNonEmptyString(data.markdown) ??
        asNonEmptyString(data.content) ??
        asNonEmptyString(data.html) ??
        '';
      const trimmedText = trimToBudget(text, maxBytes);
      return {
        url:
          asNonEmptyString(metadata?.sourceURL) ??
          asNonEmptyString(data.url) ??
          input.url,
        statusCode: 200,
        contentType: 'text/markdown',
        title:
          asNonEmptyString(metadata?.title) ?? asNonEmptyString(data.title),
        text: trimmedText,
        blockedReason: detectBlockedReason(200, 'text/markdown', trimmedText),
        provider: 'firecrawl-scrape',
        warnings:
          text.length >= maxBytes
            ? [`Response truncated at ${maxBytes} bytes.`]
            : [],
      };
    },
  };
}

export function createFirecrawlCrawlProvider(
  config: FirecrawlCrawlProviderConfig,
): StructuredCrawlToolProvider {
  if (!config.apiKey?.trim()) {
    throw new Error(
      'FIRECRAWL_API_KEY is required to create the Firecrawl crawl provider.',
    );
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiKey = config.apiKey.trim();
  return {
    crawl: async (input) => {
      const limit = Math.min(
        input.limit ?? input.budget?.maxPages ?? config.maxPages ?? 3,
        config.maxPages ?? 5,
      );
      const response = await fetchWithTimeout(
        fetchImpl,
        'https://api.firecrawl.dev/v1/crawl',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            url: input.url,
            limit,
            scrapeOptions: { formats: ['markdown'] },
          }),
        },
        input.budget?.timeoutMs ?? config.timeoutMs ?? 30_000,
      );
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`Firecrawl crawl failed with HTTP ${response.status}.`);
      }
      const data = Array.isArray(payload.data) ? payload.data : [];
      return {
        startUrl: input.url,
        provider: 'firecrawl',
        pages: data
          .flatMap((page) => {
            const record = asRecord(page);
            const metadata = asRecord(record?.metadata);
            const url =
              asNonEmptyString(metadata?.sourceURL) ??
              asNonEmptyString(record?.url) ??
              input.url;
            return [
              {
                url,
                title: asNonEmptyString(metadata?.title),
                text:
                  asNonEmptyString(record?.markdown) ??
                  asNonEmptyString(record?.content),
                blockedReason: null,
              },
            ];
          })
          .slice(0, limit),
      };
    },
  };
}

export function createHttpCrawlProvider(
  config: HttpFetchProviderConfig = {},
): StructuredCrawlToolProvider {
  const fetchProvider = createHttpFetchProvider(config);
  return {
    crawl: async (input) => {
      const first = await fetchProvider.fetch(input);
      return {
        startUrl: input.url,
        provider: 'http-crawl',
        warnings: first.warnings,
        pages: [
          {
            url: first.url,
            title: first.title,
            text: first.text,
            blockedReason: first.blockedReason,
          },
        ],
      };
    },
  };
}
