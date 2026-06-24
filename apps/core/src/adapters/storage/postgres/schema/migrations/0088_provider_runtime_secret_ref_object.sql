ALTER TABLE "provider_connections"
  ALTER COLUMN "runtime_secret_refs_json" SET DEFAULT '{}';

UPDATE "provider_connections"
SET "runtime_secret_refs_json" = '{}'
WHERE left(btrim("runtime_secret_refs_json"), 1) = '[';
