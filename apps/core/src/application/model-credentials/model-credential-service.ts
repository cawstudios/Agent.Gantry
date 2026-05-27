import type { AppId } from '../../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { ModelCredentialRepository } from '../../domain/ports/repositories.js';
import type {
  ModelCredential,
  ModelCredentialFieldFingerprint,
  ModelCredentialProvider,
  ModelCredentialStatus,
} from '../../domain/model-credentials/model-credentials.js';
import { sha256Hex, stableSha256Json } from '../../shared/stable-hash.js';
import {
  listSupportedModelCredentialProviders,
  normalizeModelCredentialProvider,
} from '../../domain/model-credentials/model-credentials.js';
import {
  getModelProviderDefinition,
  normalizeModelCredentialPayload,
  singleSecretPayload,
  type ModelCredentialPayload,
} from '../../shared/model-provider-registry.js';

type ModelCredentialAuditPublisher = (
  event: RuntimeEventPublishInput,
) => Promise<unknown> | unknown;

export type ModelCredentialHealth = 'ready' | 'missing' | 'disabled';

export class ModelCredentialService {
  constructor(
    private readonly credentials: ModelCredentialRepository,
    private readonly audit?: ModelCredentialAuditPublisher,
  ) {}

  async list(input: { appId: AppId }) {
    const configured = new Map(
      (await this.credentials.listModelCredentials(input)).map((credential) => [
        credential.providerId,
        credential,
      ]),
    );
    return listSupportedModelCredentialProviders().map((providerId) => {
      const credential = configured.get(providerId);
      const health: ModelCredentialHealth =
        credential?.status === 'active'
          ? 'ready'
          : credential
            ? 'disabled'
            : 'missing';
      return {
        providerId,
        label: getModelProviderDefinition(providerId)?.label ?? providerId,
        configured: health === 'ready',
        status: credential?.status ?? ('disabled' as ModelCredentialStatus),
        health,
        fingerprint: credential?.fingerprint ?? null,
        fieldFingerprints: credential?.fieldFingerprints ?? [],
        schemaVersion:
          credential?.schemaVersion ??
          getModelProviderDefinition(providerId)?.credentialSchema.version ??
          1,
        configuredFields:
          credential?.fieldFingerprints.map((item) => item.field) ?? [],
        supportedWorkloads:
          getModelProviderDefinition(providerId)?.supportedWorkloads ?? [],
        updatedAt: credential?.updatedAt ?? null,
      };
    });
  }

  async set(input: {
    appId: AppId;
    providerId: string;
    payload: unknown;
    actor?: string;
  }) {
    const providerId = normalizeModelCredentialProvider(input.providerId);
    const payload = normalizeModelCredentialPayload({
      providerId,
      payload: input.payload,
    });
    const provider = getModelProviderDefinition(providerId);
    const schemaVersion = provider?.credentialSchema.version ?? 1;
    const fieldFingerprints = fingerprintCredentialFields(providerId, payload);
    const metadata = await this.credentials.upsertModelCredential({
      appId: input.appId,
      providerId,
      schemaVersion,
      payload,
      fingerprint: fingerprintCredentialPayload(payload),
      fieldFingerprints,
      actor: input.actor,
    });
    await this.publishAudit({
      appId: input.appId,
      actor: input.actor ?? 'model-credential-service',
      eventType: RUNTIME_EVENT_TYPES.CREDENTIAL_MODEL_UPDATED,
      payload: {
        providerId: metadata.providerId,
        status: metadata.status,
        fingerprint: metadata.fingerprint,
        fieldFingerprints: metadata.fieldFingerprints,
        schemaVersion: metadata.schemaVersion,
        updatedAt: metadata.updatedAt,
      },
    });
    return metadata;
  }

  async setSingleSecret(input: {
    appId: AppId;
    providerId: string;
    value: string;
    actor?: string;
  }) {
    return this.set({
      appId: input.appId,
      providerId: input.providerId,
      payload: singleSecretPayload({
        providerId: input.providerId,
        value: input.value,
      }),
      actor: input.actor,
    });
  }

  async disable(input: { appId: AppId; providerId: string; actor?: string }) {
    const providerId = normalizeModelCredentialProvider(input.providerId);
    const metadata = await this.credentials.disableModelCredential({
      appId: input.appId,
      providerId,
      actor: input.actor,
    });
    if (metadata) {
      await this.publishAudit({
        appId: input.appId,
        actor: input.actor ?? 'model-credential-service',
        eventType: RUNTIME_EVENT_TYPES.CREDENTIAL_MODEL_DISABLED,
        payload: {
          providerId: metadata.providerId,
          status: metadata.status,
          fingerprint: metadata.fingerprint,
          fieldFingerprints: metadata.fieldFingerprints,
          schemaVersion: metadata.schemaVersion,
          updatedAt: metadata.updatedAt,
        },
      });
    }
    return metadata;
  }

  async getActiveCredential(input: {
    appId: AppId;
    providerId: ModelCredentialProvider;
  }): Promise<ModelCredential | null> {
    const credential = await this.credentials.getModelCredential(input);
    if (!credential || credential.status !== 'active') return null;
    return credential;
  }

  async getActiveSecret(input: {
    appId: AppId;
    providerId: ModelCredentialProvider;
  }): Promise<string | null> {
    const credential = await this.getActiveCredential(input);
    if (!credential) return null;
    const provider = getModelProviderDefinition(input.providerId);
    const field = provider?.credentialSchema.fields.find((item) => item.secret);
    return field ? (credential.payload[field.name] ?? null) : null;
  }

  private async publishAudit(input: RuntimeEventPublishInput): Promise<void> {
    if (!this.audit) return;
    await this.audit(input);
  }
}

export function fingerprintCredential(value: string): string {
  const digest = sha256Hex(value);
  return `sha256:${digest.slice(0, 16)}`;
}

export function fingerprintCredentialPayload(
  payload: ModelCredentialPayload,
): string {
  return `sha256:${stableSha256Json(payload).slice(0, 16)}`;
}

function fingerprintCredentialFields(
  providerId: ModelCredentialProvider,
  payload: ModelCredentialPayload,
): ModelCredentialFieldFingerprint[] {
  const provider = getModelProviderDefinition(providerId);
  return (provider?.credentialSchema.fields ?? [])
    .filter((field) => field.secret && payload[field.name])
    .map((field) => ({
      field: field.name,
      fingerprint: fingerprintCredential(payload[field.name]!),
    }));
}
