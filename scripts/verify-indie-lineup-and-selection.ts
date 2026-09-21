// scripts/verify-indie-lineup-and-selection.ts
// Offline regression check for lib/indie-brand-lineup.ts (stubbed Rainforest
// type=search, same pattern as scripts/verify-legacy-brand-discovery.ts) and
// an end-to-end synthetic selection scenario proving the core acceptance
// criterion: a motor-matched-but-further-priced candidate outranks a
// motor-mismatched-but-closer-priced one. Zero real API credits spent.
//
// Run with: npx tsx scripts/verify-indie-lineup-and-selection.ts

export {};

process.env.RAINFOREST_API_KEY = "test-key-not-a-real-credential";

let failures = 0;
let passes = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passes++;
    console.log(`  PASS: ${message}`);
  } else {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

type Scenario = "lineup" | "slow";
let scenario: Scenario = "lineup";

function searchResultPayload(items: { asin: string; title: string; price: number }[]) {
  return JSON.stringify({
    search_results: items.map(it => ({
      asin: it.asin, title: it.title, sponsored: false,
      prices: [{ value: it.price, raw: `$${it.price.toFixed(2)}` }],
      rating: 4.3, ratings_total: 500, recent_sales: "100+ bought in past month",
    })),
  });
}

(globalThis as any).fetch = async (input: any): Promise<Response> => {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.includes("rainforestapi.com")) return new Response("{}", { status: 500 });
  const u = new URL(url);
  if (u.searchParams.get("type") !== "search") return new Response("{}", { status: 500 });

  if (scenario === "slow") {
    await new Promise(r => setTimeout(r, 50));
    return new Response(searchResultPayload([]), { status: 200 });
  }

  const term = u.searchParams.get("search_term") || "";
  if (term.startsWith("Skorch")) {
    return new Response(searchResultPayload([
      { asin: "B0SKORCH01", title: "Skorch Ember Entry Trimmer", price: 49 },
      { asin: "B0SKORCH02", title: "Skorch Ember Mid Trimmer", price: 129 },
      { asin: "B0SKORCH03", title: "Skorch Ember Pro Flagship Trimmer", price: 219 },
    ]), { status: 200 });
  }
  return new Response(searchResultPayload([]), { status: 200 });
};

function makeFamily(overrides: any): any {
  return { id: `mfam_${overrides.family_key}`, domain: "clipper_trimmer_shaver", aliases: [], modifier: false, adjacent_families: [], enabled: true, sort_order: 0, ...overrides };
}
const FAMILIES = [
  makeFamily({ family_key: "rotary", label: "Rotary Motor", aliases: ["rotary", "rotary motor"], sort_order: 0 }),
  makeFamily({ family_key: "vector", label: "Vector Motor", aliases: ["vector", "in3", "electromagnetic vector"], sort_order: 1 }),
];

