CREATE TABLE IF NOT EXISTS memory_items (
  id text PRIMARY KEY,
  scope text NOT NULL,
  group_folder text NOT NULL,
  user_id text,
  topic_id text,
  kind text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  why text,
  load_bearing boolean NOT NULL DEFAULT false,
  source_turn_id text,
  source text NOT NULL,
  source_folder text NOT NULL DEFAULT 'items',
  file_path text NOT NULL DEFAULT '',
  content_hash text NOT NULL DEFAULT '',
  indexed_at timestamptz,
  embedding_pending boolean NOT NULL DEFAULT false,
  blocked_reason text,
  confidence double precision NOT NULL DEFAULT 0.5,
  is_pinned boolean NOT NULL DEFAULT false,
  used_count integer NOT NULL DEFAULT 0,
  superseded_by text,
  version integer NOT NULL DEFAULT 1,
  last_used_at timestamptz,
  last_retrieved_at timestamptz,
  retrieval_count integer NOT NULL DEFAULT 0,
  total_score double precision NOT NULL DEFAULT 0,
  max_score double precision NOT NULL DEFAULT 0,
  query_hashes_json text NOT NULL DEFAULT '[]',
  recall_days_json text NOT NULL DEFAULT '[]',
  embedding_json text,
  embedding vector(3072),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  last_reviewed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_memory_items_scope_group
  ON memory_items(scope, group_folder, topic_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_items_file_path ON memory_items(file_path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_active_unique_key
  ON memory_items(scope, group_folder, COALESCE(user_id, ''), COALESCE(topic_id, ''), key)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_memory_items_search
  ON memory_items USING gin (
    to_tsvector('english', key || ' ' || value || ' ' || COALESCE(why, ''))
  );
CREATE INDEX IF NOT EXISTS idx_memory_items_embedding
  ON memory_items USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_procedures (
  id text PRIMARY KEY,
  scope text NOT NULL,
  group_folder text NOT NULL,
  topic_id text,
  title text NOT NULL,
  body text NOT NULL,
  tags_json text NOT NULL DEFAULT '[]',
  origin text NOT NULL DEFAULT 'explicit',
  trigger text,
  source text NOT NULL,
  confidence double precision NOT NULL DEFAULT 0.5,
  version integer NOT NULL DEFAULT 1,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_memory_procedures_scope_group
  ON memory_procedures(scope, group_folder, topic_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_procedures_search
  ON memory_procedures USING gin (to_tsvector('english', title || ' ' || body));

CREATE TABLE IF NOT EXISTS memory_chunks (
  id text PRIMARY KEY,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_path text NOT NULL,
  scope text NOT NULL,
  group_folder text NOT NULL,
  topic_id text,
  kind text NOT NULL,
  chunk_hash text NOT NULL UNIQUE,
  text text NOT NULL,
  token_count integer NOT NULL,
  importance_weight double precision NOT NULL DEFAULT 1,
  embedding_json text,
  embedding vector(3072),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_scope_group
  ON memory_chunks(scope, group_folder, topic_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_source
  ON memory_chunks(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_search
  ON memory_chunks USING gin (to_tsvector('english', text));
CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding
  ON memory_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_events (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  payload_json text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_events_event_entity
  ON memory_events(event_type, entity_id, id DESC);

CREATE TABLE IF NOT EXISTS memory_usage_events (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id text NOT NULL,
  query_hash text NOT NULL,
  score double precision NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS embedding_cache (
  text_hash text NOT NULL,
  model text NOT NULL,
  embedding_json text NOT NULL,
  embedding vector(3072),
  created_at timestamptz NOT NULL,
  CONSTRAINT embedding_cache_pk PRIMARY KEY (text_hash, model)
);