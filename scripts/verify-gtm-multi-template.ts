// scripts/verify-gtm-multi-template.ts
// Offline regression check for GTM Multi-Template (Barber + Beauty) support
// — no live Supabase/OpenAI/Gemini call, no .env.local loaded. Exercises the
// REAL uploaded beauty template (checked into the repo as scripts/fixtures/
// gtm-official-template-beauty.xlsx, downloaded via a one-off read-only
// inspection of the live Supabase project during planning) alongside the
// existing barber fixture, exactly like scripts/verify-gtm-workbook-export.ts
// does for barber alone.
//
// Run with: npx tsx scripts/verify-gtm-multi-template.ts

export {};

import * as fs from "fs";
import * as path from "path";
import PizZip from "pizzip";

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

const BARBER_FIXTURE = path.join(__dirname, "fixtures", "gtm-official-template.xlsx");
const BEAUTY_FIXTURE = path.join(__dirname, "fixtures", "gtm-official-template-beauty.xlsx");

async function main() {
  console.log("=== GTM Multi-Template (Barber + Beauty) verification ===\n");

  // ---- Section 1: pure-logic family resolution/gating (no fixture needed) ----
  console.log("[1] resolveGtmFamily / structurallyInapplicableFieldIds / visibleGtmSchema");
  const { resolveGtmFamily, GTM_FIELD_SCHEMA, visibleGtmSchema } = await import("../lib/gtm-field-schema");
  const { structurallyInapplicableFieldIds } = await import("../lib/gtm-generate");

  const toolTypes = [
    { type_key: "clipper", family: "clipper_trimmer_shaver" },
    { type_key: "dryer", family: "beauty" },
    { type_key: "flat_iron", family: "beauty" },
    { type_key: "combo", family: null },
  ];

  assert(resolveGtmFamily({ toolType: "clipper" }, toolTypes) === "clipper_trimmer_shaver", "clipper resolves to clipper_trimmer_shaver family");
  assert(resolveGtmFamily({ toolType: "dryer" }, toolTypes) === "beauty", "dryer resolves to beauty family");
  assert(resolveGtmFamily({ toolType: "combo" }, toolTypes) === undefined, "an explicit null family (combo) resolves to undefined — no exclusion");
  assert(resolveGtmFamily({ toolType: "unknown_type" }, toolTypes) === undefined, "an unresolved tool type resolves to undefined — no exclusion");
  assert(resolveGtmFamily({ toolType: "clipper", gtmTemplateOverride: "beauty" }, toolTypes) === "beauty", "project override wins over the tool type's own family");
  assert(resolveGtmFamily({ toolType: "dryer", gtmTemplateOverride: "barber" }, toolTypes) === "clipper_trimmer_shaver", "override to 'barber' resolves to clipper_trimmer_shaver family");

  const clipperNaIds = structurallyInapplicableFieldIds("motor", "tool", "clipper_trimmer_shaver");
  assert(clipperNaIds.has("barrel_material") && clipperNaIds.has("wattage") && clipperNaIds.has("control_heat_range"), "a clipper_trimmer_shaver product structurally N/As every beauty-only field");
  assert(!clipperNaIds.has("blade_name") && !clipperNaIds.has("lids_qty"), "a clipper_trimmer_shaver product keeps its own barber-only fields AND the shared Lids fields");

  const beautyNaIds = structurallyInapplicableFieldIds("motor", "tool", "beauty");
  assert(beautyNaIds.has("blade_name") && beautyNaIds.has("lever_type") && beautyNaIds.has("charging_voltage"), "a beauty product structurally N/As every barber-only field (Blades/Lever/Charging)");
  assert(!beautyNaIds.has("barrel_material") && !beautyNaIds.has("lids_qty"), "a beauty product keeps its own beauty-only fields AND the shared Lids fields");

  const unresolvedNaIds = structurallyInapplicableFieldIds(undefined, "tool", undefined);
  assert(!unresolvedNaIds.has("blade_name") && !unresolvedNaIds.has("barrel_material"), "an unresolved family excludes neither side — same 'only exclude on a known mismatch' discipline as primaryCriterion");

  const barberVisible = visibleGtmSchema(GTM_FIELD_SCHEMA, {}, "clipper_trimmer_shaver");
  const beautyVisible = visibleGtmSchema(GTM_FIELD_SCHEMA, {}, "beauty");
  assert(barberVisible.some(f => f.id === "blade_name") && !barberVisible.some(f => f.id === "barrel_material"), "visibleGtmSchema hides beauty-only fields for a barber-family product");
  assert(beautyVisible.some(f => f.id === "barrel_material") && !beautyVisible.some(f => f.id === "blade_name"), "visibleGtmSchema hides barber-only fields for a beauty-family product");
  // lids_qty is legacyOptional (manual-fill-only — hidden until it has a
  // real answer, same as every other legacyOptional field), so an empty
  // fields map hides it for BOTH families regardless of the family gate
  // this test actually cares about — that's visibleGtmSchema's documented
  // legacyOptional behavior, not a family-gating bug. Supplying a real
  // answer isolates what this assertion is actually testing: that the
  // family gate itself doesn't ALSO exclude this shared (non-family-
  // tagged) field once it's actually filled in.
  const withLidsAnswered = { lids_qty: { answer: "2" } };
  const barberVisibleWithLids = visibleGtmSchema(GTM_FIELD_SCHEMA, withLidsAnswered, "clipper_trimmer_shaver");
  const beautyVisibleWithLids = visibleGtmSchema(GTM_FIELD_SCHEMA, withLidsAnswered, "beauty");
  assert(barberVisibleWithLids.some(f => f.id === "lids_qty") && beautyVisibleWithLids.some(f => f.id === "lids_qty"), "the shared Lids/Customizable Parts fields stay visible for both families once answered");
  const nonLegacyOptionalCount = GTM_FIELD_SCHEMA.filter(f => !f.legacyOptional).length;
  assert(visibleGtmSchema(GTM_FIELD_SCHEMA, {}).length === nonLegacyOptionalCount, "omitting resolvedFamily applies only the pre-existing legacyOptional filter — unchanged pre-multi-template behavior");

  // ---- Section 2: industry-scoped template CRUD (memoryDb, offline) ----
  console.log("\n[2] gtm_workbook_templates industry scoping (memoryDb)");
  const { createGtmWorkbookTemplate, getActiveGtmWorkbookTemplate, setActiveGtmWorkbookTemplate } = await import("../lib/db/gtm-workbook-templates");
  const emptySheetSummary = { sheetNames: [], missingRequiredSheets: [] };

  const barberRow = await createGtmWorkbookTemplate({ name: "Barber Test", fileBuffer: Buffer.from("x"), fileName: "barber.xlsx", sheetSummary: emptySheetSummary, industry: "barber" });
  const beautyRow = await createGtmWorkbookTemplate({ name: "Beauty Test", fileBuffer: Buffer.from("y"), fileName: "beauty.xlsx", sheetSummary: emptySheetSummary, industry: "beauty" });
  await setActiveGtmWorkbookTemplate(barberRow.id, "barber");
  await setActiveGtmWorkbookTemplate(beautyRow.id, "beauty");

  const activeBarber = await getActiveGtmWorkbookTemplate("barber");
  const activeBeauty = await getActiveGtmWorkbookTemplate("beauty");
  assert(activeBarber?.id === barberRow.id, "the barber template is active under the 'barber' industry lookup");
  assert(activeBeauty?.id === beautyRow.id, "the beauty template is active under the 'beauty' industry lookup — BOTH active simultaneously");

  const barberRow2 = await createGtmWorkbookTemplate({ name: "Barber Test 2", fileBuffer: Buffer.from("z"), fileName: "barber2.xlsx", sheetSummary: emptySheetSummary, industry: "barber" });
  await setActiveGtmWorkbookTemplate(barberRow2.id, "barber");
  const stillActiveBeauty = await getActiveGtmWorkbookTemplate("beauty");
  assert(stillActiveBeauty?.id === beautyRow.id, "activating a new barber template leaves the beauty template's active status untouched");
  const newActiveBarber = await getActiveGtmWorkbookTemplate("barber");
  assert(newActiveBarber?.id === barberRow2.id, "the new barber template is now active, replacing the old one");

  // ---- Section 3: template inspection (Part 1.2) against the REAL beauty fixture ----
  console.log("\n[3] Template inspection — real beauty template vs. barber reference labels");
  if (!fs.existsSync(BEAUTY_FIXTURE)) {
    console.error(`  SKIP: ${BEAUTY_FIXTURE} not found — beauty fixture missing`);
    failures++;
  } else {
    const { buildGtmTemplateFieldInspection } = await import("../lib/gtm-workbook-inspection");
    const beautyBuffer = fs.readFileSync(BEAUTY_FIXTURE);
    const inspection = buildGtmTemplateFieldInspection(beautyBuffer);

    assert(!!inspection["Product Knowledge"], "inspection produces a Product Knowledge entry");
    assert(inspection["Product Knowledge"].shared.some(l => l === "Core Consumer"), "Product Knowledge: 'Core Consumer' is correctly detected as shared");
    assert(inspection["Product Knowledge"].candidateOnly.some(l => l.includes("Barrel Material")), "Product Knowledge: 'Barrel Material' is correctly detected as beauty-only (candidateOnly)");
    assert(inspection["Product Knowledge"].referenceOnly.some(l => l === "Blade Name"), "Product Knowledge: 'Blade Name' is correctly detected as missing from beauty (referenceOnly)");
    assert(inspection["Marketing Direction"].referenceOnly.length === 0, "Marketing Direction: zero reference-only labels — confirmed 100% shared between barber and beauty");
  }

  // ---- Section 4: renderGtmWorkbook against the REAL beauty fixture ----
  console.log("\n[4] renderGtmWorkbook — real beauty template export");
  if (!fs.existsSync(BEAUTY_FIXTURE) || !fs.existsSync(BARBER_FIXTURE)) {
    console.error("  SKIP: one or both fixtures missing");
    failures++;
  } else {
    const { renderGtmWorkbook } = await import("../lib/gtm-workbook-data-mapper");
    const { openGtmWorkbook } = await import("../lib/gtm-workbook-render");
    const { mapSheetNamesToParts } = await import("../lib/gtm-workbook-template-parser");

    const beautyBuffer = fs.readFileSync(BEAUTY_FIXTURE);
    const beautyFields: Record<string, { answer: string }> = {
      core_consumer: { answer: "Consumer" },
      barrel_material: { answer: "Ceramic-coated titanium" },
      barrel_size: { answer: "1.25 in" },
      barrel_length: { answer: "6 in" },
      plate_material: { answer: "Titanium" },
      wattage: { answer: "1875W" },
      motor_type: { answer: "AC Motor" },
      motor_rpm: { answer: "N/A" },
      motor_noise_level_db: { answer: "68 dB" },
      control_heat_range: { answer: "150-450°F" },
      lids_qty: { answer: "2" },
      travel_bag_case: { answer: "Yes, included" },
      attachments_list: { answer: "Diffuser, concentrator nozzle" },
      product_title: { answer: "Test Dryer" },
      warranty: { answer: "2 Year Limited" },
    };

    const result = renderGtmWorkbook(beautyBuffer, { fields: beautyFields, headerSku: null, collection: "Test Collection", upc: "000000000000", sku: "SC-TEST-1" }, "beauty");
    assert(result.unmapped.length < 5, `most beauty-mapped fields found their real row (unmapped: ${JSON.stringify(result.unmapped)})`);

    const outWorkbook = openGtmWorkbook(result.buffer);
    const { readCellText } = await import("../lib/gtm-workbook-render");
    const pk = outWorkbook.getSheetXml("Product Knowledge");
    assert(readCellText(pk, outWorkbook.sharedStrings, "C60") === "Ceramic-coated titanium", "Barrel Material lands in the real beauty template's Product Knowledge row 60");
    assert(readCellText(pk, outWorkbook.sharedStrings, "C79") === "1875W", "Wattage lands in the real beauty template's Product Knowledge row 79");
    assert(readCellText(pk, outWorkbook.sharedStrings, "C83") === "2", "Qty (Customizable Parts, shared with barber's Lids) lands in row 83");

    const box = outWorkbook.getSheetXml("BOX ONLY");
    const boxSkuRow = (await import("../lib/gtm-workbook-render")).findRowByLabel(box, outWorkbook.sharedStrings, "A", "SKU");
    assert(!!boxSkuRow && readCellText(box, outWorkbook.sharedStrings, `C${boxSkuRow}`) === "SC-TEST-1", "BOX ONLY's beauty-only SKU row is filled from the project's SKU");

    // Untouched-tab byte-identity — dynamically resolved (not hardcoded
    // sheetN.xml numbers, since the beauty workbook's internal tab order
    // differs from barber's) as every sheet name OTHER than the 5 filled
    // content tabs.
    const inZip = new PizZip(beautyBuffer);
    const outZip = new PizZip(result.buffer);
    const sheetParts = mapSheetNamesToParts(inZip);
    const FILLED_TABS = new Set(["Product Knowledge", "BOX ONLY", "Marketing Direction", "Product FAQ", "Final Copy"]);
    let untouchedChecked = 0;
    let allByteIdentical = true;
    for (const [name, part] of Object.entries(sheetParts)) {
      if (FILLED_TABS.has(name)) continue;
      const before = inZip.file(part)?.asUint8Array();
      const after = outZip.file(part)?.asUint8Array();
      if (!before || !after || Buffer.compare(Buffer.from(before), Buffer.from(after)) !== 0) allByteIdentical = false;
      untouchedChecked++;
    }
    assert(untouchedChecked === 7, `7 non-content tabs identified for byte-identity check (got ${untouchedChecked})`);
    assert(allByteIdentical, "every untouched tab in the beauty template is byte-for-byte identical after export");

    // Barber regression — passing industry="barber" explicitly (the new
    // default) must behave exactly like the pre-multi-template signature.
    const barberBuffer = fs.readFileSync(BARBER_FIXTURE);
    const barberResult = renderGtmWorkbook(barberBuffer, { fields: { core_consumer: { answer: "Both" } }, headerSku: null, collection: null, upc: null }, "barber");
    const barberResultDefaulted = renderGtmWorkbook(barberBuffer, { fields: { core_consumer: { answer: "Both" } }, headerSku: null, collection: null, upc: null });
    assert(Buffer.compare(barberResult.buffer, barberResultDefaulted.buffer) === 0, "explicit industry='barber' produces byte-identical output to omitting the param (default unchanged)");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures > 0 ? "\nSome checks FAILED." : "\nAll checks passed.");
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
