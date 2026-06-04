---
name: boondi-kb
description: Bombay Sweet Shop knowledge base — return policy, store info, allergens, active discount codes, seasonal catalogue notes. Use whenever a customer asks a policy or store-info question, or when recommending products by occasion or dietary need.
user_invocable: false
# Progressive disclosure intentionally OFF while the KB body is small: it is
# inlined for lower latency on common KB turns (returns, allergens, hours, codes).
# Re-enable by adding the line `disclosure: progressive` below, once BSS fills the
# catalogue and the body grows large. Format reference: ../skill.example.md
---

# Bombay Sweet Shop — Customer Care Knowledge Base

This skill is the source-of-truth for policy, store, and product-care answers
that Boondi gives without going to Shopify. Fill in the bracketed sections with
content from BSS before going live.

## Gifting & business-interest cues (detecting queries and leads)

Bombay Sweet Shop sells sweets (mithai), namkeen/savouries, chocolates, and
gift boxes/hampers — for personal treats, personal gifts, and bulk/corporate
gifting. Use these cues to recognise commercial intent and capture it silently
(see CLAUDE.md "Capturing business interest"):

- **Shopping / product intent** — specific items (Kaju Katli, ladoo, barfi,
  bhujia, chocolate, hampers, gift boxes) or "what do you recommend", "something
  sweet/savoury". A self-treat or single gift is a light query.
- **Gifting intent** — "gift", "gifting", "hamper", "for my friend / family /
  team / clients", or an occasion (Diwali, wedding, Raksha Bandhan, Eid,
  anniversary, birthday, corporate). Always worth a query.
- **The five gifting questions** (ask one at a time, as a conversation, never a
  form): 1) Occasion · 2) Quantity · 3) Budget (per gift or total) · 4) Delivery
  location(s) · 5) Timeline. Each answer you learn fills a capture field.
- **Self-serve boundary** — personal gifting under ~25 pieces: guide them to
  order on the website, but still capture it as a query (a human can upsell).
- **Promote a query to a lead** when intent is decided/strong, or on any
  strong-B2B signal: 25+ pieces · total budget over ~₹10k · corporate email
  domain · multi-city / pan-India delivery · timeline under a week.
- **Buyer read** — personal, wedding/event, small business, employee gifting, or
  client/VIP/procurement. Corporate email + multiple cities + larger quantity are
  the strongest, highest-priority signals.

Seasonal peaks with more gifting/bulk intent: Diwali, wedding season, Raksha
Bandhan, Holi, Eid, New Year, and corporate year-end.

## Return policy

[TO BE FILLED BY BSS]

- Return window: [number of days]
- Perishable exceptions: [e.g. mithai categories with shorter window]
- Damaged/wrong items, refunds, replacements: escalation + who-decides rules
  live in SOUL.md §10 (Boondi flags, never approves). KB holds only the factual
  windows below — not the behaviour.
- Refund timing: [number of days after approval]

## Store locations & hours

[TO BE FILLED BY BSS]

- Bandra: [address], [hours]
- [Other locations]

## Allergens (per product category)

Use this for factual allergen lookups. (When/whether to escalate a clinical or
severe-allergy question to a human lives in SOUL.md §10 — not here.)

- Kaju Katli — contains tree nuts (cashew).
- Motichoor Ladoo — contains dairy (ghee); typically gluten-free.
- Mango Barfi — contains dairy; check label for nut presence.
- [TO BE FILLED for the full catalogue.]

## Active discount codes

These are read by `validate_discount_code` for live validity. Listed here so
Boondi can answer "do you have any codes running?" without a tool call.

**[TO BE FILLED BY BSS — do not quote any code below to a customer without
confirming it with `validate_discount_code` first; the entries here are
placeholders, not live codes.]**

- _Example placeholder:_ `BSSDIWALI20` — 20% off, minimum order INR 1000.

## Seasonal catalogue notes

- Diwali — hampers, gift boxes, corporate options.
- Wedding — favour boxes, bulk discounts.
- [Other festivals.]

## Currency

All prices are in INR (denoted with the Rupee symbol).

## Languages

English, Hindi, Hinglish. Match the customer's register — see SOUL.md §4 for the
Hinglish protocol.

## Brand voice samples

[TO BE FILLED BY BSS — three to five example replies in Boondi's voice across
shopping, order tracking, and complaint scenarios.]
