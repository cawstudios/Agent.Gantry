import type { IncomingMessage, ServerResponse } from 'node:http';

import { sendError } from '../http.js';

export async function handleSettingsRoutes(
  _req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/v1/settings') return false;
  sendError(
    res,
    410,
    'SETTINGS_API_REMOVED',
    'The v1 settings API was removed. Runtime settings are now configured through settings.yaml and app/channel/agent admin routes.',
  );
  return true;
}
