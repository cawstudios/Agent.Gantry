type TransportLike = {
  request<T>(options: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<T>;
};

export type RuntimeSettingsResponse = {
  settings: {
    desiredState: {
      authoritative: boolean;
    };
    agent: {
      name: string;
      defaultModel: string;
      oneTimeJobDefaultModel: string;
      recurringJobDefaultModel: string;
    };
    agents: Record<
      string,
      {
        name: string;
        folder: string;
        persona?:
          | 'developer'
          | 'generalist'
          | 'sales'
          | 'marketing'
          | 'operations'
          | 'research';
        relationshipMode?: 'personal' | 'organization';
        model?: string;
        oneTimeJobDefaultModel?: string;
        recurringJobDefaultModel?: string;
        bindings: Record<
          string,
          {
            jid: string;
            provider?: string;
            name?: string;
            trigger: string;
            addedAt: string;
            requiresTrigger: boolean;
            model?: string;
          }
        >;
        capabilities: {
          toolIds: string[];
          skillIds: string[];
          mcpServerIds: string[];
        };
        access?: {
          preset: 'full' | 'locked';
        };
      }
    >;
    memory: {
      enabled: boolean;
      dreaming: {
        enabled: boolean;
      };
    };
    runtime: {
      queue: {
        maxMessageRuns: number;
        maxJobRuns: number;
        maxMessageBacklog: number;
        maxTaskBacklog: number;
        maxRetries: number;
        baseRetryMs: number;
        drainDeadlineMs: number;
      };
      sandbox: {
        provider: 'direct' | 'sandbox_runtime';
        resourceLimits: {
          cpuSeconds: number;
          memoryMb: number;
          maxProcesses: number;
        };
      };
      artifactStore: {
        driver: 'local' | 's3';
        bucket?: string;
        region?: string;
        endpoint?: string;
        forcePathStyle?: boolean;
      };
      deploymentMode: 'workstation' | 'fleet';
    };
    browser: {
      usage: {
        enabled: boolean;
        mode: 'audit' | 'enforce';
        windowMs: number;
        maxActionsPerWindow: number;
        maxConcurrentPerSite: number;
      };
    };
    permissions: {
      yoloMode: {
        enabled: boolean;
        denylist: string[];
        denylistPaths: string[];
      };
      egress: {
        denylist: string[];
      };
    };
  };
};

export function createSettingsClient(transport: TransportLike) {
  return {
    get: () =>
      transport.request<RuntimeSettingsResponse>({
        method: 'GET',
        path: '/v1/settings',
      }),
  };
}
