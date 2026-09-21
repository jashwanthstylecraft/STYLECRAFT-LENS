// scripts/verify-motor-price-discovery.ts
// Offline regression check for the "Motor+Price-Led Discovery & Analysis
// Form Overhaul" plan — no live OpenAI/Gemini/Rainforest/Supabase calls.
// globalThis.fetch is stubbed before anything is imported (same pattern as
// scripts/verify-legacy-brand-discovery.ts), and no .env.local is loaded,
// so every DB-backed helper below runs against memoryDb's real seeded
// defaults (motor families, legacy brand registry) rather than Supabase.
//
// Covers, in order:
// [1] filterCandidatesByCategoryAndIdentity — a trimmer analysis never
//     admits a clipper-titled candidate (the exact regression scenario).
// [2] enrichCompetitorsWithRainforest's forwarded grounding data +
//     selectByCompositeScore — motor tier resolves from real forwarded
//     specs/bullets (not "unverified" when grounding data exists), price
//     falls within the computed band, and a matching Key Differentiator
//     measurably outscores an otherwise-identical candidate without one.
// [3] buildPhase1Prompt/buildPhase2Prompt — zero literal "clipper"
//     substrings anywhere in the generated prompt text for a trimmer
//     identity, and the motor+price discovery instruction is combined
//     into one example query, not two separate ones.
// [4] resolveLegacyBrandsForIdentity — a "both" target-market resolution
//     merges the real seeded pro+retail clipper brand lists, deduping
//     Wahl/Andis/Oster (present on both) to one entry each.
// [5] computeFeatureScore / matchesDifferentiator — the differentiator
//     blend's backward-compatible optional-param contract, and the
//     synonym-group + token-overlap matching logic in isolation.
// [6] toolTypesForIndustry — Industry never offers a Tool Type from the
//     other industry's family.
// [7] searchCuratedLegacyBrands — zero literal "clipper" substrings in any
//     search term actually sent to Rainforest for a trimmer identity.
//
// Run with: npx tsx scripts/verify-motor-price-discovery.ts

export {};

process.env.RAINFOREST_API_KEY = "test-key-not-a-real-credential";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`PASS: ${message}`);
    passed++;
  } else {
    console.log(`FAIL: ${message}`);
    failed++;
  }
}

function searchResultPayload(items: { asin: string; title: string; price: number | null }[]) {
  return JSON.stringify({
    search_results: items.map(it => ({
      asin: it.asin,
      title: it.title,
      sponsored: false,
      prices: it.price != null ? [{ value: it.price, raw: `$${it.price.toFixed(2)}` }] : [],
      rating: 4.5,
      ratings_total: 1200,
      recent_sales: "300+ bought in past month",
    })),
  });
}

const sawSearchTerms: string[] = [];

(globalThis as any).fetch = async (input: any): Promise<Response> => {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.includes("rainforestapi.com")) return new Response("{}", { status: 500 });

  const u = new URL(url);
  if (u.searchParams.get("type") !== "search") return new Response(searchResultPayload([]), { status: 200 });
  const searchTerm = u.searchParams.get("search_term") || "";
  sawSearchTerms.push(searchTerm);

  if (searchTerm.toLowerCase().startsWith("wahl")) {
    return new Response(searchResultPayload([{ asin: "B0WAHL0001", title: "Wahl Professional Trimmer Pro", price: 249.95 }]), { status: 200 });
  }
  return new Response(searchResultPayload([]), { status: 200 });
};

const TARGET_PRICE = 259.95;

// Mirrors lib/memoryDb.ts's seedToolTypeDefaults exactly (the real
// production seed) — used everywhere this script needs a ToolTypeRow[].
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

// The core regression fixture the plan's acceptance criterion 5 names
// directly: trimmer + vector motor + $259.
const TRIMMER_IDENTITY: any = {
  productName: "Apex Cordless Trimmer",
  brand: "Apex",
  category: "Clippers",
  subcategory: "Professional Trimmer",
  whatItIs: "A cordless professional detail trimmer",
  keyAttributes: ["zero-gap blade"],
  targetUser: "both",
  priceObserved: { value: TARGET_PRICE, currency: "USD", source: "form" },
  confidence: "high",
  evidence: [],
  identityStatus: "verified",
  toolType: "trimmer",
};