// Mirrors lib/memoryDb.ts's seedToolTypeDefaults exactly (the real
// production seed) — this script's own identity fixture has no toolType set,
// so nothing here actually exercises tool-type filtering, but
// CompositeScoringContext now requires the field regardless.
function makeToolTypesFixture(): any[] {
  const now = new Date().toISOString();
  const defs: { key: string; label: string; aliases: string[]; family: string | null; primaryCriterion: "motor" | "heat_technology" | "none" }[] = [
    { key: "trimmer", label: "Trimmer", aliases: ["trimmer", "beard trimmer", "detailer", "outliner", "liner", "edger"], family: "clipper_trimmer_shaver", primaryCriterion: "motor" },
    { key: "shaver", label: "Shaver", aliases: ["shaver", "foil shaver", "rotary shaver", "electric shaver", "razor"], family: "clipper_trimmer_shaver", primaryCriterion: "motor" },
    { key: "dryer", label: "Hair Dryer", aliases: ["dryer", "blow dryer", "diffuser"], family: "beauty", primaryCriterion: "motor" },
    { key: "flat_iron", label: "Flat Iron", aliases: ["flat iron", "straightener", "hair iron"], family: "beauty", primaryCriterion: "heat_technology" },
    { key: "curling_iron", label: "Curling Iron", aliases: ["curling iron", "curling wand", "curler", "wand"], family: "beauty", primaryCriterion: "heat_technology" },
    { key: "hot_brush", label: "Hot Brush", aliases: ["hot brush", "styling brush", "heated brush"], family: "beauty", primaryCriterion: "heat_technology" },
    { key: "clipper", label: "Clipper", aliases: ["clipper"], family: "clipper_trimmer_shaver", primaryCriterion: "motor" },
    { key: "other_styling", label: "Other Styling Tool", aliases: [], family: "beauty", primaryCriterion: "none" },
    { key: "combo", label: "Combo / Multi-Tool Kit", aliases: [], family: null, primaryCriterion: "none" },
  ];
  return defs.map((d, i) => ({
    id: `ttype_${d.key}`, type_key: d.key, label: d.label, aliases: d.aliases, family: d.family,
    primary_criterion: d.primaryCriterion,
    enabled: true, custom: false, sort_order: i, created_at: now, updated_at: now,
  }));
}
const TOOL_TYPES = makeToolTypesFixture();

function makeIdentity(): any {
  return {
    productName: "Test Trimmer", brand: null, category: "Trimmers", subcategory: "Professional Trimmer",
    whatItIs: "trimmer", keyAttributes: [], targetUser: "pro", priceObserved: null,
    confidence: "high", evidence: [], identityStatus: "verified",
  };
}

