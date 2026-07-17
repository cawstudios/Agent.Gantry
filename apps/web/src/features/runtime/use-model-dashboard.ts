import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  requireRuntimeTransport,
  useRuntimeConnection,
} from '../../lib/api/runtime-connection';
import {
  disableModelCredential,
  loadModelDashboard,
  modelQueryKeys,
  patchModelDefaults,
  saveModelCredential,
} from './model-api';

export function useModelDashboard() {
  const connection = useRuntimeConnection();
  return useQuery({
    queryKey: modelQueryKeys.all,
    enabled: Boolean(connection.transport),
    queryFn: () => loadModelDashboard(requireRuntimeTransport(connection)),
  });
}

export function usePatchModelDefaults() {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, string | null>) =>
      patchModelDefaults(requireRuntimeTransport(connection), patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: modelQueryKeys.all });
    },
  });
}

export function useSaveModelCredential() {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      providerId: string;
      authMode?: string;
      payload: Record<string, string>;
    }) =>
      saveModelCredential(
        requireRuntimeTransport(connection),
        input.providerId,
        { authMode: input.authMode, payload: input.payload },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: modelQueryKeys.all });
    },
  });
}

export function useDisableModelCredential() {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) =>
      disableModelCredential(requireRuntimeTransport(connection), providerId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: modelQueryKeys.all });
    },
  });
}
