# Boondi CRM Connector

- Follow the Boondi guide `agents/boondi_support/docs/mcp-tool-design-guide.md`
  for every new or changed tool. Customer-facing CRM tools must default to
  compact, verified-identity responses and avoid adding avoidable LLM/tool
  loops.
- Opportunity extraction is driven from session digests; regression checks must
  invoke the operator slash-command path and then assert
  `boondi_business_records`, not local replay scripts or customer-facing tool
  calls.
- Manual extraction/debug tooling must reuse the same watcher path as the digest
  watcher so query-to-lead upgrades, scoring, and cursor advancement stay
  single-sourced.
- Admin response comments are Boondi CRM-owned review annotations. Store them in
  `boondi_response_comments`; do not inject them into prompts or memory unless a
  separate reviewed promotion flow is designed.
- Connector logs may expose digest ids, hashed conversation refs, counts, record
  ids, statuses, scores, and non-contact classification fields. Do not log raw
  phones, emails, transcripts, caller identity headers, or database URLs.
