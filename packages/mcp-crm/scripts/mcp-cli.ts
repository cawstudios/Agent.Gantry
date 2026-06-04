// Dev CLI for the boondi-crm MCP server. Signs an X-Caller-Identity header for
// a (fake) phone exactly as the Gantry runtime would, so you can exercise the
// identity-gated tools locally. Usage:
//   CLI_PHONE=9999999999 npm run cli -- call record_query '{"intentCategory":"gifting_b2b"}'
//   CLI_PHONE=9999999999 npm run cli -- call get_open_records '{}'
//   npm run cli -- list
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadDotenvUpwards } from '../src/dotenv-load.js';
import { computeIdentitySignature } from '../src/identity/identity-header.js';

loadDotenvUpwards();

const endpoint =
  process.env.BOONDI_CRM_MCP_URL ??
  `http://127.0.0.1:${process.env.BOONDI_CRM_MCP_PORT ?? '8082'}/mcp`;
const secret = process.env.SHOPIFY_MCP_IDENTITY_SECRET ?? '';
const phone = (process.env.CLI_PHONE ?? '').replace(/\D/g, '');
const cmd = process.argv[2];

if (!cmd) {
  process.stderr.write('usage: mcp-cli <list|call> [tool] [jsonArgs]\n');
  process.exit(2);
}

const headers: Record<string, string> = {};
if (phone && secret) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = computeIdentitySignature({ phone, ts }, secret);
  headers['X-Caller-Identity'] = `phone:${phone}; ts:${ts}; sig:${sig}`;
}

const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers },
});
const client = new Client({ name: 'boondi-crm-cli', version: '0.1.0' }, {});
await client.connect(transport);

try {
  if (cmd === 'list') {
    const result = await client.listTools();
    process.stdout.write(
      JSON.stringify(
        result.tools.map((t) => ({ name: t.name, description: t.description })),
        null,
        2,
      ) + '\n',
    );
  } else if (cmd === 'call') {
    const tool = process.argv[3];
    if (!tool) {
      process.stderr.write('usage: mcp-cli call <tool> [jsonArgs]\n');
      process.exit(2);
    }
    const args = process.argv[4] ? JSON.parse(process.argv[4]) : {};
    const result = await client.callTool({ name: tool, arguments: args });
    const blocks = (result.content ?? []) as Array<{
      type: string;
      text?: string;
    }>;
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        try {
          process.stdout.write(
            JSON.stringify(JSON.parse(block.text), null, 2) + '\n',
          );
        } catch {
          process.stdout.write(block.text + '\n');
        }
      }
    }
    if (result.isError) process.exitCode = 1;
  } else {
    process.stderr.write(`unknown command: ${cmd}\n`);
    process.exit(2);
  }
} finally {
  await client.close();
}
