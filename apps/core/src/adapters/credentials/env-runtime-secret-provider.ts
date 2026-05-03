import fs from 'fs';
import path from 'path';

import type { CredentialBrokerHealth } from '../../domain/models/credentials.js';
import type {
  RuntimeSecretProvider,
  RuntimeSecretRef,
} from '../../domain/ports/runtime-secret-provider.js';
import { getMyclawHome } from '../../shared/myclaw-home.js';

function readRuntimeHomeEnvValue(key: string): string {
  const envPath = path.join(getMyclawHome(), '.env');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator <= 0) continue;
      if (trimmed.slice(0, separator).trim() !== key) continue;
      const value = trimmed.slice(separator + 1).trim();
      return value.replace(/^['"]|['"]$/g, '');
    }
  } catch {
    return '';
  }
  return '';
}

export class EnvRuntimeSecretProvider implements RuntimeSecretProvider {
  constructor(private readonly source: NodeJS.ProcessEnv = process.env) {}

  getSecret(ref: RuntimeSecretRef): string {
    const value = this.getOptionalSecret(ref);
    if (!value) {
      throw new Error(`${ref.env} is required.`);
    }
    return value;
  }

  getOptionalSecret(ref: RuntimeSecretRef): string | undefined {
    const direct = this.source[ref.env]?.trim();
    if (direct) return direct;
    if (this.source !== process.env) return undefined;
    const runtimeValue = readRuntimeHomeEnvValue(ref.env).trim();
    return runtimeValue || undefined;
  }

  async healthCheck(
    refs: RuntimeSecretRef[] = [],
  ): Promise<CredentialBrokerHealth> {
    const missing = refs
      .filter((ref) => !this.getOptionalSecret(ref))
      .map((ref) => ref.env);
    if (missing.length > 0) {
      return {
        status: 'fail',
        message: 'Runtime-owned secrets are missing.',
        details: missing,
      };
    }
    return {
      status: 'pass',
      message: 'Runtime-owned secrets are configured.',
    };
  }
}
