# Scripts

- Boondi regression phone numbers must stay fake unless the number is explicitly
  supplied by the operator in `GANTRY_TEST_OPERATOR_PHONE`.
- Do not use broad unlisted-phone bypasses for signed webhook replay. The safe
  test sender set is the checked-in fake numbers plus the runtime operator
  allowlist.
- CRM lifecycle regressions should send `/digest-session` and
  `/extract-leads-queries` through the signed
  webhook path, then prove extraction through `boondi_business_records`.
- Boondi scenario runs are also admin-panel review artifacts. Do not send a
  teardown `/new` by default or otherwise clear scenario transcripts after they
  run; rely on the pre-run DB reset for clean fake-phone state.
- When driving Boondi scenario webhooks for admin-panel review, start the dev
  runtime with a short `IDLE_TIMEOUT` such as `2500`. The production default
  keeps warm LLM sessions open for 30 minutes and can fill the message queue's
  active-run slots, making later fake-phone chats appear unanswered.
