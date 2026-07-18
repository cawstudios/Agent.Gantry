import {
  evaluateEgressDenylist,
  evaluateNonPublicEgressAddress,
} from '../../../../shared/egress-policy.js';
import { isSdkSandboxNetworkAccessToolName } from '../../../../shared/agent-tool-references.js';

export function decideSdkSandboxNetworkAccess(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  denylist: readonly string[];
}):
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt: false }
  | null {
  if (!isSdkSandboxNetworkAccessToolName(input.toolName)) return null;

  const host =
    typeof input.toolInput.host === 'string' ? input.toolInput.host : '';
  const deny = evaluateEgressDenylist({
    settings: { denylist: [...input.denylist] },
    host,
  });
  if (deny) {
    return {
      behavior: 'deny',
      message: deny.reason,
      interrupt: false,
    };
  }
  const nonPublicDeny = evaluateNonPublicEgressAddress({
    host,
    address: host,
  });
  if (nonPublicDeny) {
    return {
      behavior: 'deny',
      message: nonPublicDeny.reason,
      interrupt: false,
    };
  }

  return { behavior: 'allow', updatedInput: input.toolInput };
}
