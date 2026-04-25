import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBrowserTools } from './tools/browser.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerSchedulerTools } from './tools/scheduler.js';
import { registerServiceTools } from './tools/service.js';

export function createMyClawMcpServer(): McpServer {
  const server = new McpServer({
    name: 'myclaw',
    version: '1.0.0',
  });

  registerMessagingTools(server);
  registerSchedulerTools(server);
  registerMemoryTools(server);
  registerBrowserTools(server);
  registerServiceTools(server);

  return server;
}
