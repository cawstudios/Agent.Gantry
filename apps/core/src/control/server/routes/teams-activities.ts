import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleTeamsBotFrameworkActivityRequest } from '../../../channels/teams-bot-framework-client.js';
import { sendError } from '../http.js';

export async function handleTeamsActivityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/v1/providers/teams/activities') return false;
  if (req.method !== 'POST') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    return true;
  }
  const handled = await handleTeamsBotFrameworkActivityRequest(req, res);
  if (!handled && !res.writableEnded) {
    sendError(
      res,
      503,
      'TEAMS_TRANSPORT_NOT_READY',
      'Teams Bot Framework transport is not started',
    );
  }
  return true;
}
