import * as p from '@clack/prompts';

import { controlApiRequest } from './control-api.js';

type DraftCreateOptions = {
  name?: string;
  transport?: 'http' | 'sse';
  url?: string;
  allowedToolPatterns: string[];
  autoApproveToolPatterns: string[];
  credentialRefs: Array<{
    name: string;
    target: 'env' | 'header';
    key: string;
  }>;
  createdBy?: string;
  requestedReason?: string;
  riskClass?: 'low' | 'medium' | 'high';
};

function usage(): string {
  return [
    'Usage:',
    '  myclaw mcp draft create --name <name> --transport <http|sse> --url <url> [--tool <name>] [--auto-tool <name>] [--credential <name:env|header:key>]',
    '  myclaw mcp draft list',
    '  myclaw mcp approve <serverId> [--by <admin>]',
    '  myclaw mcp reject <serverId> --reason <text> [--by <admin>]',
    '  myclaw mcp list [--status <draft|approved|rejected|disabled>]',
    '  myclaw mcp test <serverId> [--by <admin>]',
    '  myclaw mcp disable <serverId> [--reason <text>] [--by <admin>]',
    '  myclaw mcp bind <agentId> <serverId> [--required] [--policy <policyId>]',
    '  myclaw mcp unbind <agentId> <serverId>',
    '  myclaw mcp agent list <agentId>',
  ].join('\n');
}

export async function runMcpCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [family, action, ...rest] = args;
  try {
    if (family === 'draft' && action === 'create') {
      return await createDraft(runtimeHome, rest);
    }
    if (family === 'draft' && action === 'list') {
      return await printList(runtimeHome, '/v1/mcp-servers/drafts', 'drafts');
    }
    if (family === 'approve' || family === 'reject') {
      return await reviewDraft(runtimeHome, family, action, rest);
    }
    if (family === 'list') {
      return await listServers(runtimeHome, [action, ...rest].filter(Boolean));
    }
    if (family === 'test' || family === 'disable') {
      return await mutateServer(runtimeHome, family, action, rest);
    }
    if (family === 'bind') return await bindServer(runtimeHome, action, rest);
    if (family === 'unbind')
      return await unbindServer(runtimeHome, action, rest);
    if (family === 'agent' && action === 'list') {
      return await listAgentBindings(runtimeHome, rest[0]);
    }
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : 'MCP command failed');
    return 1;
  }
  p.note(usage(), 'MCP Servers');
  return 1;
}

async function createDraft(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const parsed = parseDraftCreateArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }
  const response = await controlApiRequest(runtimeHome, {
    method: 'POST',
    path: '/v1/mcp-servers/drafts',
    body: {
      name: parsed.name,
      transport: parsed.transport,
      config: transportConfig(parsed),
      allowedToolPatterns: parsed.allowedToolPatterns,
      autoApproveToolPatterns: parsed.autoApproveToolPatterns,
      credentialRefs: parsed.credentialRefs,
      createdBy: parsed.createdBy,
      requestedReason: parsed.requestedReason,
      riskClass: parsed.riskClass,
    },
  });
  printRecord(response, 'MCP Draft Created');
  return 0;
}

function parseDraftCreateArgs(
  args: string[],
): DraftCreateOptions | { error: string } {
  const options: DraftCreateOptions = {
    allowedToolPatterns: [],
    autoApproveToolPatterns: [],
    credentialRefs: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = args[index + 1] || '';
    if (arg === '--name') {
      options.name = value;
      index += 1;
    } else if (arg === '--transport') {
      if (value !== 'http' && value !== 'sse') {
        return {
          error: 'Invalid --transport. Use http or sse.',
        };
      }
      options.transport = value;
      index += 1;
    } else if (arg === '--url') {
      options.url = value;
      index += 1;
    } else if (arg === '--tool') {
      options.allowedToolPatterns.push(value);
      index += 1;
    } else if (arg === '--auto-tool') {
      options.autoApproveToolPatterns.push(value);
      index += 1;
    } else if (arg === '--credential') {
      const ref = parseCredentialRef(value);
      if (!ref) return { error: 'Use --credential <name:env|header:key>.' };
      options.credentialRefs.push(ref);
      index += 1;
    } else if (arg === '--by' || arg === '--created-by') {
      options.createdBy = value;
      index += 1;
    } else if (arg === '--reason') {
      options.requestedReason = value;
      index += 1;
    } else if (arg === '--risk') {
      if (value !== 'low' && value !== 'medium' && value !== 'high') {
        return { error: 'Invalid --risk. Use low, medium, or high.' };
      }
      options.riskClass = value;
      index += 1;
    } else {
      return { error: `Unknown MCP draft option: ${arg}` };
    }
  }
  if (!options.name) return { error: 'Missing --name.' };
  if (!options.transport) return { error: 'Missing --transport.' };
  if (!options.url) {
    return { error: 'Missing --url.' };
  }
  return options;
}