async function main() {
  const { buildIndieBrandLineups, computePercentileInLineup, INDIE_LINEUP_TIME_BUDGET_MS } = await import("../lib/indie-brand-lineup");
  const { selectByCompositeScore } = await import("../lib/analysisEngine");
  const { listGroomingGateRules, getGroomingGateConfidenceThreshold } = await import("../lib/db/grooming-gate-rules");

  console.log("\n[1] buildIndieBrandLineups + computePercentileInLineup — real lineup, real percentile");
  scenario = "lineup";
  const lineups = await buildIndieBrandLineups([{ brand: "Skorch", subcategory: "Professional Trimmer" }]);
  const skorchLineup = lineups.get("Skorch") || [];
  assert(skorchLineup.length === 3, `Skorch's lineup has all 3 real products found (got ${skorchLineup.length})`);

  const flagshipPercentile = computePercentileInLineup(219, skorchLineup);
  const entryPercentile = computePercentileInLineup(49, skorchLineup);
  assert(flagshipPercentile === 1, `the $219 model is Skorch's own flagship (percentile 1, got ${flagshipPercentile})`);
  assert(entryPercentile === 0, `the $49 model is Skorch's own entry model (percentile 0, got ${entryPercentile})`);

  const singleItemLineup = [{ asin: "X", title: "Solo", price_raw: 75 }];
  assert(computePercentileInLineup(75, singleItemLineup) === 1, "a single-item lineup has nothing to rank against — treated as its own full range, not a guessed midpoint");
  assert(computePercentileInLineup(50, []) === null, "an empty lineup returns null (never a fabricated percentile)");

  console.log("\n[2] buildIndieBrandLineups — time-budget cutoff never blocks, returns empty for skipped brands");
  scenario = "slow";
  const startBeforeCutoffTest = Date.now();
  const cutoffLineups = await buildIndieBrandLineups([
    { brand: "SlowBrandA", subcategory: "Trimmer" },
    { brand: "SlowBrandB", subcategory: "Trimmer" },
    { brand: "SlowBrandC", subcategory: "Trimmer" },
  ]);
  const elapsed = Date.now() - startBeforeCutoffTest;
  assert(elapsed < INDIE_LINEUP_TIME_BUDGET_MS + 2000, `the whole batch respects roughly the shared time budget (took ${elapsed}ms, budget ${INDIE_LINEUP_TIME_BUDGET_MS}ms)`);
  assert(Array.from(cutoffLineups.values()).every(l => Array.isArray(l)), "every brand (searched or skipped) gets a real array back, never undefined");

  console.log("\n[3] selectByCompositeScore — motor match outranks a closer price (the core acceptance criterion)");
  const identity = makeIdentity();
  const ourMotor = { familyKey: "rotary", label: "Rotary", modifierKey: null, modifierLabel: null, source: "motor_tech_field" as const };
  const ctx = {
    motorFamilies: FAMILIES,
    toolTypes: TOOL_TYPES,
    primaryCriterion: "motor" as const,
    ourMotor,
    ourHeatTech: null,
    ourSpecs: { rpm: null, runTimeMinutes: null, cordless: null, buildMaterial: null, bladeTech: null },
    weights: { motor: 0.45, price: 0.35, feature: 0.2 },
    // CompositeScoringContext also requires the grooming-gate fields now —
    // the real seeded default rules (same ones production/memoryDb starts
    // with), not an empty array: an empty rules list makes 1B's
    // required_keyword check always fail (nothing to match), rejecting
    // every candidate outright rather than "passing everything through".
    groomingGateRules: await listGroomingGateRules(),
    groomingGateConfidenceThreshold: await getGroomingGateConfidenceThreshold(),
    ourGroomingTag: null,
    ourIsPetGrooming: false,
  };

  const motorMatchFurtherPrice = {
    name: "MotorMatch Precision Trimmer", brand: "MotorMatch Co", asin: "B0MOTORMATCH",
    amazon_url: "https://www.amazon.com/dp/B0MOTORMATCH", price: "$280.00", price_raw: 280,
    rating: "4.5", review_count: "500", monthly_sales: null, bsr_rank: null, initials: "MM",
    key_features: [], strengths: [], weaknesses: [], recent_news: [], top_feature_summary: "",
    // Includes a structural noun ("blade") alongside the motor mention —
    // the grooming gate's post-enrichment 1F check requires real
    // blade/guard/foil/barrel/plate/comb evidence whenever motor evidence
    // is present, to distinguish a finished grooming tool from a bare
    // motor/component listing.
    feature_bullets: ["Powered by a rotary motor for precision cuts with a stainless steel blade."], specifications: [], description: null,
  };
  const priceMatchWrongMotor = {
    name: "CloseButWrong Trimmer", brand: "CloseButWrong Co", asin: "B0CLOSEBUT01",
    amazon_url: "https://www.amazon.com/dp/B0CLOSEBUT01", price: "$262.00", price_raw: 262,
    rating: "4.2", review_count: "300", monthly_sales: null, bsr_rank: null, initials: "CB",
    key_features: [], strengths: [], weaknesses: [], recent_news: [], top_feature_summary: "",
    feature_bullets: ["Equipped with a magnetic motor system and adjustable guard comb."], specifications: [], description: null,
  };

  const targetPrice = 260;
  const selected = selectByCompositeScore([motorMatchFurtherPrice, priceMatchWrongMotor], targetPrice, "legacy", identity, 1, ctx as any);
  assert(selected.length === 1, `exactly 1 result for limit=1 (got ${selected.length})`);
  assert(selected[0]?.brand === "MotorMatch Co", `the motor-matched candidate wins despite being $20 further from target than the $2-away wrong-motor candidate (got "${selected[0]?.brand}")`);
  assert(selected[0]?.motor_match_tier === "exact", `the winner's motor_match_tier is "exact" (got "${selected[0]?.motor_match_tier}")`);
  assert(typeof selected[0]?.composite_score === "number" && selected[0].composite_score > 0.7, `the winner's composite score reflects the motor-dominant weighting (got ${selected[0]?.composite_score})`);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
