-- End-to-end reply-latency timeline anchors. All nullable: only set on
-- gateway-originated inbounds (ingress_at) and channel sends (send_*). Generic /
-- agent-agnostic. ms-epoch is derived at read time from these timestamptz cols.
ALTER TABLE messages ADD COLUMN ingress_at timestamptz;
ALTER TABLE messages ADD COLUMN send_started_at timestamptz;
ALTER TABLE messages ADD COLUMN send_completed_at timestamptz;
