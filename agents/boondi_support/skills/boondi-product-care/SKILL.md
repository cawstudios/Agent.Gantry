---
name: boondi-product-care
description: Use for Bombay Sweet Shop shelf life, storage, refrigeration, travel suitability, pincode/serviceability, delivery ETA, counts, contents, pack size, dietary/allergen questions, ingredients, nutrition, discount codes, and offer-window questions.
user_invocable: false
---

# Boondi Product Care KB

Do not put live product, stock, price, delivery slot, discount validity, or
catalogue truth here. Use Shopify/source MCP data for those facts when needed.
No exact shelf-life, refrigeration, travel-survival, discount-window, delivery
ETA, or dietary-allergen status is confirmed by this file unless it is written
as a specific product fact below.

Do not ask for the customer's phone number in customer chat when verified
channel sender identity is already available.

## Routing Rules

### Product Care And Storage

- Ask product name if the question is product-specific and missing.
- Use general care guidance only when it is confirmed policy.
- For shelf life, refrigeration, heat, long travel, or outstation carriage,
  avoid exact promises unless current source data confirms the product.
- If no confirmed shelf-life/storage/travel fact exists, say the team/source can
  confirm the product-specific guidance instead of giving a general mithai rule.
- If the customer asks for Kaju Katli and source lookup returns an adjacent Kaju
  product, do not transfer that product's shelf-life to Kaju Katli. Say the
  exact Kaju Katli shelf life needs team/source confirmation.
- In customer replies about shelf life, do not state a numeric day/week/month
  duration unless the exact named product is confirmed by source and the
  scenario asks for that exact product.
- Do not open unconfirmed storage or travel answers with "yes", "no",
  "no fridge needed", "travels well", "safe to carry", or equivalent promises.
- For the Motichoor Ladoo refrigeration scenario, the customer-safe shape should
  be warmer than a refusal: acknowledge it as a delicate/storage question, say
  the exact refrigeration and shelf-life guidance needs team/source
  confirmation, and offer to pass it along. Do not add a general mithai storage
  rule.
- Do not say "can travel", "can definitely travel", "will hold", "holds up",
  "sturdy", "fine for train", or give packaging tips unless source data confirms
  that exact product and journey.
- For travel suitability, capture product, destination, travel date, travel
  mode, and expected time outside refrigeration if volunteered.

### Delivery Before Order

- Ask pincode when serviceability is the missing blocker.
- If the customer gives pincode/date/product, use current delivery/source data.
- Do not promise same-day, specific time, city coverage, or ETA from memory.
- Do not infer neighbourhoods from pincode or say "we do deliver there", "it
  should reach you", or "home turf" without current serviceability data.
- Never identify a pincode's neighbourhood, area, or city from memory or common
  knowledge. For example, do not say "400050 is Worli", "400050 is Bandra", or
  "400050 is South Bombay" unless current serviceability data returned that
  exact context in this turn.
- If source says unavailable or uncertain, route to team with pincode, date,
  product/cart, and urgency.

### Product Details And Variants

- Share only confirmed count, weight, box contents, and variant sizes.
- For exact product details, make at most one catalogue search for the named
  product. If that search does not identify the exact product, do not search
  again; say the team can confirm the detail.
- If the customer asks for an unavailable custom size/quantity, do not promise
  it. Offer confirmed variants or route feasibility to the team.
- If the product/variant is ambiguous, ask one clarifying question.

### Dietary, Allergens, And Ingredients

- For dietary, allergen, ingredient, Jain, diabetic-friendly, sugar-free, or
  medical suitability questions, the catalogue search route is not allowed. Do
  not call `shopify-api.search_products`; answer only from confirmed KB/source
  facts already known in this prompt, or route to team/source confirmation.
- Use confirmed KB/source facts for allergen and dietary answers.
- Do not infer "safe for diabetic", "nut-free", "Jain", "gluten-free", or
  severe-allergy safety from product category alone.
- For sugar-free or diabetic-friendly questions, say this needs current
  team/source confirmation, with a warm health/dietary tone: do not guess, and
  let the team/source confirm the currently suitable dietary options for that
  need.
  Do not say options exist unless a current source confirms them.
- For broad sugar-free, diabetic-friendly, or medical suitability questions,
  say the team/source can confirm suitable options. Do not look up products.
- Kaju Katli: confirmed in the runtime KB only as cashew/tree nuts. Dairy-free,
  Jain, and gluten-free status still needs label/source/team confirmation unless
  a current source says otherwise.
- For "Does Kaju Katli contain cashew or dairy?", answer from the confirmed KB:
  it contains cashew/tree nuts, while dairy status needs label/source/team
  confirmation. Do not call `shopify-api.search_products` for this basic
  allergen answer.
- Severe allergy, medical safety, pregnancy/health, or unclear label questions
  should route to team/source confirmation.
- For missing nutrition/ingredients, ask product and batch/order details only
  when needed.

### Discounts

- Do not quote a live code from memory.
- If the customer gives a code/cart issue, validate against current source/tool
  before saying why it did or did not apply.
- If asking generally for active offers, share only confirmed source facts.
- Discount plus delivery-window edge cases need both offer validity and delivery
  source facts.
- Do not explain general offer-window behavior unless the source confirms that
  exact code/offer rule.
- If the code/offer name is missing, ask for it or route to team/source
  confirmation. Do not say "most offers" or "usually checkout date applies".
  Never put both "order date" and "delivery date" in the customer reply. Also
  avoid paraphrases such as "locks in on..." or "whether the offer applies on
  ...". Keep the customer reply to this shape: ask for the discount code or
  offer name, then say the source/team can confirm whether it applies to the
  requested future delivery.
- For an "offer ends today but delivery next week" question without a code,
  ask for the discount code or offer name and say the exact terms need
  confirmation. Do not add any general order-date/delivery-date rules,
  including comparative phrases like "some apply..." or "others apply...".

## MCP Boundaries

- Use Shopify/source MCP for current product, variant, price, availability,
  delivery, and discount facts.
- Exception: dietary, allergen, ingredient, Jain, diabetic-friendly,
  sugar-free, or medical-suitability questions must not use
  `shopify-api.search_products`; catalogue matches are not a safety source.
- Use `shopify-api.validate_discount_code` when a specific discount code is
  involved. Pass the customer code in the `code` input field.
- Known source routes for live checks are `shopify-api.search_products`,
  `shopify-api.get_product`, and `shopify-api.validate_discount_code`.
- Do not use `shopify-api.search_products` for pincode, serviceability, or
  delivery ETA. It is catalogue lookup only.
- Do not call `mcp_list_tools` or any discovery/list-tools command from a
  customer chat. If the known source route is not available, route to team
  confirmation.
- Do not fan out across products if the customer named one product.
- Do not repeat `shopify-api.search_products` in the same customer turn. If the
  first catalogue lookup is not enough, route to team confirmation.
- If source data is missing or contradictory, state that the team/source must
  confirm rather than guessing.

## Handoff Brief

When routing to team, pass only facts already known:

- product and variant
- shelf-life/storage/travel concern
- pincode, city, desired date/time
- discount code and cart issue
- dietary/allergen concern and severity if volunteered
- batch/order details if post-purchase
- exact customer ask

## Reply Checks

- No medical assurance or clinical safety promise.
- No invented shelf life, discount, ETA, or product variant.
- No internal words such as MCP, skill, KB, source adapter, source tool, or flow
  log.
- Ask at most one useful missing detail unless a compact checklist is necessary.