function parseCredentialRef(
  value: string,
): DraftCreateOptions['credentialRefs'][number] | null {
  const [name, target, key] = value.split(':');
  if (!name || !key || (target !== 'env' && target !== 'header')) return null;
  return { name, target, key };
}

function transportConfig(input: DraftCreateOptions): Record<string, unknown> {
  return { transport: input.transport, url: input.url };
}

async function reviewDraft(
  runtimeHome: string,
  action: 'approve' | 'reject',
  serverId = '',
  args: string[],
): Promise<number> {
  if (!serverId) {
    p.log.error(`Missing server id for mcp ${action}.`);
    return 1;
  }
  const options = parseByReasonArgs(args);
  const body =
    action === 'approve'
      ? { approvedBy: options.by }
      : { rejectedBy: options.by, reason: options.reason };
  const response = await controlApiRequest(runtimeHome, {
    method: 'POST',
    path: `/v1/mcp-servers/drafts/${encodeURIComponent(serverId)}/${action}`,
    body,
  });
  printRecord(
    response,
    `MCP Draft ${action === 'approve' ? 'Approved' : 'Rejected'}`,
  );
  return 0;
}

async function listServers(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const status = flagValue(args, '--status');
  return await printList(
    runtimeHome,
    `/v1/mcp-servers${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    'servers',
  );
}

async function mutateServer(
  runtimeHome: string,
  action: 'test' | 'disable',
  serverId = '',
  args: string[],
): Promise<number> {
  if (!serverId) {
    p.log.error(`Missing server id for mcp ${action}.`);
    return 1;
  }
  const options = parseByReasonArgs(args);
  const response = await controlApiRequest(runtimeHome, {
    method: 'POST',
    path: `/v1/mcp-servers/${encodeURIComponent(serverId)}/${action}`,
    body:
      action === 'test'
        ? { testedBy: options.by }
        : { disabledBy: options.by, reason: options.reason },
  });
  printRecord(
    response,
    `MCP Server ${action === 'test' ? 'Tested' : 'Disabled'}`,
  );
  return 0;
}

async function bindServer(
  runtimeHome: string,
  agentId = '',
  args: string[],
): Promise<number> {
  const serverId = args[0] || '';
  if (!agentId || !serverId) {
    p.log.error('Use myclaw mcp bind <agentId> <serverId>.');
    return 1;
  }
  const response = await controlApiRequest(runtimeHome, {
    method: 'PUT',
    path: `/v1/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(serverId)}`,
    body: {
      required: args.includes('--required'),
      permissionPolicyIds: flagValues(args.slice(1), '--policy'),
    },
  });
  printRecord(response, 'MCP Server Bound');
  return 0;
}

async function unbindServer(
  runtimeHome: string,
  agentId = '',
  args: string[],
): Promise<number> {
  const serverId = args[0] || '';
  if (!agentId || !serverId) {
    p.log.error('Use myclaw mcp unbind <agentId> <serverId>.');
    return 1;
  }
  const response = await controlApiRequest(runtimeHome, {
    method: 'DELETE',
    path: `/v1/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(serverId)}`,
  });
  printRecord(response, 'MCP Server Unbound');
  return 0;
}

async function listAgentBindings(
  runtimeHome: string,
  agentId = '',
): Promise<number> {
  if (!agentId) {
    p.log.error('Use myclaw mcp agent list <agentId>.');
    return 1;
  }
  return await printList(
    runtimeHome,
    `/v1/agents/${encodeURIComponent(agentId)}/mcp-servers`,
    'bindings',
  );
}

async function printList(
  runtimeHome: string,
  path: string,
  key: string,
): Promise<number> {
  const response = await controlApiRequest(runtimeHome, {
    method: 'GET',
    path,
  });
  const items =
    isRecord(response) && Array.isArray(response[key]) ? response[key] : [];
  p.note(
    items.length
      ? items.map((item) => summarizeRecord(item)).join('\n')
      : '(none)',
    'MCP Servers',
  );
  return 0;
}

function parseByReasonArgs(args: string[]): { by?: string; reason?: string } {
  return { by: flagValue(args, '--by'), reason: flagValue(args, '--reason') };
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : undefined;
}

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]!);
  }
  return values;
}

function printRecord(response: unknown, title: string): void {
  p.note(JSON.stringify(response, null, 2), title);
}

function summarizeRecord(input: unknown): string {
  if (!isRecord(input)) return String(input);
  const id = String(input.id || input.serverId || input.bindingId || '');
  const name = String(input.name || input.agentId || '');
  const status = String(
    input.status || (input.enabled === false ? 'disabled' : 'enabled'),
  );
  return [id, name, status].filter(Boolean).join(' | ');
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object';
}
