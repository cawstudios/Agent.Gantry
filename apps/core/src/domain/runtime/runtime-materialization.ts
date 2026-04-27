export type RuntimeMaterializationCleanupPolicy =
  | 'delete-after-run'
  | 'retain-for-debug';

export interface LocalScratchDirectory {
  runId: string;
  baseTempDir: string;
  path: string;
  cleanupPolicy: RuntimeMaterializationCleanupPolicy;
  cleanup: () => void;
}

export interface RuntimeMaterialization {
  runId: string;
  baseTempDir: string;
  cleanupPolicy: RuntimeMaterializationCleanupPolicy;
  cleanup: () => void;
}
