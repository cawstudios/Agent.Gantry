export interface StorageCapabilities {
  lexicalSearch: boolean;
  vectorSearch: boolean;
  vectorReason?: string;
  textSearch?: boolean;
  textSearchReason?: string;
  jobQueue?: boolean;
  jobQueueReason?: string;
  maxEmbeddingDimensions?: number;
}

export const SQLITE_MAX_EMBEDDING_DIMENSIONS = 8192;
export const POSTGRES_MAX_EMBEDDING_DIMENSIONS = 16000;
