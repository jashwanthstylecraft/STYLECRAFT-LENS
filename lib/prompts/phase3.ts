import { getMarketData } from "@/lib/market-data";
import { buildOverviewParagraph, CompetitorSummary } from "@/lib/build-overview-paragraph";
import type { AnalysisContext } from "@/lib/analysisEngine";
import type { IdentityCard } from "@/lib/product-identification";
import { resolveBrandForProduct, getActiveVoiceGuide, buildVoiceBlock, getToneDirective } from "@/lib/brand-voice";

export async function buildPhase3Prompt(
  ctx: AnalysisContext,
  identity: IdentityCard,
  phase1: any,
  phase2: any,
  extraInstruction?: string
) {
  const marketData = getMarketData(identity.subcategory || identity.category, ctx.productName);

  // Build competitor list for price analysis
  const allCompetitors: CompetitorSummary[] = [
    ...(phase1?.competitors ?? []).map((c: any) => ({
      name: c.name,
      price: c.price ?? null,
      tier: "legacy" as const,
      asin: c.asin ?? null,
      nearest_match: c.nearest_match ?? false,
      nearest_match_reason: c.nearest_match_reason ?? null,
    })),
    ...(phase2?.competitors ?? []).map((c: any) => ({
      name: c.name,
      price: c.price ?? null,
      tier: "emerging" as const,
      asin: c.asin ?? null,
      nearest_match: c.nearest_match ?? false,
      nearest_match_reason: c.nearest_match_reason ?? null,
    })),
  ];

  // Generate the overview paragraph IN CODE — not by the AI model. When
  // marketData is null (no curated data for this category — see
  // lib/market-data.ts), buildOverviewParagraph renders the honest
  // "no verifiable public figure found" text instead of a number.
  const overviewParagraph = buildOverviewParagraph({
    productName: ctx.productName,
    motorTech: ctx.motorTech ?? "",
    pricePoint: ctx.pricePoint ?? "",
    targetMarket: ctx.targetMarket,
    category: identity.category,
    subcategory: identity.subcategory,
    toolType: identity.toolType,
    marketData,
    competitors: allCompetitors,
  });

  // Find price floor, ceiling, average from real data for context block —
  // nearest-match competitors are deliberately excluded from this
  // calculation: they were seated specifically because their price fell
  // outside the normal band, so including them would skew the floor/
  // ceiling the model is separately told to reason about (and to treat
  // those same entries as adjacent-market references, not direct rivals —
  // see ABSOLUTE RULE 8 below).
  const realPrices = allCompetitors
    .filter((c: any) => !c.nearest_match)
    .map((c: any) => parseFloat((c.price ?? "").replace(/[^0-9.]/g, "")))
    .filter((n: number) => !isNaN(n) && n > 0);

  const priceFloor = realPrices.length ? Math.min(...realPrices).toFixed(2) : "49.99";
  const priceCeiling = realPrices.length ? Math.max(...realPrices).toFixed(2) : "319.95";

  const primaryAttribute = identity.keyAttributes[0] || ctx.motorTech || identity.subcategory;

  const productSpecificBlock = `
PRODUCT BEING ANALYZED:
  Name: ${ctx.productName}
  Category: ${identity.category} / ${identity.subcategory}
  What it is: ${identity.whatItIs}
  Key attributes: ${identity.keyAttributes.join(", ") || "not specified"}
  Our price: ${ctx.pricePoint ?? identity.priceObserved?.value ?? "not specified"}
  Target: ${ctx.targetMarket}

REAL COMPETITOR PRICES FROM PHASE 1/2 RESEARCH (Amazon-sourced):
${allCompetitors.map((c: any) =>
  ` ${c.tier === "legacy" ? "LEGACY" : "EMERGING"} | ${c.name} | Price: ${c.price ?? "—"} | ASIN: ${c.asin ?? "N/A"}${c.nearest_match ? ` | NEAREST-MATCH (adjacent-market reference, not a direct competitor — ${c.nearest_match_reason || "no exact-fit candidate found"})` : ""}`
).join("\n")}

You have live Google Search available — use it to verify current market size, CAGR, and trend data for this category and price tier before writing the analysis.
`.trim();

  const marketDataInstruction = marketData
    ? `Pre-verified market data for this category is provided below in the template — use those exact figures, do not search for or invent different ones.`
    : `No pre-verified market data exists for this category. You MUST search the web for a real, current, citable market size figure. If you find one from a credible source, add it to "citations" with type "market_stat" and the exact URL + a short verbatim quote from the page. If you cannot find a reliable figure, leave "citations" without a market_stat entry — do NOT invent a number. Set every market_snapshot numeric field to null in that case; the app will render an honest "no verifiable public figure found" message instead of guessing.`;

  // Brand Voice Guide — Corporate register only (confident but polished,
  // no street slang, heritage OK per the tone spectrum) and strictly
  // subordinate to every ABSOLUTE RULE below: voice never loosens the
  // citation/no-invention discipline this prompt already enforces.
  const brand = await resolveBrandForProduct(ctx.productName);
  const voiceBlock = buildVoiceBlock(await getActiveVoiceGuide(brand));

  const systemText = `You are a market analyst. You MUST write analysis that is SPECIFIC to this exact product and its category (${identity.category} / ${identity.subcategory}) — never any other product category.

Do not narrate your search process or explain what you're doing between searches — search silently, then respond with ONLY the final JSON object. No preamble, no commentary.

ABSOLUTE RULES:
1. DO NOT change or rewrite the overview_paragraph provided in the template. Use it EXACTLY as provided.
2. ${marketDataInstruction}
3. Every trend MUST use a real data point — search for it if you don't already have a verified figure, and add it to "citations".
4. Threats MUST name specific competitors with their real prices (e.g. "BaBylissPRO at $149.99").
5. Opportunities MUST reference this product's specific price gap vs named competitors.
6. Every factual claim that isn't directly restating the competitor price data already provided above MUST have a matching entry in "citations" with a real URL and a short VERBATIM quote from that page — a quote you paraphrase or invent will fail server-side verification and be discarded. If you cannot find a citable source for a claim, omit the claim rather than stating it uncited.
7. Do not include analysis of any other product category. Do not reuse boilerplate from previous analyses — every claim must trace to the competitor data or category above.
8. Any competitor marked NEAREST-MATCH above was included only because no exact-fit competitor could be found — treat it as an adjacent-market reference point, never as a direct rival. Do not build a threat, positioning claim, or price-gap argument primarily around a nearest-match entry; prefer the non-nearest-match competitors for those. It's fine to mention one briefly for context (e.g. "the broader market includes X at $Y"), but never present it as if it directly competes on motor/plate-heat technology or market segment.
9. target_buyer_persona is a reasoned synthesis of who this specific product (not any competitor) is for, grounded in its category/price point/target market and the competitive landscape above — it is a judgment call like positioning_recommendation, not a factual claim, so it needs no citation. NEVER invent a specific fake individual: no real-sounding full name, no exact single age, no fabricated photo or likeness. Use a descriptive archetype label (e.g. "The Precision-Focused Barber") and an age RANGE, not a specific age. Keep it specific to ${identity.subcategory} at ${ctx.pricePoint ?? "the observed price point"} — never generic boilerplate that could apply to any product in this category. Its pain_points/objections/messaging_that_resonates fields must ground in the REAL competitor data provided above (named competitors, their real prices/gaps) the same way positioning_recommendation does — never a fabricated statistic or invented percentage (no "73% likely to buy"-style claims); these are qualitative judgment calls, not survey results.
${extraInstruction ? `\n${extraInstruction}\n` : ""}
Return ONLY valid JSON. No markdown.${voiceBlock}\n${getToneDirective("corporate")}
This voice/tone guidance NEVER overrides ABSOLUTE RULES 1-8 above — a claim still needs a real citation or it gets omitted, full stop.`;

  const userText = `${productSpecificBlock}

Return this exact JSON. The overview_paragraph is already written — copy it exactly:

{
  "web_searches_performed": 4,
  "amazon_category": "${identity.category} / ${identity.subcategory}",
  "data_sources_used": ["${marketData?.source ?? "Amazon product research (Phase 1/2)"}", "Amazon product research (Phase 1/2)", "Google Search grounding"],
  "market_snapshot": {
    "market_size_current": ${marketData ? `"${marketData.market_size_2026}"` : "null /* only fill if a market_stat citation backs it */"},
    "market_size_year": "2026",
    "market_size_forecast": ${marketData ? `"${marketData.market_size_forecast}"` : "null"},
    "forecast_year": ${marketData ? `"${marketData.forecast_year}"` : "null"},
    "cagr_percent": ${marketData ? `"${marketData.cagr}"` : "null"},
    "cagr_period": ${marketData ? `"${marketData.cagr_period}"` : "null"},
    "data_source": ${marketData ? `"${marketData.source}"` : "null"},
    "headline_stat_label": "${marketData ? "growth" : "unavailable"}",
    "headline_stat_value": ${marketData ? `"${marketData.market_size_2026} ${marketData.industry_label} snapshot (2026)"` : "null"},
    "overview_paragraph": "${overviewParagraph.replace(/"/g, '\\"')}"
  },
  "key_trends": [
    {
      "trend_name": "Name from search results or verified data",
      "description": "Description using a real data point. Include source in parentheses.",
      "source": "Source name"
    }
  ],
  "market_gaps": [
    "Gap that is SPECIFIC to ${primaryAttribute} and ${ctx.pricePoint ?? "the observed"} price point, within the ${identity.subcategory} category"
  ],
  "top_threats": [
    {
      "competitor_name": "Real name from competitor data above",
      "threat_description": "Must include their real price from the competitor data above"
    }
  ],
  "top_opportunities": [
    {
      "action": "Action specific to ${primaryAttribute} and ${ctx.pricePoint ?? "the observed price"}",
      "description": "Reference real competitor prices and the specific price gap"
    }
  ],
  "positioning_recommendation": "Must name competitors with their real prices. Must state the price gap. Must be specific to ${identity.subcategory} positioning and ${primaryAttribute}.",
  "target_buyer_persona": {
    "archetype_name": "Short descriptive label for who THIS product (${ctx.productName}) is for, e.g. 'The Precision-Focused Barber' — never a fake proper name",
    "quote": "A short first-person line capturing their core want, grounded in this product's real differentiator (${primaryAttribute}) and price point",
    "age_range": "An age range, e.g. '28-45' — never a single specific age",
    "household_income": "An income range reasoned from the ${ctx.pricePoint ?? "observed"} price point and ${ctx.targetMarket} target market — not invented precision",
    "life_stage": "e.g. 'Working professional, building a client base' — grounded in ${ctx.targetMarket}",
    "shopping_style": "How this buyer researches/shops for ${identity.subcategory} products",
    "lifestyle_and_personality": "2-3 sentences: what they value, how ${ctx.productName} fits their routine/identity. Specific to this product, not generic category boilerplate.",
    "pain_points": "1-2 sentences on what frustrates this buyer about their current/alternative options — ground in a real named competitor's gap from the data above, not a generic complaint",
    "objections": "The 1-2 most likely hesitations or doubts before buying ${ctx.productName}, grounded in its real price point and category",
    "purchase_triggers": "What specifically would move this buyer to purchase NOW — a feature, price point, warranty, proof point grounded in ${ctx.productName}'s real differentiator (${primaryAttribute})",
    "messaging_that_resonates": "1-2 short claims/phrases that would land with this buyer, grounded in ${ctx.productName}'s real differentiator vs the named competitors above — never a fabricated statistic or percentage",
    "preferred_channels": "Where this buyer actually discovers and buys ${identity.subcategory} products (e.g. pro-supply retailers, trade shows, Amazon, distributor reps) — grounded in ${ctx.targetMarket}"
  },
  "strategic_recommendations": [
    {
      "priority": "high",
      "category": "product",
      "headline": "Specific to ${primaryAttribute} in the ${identity.subcategory} category",
      "explanation": "Reference real competitors and their prices"
    }
  ],
  "quick_wins": [
    "Reference specific competitor ASIN and name from the data provided"
  ],
  "citations": [
    {
      "text": "The specific factual claim this citation backs (e.g. the market size figure, or a trend's data point)",
      "type": "market_stat",
      "sources": [
        { "url": "https://real-source-url", "title": "Page title", "publisher": "Publisher/site name", "quote": "Short VERBATIM fragment actually on that page" }
      ]
    }
  ]
}`;

  return {
    system: systemText,
    systemPrompt: systemText,
    userMessage: userText,
    userPrompt: userText
  };
}
