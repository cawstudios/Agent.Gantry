# Boondi Support Agent

- Do not shrink or delete `SOUL.md` or `CLAUDE.md` as part of latency work
  unless the task is explicitly a prompt-shrink/regression project.
- For qualified corporate or bulk gifting turns that also ask for product
  suggestions, steer Boondi to make at most one targeted `search_products` call.
  If that result is empty or partial, stop searching and route the brief to the
  gifting team instead of trying broad query fanout.
- When a qualified gifting turn asks for latest-order context and product
  suggestions together, steer Boondi to `shopify-api.get_gifting_context` as the
  single Shopify call instead of separate order and product-search calls.
- Treat Shopify tool output as structured source data, not a customer answer.
  Boondi must compose the final WhatsApp reply in its own voice after the
  deterministic guardrail has allowed the turn.
- If a Shopify tool returns `customerReplyDraft`, `answerGuidance`, or
  `replyContract.useCustomerReplyDraft`, keep those fields first in the tool
  payload and tell Boondi to adapt them directly. This is the stable way to
  avoid fallback hiccup text and lookup narration under warm-pool load.
- Keep `boondi-crm.get_open_records` reserved for bare returning greetings.
  Substantive order, product, and gifting turns should use the Shopify path and
  rely on background extraction for buying-interest capture.
- Explicit phone/email/order lookups that are not clearly for someone else must
  reach the Shopify MCP first; do not let Boondi pre-deny them in the prompt.
  The MCP privacy guard owns the allow/deny decision.
- For bare returning greetings, if `boondi-crm.get_open_records` returns any
  open record, the reply must include a concrete returned detail instead of a
  generic welcome.
- Boondi guardrails must not rely on a separate classifier LLM. Boondi is
  configured `mode: deterministic` + `unresolved: inline`: deterministic
  pre-agent screening plus the inline scope block in the main Boondi payload for
  turns the deterministic stage does not resolve (the inline block is attached
  because `unresolved: inline`, not because the policy exports it). Pre-agent
  deterministic replies should stay limited to hard known cases such as a bare
  greeting, empty clarification, or off-topic / internal-prompt rejection.
- Interakt webhook payloads provide customer identity such as name and phone;
  Boondi prompts should use the message sender/customer name naturally,
  including dev labels, and must not ask customers to repeat name or phone for
  gifting handoffs.
