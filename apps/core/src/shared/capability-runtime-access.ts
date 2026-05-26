export type CapabilityRuntimeAccessSourceType =
  | 'local_cli'
  | 'skill_action'
  | 'mcp_server'
  | 'builtin_tool'
  | 'configured_adapter';

export interface CapabilityRuntimeAccessBase {
  selectedCapabilityId: string;
  sourceType: CapabilityRuntimeAccessSourceType;
  auditLabel: string;
}

export interface LocalCliNetworkBinding {
  commandRules: string[];
  hosts: string[];
}

export interface LocalCliCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
  sourceType: 'local_cli';
  commandRules: string[];
  credentialDirs: string[];
  networkBindings: LocalCliNetworkBinding[];
}

export interface SkillActionCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
  sourceType: 'skill_action';
  skillId: string;
  selectedAction: string;
  declaredEnvRefs: string[];
  commandRules: string[];
}

export interface McpServerCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
  sourceType: 'mcp_server';
  reviewedServerId: string;
  allowedTools: string[];
  credentialRefs: string[];
}

export interface BuiltinToolCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
  sourceType: 'builtin_tool';
  runtimeToolRules: string[];
}

export interface ConfiguredAdapterCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
  sourceType: 'configured_adapter';
  adapterRef: string;
}

export type CapabilityRuntimeAccess =
  | LocalCliCapabilityRuntimeAccess
  | SkillActionCapabilityRuntimeAccess
  | McpServerCapabilityRuntimeAccess
  | BuiltinToolCapabilityRuntimeAccess
  | ConfiguredAdapterCapabilityRuntimeAccess;
