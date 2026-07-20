import type {
  ModelDefaultsPatchRequest,
  ModelDefaultsResponse,
  ModelPreviewRequest,
  ModelPreviewResponse,
  ModelRecord,
} from './job-model-types.js';
import type {
  DisableModelCredentialResponse,
  ListModelCredentialsResponse,
  ModelCredentialMutationResponse,
  PutModelCredentialRequest,
} from './openapi-types.js';
import type { RequestOptions } from './types.js';

type ModelsTransport = {
  request<T>(options: RequestOptions): Promise<T>;
};

export function createModelsClient(transport: ModelsTransport) {
  return {
    list: () =>
      transport.request<{ models: ModelRecord[] }>({
        method: 'GET',
        path: '/v1/models',
      }),
    defaults: {
      get: () =>
        transport.request<ModelDefaultsResponse>({
          method: 'GET',
          path: '/v1/models/defaults',
        }),
      update: (input: ModelDefaultsPatchRequest) =>
        transport.request<ModelDefaultsResponse>({
          method: 'PATCH',
          path: '/v1/models/defaults',
          body: input,
        }),
    },
    preview: (input: ModelPreviewRequest) =>
      transport.request<ModelPreviewResponse>({
        method: 'POST',
        path: '/v1/models/preview',
        body: input,
      }),
    credentials: {
      list: () =>
        transport.request<ListModelCredentialsResponse>({
          method: 'GET',
          path: '/v1/credentials/models',
        }),
      set: (providerId: string, input: PutModelCredentialRequest) =>
        transport.request<ModelCredentialMutationResponse>({
          method: 'PUT',
          path: `/v1/credentials/models/${encodeURIComponent(providerId)}`,
          body: input,
        }),
      disable: (providerId: string) =>
        transport.request<DisableModelCredentialResponse>({
          method: 'DELETE',
          path: `/v1/credentials/models/${encodeURIComponent(providerId)}`,
        }),
    },
  };
}
