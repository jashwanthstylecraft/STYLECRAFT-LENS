// scripts/verify-gtm-schema-v2.ts
// Offline regression check for GTM Schema v2 (6 field changes to the
// Product Knowledge sheet). Pure-function/data-only — no live Rainforest/
// OpenAI/Gemini/Supabase call, no .env.local loaded. Since no API keys are
// set here, hasOpenAIKey/hasGeminiKey are both false, so any AI-backed path
// this touches (Change 3's competitor top-up, Change 4's Expert Tip
// generation) would gracefully no-op rather than reach the network — this
// script exercises the DETERMINISTIC floor of each deriver directly instead
// of the AI top-up, which is exactly the part that's actually testable
// offline. Covers the spec's 3 required tests: (1) Anime Trimmer fixture,
// (2) manufacturer ambiguity, (3) migration planning.
//
// Run with: npx tsx scripts/verify-gtm-schema-v2.ts

export {};

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

async function main() {
  const { GTM_FIELD_SCHEMA } = await import("../lib/gtm-field-schema");
  const {
    deriveGoodBetterBestLineup,
    deriveGoodBetterBestPerformance,
    deriveManufacturer,
    deriveComparisonChartSuggestion,
  } = await import("../lib/gtm-tier6-inference");
  const { deriveFeaturesFullListDeterministic, isGroundedInFeatures } = await import("../lib/gtm-features-and-tip");
  const { planFieldMigration } = await import("../lib/gtm-schema-v2-migration");

  // ---- Section 1: schema shape — renamed/removed/added fields ----
  console.log("\n[1] GTM_FIELD_SCHEMA shape");
  const byId = new Map(GTM_FIELD_SCHEMA.map(f => [f.id, f]));
  // Field count is asserted precisely in scripts/verify-gtm-schema-v3.ts
  // instead of hardcoded here — GTM Schema v3 changed the total again
  // (repeatable-row groups), so a literal count in this older script would
  // just go stale every time the schema evolves further.
  assert(byId.get("good_better_best")?.question === "Good Better Best (Lineup)", "good_better_best renamed to 'Good Better Best (Lineup)'");
  assert(!byId.has("performance"), "old 'performance' field is gone");
  assert(!byId.has("comps"), "old 'comps' field is gone");
  // comps_buying_guide was removed by GTM Schema v2 (this task) but revived
  // by GTM Schema v3 as a fresh plain link/text field — no longer asserted
  // gone here; see verify-gtm-schema-v3.ts for its current, correct shape.
  assert(byId.get("good_better_best_performance")?.question === "Good Better Best (Performance)", "new good_better_best_performance field exists with the right question");
  const chart = byId.get("comparison_chart_web_only");
  assert(!!chart, "new comparison_chart_web_only field exists");
  assert(
    chart?.helperText === "Select two products to feature as comparisons on the DTC site and provide the SKUs. You may include products from either StyleCraft or Gamma+.",
    "comparison_chart_web_only's helperText matches the exact quoted spec text"
  );
  assert(chart?.uiControl === "sku_picker", "comparison_chart_web_only is marked for the sku_picker UI control");
  assert(byId.has("manufacturer"), "manufacturer field id is unchanged");

  // ---- Section 2: Anime Trimmer fixture (real catalog seed data) ----
  console.log("\n[2] Anime Trimmer fixture — Lineup / Performance / Features / Expert Tip grounding / Comparison Chart / Manufacturer");

  // Same 2 real rows as lib/memoryDb.ts's seedCatalogProductDefaults, plus a
  // synthetic 3rd StyleCraft trimmer and one synthetic Gamma+ trimmer (the
  // catalog has zero real Gamma+ data today — see the plan's own scope
  // note) so the cross-brand Comparison Chart path is actually exercised.
  const catalogRows = [
    { name: "Anime Trimmer", brand: "StyleCraft", sku: null, tool_type: "trimmer", target_price: 199.95, motor_family: "brushless", active: true },
    { name: "Rogue Trimmer", brand: "StyleCraft", sku: "SC-1001", tool_type: "trimmer", target_price: 149.95, motor_family: "brushless", active: true },
    { name: "Instinct Trimmer", brand: "StyleCraft", sku: "SC-1002", tool_type: "trimmer", target_price: 259.95, motor_family: "brushless", active: true },
    { name: "Absolute Trimmer", brand: "Gamma+", sku: "GP-2001", tool_type: "trimmer", target_price: 179.95, motor_family: "brushless", active: true },
  ];

  const lineup = deriveGoodBetterBestLineup(
    "trimmer",
    199.95,
    catalogRows.map(r => ({ tool_type: r.tool_type, target_price: r.target_price, active: r.active })),
    "Trimmer"
  );
  assert(!!lineup && ["Good", "Better", "Best"].includes(lineup.answer), "Lineup derives a real Good/Better/Best tier from catalog prices");
  assert(!!lineup?.sourceDetail?.label?.startsWith("Derived from catalog lineup ("), "Lineup's citation names its catalog basis");

  const competitors = [
    { motor_type: "6,800rpm brushless motor", specifications: [{ name: "RPM", value: "6,800" }], feature_bullets: ["cordless design"] },
    { motor_type: "6,200rpm rotary motor", specifications: [{ name: "RPM", value: "6,200" }], feature_bullets: [] },
    { motor_type: "7,000rpm brushless motor", specifications: [{ name: "RPM", value: "7,000" }], feature_bullets: [] },
  ];
  const performance = deriveGoodBetterBestPerformance(7800, "Brushless Motor (EON Digital Brushless)", competitors);
  assert(performance?.answer === "Elite", "Performance ranks our 7,800rpm above all 3 competitors as Elite (Standard/Premium/Elite, not Good/Better/Best)");
  assert(
    !!performance?.sourceDetail?.label?.includes("7800rpm") && !!performance?.sourceDetail?.label?.includes("vs competitor median"),
    `Performance's citation names our RPM and the competitor median (got: ${performance?.sourceDetail?.label})`
  );

  const anime = catalogRows[0];
  const tds = {
    motor_type: "EON Digital Brushless Motor",
    motor_rpm: "7,800rpm",
    blade_name: "X-Pro wide DLC blade",
  };
  const featureBullets = deriveFeaturesFullListDeterministic(
    "EON Digital brushless motor up to 7,800rpm, X-Pro wide DLC blade with \"The One\" cutter, ergonomic lightweight design",
    tds
  );
  assert(featureBullets.length >= 3, `Features deterministic floor produces multiple bullets (got ${featureBullets.length})`);
  assert(featureBullets.some(b => b.source === "input"), "Features includes at least one [Input]-tagged bullet from the catalog description");
  assert(featureBullets.some(b => b.source === "our_listing"), "Features includes at least one [Our listing]-tagged bullet from TDS specs");
  assert(featureBullets.every(b => b.source !== "unconfirmed"), "the deterministic floor alone never produces an [Unconfirmed] line (that only comes from the AI top-up)");

  // Catalog-record description merge — a project whose own free-text
  // Description is blank/sparse still gets real [Input] bullets from the
  // matched catalog record's own description (lib/catalog-import.ts can
  // populate that straight from a spreadsheet's "Features & Benefits"
  // column), rather than falling through with zero input bullets.
  const catalogOnlyBullets = deriveFeaturesFullListDeterministic(
    "",
    tds,
    "Titanium DLC blade, whisper-quiet operation, 4-hour cordless runtime"
  );
  assert(catalogOnlyBullets.some(b => b.source === "input" && b.text.includes("Titanium DLC blade")), "a blank project Description still yields [Input] bullets sourced from the catalog record's own description");

  const mergedNoDupe = deriveFeaturesFullListDeterministic(
    "Titanium DLC blade, ergonomic grip",
    tds,
    "Titanium DLC blade, whisper-quiet operation"
  );
  const titaniumMentions = mergedNoDupe.filter(b => b.text.toLowerCase().includes("titanium dlc blade")).length;
  assert(titaniumMentions === 1, `a callout present in BOTH the project Description and the catalog description is merged, not duplicated (got ${titaniumMentions} mentions)`);
  assert(mergedNoDupe.some(b => b.text.includes("whisper-quiet operation")), "a catalog-only callout not already in the project Description is still included");

  const confirmedFeatureLines = featureBullets.map(b => b.text);
  const groundedTip = "For the cleanest fade, let the X-Pro wide DLC blade do the heavy lifting on bulk removal before switching to a finer guard.";
  const ungroundedTip = "This trimmer includes a built-in laser leveling guide for perfectly symmetrical lines.";
  assert(isGroundedInFeatures(groundedTip, confirmedFeatureLines), "Expert Tip grounding check accepts a tip that references a real listed feature (the X-Pro blade)");
  assert(!isGroundedInFeatures(ungroundedTip, confirmedFeatureLines), "Expert Tip grounding check rejects a tip referencing an invented capability");

  const chartSuggestion = deriveComparisonChartSuggestion("trimmer", 199.95, "brushless", catalogRows);
  assert(!!chartSuggestion, "Comparison Chart auto-suggest produces a suggestion");
  const slots: { brand: string }[] = chartSuggestion?.sourceDetail?.slots || [];
  assert(slots.length === 2, `Comparison Chart suggests exactly 2 slots (got ${slots.length})`);
  assert(slots.some(s => s.brand === "StyleCraft") && slots.some(s => s.brand === "Gamma+"), "Comparison Chart's 2 suggested slots span both StyleCraft and Gamma+");
  assert(chartSuggestion?.sourceDetail?.label === "Suggested — confirm", "Comparison Chart suggestion is labeled 'Suggested — confirm', never presented as final");

  const manufacturerFromCatalog = deriveManufacturer(anime.name, anime.brand, [], null);
  assert(manufacturerFromCatalog.answer === "StyleCraft", "Manufacturer resolves to StyleCraft via the catalog record");
  assert(manufacturerFromCatalog.sourceDetail?.label === "From catalog record", "Manufacturer's citation says 'From catalog record'");

  // ---- Section 3: Manufacturer ambiguity — never guesses ----
  console.log("\n[3] Manufacturer ambiguity — unknown product renders a confirm quick-pick, not a guess");
  const hints = [
    { brand: "StyleCraft", namePrefixes: ["Saber", "Anime", "Protege", "Rebel", "Rogue", "Instinct"] },
    { brand: "Gamma+", namePrefixes: ["Absolute", "X-Evo"] },
  ];
  const ambiguous = deriveManufacturer("Zephyr Pro Clipper 3000", null, hints, null);
  assert(ambiguous.answer === "Confirm manufacturer", "an unmatched product name never gets a guessed brand as its answer");
  assert(ambiguous.sourceDetail?.ambiguous === true, "the ambiguous case is flagged with sourceDetail.ambiguous, which the UI keys its quick-pick render off of");
  assert(ambiguous.flagged === true, "the ambiguous case sets flagged so it surfaces in review");

  const matchedByHint = deriveManufacturer("Absolute Pro Trimmer", null, hints, null);
  assert(matchedByHint.answer === "Gamma+", "a name-prefix hint match still resolves confidently (not every unmatched-catalog case is ambiguous)");
  assert(matchedByHint.sourceDetail?.label === "From product line match", "hint-matched manufacturer cites 'From product line match'");

  // ---- Section 4: migration planning — old values preserved, no orphans ----
  console.log("\n[4] planFieldMigration — old values preserved in Notes, old rows deleted, no orphans");
  const docWithOldFields = [
    { field_id: "performance", answer: "Elite" },
    { field_id: "comps", answer: "N/A" },
    { field_id: "comps_buying_guide", answer: "Wahl Senior; Andis Master" },
    { field_id: "good_better_best", answer: "Best" },
  ];
  const plan = planFieldMigration(docWithOldFields);
  assert(
    plan.toDelete.length === 3 && ["performance", "comps", "comps_buying_guide"].every(id => plan.toDelete.includes(id)),
    "migration plan deletes all 3 old field rows"
  );
  const performanceStep = plan.notesSteps.find(s => s.newId === "good_better_best_performance");
  assert(performanceStep?.notesText === "Previous value: Elite", "performance's real answer is stashed into good_better_best_performance's Notes verbatim");
  const chartStep = plan.notesSteps.find(s => s.newId === "comparison_chart_web_only");
  assert(
    chartStep?.notesText === "Previous Comps for Buying Guide value: Wahl Senior; Andis Master",
    "comps_buying_guide's real answer is stashed into comparison_chart_web_only's Notes — comps' bare N/A contributes nothing since it was never a real answer"
  );

  const alreadyMigratedDoc = [
    { field_id: "good_better_best", answer: "Best" },
    { field_id: "good_better_best_performance", answer: "Best — 7,800rpm..." },
    { field_id: "comparison_chart_web_only", answer: "1. Rogue Trimmer..." },
  ];
  const noopPlan = planFieldMigration(alreadyMigratedDoc);
  assert(noopPlan.toDelete.length === 0 && noopPlan.notesSteps.length === 0, "a document with none of the 3 old fields left is a safe no-op (re-run safety)");

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
