import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { logger } from '../../infrastructure/logging/logger.js';
import {
  isAgentPreRunContextProvider,
  type AgentPreRunContextProvider,
} from './pre-run-context-types.js';

const PROVIDER_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const providerCache = new Map<string, AgentPreRunContextProvider | null>();

export async function loadAgentPreRunContextProvider(input: {
  agentFolderPath: string;
  name: string;
}): Promise<AgentPreRunContextProvider | null> {
  const name = input.name.trim();
  if (!PROVIDER_NAME_PATTERN.test(name)) return null;

  const providersDir = path.resolve(input.agentFolderPath, 'pre-run-context');
  const cacheKey = `${providersDir}::${name}`;
  const cached = providerCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let loaded: AgentPreRunContextProvider | null = null;
  for (const ext of ['ts', 'js'] as const) {
    const candidate = path.resolve(providersDir, `${name}.${ext}`);
    if (!candidate.startsWith(providersDir + path.sep)) continue;
    if (!fs.existsSync(candidate)) continue;
    try {
      const mod = (await import(pathToFileURL(candidate).href)) as Record<
        string,
        unknown
      >;
      const exported = mod.provider ?? mod.default;
      if (isAgentPreRunContextProvider(exported)) {
        loaded = exported;
        break;
      }
      logger.warn(
        { candidate, name },
        'Agent pre-run context export is not a valid provider',
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- A bad agent plugin must degrade to unavailable, not crash startup.
    } catch (err) {
      logger.warn(
        {
          candidate,
          name,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to load agent pre-run context provider',
      );
    }
  }

  providerCache.set(cacheKey, loaded);
  return loaded;
}
