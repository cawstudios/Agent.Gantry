# Shopify MCP

## Customer-Facing Privacy Denials

- Customer identity and ownership denials must use plain customer-facing wording.
- Do not expose internal guard names, MCP/tool details, signed-header mechanics, admin/back-office instructions, bypass language, or diagnostic identifiers in tool content that can be shown to an end user.
- For customer messaging flows, say that the requested phone number, email, customer, or order does not match the phone number the customer is messaging from.
- Keep internal denial codes and developer diagnostics inside typed errors, logs, and tests; strip them from `customerSafe` tool responses.

## Latency-Sensitive Tool Payloads

- Default live customer-support tools to the smallest payload that answers the common question; require an explicit `limit` or detail lookup for wider history.
- Search/list tools should return compact summaries. Put bulky descriptions, images, tags, and deep detail behind specific detail tools so agent compose rounds do not carry unnecessary catalogue context.
