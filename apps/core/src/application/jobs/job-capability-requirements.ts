import type { JobCapabilityRequirement } from '../../domain/types.js';
import { ApplicationError } from '../common/application-error.js';
import {
  isValidSemanticCapabilityId,
  semanticCapabilityRule,
} from '../../shared/semantic-capability-ids.js';
import { getBuiltinSemanticCapability } from '../../shared/semantic-capabilities.js';

const IMPLEMENTATION_KINDS = new Set([
  'configured_access',
  'local_cli',
  'mcp_server',
  'builtin_tool',
]);

export function normalizeCapabilityRequirements(
  input: readonly JobCapabilityRequirement[] | undefined,
): JobCapabilityRequirement[] {
  if (!input || input.length === 0) return [];
  const out: JobCapabilityRequirement[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'capabilityRequirements entries must be objects.',
      );
    }
    const capabilityId = stringField(entry.capabilityId, 'capabilityId');
    if (!isValidSemanticCapabilityId(capabilityId)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'capabilityRequirements capabilityId must use lowercase dot-separated words such as google.sheets.write.',
      );
    }
    const reason = stringField(entry.reason, 'reason');
    const implementation = normalizeImplementation(entry.implementation);
    const key = `${capabilityId}\u0000${implementation?.kind ?? ''}\u0000${implementation?.name ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      capabilityId,
      reason,
      ...(implementation ? { implementation } : {}),
    });
  }
  return out;
}

export function capabilityRequirementToolRules(
  requirements: readonly JobCapabilityRequirement[] | undefined,
): string[] {
  const normalized = normalizeCapabilityRequirements(requirements);
  return [
    ...new Set(
      normalized.map((item) => semanticCapabilityRule(item.capabilityId)),
    ),
  ];
}

export function formatCapabilityRequirement(
  requirement: JobCapabilityRequirement,
): string {
  const capability = humanizeCapabilityId(requirement.capabilityId);
  const implementation = requirement.implementation;
  if (!implementation?.name) return capability;
  return `${capability} using ${implementation.name}`;
}

export function capabilityRequirementSetupAction(
  requirement: JobCapabilityRequirement,
): string {
  const implementation = requirement.implementation;
  if (implementation?.kind === 'local_cli') {
    const name =
      implementation.name || implementation.executablePath || 'local CLI';
    return [
      'propose_local_cli_capability',
      JSON.stringify({
        capabilityId: requirement.capabilityId,
        displayName: humanizeCapabilityId(requirement.capabilityId),
        category: name,
        risk: 'write',
        accountLabel: name,
        can: requirement.reason,
        cannot:
          'Bypass protected paths, change credentials, or run commands outside reviewed templates.',
        executablePath: implementation.executablePath ?? name,
        executableVersion: 'unknown',
        executableHash: 'unknown',
        commandTemplates: implementation.commandTemplate
          ? [implementation.commandTemplate]
          : [`${name} *`],
        authPreflightCommand: implementation.authPreflight,
        protectedPaths: implementation.protectedPaths ?? [],
        reason: requirement.reason,
      }),
    ].join(' ');
  }
  return [
    'request_capability',
    JSON.stringify({
      capabilityId: requirement.capabilityId,
      reason: requirement.reason,
    }),
  ].join(' ');
}

function normalizeImplementation(
  input: JobCapabilityRequirement['implementation'] | undefined,
): JobCapabilityRequirement['implementation'] | undefined {
  if (!input) return undefined;
  if (!IMPLEMENTATION_KINDS.has(input.kind)) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'capabilityRequirements implementation.kind must be configured_access, local_cli, mcp_server, or builtin_tool.',
    );
  }
  const implementation: NonNullable<
    JobCapabilityRequirement['implementation']
  > = {
    kind: input.kind,
  };
  const name = optionalString(input.name);
  if (name) implementation.name = name;
  const executablePath = optionalString(input.executablePath);
  if (executablePath) implementation.executablePath = executablePath;
  const commandTemplate = optionalString(input.commandTemplate);
  if (commandTemplate) implementation.commandTemplate = commandTemplate;
  const authPreflight = optionalString(input.authPreflight);
  if (authPreflight) implementation.authPreflight = authPreflight;
  const protectedPaths = Array.isArray(input.protectedPaths)
    ? input.protectedPaths
        .map(optionalString)
        .filter((item): item is string => Boolean(item))
    : [];
  if (protectedPaths.length > 0) {
    implementation.protectedPaths = [...new Set(protectedPaths)];
  }
  return implementation;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `capabilityRequirements ${field} is required.`,
    );
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function humanizeCapabilityId(capabilityId: string): string {
  const builtin = getBuiltinSemanticCapability(capabilityId);
  if (builtin) return builtin.displayName;
  return capabilityId
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
