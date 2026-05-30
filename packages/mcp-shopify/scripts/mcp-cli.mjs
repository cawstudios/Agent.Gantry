#!/usr/bin/env node
// Tiny REPL-style CLI for talking to the Shopify MCP server.
// Usage:
//   node packages/mcp-shopify/scripts/mcp-cli.mjs list
//   node packages/mcp-shopify/scripts/mcp-cli.mjs call <tool_name> '<json args>'
//
// Examples:
//   node packages/mcp-shopify/scripts/mcp-cli.mjs call search_products '{"limit":3}'
//   node packages/mcp-shopify/scripts/mcp-cli.mjs call get_product '{"handleOrId":"the-minimal-snowboard"}'
//   node packages/mcp-shopify/scripts/mcp-cli.mjs call validate_discount_code '{"code":"FREESHIPPING2026"}'

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = process.env.SHOPIFY_MCP_URL ?? 'http://127.0.0.1:8081/mcp';
const cmd = process.argv[2];

if (!cmd) {
  console.error('usage: mcp-cli.mjs <list|call> [tool] [jsonArgs]');
  process.exit(2);
}

const transport = new StreamableHTTPClientTransport(new URL(endpoint));
const client = new Client({ name: 'shopify-mcp-cli', version: '0.1.0' }, {});
await client.connect(transport);

try {
  if (cmd === 'list') {
    const result = await client.listTools();
    console.log(JSON.stringify(result.tools.map((t) => ({ name: t.name, description: t.description })), null, 2));
  } else if (cmd === 'call') {
    const tool = process.argv[3];
    if (!tool) {
      console.error('usage: mcp-cli.mjs call <tool> [jsonArgs]');
      process.exit(2);
    }
    const args = process.argv[4] ? JSON.parse(process.argv[4]) : {};
    const result = await client.callTool({ name: tool, arguments: args });
    for (const block of result.content ?? []) {
      if (block.type === 'text') {
        try {
          console.log(JSON.stringify(JSON.parse(block.text), null, 2));
        } catch {
          console.log(block.text);
        }
      } else {
        console.log(JSON.stringify(block, null, 2));
      }
    }
    if (result.isError) process.exitCode = 1;
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
} finally {
  await client.close();
}
