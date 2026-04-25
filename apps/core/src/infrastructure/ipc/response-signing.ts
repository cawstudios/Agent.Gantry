import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'crypto';

export interface IpcResponseSigningKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function createIpcResponseSigningKeyPair(): IpcResponseSigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKeyPem: privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
  };
}

export function canonicalIpcResponsePayload(
  payload: Record<string, unknown>,
): Buffer {
  return Buffer.from(JSON.stringify(payload));
}

export function signIpcResponsePayload(
  privateKeyPem: string | undefined,
  payload: Record<string, unknown>,
): string | undefined {
  const key = privateKeyPem?.trim();
  if (!key) return undefined;
  return cryptoSign(null, canonicalIpcResponsePayload(payload), key).toString(
    'base64',
  );
}

export function verifyIpcResponsePayload(
  publicKeyPem: string | undefined,
  payload: Record<string, unknown>,
  signature: string | undefined,
): boolean {
  const key = publicKeyPem?.trim();
  const sig = signature?.trim();
  if (!key || !sig) return false;
  try {
    return cryptoVerify(
      null,
      canonicalIpcResponsePayload(payload),
      key,
      Buffer.from(sig, 'base64'),
    );
  } catch {
    return false;
  }
}