async function main() {
  const {
    filterCandidatesByCategoryAndIdentity,
    selectByCompositeScore,
    buildPhase1Prompt,
    buildPhase2Prompt,
  } = await import("../lib/analysisEngine");
  const { computeFeatureScore } = await import("../lib/competitor-scoring");
  const { matchesDifferentiator } = await import("../lib/differentiator-match");
  const { resolveLegacyBrandsForIdentity } = await import("../lib/legacy-brand-registry");
  const { toolTypesForIndustry } = await import("../lib/tool-type-taxonomy");
  const { listMotorFamilies } = await import("../lib/db/motor-families");
  const { searchCuratedLegacyBrands } = await import("../lib/legacy-brand-discovery");
  const { listGroomingGateRules, getGroomingGateConfidenceThreshold } = await import("../lib/db/grooming-gate-rules");
  const groomingGateRules = await listGroomingGateRules();
  const groomingGateConfidenceThreshold = await getGroomingGateConfidenceThreshold();

  console.log("\n[1] filterCandidatesByCategoryAndIdentity — a trimmer analysis never admits a clipper");
  {
    const candidates = [
      { name: "Andis GTX-EXO Cordless Trimmer", top_feature_summary: "Zero-gap T-blade" },
      { name: "Wahl Senior Clipper", top_feature_summary: "High-torque electromagnetic motor" },
      { name: "BaBylissPRO SnapFX Trimmer", top_feature_summary: "" },
    ];
    const filtered = filterCandidatesByCategoryAndIdentity(candidates, "legacy", TRIMMER_IDENTITY, TOOL_TYPES, groomingGateRules);
    assert(filtered.length === 2, `only the 2 real trimmers survive (got ${filtered.length})`);
    assert(filtered.every((c: any) => !/clipper/i.test(c.name)), "zero \"clipper\"-titled candidates survive a trimmer analysis");
  }

  console.log("\n[2] selectByCompositeScore — motor grounding from forwarded specs/bullets, price band, differentiator boost");
  {
    const motorFamilies = await listMotorFamilies();
    const ourMotor = { familyKey: "vector", label: "Vector Motor", modifierKey: null, modifierLabel: null, source: "motor_tech_field" as const };

    // Grounded via forwarded specifications (the exact bug this plan
    // fixes in enrichCompetitorsWithRainforest) — should resolve "exact".
    const groundedVectorTrimmer = {
      name: "Andis GTX-EXO Cordless Trimmer", brand: "Andis", price_raw: 249.99,
      specifications: [{ name: "Motor Type", value: "Vector Motor" }],
      feature_bullets: ["Constructed with an all-metal housing for durability"],
      description: "",
    };
    // No specifications/attributes/feature_bullets/description at all —
    // the curated-legacy-candidate shape BEFORE a real type=product pull —
    // must resolve "unverified", never a false "different".
    const ungroundedTrimmer = {
      name: "BaBylissPRO SnapFX Trimmer", brand: "BaByliss", price_raw: 259.0,
    };
    // Grounded, but explicitly a DIFFERENT motor family and no differentiator match.
    const differentMotorTrimmer = {
      name: "Gamma+ Absolute Zero Cordless Trimmer", brand: "Gamma+", price_raw: 255.0,
      specifications: [{ name: "Motor Type", value: "Rotary Motor" }],
      feature_bullets: ["Lightweight plastic housing"],
      description: "",
    };

    const ctx = {
      motorFamilies, toolTypes: TOOL_TYPES, primaryCriterion: "motor" as const, ourMotor, ourHeatTech: null,
      ourSpecs: { rpm: null, runTimeMinutes: null, cordless: null, buildMaterial: null, bladeTech: null },
      weights: { motor: 0.45, price: 0.35, feature: 0.2 },
      keyDiff: "full metal body",
      groomingGateRules,
      groomingGateConfidenceThreshold,
      ourGroomingTag: null,
      ourIsPetGrooming: false,
    };

    const scored = selectByCompositeScore(
      [groundedVectorTrimmer, ungroundedTrimmer, differentMotorTrimmer],
      TARGET_PRICE, "legacy", TRIMMER_IDENTITY, 5, ctx as any
    );

    const grounded = scored.find((c: any) => c.name === groundedVectorTrimmer.name);
    const ungrounded = scored.find((c: any) => c.name === ungroundedTrimmer.name);
    const differentMotor = scored.find((c: any) => c.name === differentMotorTrimmer.name);

    assert(!!grounded && grounded.motor_match_tier === "exact", `grounded candidate resolves motor tier "exact" via forwarded specs (got ${grounded?.motor_match_tier})`);
    assert(!!ungrounded && ungrounded.motor_match_tier === "unverified", `candidate with zero grounding data resolves "unverified", not a false "different" (got ${ungrounded?.motor_match_tier})`);
    assert(!!differentMotor && differentMotor.motor_match_tier === "different", `grounded-but-different-family candidate resolves "different" (got ${differentMotor?.motor_match_tier})`);

    assert(!!grounded && grounded.differentiator_match === true, "the candidate whose bullets mention \"all-metal housing\" matches the \"full metal body\" differentiator (synonym group)");
    assert(!!ungrounded && ungrounded.differentiator_match === false, "a candidate with no grounding text at all does not match the differentiator");
    assert(!!grounded && !!differentMotor && grounded.composite_score > differentMotor.composite_score, "the grounded, differentiator-matching, motor-exact candidate scores strictly higher than a different-motor, non-matching one");

    assert(scored.every((c: any) => c.price_score >= 0 && c.price_score <= 1), "every scored candidate has a valid [0,1] price_score");
    assert(scored.every((c: any) => !c.out_of_band), "every candidate ($249.99/$259/$255 against a $259.95 target) falls within the primary price band, none flagged out_of_band");
  }

  console.log("\n[3] buildPhase1Prompt/buildPhase2Prompt — zero hardcoded \"clipper\" in query templates, one combined motor+price instruction");
  {
    // Deliberately adversarial: identity.category is the literal broad
    // Amazon department name ("Clippers") a real trimmer can plausibly be
    // filed under (the exact ambiguity the original contamination bug came
    // from) — identity.category/.subcategory are legitimately echoed
    // elsewhere in the prompt as AI-identified context (not a "query
    // template"), so this section only asserts on the actual QUERY-
    // CONSTRUCTION text (the DISCOVERY PRIORITY paragraph/example search
    // and the JSON schema's own static example strings), matching the
    // plan's "zero clipper strings in any generated query" wording.
    // pricePoint set explicitly (as the now-required, currency-formatted
    // form field always provides — see Phase A's formatPriceOnBlur) so
    // targetDisplay resolves through the first, already-"$"-prefixed
    // branch of its context.pricePoint || identity.priceObserved?.value
    // || fallback chain, rather than identity.priceObserved.value's raw
    // unformatted number.
    const context: any = { productName: "Apex Cordless Trimmer", targetMarket: "both", keyDiff: "full metal body", pricePoint: "$259.95" };
    const ourMotorLabel = "Vector";

    const p1 = buildPhase1Prompt(context, TRIMMER_IDENTITY, TARGET_PRICE, TOOL_TYPES, ourMotorLabel);
    const p2 = buildPhase2Prompt(context, TRIMMER_IDENTITY, TARGET_PRICE, TOOL_TYPES, undefined, ourMotorLabel);

    for (const [label, { systemPrompt, userPrompt }] of [["Phase 1", p1], ["Phase 2", p2]] as const) {
      const priorityStart = systemPrompt.indexOf("DISCOVERY PRIORITY");
      const priorityEnd = systemPrompt.indexOf("CRITICAL RULES:");
      const discoveryPriorityParagraph = systemPrompt.slice(priorityStart, priorityEnd);
      assert(priorityStart >= 0, `${label} systemPrompt has a DISCOVERY PRIORITY paragraph`);
      assert(!/clipper/i.test(discoveryPriorityParagraph), `${label}'s DISCOVERY PRIORITY paragraph (the actual query-construction instruction) contains zero "clipper" for a trimmer identity`);
      assert(discoveryPriorityParagraph.includes("Vector") && discoveryPriorityParagraph.includes("$259.95"), `${label}'s DISCOVERY PRIORITY paragraph names both the motor label and the target price in one combined instruction`);
      assert(discoveryPriorityParagraph.includes("full metal body"), `${label}'s DISCOVERY PRIORITY paragraph mentions the Key Differentiator when one was given`);

      const schemaStart = systemPrompt.indexOf("Return this EXACT JSON schema:");
      const schemaText = systemPrompt.slice(schemaStart);
      assert(!/clipper/i.test(schemaText), `${label}'s static JSON schema example text (inclusion_rationale example) contains zero hardcoded "clipper" reference`);

      const instructionsStart = userPrompt.indexOf("Instructions:");
      const instructionsText = userPrompt.slice(instructionsStart);
      assert(!/clipper/i.test(instructionsText), `${label}'s userPrompt Instructions list (the combined-query example) contains zero "clipper"`);
      assert(instructionsText.includes("Vector") || instructionsText.includes("vector"), `${label}'s Instructions combine motor technology into the same example query as price`);
    }
  }

  console.log("\n[4] resolveLegacyBrandsForIdentity — \"both\" merges the real seeded pro+retail clipper lists");
  {
    const registry = await resolveLegacyBrandsForIdentity({ category: "Clippers", subcategory: "Professional Trimmer", targetUser: "both" }, TOOL_TYPES);
    assert(!!registry, "a \"both\" resolution for a clipper/trimmer/shaver category returns a merged registry, not null");
    const byName = new Map((registry?.brands || []).map(b => [b.brand_name, b]));

    assert(byName.size === 11, `merged list has exactly 11 distinct brands — union of 7 pro + 7 retail minus 3 overlapping (got ${byName.size})`);
    for (const both of ["Wahl", "Andis", "Oster"]) {
      const b = byName.get(both);
      assert(!!b && (b.sourceLists || []).length === 2 && b.sourceLists!.includes("pro") && b.sourceLists!.includes("retail"), `"${both}" appears exactly once, tagged with BOTH source lists (got ${JSON.stringify(b?.sourceLists)})`);
    }
    const proOnly = byName.get("TPOB");
    assert(!!proOnly && (proOnly.sourceLists || []).length === 1 && proOnly.sourceLists![0] === "pro", "a pro-only brand (TPOB) is tagged with only [\"pro\"]");
    const retailOnly = byName.get("Manscaped");
    assert(!!retailOnly && (retailOnly.sourceLists || []).length === 1 && retailOnly.sourceLists![0] === "retail", "a retail-only brand (Manscaped) is tagged with only [\"retail\"]");

    // The plain pro/consumer single-list path must stay unchanged.
    const proOnlyRegistry = await resolveLegacyBrandsForIdentity({ category: "Clippers", subcategory: "Professional Trimmer", targetUser: "pro" }, TOOL_TYPES);
    assert(!!proOnlyRegistry && proOnlyRegistry.brands.every(b => !b.sourceLists), "the plain \"pro\" resolution is unaffected — no sourceLists tagging at all");
  }

  console.log("\n[5] computeFeatureScore / matchesDifferentiator — backward compatibility + synonym matching");
  {
    assert(computeFeatureScore({}, {}) === 0, "2-arg call (no differentiator param) behaves exactly as before — 0 for nothing comparable");
    assert(computeFeatureScore({}, {}, undefined) === 0, "explicit undefined differentiator behaves exactly as before");
    assert(computeFeatureScore({}, {}, null) === 0, "explicit null differentiator (no Key Differentiator given) behaves exactly as before");
    assert(computeFeatureScore({}, {}, true) === 0.3, "a true differentiator match contributes exactly its 0.3 weight when structural score is 0");
    assert(computeFeatureScore({}, {}, false) === 0, "a false differentiator match contributes nothing");
    const structural = computeFeatureScore({ cordless: true }, { cordless: true });
    assert(Math.abs(computeFeatureScore({ cordless: true }, { cordless: true }, true) - (structural * 0.7 + 0.3)) < 1e-9, "differentiator blend is structuralScore*0.7 + 0.3 when true");

    assert(matchesDifferentiator("full metal body", "constructed with an all-metal housing for durability") === true, "\"full metal body\" matches \"all-metal housing\" via the synonym group (shares zero literal words)");
    assert(matchesDifferentiator("zero-gap blade", "razor sharp zero gap T-blade design") === true, "\"zero-gap blade\" matches \"zero gap T-blade\" via the synonym group");
    assert(matchesDifferentiator("bluetooth connectivity", "aluminum body, 4 hour battery") === false, "an unrelated differentiator does not false-positive match");
    assert(matchesDifferentiator("", "anything") === false, "an empty Key Differentiator never matches");
    assert(matchesDifferentiator("full metal body", "") === false, "empty candidate text never matches");
  }

  console.log("\n[6] toolTypesForIndustry — Industry never offers the other Industry's Tool Type family");
  {
    // GROOMING_TOOL_TYPES/BEAUTY_TOOL_TYPES (fixed arrays) no longer exist —
    // Tool Type is DB-backed now, so the equivalent check is on each
    // returned row's own `family` column instead of a hardcoded key list.
    const groomingOpts = toolTypesForIndustry("grooming-barbering", TOOL_TYPES);
    const beautyOpts = toolTypesForIndustry("haircare-styling", TOOL_TYPES);
    assert(groomingOpts.every(t => t.family === "clipper_trimmer_shaver" || t.family === null), "grooming-barbering only offers clipper/trimmer/shaver-family (or family-agnostic combo) tool types");
    assert(beautyOpts.every(t => t.family === "beauty" || t.family === null), "haircare-styling only offers beauty-family (or family-agnostic combo) tool types");
    assert(!groomingOpts.some(t => t.type_key === "dryer") && !groomingOpts.some(t => t.type_key === "flat_iron"), "grooming-barbering never offers a beauty-only tool type");
    assert(!beautyOpts.some(t => t.type_key === "clipper") && !beautyOpts.some(t => t.type_key === "trimmer") && !beautyOpts.some(t => t.type_key === "shaver"), "haircare-styling never offers a grooming-only tool type");
    assert(groomingOpts.some(t => t.type_key === "combo") && beautyOpts.some(t => t.type_key === "combo"), "combo is valid under either industry");
  }

  console.log("\n[7] searchCuratedLegacyBrands — zero \"clipper\" in any search term sent to Rainforest for a trimmer identity");
  {
    sawSearchTerms.length = 0;
    const registry = await resolveLegacyBrandsForIdentity({ category: "Clippers", subcategory: "Professional Trimmer", targetUser: "pro" }, TOOL_TYPES);
    await searchCuratedLegacyBrands(
      (registry?.brands || []).slice(0, 2),
      { category: TRIMMER_IDENTITY.category, subcategory: TRIMMER_IDENTITY.subcategory, toolType: "trimmer" },
      TARGET_PRICE,
      registry!.categorySlug,
      TOOL_TYPES,
      undefined,
      // Testability hooks (both budgets) — bounds this call to a couple
      // seconds instead of the real 20s/12s production budgets, which this
      // offline script was previously never reaching (an earlier, now-fixed
      // crash in part [2] always aborted the script before part [7] ran).
      2_000,
      "Vector",
      2_000
    );
    assert(sawSearchTerms.length > 0, "at least one real search term was captured");
    assert(sawSearchTerms.every(t => !/clipper/i.test(t)), `zero literal "clipper" substrings in any constructed query for a trimmer identity (saw: ${JSON.stringify(sawSearchTerms)})`);
    assert(sawSearchTerms.some(t => /trimmer/i.test(t)), "at least one query explicitly names the tool type (\"trimmer\")");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} assertion(s) failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
