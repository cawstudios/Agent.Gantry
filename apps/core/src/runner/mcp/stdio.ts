/**
 * Stdio MCP Server for MyClaw.
 * Standalone process that agent teams subagents can inherit.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMyClawMcpServer } from './server.js';

const server = createMyClawMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
