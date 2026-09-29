// scripts/verify-marketing-direction-flagship.ts
// Offline regression check for the Marketing Direction section (GTM
// workbook export work, 4th filled tab) — flagship/collab fixture. No live
// Rainforest/OpenAI/Gemini call, no .env.local loaded: isSupabaseConfigured
// resolves false and hasOpenAIKey/hasGeminiKey both resolve false, so
// callAiForJson always returns null (see lib/ai-json-call.ts) and every
// AI-written Marketing Direction field comes back absent rather than
// fabricated — same "gracefully returns nothing rather than inventing
// content" discipline scripts/verify-gtm-workbook-export.ts's FAQ section
// already established. What CAN be exercised offline — and is exercised
// here — is every deterministic mechanism around the AI call: price-relation
// framing, the tool-type-confusion guard, Previous Product Reference
// resolution, and the exemplar anti-copy similarity check against the real
// Jeezy Trimmer excerpts.
//
// Run with: npx tsx scripts/verify-marketing-direction-flagship.ts

export {};

let passes = 0;
let failures = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passes++;
    console.log(`  PASS: ${message}`);
  } else {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

function buildCatalogProduct(overrides: Partial<Record<string, any>>) {
  const now = new Date().toISOString();
  return {
    id: "cp_default", name: "Default Product", industry: "haircare-styling", target_market: "pro",
    tool_type: "trimmer", target_price: null, description: null, motor_family: null, motor_branded: null,
    heat_tech_family: null, heat_tech_branded: null, active: true, import_flags: [], source: "seed",
    brand: "StyleCraft", sku: null, product_kind: "tool", parent_sku: null, collection: null, upc: null,
    created_at: now, updated_at: now,
    ...overrides,
  } as any;
}

async function main() {
  const { generateMarketingDirection, deriveBarrierFraming, deriveToolTypeGuardClause } = await import("../lib/gtm-marketing-direction");
  const { derivePriceRelation } = await import("../lib/pricing-analysis");
  const { finalizeFieldAnswers } = await import("../lib/field-finalize");
  const { GTM_FIELD_SCHEMA } = await import("../lib/gtm-field-schema");
  const { GTM_STYLE_EXEMPLARS, renderStyleExemplarBlock } = await import("../lib/gtm-style-exemplars");
  const { textSimilarity } = await import("../lib/text-similarity");

  const marketingDirectionSchema = GTM_FIELD_SCHEMA.filter(f => f.section === "Marketing Direction");

  // ---- Section 1: Deterministic Consumer Barrier framing — premium/price-justification ----
  console.log("\n[1] Flagship fixture — priced ABOVE the category median");
  const flagshipCompetitorRows = [
    { name: "A", brand: "A", tier: null, price: "$99.95", price_raw: 99.95, source_url: null, retrieved_at: null, price_source: null },
    { name: "B", brand: "B", tier: null, price: "$109.95", price_raw: 109.95, source_url: null, retrieved_at: null, price_source: null },
    { name: "C", brand: "C", tier: null, price: "$119.95", price_raw: 119.95, source_url: null, retrieved_at: null, price_source: null },
  ] as any;
  const flagshipRelation = derivePriceRelation(259.95, flagshipCompetitorRows);
  assert(flagshipRelation === "above", `flagship target price $259.95 (vs ~$110 median) derives relation "above" (got "${flagshipRelation}")`);
  const flagshipBarrier = deriveBarrierFraming(flagshipRelation);
  assert(flagshipBarrier.includes("PRICE-JUSTIFICATION"), "flagship's Consumer Barrier framing instructs a PRICE-JUSTIFICATION question, not a credibility one");

  // ---- Section 2: Tool-type-confusion guard — real collection sibling ----
  console.log("\n[2] Tool-type guard — generalized from a real collection sibling, not the hardcoded 'clipper vs trimmer'");
  const flagshipGuard = deriveToolTypeGuardClause("trimmer", ["clipper"]);
  assert(flagshipGuard.includes("trimmer") && flagshipGuard.includes("clipper"), "the guard clause names both this product's own tool type and its real sibling's tool type");
  assert(deriveToolTypeGuardClause("trimmer", []) === "", "zero siblings produces an EMPTY guard clause — never a fabricated confusion pair");

  // ---- Section 3: Full generateMarketingDirection call — deterministic fields only (no AI key present) ----
  console.log("\n[3] generateMarketingDirection — Previous Product Reference resolves without any AI call");
  const catalogProducts = [
    buildCatalogProduct({ id: "p1", name: "SC x Test Collab Trimmer", tool_type: "trimmer", collection: "Test Collab" }),
    buildCatalogProduct({ id: "p2", name: "SC x Test Collab Clipper", tool_type: "clipper", collection: "Test Collab" }),
  ];
  const sources = {
    project: { productName: "SC x Test Collab Trimmer", toolType: "trimmer" },
    salesKit: null,
    tds: null,
    activeReport: {
      competitive_analysis: {},
      pricing_analysis: { target_price: "$259.95", competitor_prices: flagshipCompetitorRows },
    },
  } as any;
  const gtmFieldsFlat = {};

  const result = await generateMarketingDirection(
    sources, gtmFieldsFlat, "Test Collab", catalogProducts, "p1",
    "English (primary). Spanish (secondary, for retail/DTC market reach). French Canadian"
  );

  assert(result.marketing_previous_product_reference?.answer === "SC x Test Collab Clipper", `Previous Product Reference auto-resolves to the one real collection sibling (got "${result.marketing_previous_product_reference?.answer}")`);
  assert(result.marketing_previous_product_reference?.source === "derived", "Previous Product Reference is sourced as a real lookup, never an AI guess");

  const WRITTEN_IDS = ["marketing_primary_goal", "marketing_success_kpis", "marketing_launch_timing", "marketing_core_audience", "marketing_secondary_audience", "marketing_consumer_barrier", "marketing_messaging_direction", "marketing_visual_direction", "marketing_content_ideas", "marketing_dos_donts", "marketing_web_coverage", "marketing_ad_channels", "marketing_print_material", "marketing_trade_show_launch"];
  assert(WRITTEN_IDS.every(id => result[id] === undefined), "with no OpenAI/Gemini key configured, every AI-written field comes back absent rather than fabricated (matches the Product FAQ phase's own established discipline)");

  // ---- Section 4: finalizeFieldAnswers — internal fields never invented, honest terminals ----
  console.log("\n[4] finalizeFieldAnswers — the 6 sampling/promo fields always end at 'Awaiting internal input'");
  const finalized = finalizeFieldAnswers(result, marketingDirectionSchema, 1);
  const INTERNAL_IDS = ["marketing_educator_sampling", "marketing_influencer_sampling", "marketing_stylecraft_sales_team", "marketing_external_sales_rep_sampling", "marketing_key_accounts_sampling", "marketing_promo"];
  assert(INTERNAL_IDS.every(id => finalized[id]?.answer === "Awaiting internal input"), "all 6 internal sampling/promo fields resolve to 'Awaiting internal input' — a numeric count is never invented");
  assert(finalized.marketing_previous_product_reference?.answer === "SC x Test Collab Clipper", "the real sibling answer survives finalization untouched");

  // ---- Section 5: Exemplar anti-copy similarity — real Jeezy Trimmer text vs. a lightly-reworded near-copy ----
  console.log("\n[5] textSimilarity vs. the real Marketing Direction exemplar excerpts — the anti-copy check's own comparison basis");
  const jeezyTrimmer = GTM_STYLE_EXEMPLARS.find(ex => ex.sku === "SC423B")!;
  const exemplarWebCoverage = jeezyTrimmer.excerpts.marketing_web_coverage!;
  assert(!!exemplarWebCoverage, "the Jeezy Trimmer exemplar carries a real marketing_web_coverage excerpt");
  const lightlyReworded = exemplarWebCoverage.replace("Full PDP refresh", "Complete PDP refresh").replace("product family page", "product line page");
  assert(textSimilarity(lightlyReworded, exemplarWebCoverage) > 0.8, "a lightly-reworded near-copy of the real exemplar still scores above the 0.8 anti-copy threshold");
  const genuinelyDistinct = "Refresh the DTC PDP for SC901X and cross-list it under the Value Line category page; no other collection or family page exists for this standalone product.";
  assert(textSimilarity(genuinelyDistinct, exemplarWebCoverage) < 0.8, "genuinely distinct copy for a different product scores below the anti-copy threshold");

  const styleBlock = renderStyleExemplarBlock(["marketing_web_coverage", "marketing_content_ideas"]);
  assert(styleBlock.includes("SC423B"), "requesting a field the exemplar DOES have (marketing_web_coverage) attaches the real Jeezy Trimmer corpus");
  assert(!styleBlock.includes("marketing_content_ideas:"), "marketing_content_ideas was deliberately omitted from the exemplar (only a mid-sentence fragment existed) — never rendered, never fabricated");

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
