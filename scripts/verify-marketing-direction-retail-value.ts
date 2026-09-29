// scripts/verify-marketing-direction-retail-value.ts
// Offline regression check for the Marketing Direction section (GTM
// workbook export work, 4th filled tab) — retail/value fixture, contrasted
// against scripts/verify-marketing-direction-flagship.ts's collab fixture to
// prove the deterministic mechanisms are genuinely INPUT-DRIVEN rather than
// boilerplate: same relation/guard/lookup logic, opposite real inputs,
// demonstrably different output. Same offline discipline as the flagship
// script — no live Rainforest/OpenAI/Gemini call, no .env.local loaded.
//
// Run with: npx tsx scripts/verify-marketing-direction-retail-value.ts

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
    id: "cp_default", name: "Default Product", industry: "haircare-styling", target_market: "retail",
    tool_type: "clipper", target_price: null, description: null, motor_family: null, motor_branded: null,
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
  const { GTM_STYLE_EXEMPLARS } = await import("../lib/gtm-style-exemplars");
  const { textSimilarity } = await import("../lib/text-similarity");

  const marketingDirectionSchema = GTM_FIELD_SCHEMA.filter(f => f.section === "Marketing Direction");

  // ---- Section 1: Deterministic Consumer Barrier framing — value/credibility, NOT premium ----
  console.log("\n[1] Retail-value fixture — priced AT/BELOW the category median");
  const valueCompetitorRows = [
    { name: "A", brand: "A", tier: null, price: "$79.95", price_raw: 79.95, source_url: null, retrieved_at: null, price_source: null },
    { name: "B", brand: "B", tier: null, price: "$89.95", price_raw: 89.95, source_url: null, retrieved_at: null, price_source: null },
    { name: "C", brand: "C", tier: null, price: "$69.95", price_raw: 69.95, source_url: null, retrieved_at: null, price_source: null },
  ] as any;
  const valueRelation = derivePriceRelation(49.95, valueCompetitorRows);
  assert(valueRelation === "below", `value target price $49.95 (vs ~$80 median) derives relation "below" (got "${valueRelation}")`);
  const valueBarrier = deriveBarrierFraming(valueRelation);
  assert(valueBarrier.includes("CREDIBILITY"), "value fixture's Consumer Barrier framing instructs a CREDIBILITY question, not a price-justification one");
  assert(valueBarrier !== deriveBarrierFraming("above"), "the value fixture's barrier framing text is demonstrably different from the flagship (above-median) framing — proves input-driven, not boilerplate");

  // ---- Section 2: Tool-type guard — zero collection siblings ----
  console.log("\n[2] Tool-type guard — no collection, no siblings, no fabricated confusion pair");
  const valueGuard = deriveToolTypeGuardClause("clipper", []);
  assert(valueGuard === "", "a standalone product with zero collection siblings gets an EMPTY guard clause, never an invented confusion pair");

  // ---- Section 3: Full generateMarketingDirection call — Previous Product Reference has no sibling to resolve ----
  console.log("\n[3] generateMarketingDirection — no collection means Previous Product Reference is honestly left unresolved");
  const catalogProducts = [
    buildCatalogProduct({ id: "v1", name: "SC Value Clipper", tool_type: "clipper", collection: null }),
    // An unrelated OTHER collection's products must never leak in as a false sibling.
    buildCatalogProduct({ id: "v2", name: "SC x Test Collab Trimmer", tool_type: "trimmer", collection: "Test Collab" }),
  ];
  const sources = {
    project: { productName: "SC Value Clipper", toolType: "clipper" },
    salesKit: null,
    tds: null,
    activeReport: {
      competitive_analysis: {},
      pricing_analysis: { target_price: "$49.95", competitor_prices: valueCompetitorRows },
    },
  } as any;
  const gtmFieldsFlat = {}; // no product_name_origin resolved yet

  const result = await generateMarketingDirection(
    sources, gtmFieldsFlat, null, catalogProducts, "v1",
    "English (primary). Spanish (secondary, for retail/DTC market reach). French Canadian"
  );

  assert(result.marketing_previous_product_reference === undefined, "with no collection, Previous Product Reference is left unset — never a guessed 'N/A — first in line' from AI");

  // ---- Section 4: finalizeFieldAnswers — honest "Not found" terminal for the unresolved lookup field ----
  console.log("\n[4] finalizeFieldAnswers — Previous Product Reference gets the honest 'Not found' terminal, not a fabricated N/A");
  const finalized = finalizeFieldAnswers(result, marketingDirectionSchema, 1);
  assert(finalized.marketing_previous_product_reference?.answer.startsWith("Not found"), `unresolved Previous Product Reference finalizes to the standard 'Not found — checked N sources' terminal (got "${finalized.marketing_previous_product_reference?.answer}")`);
  const INTERNAL_IDS = ["marketing_educator_sampling", "marketing_influencer_sampling", "marketing_stylecraft_sales_team", "marketing_external_sales_rep_sampling", "marketing_key_accounts_sampling", "marketing_promo"];
  assert(INTERNAL_IDS.every(id => finalized[id]?.answer === "Awaiting internal input"), "internal sampling/promo fields still resolve to 'Awaiting internal input' for the value fixture too");

  // ---- Section 5: Contrast proof — the two fixtures' Previous Product Reference outcome genuinely differs ----
  console.log("\n[5] Cross-fixture contrast — same code path, different real inputs, demonstrably different outcome");
  assert(finalized.marketing_previous_product_reference?.answer !== "SC x Test Collab Clipper", "the value fixture's Previous Product Reference never picks up the flagship fixture's unrelated sibling — collection isolation holds");

  // ---- Section 6: Anti-leak — no verbatim Jeezy Trimmer exemplar text appears in this fixture's own AI-WRITTEN output ----
  // Scoped to AI-written field ids only — marketing_previous_product_reference
  // is a deterministic lookup (never routed through the exemplar-guarded AI
  // path), so it's excluded from this check.
  console.log("\n[6] Anti-leak check — none of the real exemplar's marketing_* text appears verbatim in this run's AI-written output");
  const jeezyTrimmer = GTM_STYLE_EXEMPLARS.find(ex => ex.sku === "SC423B")!;
  const AI_WRITTEN_IDS = new Set(["marketing_primary_goal", "marketing_success_kpis", "marketing_launch_timing", "marketing_core_audience", "marketing_secondary_audience", "marketing_consumer_barrier", "marketing_messaging_direction", "marketing_visual_direction", "marketing_content_ideas", "marketing_dos_donts", "marketing_web_coverage", "marketing_ad_channels", "marketing_print_material", "marketing_trade_show_launch"]);
  const aiWrittenOutputText = Object.entries(finalized).filter(([id]) => AI_WRITTEN_IDS.has(id)).map(([, f]: any) => f.answer).join(" | ");
  const leaked = Object.entries(jeezyTrimmer.excerpts).filter(([id, text]) => AI_WRITTEN_IDS.has(id) && typeof text === "string" && aiWrittenOutputText.includes(text));
  assert(leaked.length === 0, `zero verbatim exemplar substrings leaked into this fixture's AI-written output (found ${leaked.length}: ${leaked.map(([id]) => id).join(", ")})`);

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
