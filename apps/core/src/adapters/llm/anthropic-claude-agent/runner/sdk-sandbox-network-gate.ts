import { evaluateEgressDenylist } from '../../../../shared/egress-policy.js';
import { isSdkSandboxNetworkAccessToolName } from '../../../../shared/agent-tool-references.js';
import {
  normalizeEgressAuthorityHost,
  resolvePublicEgressAddress,
} from '../../../../shared/egress-target-resolution.js';
import { isIpAddress } from '../../../../shared/network-host-declaration.js';

export async function decideSdkSandboxNetworkAccess(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  denylist: readonly string[];
}): Promise<
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt: false }
  | null
> {
  if (!isSdkSandboxNetworkAccessToolName(input.toolName)) return null;

  const authority =
    typeof input.toolInput.host === 'string' ? input.toolInput.host : '';
  const host = normalizeEgressAuthorityHost(authority);
  const deny = evaluateEgressDenylist({
    settings: { denylist: [...input.denylist] },
    host: host ?? authority,
  });
  if (deny) {
    return {
      behavior: 'deny',
      message: deny.reason,
      interrupt: false,
    };
  }
  const isLoopbackHostname =
    host === 'localhost' || host?.endsWith('.localhost') === true;
  // In direct mode the SDK sandbox asks only for a boolean network decision,
  // then its proxy reconnects with the original hostname. Unlike
  // sandbox_runtime's Gantry egress gateway, that path cannot bind approval to
  // the address checked here, so hostname requests must fail closed.
  if (host && !isIpAddress(host) && !isLoopbackHostname) {
    return {
      behavior: 'deny',
      message: `Direct-mode SDK sandbox network access requires an IP-literal host; hostname ${host} cannot be safely pinned after DNS resolution.`,
      interrupt: false,
    };
  }
  const resolution = host
    ? await resolvePublicEgressAddress(host)
    : { ok: false as const, host: authority.trim() };
  if (!resolution.ok) {
    return {
      behavior: 'deny',
      message:
        resolution.deny?.reason ??
        `SDK sandbox network access could not safely resolve ${resolution.host || 'the requested host'}.`,
      interrupt: false,
    };
  }

  return { behavior: 'allow', updatedInput: input.toolInput };
}
