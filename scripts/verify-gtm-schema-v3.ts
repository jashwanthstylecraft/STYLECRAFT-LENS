// scripts/verify-gtm-schema-v3.ts
// Offline regression check for GTM Schema v3 (76-item field inventory,
// repeatable rows, select controls, structural N/A, "Not found — checked
// {K} sources" terminal state). Pure-function/data-only — no live
// Rainforest/OpenAI/Gemini/Supabase call, no .env.local loaded.
//
// Run with: npx tsx scripts/verify-gtm-schema-v3.ts

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
  const { GTM_FIELD_SCHEMA, INTERNAL_FIELD_IDS, visibleGtmSchema } = await import("../lib/gtm-field-schema");
  const { structurallyInapplicableFieldIds, matchesFieldOptions } = await import("../lib/gtm-generate");
  const { deriveFieldsFromSources } = await import("../lib/gtm-derive");
  const { filterTrailingEmptyGroupRows } = await import("../lib/gtm-group-fields");
  const { planV3Migration } = await import("../lib/gtm-schema-v3-migration");
  const { hasCapsLead, hasExactSpecValue } = await import("../lib/gtm-format-checks");

  // ---- Section 1: schema shape ----
  console.log("\n[1] GTM_FIELD_SCHEMA v3 shape");
  const byId = new Map(GTM_FIELD_SCHEMA.map(f => [f.id, f]));
  console.log(`  (schema has ${GTM_FIELD_SCHEMA.length} total fields)`);

  const coreConsumer = byId.get("core_consumer");
  assert(coreConsumer?.uiControl === "select" && JSON.stringify(coreConsumer?.options) === JSON.stringify(["Pro", "Retail", "Both"]), "core_consumer is a Pro/Retail/Both select");

  const noiseLevel = byId.get("motor_noise_level");
  assert(noiseLevel?.uiControl === "select" && JSON.stringify(noiseLevel?.options) === JSON.stringify(["Ultra Quiet", "Low", "Moderate"]), "motor_noise_level is an Ultra Quiet/Low/Moderate select");
  assert(!!byId.get("motor_recharge_time"), "new motor_recharge_time field exists");

  assert(!byId.has("features_full_list"), "old single features_full_list field is gone");
  const featureRows = Array.from({ length: 5 }, (_, i) => byId.get(`features_full_list_${i + 1}`));
  assert(featureRows.every(Boolean), "features_full_list_1..5 all exist");
  assert(featureRows.every(f => f?.group?.id === "features_full_list" && f?.group?.total === 5), "every features_full_list row carries correct group metadata");

  assert(!byId.has("top_6_features"), "old single top_6_features field is gone");
  assert(Array.from({ length: 5 }, (_, i) => byId.get(`top_6_features_${i + 1}`)).every(Boolean), "top_6_features_1..5 all exist");

  assert(!byId.has("feature_icons"), "old single feature_icons field is gone");
  assert(Array.from({ length: 5 }, (_, i) => byId.get(`feature_icons_${i + 1}`)).every(Boolean), "feature_icons_1..5 all exist");

  assert(!byId.has("upsell_cross_sell"), "old upsell_cross_sell field is gone");
  assert(byId.get("up_sell")?.kind === "written", "new up_sell field exists and is written-kind");
  assert(Array.from({ length: 2 }, (_, i) => byId.get(`cross_sell_${i + 1}`)).every(Boolean), "cross_sell_1..2 all exist");

  assert(!!byId.get("comps_buying_guide") && byId.get("comps_buying_guide")?.uiControl === undefined, "comps_buying_guide is revived as a plain link/text field (no special uiControl)");
  assert(!!byId.get("comparison_chart_web_only")?.uiControl, "comparison_chart_web_only (picker) is untouched");

  assert(INTERNAL_FIELD_IDS.has("trademark_symbol") && byId.get("trademark_symbol")?.owner === "Legal", "trademark_symbol is internal-kind, owned by Legal");
  assert(INTERNAL_FIELD_IDS.has("rating_label") && byId.get("rating_label")?.owner === "Product Marketing", "rating_label is internal-kind, owned by Product Marketing");

  assert(!!byId.get("product_description"), "product_description is kept (not itemized in the v3 spec, but a real existing field)");
  assert(["plate_material", "heater_type", "max_temp_class"].every(id => byId.has(id)), "Heat/Plate Technology section is kept (not itemized in the v3 spec, but real existing data for motorless styling tools)");

  // ---- Section 2: structural N/A — Motor/Heat-Tech skip scraping ----
  console.log("\n[2] structurallyInapplicableFieldIds — skip scraping for non-applicable sections");
  const motorIds = GTM_FIELD_SCHEMA.filter(f => f.section === "Motor").map(f => f.id);
  const heatIds = GTM_FIELD_SCHEMA.filter(f => f.section === "Heat/Plate Technology").map(f => f.id);

  const motorProduct = structurallyInapplicableFieldIds("motor");
  assert(motorIds.every(id => !motorProduct.has(id)), "a motorized product (flagship/accessible-tool) keeps every Motor field eligible");
  assert(heatIds.every(id => motorProduct.has(id)), "a motorized product's Heat/Plate Technology fields are structurally N/A");

  const heatProduct = structurallyInapplicableFieldIds("heat_technology");
  assert(motorIds.every(id => heatProduct.has(id)), "a heat-tech product's Motor fields are structurally N/A");
  assert(heatIds.every(id => !heatProduct.has(id)), "a heat-tech product keeps every Heat/Plate Technology field eligible");

  const accessoryProduct = structurallyInapplicableFieldIds("none");
  assert(motorIds.every(id => accessoryProduct.has(id)) && heatIds.every(id => accessoryProduct.has(id)), "an accessory (foil-class, primary_criterion 'none') is structurally N/A for BOTH Motor and Heat/Plate Technology");

  const unresolvedProduct = structurallyInapplicableFieldIds(undefined);
  assert(unresolvedProduct.size === 0, "an unresolved/custom tool type with no primary_criterion never loses legitimate access to either section");

  // ---- Section 3: select-field enum validation — never accepts free text ----
  console.log("\n[3] matchesFieldOptions — select fields reject non-matching answers");
  assert(matchesFieldOptions(coreConsumer!, "Both"), "an exact-match enum answer is accepted");
  assert(matchesFieldOptions(coreConsumer!, "both"), "enum matching is case-insensitive");
  assert(!matchesFieldOptions(coreConsumer!, "Everyone"), "a non-matching free-text answer is rejected for a select field");
  assert(matchesFieldOptions(byId.get("warranty")!, "1 Year Limited Warranty"), "a non-select field always passes (no options to violate)");

  // ---- Section 4: Core Consumer derives from the project's real targetMarket ----
  console.log("\n[4] Core Consumer derivation — Pro/Retail/Both from targetMarket, never free AI narrative");
  const baseProject = { productName: "Test Trimmer" };
  const proAnswer = deriveFieldsFromSources({ ...baseProject, targetMarket: "pro" }, null, null, null);
  const retailAnswer = deriveFieldsFromSources({ ...baseProject, targetMarket: "consumer" }, null, null, null);
  const bothAnswer = deriveFieldsFromSources({ ...baseProject, targetMarket: "both" }, null, null, null);
  assert(proAnswer.core_consumer?.answer === "Pro" && proAnswer.core_consumer?.source === "project_record", "targetMarket 'pro' derives Core Consumer = Pro, from project_record");
  assert(retailAnswer.core_consumer?.answer === "Retail", "targetMarket 'consumer' derives Core Consumer = Retail");
  assert(bothAnswer.core_consumer?.answer === "Both", "targetMarket 'both' derives Core Consumer = Both");

  // ---- Section 5: trailing-empty-row trim (default: trim) ----
  console.log("\n[5] filterTrailingEmptyGroupRows — default: trim");
  const groupSchema = [
    { id: "g_1", section: "General", question: "Row #1", kind: "grounded" as const, group: { id: "g", index: 1, total: 3 } },
    { id: "g_2", section: "General", question: "Row #2", kind: "grounded" as const, group: { id: "g", index: 2, total: 3 } },
    { id: "g_3", section: "General", question: "Row #3", kind: "grounded" as const, group: { id: "g", index: 3, total: 3 } },
    { id: "solo", section: "General", question: "Solo field", kind: "grounded" as const },
  ];
  const partiallyFilled = filterTrailingEmptyGroupRows(groupSchema, id => ({ g_1: "Real value 1", g_2: "Real value 2", solo: "Real solo" }[id] || null));
  assert(partiallyFilled.map(f => f.id).join(",") === "g_1,g_2,solo", "trailing empty row (g_3, unfilled) is trimmed from the export, filled rows and non-group fields survive");

  const allEmpty = filterTrailingEmptyGroupRows(groupSchema, () => null);
  assert(allEmpty.filter(f => f.id.startsWith("g_")).map(f => f.id).join(",") === "g_1", "an entirely-unfilled group still keeps row 1 (never invisible)");

  // ---- Section 5b: visibleGtmSchema — legacyOptional hiding treats every
  // system placeholder as "unfilled", not just a bare empty string/"N/A" ----
  console.log("\n[5b] visibleGtmSchema — legacyOptional field hiding");
  const optionalField = [{ id: "lever_color", section: "Lever", question: "Color", legacyOptional: true }];
  assert(visibleGtmSchema(optionalField, {}).length === 0, "a legacyOptional field with no stored answer at all is hidden");
  assert(visibleGtmSchema(optionalField, { lever_color: { answer: "" } }).length === 0, "a legacyOptional field with a bare empty-string answer is hidden");
  assert(visibleGtmSchema(optionalField, { lever_color: { answer: "N/A" } }).length === 0, "a legacyOptional field answered 'N/A' is hidden");
  assert(visibleGtmSchema(optionalField, { lever_color: { answer: "Awaiting internal input" } }).length === 0, "a legacyOptional field still sitting on the internal-kind placeholder is hidden");
  assert(visibleGtmSchema(optionalField, { lever_color: { answer: "Not found — pre-launch: no web presence to search" } }).length === 0, "a legacyOptional field sitting on a 'Not found —' system placeholder is hidden, not treated as real data");
  assert(visibleGtmSchema(optionalField, { lever_color: { answer: "Red" } }).length === 1, "a legacyOptional field with a genuine real answer is shown");

  // ---- Section 6: format checks ----
  console.log("\n[6] hasCapsLead / hasExactSpecValue");
  assert(hasCapsLead("ZERO-GAP PRECISION — cuts closer without snagging"), "a real CAPS-lead claim is detected");
  assert(!hasCapsLead("This trimmer has a great motor"), "a plain-case line is not a CAPS-lead claim");
  assert(hasExactSpecValue("Up to 7,800rpm brushless motor"), "a line with a real spec value (rpm) is detected");
  assert(hasExactSpecValue("3.5 hours of cordless run time"), "a line with a real spec value (hours) is detected");
  assert(!hasExactSpecValue("Great performance and reliable build quality"), "a line with no spec value is correctly not detected");

  // ---- Section 7: migration — old fields split into new rows/notes, no orphans ----
  console.log("\n[7] planV3Migration — old fields split into new rows and Notes, no orphans");
  const oldDoc = [
    { field_id: "upsell_cross_sell", answer: "Consider bundling with the matching clipper for a full kit upsell.", source: "sales_kit" },
    { field_id: "top_6_features", answer: "1. Brushless motor\n2. Zero-gap blade\n3. Cordless design\n4. Fast charging\n5. Ergonomic grip\n6. Full metal body", source: "sales_kit" },
    { field_id: "feature_icons", answer: "Motor, Blade, Battery, Grip", source: "sales_kit" },
    { field_id: "features_full_list", answer: "7,800rpm brushless motor [Input]\nCordless design [Our listing]", source: "derived" },
    { field_id: "trademark_symbol", answer: "™ after first mention", source: "tds", owner: "Product Marketing" },
    { field_id: "good_better_best", answer: "Best", source: "derived" },
  ];
  const migrationPlan = planV3Migration(oldDoc as any);
  assert(
    ["upsell_cross_sell", "top_6_features", "feature_icons", "features_full_list"].every(id => migrationPlan.toDelete.includes(id)),
    "migration plan deletes all 4 old field rows"
  );
  assert(!!migrationPlan.upSellNotesStep?.notesText.startsWith("Previous value:"), "upsell_cross_sell's real value is stashed into up_sell's Notes (mixed concept, can't be split into rows)");
  const top6Seeds = migrationPlan.groupSeeds.filter(s => s.fieldId.startsWith("top_6_features_"));
  assert(top6Seeds.length === 6 && top6Seeds[0].answer === "Brushless motor", "top_6_features splits into 6 real row answers via splitNumberedList");
  const iconSeeds = migrationPlan.groupSeeds.filter(s => s.fieldId.startsWith("feature_icons_"));
  assert(iconSeeds.length === 4 && iconSeeds[0].answer === "Motor", "feature_icons splits into real row answers on commas");
  const featureSeeds = migrationPlan.groupSeeds.filter(s => s.fieldId.startsWith("features_full_list_"));
  assert(featureSeeds.length === 2 && featureSeeds[0].answer === "7,800rpm brushless motor [Input]", "features_full_list splits into real row answers on newlines");
  assert(migrationPlan.trademarkOwnerFix === true, "trademark_symbol still at the generic 'Product Marketing' owner is flagged for backfill to Legal");

  const cleanDoc = [
    { field_id: "up_sell", answer: "Consider the premium kit.", source: "sales_kit" },
    { field_id: "top_6_features_1", answer: "Brushless motor", source: "sales_kit" },
    { field_id: "trademark_symbol", answer: "™ after first mention", source: "tds", owner: "Legal" },
  ];
  const noopPlan = planV3Migration(cleanDoc as any);
  assert(noopPlan.toDelete.length === 0 && !noopPlan.trademarkOwnerFix, "an already-migrated document is a safe no-op (re-run safety)");

  console.log(`\n${passes} passed, ${failures} failed`);
  // Pre-existing latent issue, unrelated to this file's own logic: this
  // script dynamically imports lib/gtm-generate.ts, which imports
  // lib/db/tool-types.ts -> lib/memoryDb.ts. memoryDb's constructor starts
  // a real setInterval (autosave) that keeps a plain Node script alive
  // forever unless it exits explicitly.
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
