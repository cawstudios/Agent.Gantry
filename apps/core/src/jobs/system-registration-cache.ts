import type { OpsRepository } from '../domain/repositories/ops-repo.js';

const signatures = new WeakMap<OpsRepository, string>();

export function getSystemJobRegistrationSignature(
  opsRepository: OpsRepository,
): string | undefined {
  return signatures.get(opsRepository);
}

export function setSystemJobRegistrationSignature(
  opsRepository: OpsRepository,
  signature: string,
): void {
  signatures.set(opsRepository, signature);
}

export function invalidateSystemJobRegistrationSignature(
  opsRepository: OpsRepository,
): void {
  signatures.delete(opsRepository);
}
