import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { EnvRuntimeSecretProvider } from '../../../credentials/env-runtime-secret-provider.js';
import type { RuntimeSecretProvider } from '../../../../domain/ports/runtime-secret-provider.js';

export const SECRET_ENCRYPTION_KEY_ENV = 'SECRET_ENCRYPTION_KEY';

const CREDENTIAL_SECRET_PREFIX = 'enc:v1:';

function resolveCredentialSecretKey(
  runtimeSecrets: RuntimeSecretProvider,
): Buffer {
  const raw = runtimeSecrets
    .getOptionalSecret({ env: SECRET_ENCRYPTION_KEY_ENV })
    ?.trim();
  if (!raw) {
    throw new Error(
      `${SECRET_ENCRYPTION_KEY_ENV} is required for Gantry credential encryption.`,
    );
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32) return decoded;
  throw new Error(
    `${SECRET_ENCRYPTION_KEY_ENV} must be a base64-encoded 32-byte secret for Gantry credential encryption.`,
  );
}

export function encryptCredentialSecretValue(
  value: string,
  runtimeSecrets: RuntimeSecretProvider = new EnvRuntimeSecretProvider(),
): string {
  if (value.startsWith(CREDENTIAL_SECRET_PREFIX)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    resolveCredentialSecretKey(runtimeSecrets),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    CREDENTIAL_SECRET_PREFIX.slice(0, -1),
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptCredentialSecretValue(
  stored: string,
  runtimeSecrets: RuntimeSecretProvider = new EnvRuntimeSecretProvider(),
): string {
  if (!stored.startsWith(CREDENTIAL_SECRET_PREFIX)) {
    throw new Error(
      'Gantry credential is not encrypted. Rotate it before use.',
    );
  }
  const [_enc, _v1, ivRaw, tagRaw, ciphertextRaw] = stored.split(':');
  if (!ivRaw || !tagRaw || !ciphertextRaw) {
    throw new Error('Gantry credential ciphertext is malformed.');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    resolveCredentialSecretKey(runtimeSecrets),
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
