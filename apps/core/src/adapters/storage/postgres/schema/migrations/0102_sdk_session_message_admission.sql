ALTER TABLE "live_admission_work_items"
  ADD COLUMN "request_message_id" text,
  ADD COLUMN "request_fingerprint" text,
  ADD COLUMN "accepted_event_id" integer,
  ADD COLUMN "turn_state" text,
  ADD COLUMN "queue_deadline_at" timestamp with time zone,
  ADD COLUMN "execution_timeout_ms" integer,
  ADD COLUMN "execution_deadline_at" timestamp with time zone,
  ADD COLUMN "turn_started_at" timestamp with time zone,
  ADD COLUMN "turn_ended_at" timestamp with time zone,
  ADD COLUMN "terminal_code" text;

ALTER TABLE "live_admission_work_items"
  ADD CONSTRAINT "live_admission_work_items_accepted_event_id_runtime_events_event_id_fk"
  FOREIGN KEY ("accepted_event_id") REFERENCES "runtime_events"("event_id")
  ON DELETE SET NULL;

CREATE INDEX "idx_live_admission_sdk_session_turns"
  ON "live_admission_work_items" ("agent_session_id", "turn_state", "created_at", "id")
  WHERE "request_fingerprint" IS NOT NULL;

CREATE INDEX "idx_live_admission_sdk_queue_deadline"
  ON "live_admission_work_items" ("queue_deadline_at", "created_at", "id")
  WHERE "turn_state" = 'waiting' AND "queue_deadline_at" IS NOT NULL;
