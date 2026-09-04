// scripts/verify-gtm-workbook-export.ts
// Offline regression check for the official GTM Workbook export feature
// (Part 5 of "GTM Workbook Export + 10 Auto-Generated Product FAQs") —
// no live Supabase/OpenAI/Gemini call, no .env.local loaded. Exercises the
// real uploaded template (checked into the repo as scripts/fixtures/
// gtm-official-template.xlsx) directly with PizZip, exactly like the
// production writer does — this is the strongest possible form of
// "the other 9 tabs are untouched": a raw byte comparison of the actual
// zip entries, not a parsed-value diff.
//
// Run with: npx tsx scripts/verify-gtm-workbook-export.ts

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

const FIXTURE_PATH = path.join(__dirname, "fixtures", "gtm-official-template.xlsx");

function a(text: string) {
  return { answer: text };
}

function buildSyntheticFields(): Record<string, { answer: string; notes?: string | null }> {
  const fields: Record<string, { answer: string; notes?: string | null }> = {
    core_consumer: a("Both"),
    why_creating_item: a("1. Fills the accessible lineup gap.\n2. Matches a real competitive gap."),
    positioning_statement: a("The Anime Trimmer is a lightweight, ultra-quiet cordless trimmer for barbers and home users."),
    product_name_origin: a("Named for its precise, clean lining."),
    name_story_tie: a("The Anime name signals precision anime-sharp lines."),
    new_line_or_current: a("New Line"),
    new_technology: a("Yes — IN2 brushless motor"),
    approved_pricing: a("Salon: $99.95 Retail: $109.95"),
    good_better_best: a("Better"),
    good_better_best_performance: a("Better"),
    hair_type: a("All Hair Types"),
    up_sell: a("Pair with the matching clipper for a full kit upsell."),
    reason_to_buy: a("1. ZERO-GAP PRECISION — cuts closer.\n2. QUIET OPERATION — barely audible."),
    expert_tip: a("Oil the blade before and after every use."),
    comparison_chart_web_only: a("Comp Item #1: SC601M\nComp Item #2: SC602M"),
    comps_buying_guide: a("https://example.com/buying-guide"),
    trademark_symbol: a("(TM) after first mention"),
    warranty: a("1 Year Limited Warranty"),
    certification_needed: a("CE, RoHS"),
    rating_label: a("4.5 stars"),
    dieline: a("Awaiting internal input"),
    box_type: a("Awaiting internal input"),
    product_lwh: a("8 x 2 x 2 in"),
    product_weight: a("0.5 lbs"),
    box_lwh: a("10 x 4 x 3 in"),
    measurement_by: a("Ops Team"),
    box_weight: a("0.8 lbs"),
    pallet_tier_total: a("48"),
    pallets_high: a("6"),
    product_title: a("Anime Trimmer"),
    material: a("Aluminum"),
    care_directions: a("Wipe clean after each use, oil weekly."),
    motor_type: a("Brushless Motor (IN2 Digital Brushless Motor)"),
    motor_rpm: a("7500 RPM"),
    motor_run_time: a("3 hours"),
    motor_recharge_time: a("90 minutes"),
    motor_speed: a("Single speed"),
    motor_noise_level: a("Ultra Quiet"),
    blade_name: a("DLC X-Pro Wide Blade"),
    fixed_blade: a("Fixed"),
    cutting_blade: a("DLC Deep Tooth"),
    lids_qty: a("2"),
    lids_colors: a("Black, Gold"),
    lever_type: a("Click lever"),
    lever_qty: a("1"),
    lever_color: a("Gold"),
    guards_type: a("8 comb guards"),
    guards_qty: a("8"),
    guards_color: a("Black"),
    charging_light_color: a("Red/Green"),
    charging_base_color: a("Black"),
    charging_cord_color: a("Black"),
    charging_cord_length: a("6 ft"),
    charging_port: a("USB-C"),
    charging_voltage: a("100-240V"),
    charging_logo_color: a("Gold"),
    charging_led_function: a("Blinks red while charging, solid green when full"),
    screw_driver_color: a("Gold"),
    screw_driver_brand: a("S|C Pro"),
    stretch_bracket_color: a("Black"),
    cam_follower_qty: a("1 (assembled on unit)"),
    cam_follower_color: a("Black"),
    cleaning_brush_qty: a("1"),
    cleaning_brush_color: a("Black"),
    oil_bottle_qty: a("1"),
    extra_screws_qty: a("4"),
    extra_screws_color: a("Gold"),
    included_summary: a("Trimmer, USB-C cord, 8 guards, cleaning brush, oil"),
    box_main_statement: a("Ultra-quiet precision trimming, redefined."),
    our_differentiators: a("• Quieter than category average\n• Longer runtime\n• Lighter body"),
    selling_position: a("Target price $99.95 sits at the category median of $99.00 across 8 compared competitors (range $59.99-$149.95)."),
    rep_talking_point_1: a("Quietest in class."),
    rep_talking_point_2: a("Best-in-class runtime."),
    rep_talking_point_3: a("Lightest body in the lineup."),
    dealer_gross_margin_pct: a("Awaiting internal input"),
    retail_gross_margin_pct: a("Awaiting internal input"),
    initial_quantities_ordered: a("Awaiting internal input"),
    // Marketing Direction (GTM workbook export work, 4th filled tab)
    marketing_previous_product_reference: a("Anime Clipper"),
    marketing_primary_goal: a("Drive awareness and retailer sell-in for the Anime Trimmer."),
    marketing_success_kpis: a("Revenue, ROAS, DTC traffic, sell-through."),
    marketing_launch_timing: a("Kick off 2-4 weeks before in-market date with a teaser reveal."),
    marketing_core_audience: a("Barbers and stylists who want zero-gap precision lining."),
    marketing_secondary_audience: a("Advanced home groomers."),
    marketing_consumer_barrier: a("Why trust this over an established name at this price."),
    marketing_messaging_direction: a("Confident, craft-first, no-hype."),
    marketing_product_name_origin: a("Named for its precise, anime-sharp lines."),
    marketing_visual_direction: a("Primary: dark backdrop hero shots. Avoid: overly staged looks."),
    marketing_content_ideas: a("1. Zero-gap precision demo.\n2. Quiet-operation comparison."),
    marketing_languages: a("English (primary). Spanish (secondary). French Canadian"),
    marketing_dos_donts: a("DO: highlight IN2 motor. DON'T: mix up clipper and trimmer messaging."),
    marketing_web_coverage: a("Full PDP refresh on brand.com and Amazon for SC999X."),
    marketing_ad_channels: a("P1 Launch: Paid Social. P2 Sustain: Paid Search."),
    marketing_print_material: a("Spec sheet for sales team and trade show flyer."),
    marketing_trade_show_launch: a("Yes — booth alongside the Anime Clipper."),
    marketing_educator_sampling: a("Send to all educators"),
    marketing_influencer_sampling: a("Awaiting internal input"),
    marketing_stylecraft_sales_team: a("All"),
    marketing_external_sales_rep_sampling: a("All"),
    marketing_key_accounts_sampling: a("All"),
    marketing_promo: a("Potentially promo with the Anime Clipper."),
  };
  for (let i = 1; i <= 5; i++) fields[`features_full_list_${i}`] = a(i <= 4 ? `ZERO-GAP PRECISION FEATURE ${i}` : "");
  for (let i = 1; i <= 2; i++) fields[`cross_sell_${i}`] = a(`Cross sell product ${i}`);
  for (let i = 1; i <= 5; i++) fields[`top_6_features_${i}`] = a(`Top feature ${i}`);
  for (let i = 1; i <= 5; i++) fields[`feature_icons_${i}`] = a(`ICON ${i}`);
  for (let i = 1; i <= 6; i++) fields[`box_feature_${i}`] = a(`Box feature ${i}`);
  for (let i = 1; i <= 3; i++) fields[`faq_question_${i}`] = a(`Question ${i}: how do I use it?`);
  for (let i = 1; i <= 3; i++) fields[`faq_answer_${i}`] = a(`Answer ${i}: use it like this.`);
  return fields;
}

// Content Form (Final Copy sheet export work) — a separate document
// (doc_type="content_form") merged into the same fields map the real
// export-xlsx route builds, since field ids don't collide with
// GTM_FIELD_SCHEMA's own.
function buildContentFormSyntheticFields(): Record<string, { answer: string; notes?: string | null }> {
  const fields: Record<string, { answer: string; notes?: string | null }> = {
    sexy_tagline: a("Precision that whispers."),
    techie_tagline: a("IN2 brushless motor, zero-gap blade geometry."),
    romance_copy: a("Built for barbers who demand more from every line."),
    keywords: a("cordless trimmer, zero-gap blade, brushless motor, barber trimmer"),
    amazon_long_title: a("Anime Trimmer - Cordless Zero-Gap Trimmer with IN2 Brushless Motor"),
    ecommerce_title: a("Anime Cordless Trimmer"),
    website_title: a("Anime Trimmer with IN2 Brushless Motor"),
    short_description: a("A quiet, zero-gap cordless trimmer built for all-day precision lining."),
    suggested_use: a("Oil the blade, power on, and glide close to the skin for zero-gap lines."),
    features_benefits: a("Zero-gap blade. Ultra-quiet IN2 motor. All-day runtime."),
  };
  for (let i = 1; i <= 6; i++) fields[`bullet_long_${i}`] = a(`ZERO-GAP PRECISION — bullet long ${i} detail sentence.`);
  for (let i = 1; i <= 6; i++) fields[`bullet_condensed_${i}`] = a(`Zero-gap precision ${i}`);
  for (let i = 1; i <= 3; i++) fields[`bullet_top3_${i}`] = a(`Top bullet ${i}`);
  for (let i = 1; i <= 3; i++) fields[`website_copy_short_${i}`] = a(`Short web copy ${i}`);
  for (let i = 1; i <= 3; i++) fields[`website_copy_long_${i}`] = a(`Long web copy ${i} — extended description.`);
  return fields;
}

async function main() {
  if (!fs.existsSync(FIXTURE_PATH)) {
    console.error(`Missing fixture: ${FIXTURE_PATH} — copy the real official workbook there first.`);
    process.exit(1);
  }

  const {
    openGtmWorkbook,
    generateGtmWorkbookBuffer,
    readCellText,
    findRowByLabel,
    findAllRowsByLabel,
    writeCell,
  } = await import("../lib/gtm-workbook-render");
  const { renderGtmWorkbook } = await import("../lib/gtm-workbook-data-mapper");
  const { parseGtmWorkbookTemplate, mapSheetNamesToParts, REQUIRED_GTM_WORKBOOK_SHEETS } = await import("../lib/gtm-workbook-template-parser");

  const templateBuffer = fs.readFileSync(FIXTURE_PATH);

  // ---- Section 1: Export fixture ----
  console.log("\n[1] Export fixture — mapped values land correctly, other tabs untouched, no #REF!, 3 Q/A pairs, multi-line wraps");

  const summary = parseGtmWorkbookTemplate(templateBuffer);
  assert(summary.missingRequiredSheets.length === 0, "the real template has all 3 required sheets (Product Knowledge/BOX ONLY/Product FAQ)");
  assert(REQUIRED_GTM_WORKBOOK_SHEETS.every(s => summary.sheetNames.includes(s)), "sheet name resolution finds every required sheet");

  const fields = { ...buildSyntheticFields(), ...buildContentFormSyntheticFields() };
  const result = renderGtmWorkbook(templateBuffer, { fields, headerSku: "SC999X", collection: "Homie", upc: "012345678905" });
  assert(result.unmapped.length === 0, `every mapped field found its template row (0 unmapped, got ${result.unmapped.length}: ${JSON.stringify(result.unmapped)})`);
  assert(result.repairs.length === 3, `exactly 3 formula cells were repaired (BOX ONLY Warranty/Includes/Certifications), got ${result.repairs.length}`);

  const outWorkbook = openGtmWorkbook(result.buffer);
  const pk = outWorkbook.getSheetXml("Product Knowledge");
  const box = outWorkbook.getSheetXml("BOX ONLY");
  const faq = outWorkbook.getSheetXml("Product FAQ");

  assert(readCellText(pk, outWorkbook.sharedStrings, "C2") === "Both", "Core Consumer answer lands in Product Knowledge C2");
  assert(readCellText(pk, outWorkbook.sharedStrings, "C44") === "Anime Trimmer — SC999X", "Product Title renders with the catalog-resolved SKU suffix");
  assert(readCellText(pk, outWorkbook.sharedStrings, "C13") === "ZERO-GAP PRECISION FEATURE 1", "Features (full list) row 1 lands on the anchor row itself");
  assert(readCellText(pk, outWorkbook.sharedStrings, "C17") === "", "an unfilled trailing feature row stays empty (never force-filled)");
  assert(readCellText(pk, outWorkbook.sharedStrings, "C24").includes("Cross sell product 1") && readCellText(pk, outWorkbook.sharedStrings, "C24").includes("Cross sell product 2"), "Cross Sell Products combines multiple answers into its one real template row");
  assert(readCellText(pk, outWorkbook.sharedStrings, "C95") === "1 (assembled on unit)", "Cam Follower Qty lands correctly despite the template's own 'Qtr' label typo");
  assert(readCellText(pk, outWorkbook.sharedStrings, "D27").startsWith("Example:"), "Comparison Chart WEB ONLY's helper example Notes text is left untouched, never overwritten");

  const dielineRow = findRowByLabel(pk, outWorkbook.sharedStrings, "A", "Dieline");
  assert(!!dielineRow && readCellText(pk, outWorkbook.sharedStrings, `C${dielineRow}`) === "", "an unresolved internal-kind field (Dieline, seeded as the literal 'Awaiting internal input' placeholder) exports as a genuinely blank cell, not the placeholder text");

  const multilineCell = pk.match(/<c r="C13"[^>]*(?:\/>|>[\s\S]*?<\/c>)/);
  assert(!!multilineCell && /\ss="\d+"/.test(multilineCell[0]), "a written cell keeps its original style attribute (wrap/font/border untouched)");

  assert(readCellText(box, outWorkbook.sharedStrings, "C21") === "1 Year Limited Warranty", "BOX ONLY Warranty's #REF! is replaced with the real literal value");
  assert(readCellText(box, outWorkbook.sharedStrings, "C23") === "CE, RoHS", "BOX ONLY Certifications' #REF! is replaced with the real literal value");
  assert(readCellText(box, outWorkbook.sharedStrings, "C22") === "Trimmer, USB-C cord, 8 guards, cleaning brush, oil", "BOX ONLY Includes' mis-pointed cross-sheet formula is replaced with the real Included: summary");
  assert(!box.includes("#REF!"), "zero literal #REF! remains anywhere in BOX ONLY's XML");
  assert(readCellText(box, outWorkbook.sharedStrings, "C4") === "Homie", "BOX ONLY Collection Name resolves from the catalog match");
  assert(readCellText(box, outWorkbook.sharedStrings, "C20") === "012345678905", "BOX ONLY UPC resolves from the catalog match");
  assert(readCellText(box, outWorkbook.sharedStrings, "C14") === "ICON 1", "BOX ONLY Icons reuse the same feature_icons_N answers as Product Knowledge");

  const md = outWorkbook.getSheetXml("Marketing Direction");
  assert(readCellText(md, outWorkbook.sharedStrings, "C2") === "Anime Clipper", "Marketing Direction: Previous Product Reference lands on row 2");
  assert(readCellText(md, outWorkbook.sharedStrings, "C9") === "Confident, craft-first, no-hype.", "Marketing Direction: Messaging Direction lands on row 9");
  assert(readCellText(md, outWorkbook.sharedStrings, "C13") === "English (primary). Spanish (secondary). French Canadian", "Marketing Direction: Languages lands on row 13");
  assert(readCellText(md, outWorkbook.sharedStrings, "C15") === "", "Marketing Direction: the schema-less section-header row (15) is skipped, never written to");
  assert(readCellText(md, outWorkbook.sharedStrings, "C16") === "Full PDP refresh on brand.com and Amazon for SC999X.", "Marketing Direction: Web Coverage correctly lands AFTER the skipped header row, at row 16");
  assert(readCellText(md, outWorkbook.sharedStrings, "C20") === "Send to all educators", "Marketing Direction: Educator Sampling lands on row 20");
  assert(readCellText(md, outWorkbook.sharedStrings, "C25") === "Potentially promo with the Anime Clipper.", "Marketing Direction: Promo (last row) lands on row 25");

  const qRows = findAllRowsByLabel(faq, outWorkbook.sharedStrings, "A", "Q:");
  const aRows = findAllRowsByLabel(faq, outWorkbook.sharedStrings, "A", "A:");
  assert(qRows.length === 3 && aRows.length === 3, `exactly 3 Q:/A: pairs exist (got ${qRows.length} Q, ${aRows.length} A)`);
  assert(readCellText(faq, outWorkbook.sharedStrings, `B${qRows[2]}`) === "Question 3: how do I use it?", "the 3rd FAQ question lands correctly");
  assert(readCellText(faq, outWorkbook.sharedStrings, `B${aRows[2]}`) === "Answer 3: use it like this.", "the 3rd FAQ answer lands correctly");
  const differentiatorsRow = findRowByLabel(faq, outWorkbook.sharedStrings, "A", "Our Differrentiators");
  assert(!!differentiatorsRow && readCellText(faq, outWorkbook.sharedStrings, `B${differentiatorsRow + 1}`).includes("Quieter than category average"), "Our Differentiators lands on the row below its own header label");

  // Final Copy (Content Form export work, sheet7.xml) — labels/rows
  // confirmed via a raw OOXML dump of this exact fixture. Ad Sheet Headline/
  // Sub Header (Content Form item 13) has no matching row and is never
  // written, by design — not asserted here since there's nothing to check.
  // Looked up by its OUTPUT name ("Content Form") — repositionAndRenameSheet
  // relabels this tab in the rendered file (see below), while every write
  // above happened against its real original name ("Final Copy").
  const fc = outWorkbook.getSheetXml("Content Form");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C6") === "Precision that whispers.", "Final Copy: Sexy Tagline lands on row 6");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C7") === "IN2 brushless motor, zero-gap blade geometry.", "Final Copy: Techie Tagline lands on row 7");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C9") === "Built for barbers who demand more from every line.", "Final Copy: Romance Copy lands on row 9");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C10") === "ZERO-GAP PRECISION — bullet long 1 detail sentence.", "Final Copy: Bullet Long #1 lands on the anchor row itself (10)");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C15") === "ZERO-GAP PRECISION — bullet long 6 detail sentence.", "Final Copy: Bullet Long #6 lands on row 15 (anchor + 5)");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C16") === "Zero-gap precision 1", "Final Copy: Bullet Condensed #1 lands on the anchor row itself (16)");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C21") === "Zero-gap precision 6", "Final Copy: Bullet Condensed #6 lands on row 21 (anchor + 5)");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C22") === "Top bullet 1", "Final Copy: Bullet Top 3 #1 lands on the anchor row itself (22)");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C24") === "Top bullet 3", "Final Copy: Bullet Top 3 #3 lands on row 24 (anchor + 2)");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C29") === "cordless trimmer, zero-gap blade, brushless motor, barber trimmer", "Final Copy: Keywords lands on row 29");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C34") === "Anime Trimmer - Cordless Zero-Gap Trimmer with IN2 Brushless Motor", "Final Copy: Amazon Long Title lands on row 34, despite the template's own curly-quote ’size’ label text");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C35") === "Anime Cordless Trimmer", "Final Copy: Ecommerce Title lands on row 35");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C36") === "Anime Trimmer with IN2 Brushless Motor", "Final Copy: Website Title lands on row 36");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C40") === "A quiet, zero-gap cordless trimmer built for all-day precision lining.", "Final Copy: Short Description lands on row 40");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C41") === "Oil the blade, power on, and glide close to the skin for zero-gap lines.", "Final Copy: Suggested Use lands on row 41");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C42") === "Zero-gap blade. Ultra-quiet IN2 motor. All-day runtime.", "Final Copy: Features & Benefits lands on row 42");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C46") === "", "Final Copy: Website Copy Short's own header row (46) is a pure label, never written to");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C47") === "Short web copy 1" && readCellText(fc, outWorkbook.sharedStrings, "C49") === "Short web copy 3", "Final Copy: Website Copy Short's 3 values land AFTER the header, at rows 47-49");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C50") === "", "Final Copy: Website Copy Long's own header row (50) is a pure label, never written to");
  assert(readCellText(fc, outWorkbook.sharedStrings, "C51") === "Long web copy 1 — extended description." && readCellText(fc, outWorkbook.sharedStrings, "C53") === "Long web copy 3 — extended description.", "Final Copy: Website Copy Long's 3 values land AFTER the header, at rows 51-53");

  // The other 7 tabs (sheet6 "Marketing Direction" and sheet7 "Final Copy"
  // are now filled targets, no longer untouched) + shared parts must be
  // byte-for-byte identical to the original template — the strongest
  // possible form of "untouched".
  const origZip = new PizZip(templateBuffer);
  const outZip = new PizZip(result.buffer);
  const untouchedParts = [
    "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml",
    "xl/worksheets/sheet8.xml", "xl/worksheets/sheet9.xml",
    "xl/worksheets/sheet10.xml", "xl/worksheets/sheet11.xml", "xl/worksheets/sheet12.xml",
    "xl/styles.xml", "xl/sharedStrings.xml", "xl/theme/theme1.xml",
  ];
  const allUntouchedIdentical = untouchedParts.every(p => {
    const origBytes = origZip.file(p)?.asUint8Array();
    const outBytes = outZip.file(p)?.asUint8Array();
    return origBytes && outBytes && Buffer.compare(Buffer.from(origBytes), Buffer.from(outBytes)) === 0;
  });
  assert(allUntouchedIdentical, "all 7 non-target sheets + styles/sharedStrings/theme are byte-for-byte identical to the original template");

  const sheet6Changed = Buffer.compare(
    Buffer.from(origZip.file("xl/worksheets/sheet6.xml")!.asUint8Array()),
    Buffer.from(outZip.file("xl/worksheets/sheet6.xml")!.asUint8Array())
  ) !== 0;
  assert(sheet6Changed, "Marketing Direction (sheet6.xml) DID change — confirms it's now actually being filled, not silently skipped");

  const sheet7Changed = Buffer.compare(
    Buffer.from(origZip.file("xl/worksheets/sheet7.xml")!.asUint8Array()),
    Buffer.from(outZip.file("xl/worksheets/sheet7.xml")!.asUint8Array())
  ) !== 0;
  assert(sheet7Changed, "Final Copy (sheet7.xml) DID change — confirms it's now actually being filled, not silently skipped");

  // Content Form tab reposition/rename — requested so the whole GTM +
  // Content Form output lives in one workbook, with the tab positioned
  // right next to BOX ONLY instead of buried near the end as "Final Copy".
  const outSheetsXml = outZip.file("xl/workbook.xml")!.asText().match(/<sheets>[\s\S]*?<\/sheets>/)![0];
  const outSheetNames = Array.from(outSheetsXml.matchAll(/name="([^"]*)"/g)).map(m => m[1]);
  assert(!outSheetNames.includes("Final Copy"), "the output workbook no longer has a tab literally named \"Final Copy\"");
  assert(outSheetNames.includes("Content Form"), "the output workbook has a tab named \"Content Form\"");
  const boxOnlyIdx = outSheetNames.indexOf("BOX ONLY");
  const contentFormIdx = outSheetNames.indexOf("Content Form");
  assert(contentFormIdx === boxOnlyIdx + 1, `Content Form sits immediately after BOX ONLY in tab order (BOX ONLY at ${boxOnlyIdx}, Content Form at ${contentFormIdx})`);
  assert(!outSheetsXml.includes('name="Final Copy"') && outSheetNames.length === 12, "no duplicate/orphaned sheet entry was left behind — still exactly 12 tabs, just reordered + one renamed");

  // ---- Section 2: FAQ grounding (the AI call itself needs a live key —
  // not exercised offline; this verifies the deterministic guard around it) ----
  console.log("\n[2] FAQ competitor-brand-name guard — the deterministic mechanism the AI call is wrapped in");
  const faqsModule = await import("../lib/gtm-product-faqs");
  // findBrandNameIn isn't exported (internal to the module) — verified
  // indirectly via generateProductFaqs's graceful no-op path below, since
  // exercising the actual brand-detection logic requires a live OpenAI call.
  assert(typeof faqsModule.generateProductFaqs === "function", "generateProductFaqs is exported and callable");
  const emptyFaqs = await faqsModule.generateProductFaqs(
    { project: { productName: "Test Trimmer" }, salesKit: null, tds: null, activeReport: null } as any,
    {}
  );
  assert(Object.keys(emptyFaqs).length === 0, "with zero grounded facts and no OpenAI key configured, FAQ generation gracefully returns nothing rather than inventing content");

  // ---- Section 3: Label-based mapping resilience ----
  console.log("\n[3] Label resilience — shifting rows in a copy of the template still lands values on the correct labels");
  const pkOriginal = openGtmWorkbook(templateBuffer).getSheetXml("Product Knowledge");
  const motorRowBefore = findRowByLabel(pkOriginal, openGtmWorkbook(templateBuffer).sharedStrings, "A", "Motor Type");
  assert(motorRowBefore === 60, `sanity check — Motor Type starts at row 60 in the real template (got ${motorRowBefore})`);

  function shiftRowsFrom(sheetXml: string, fromRow: number, shiftBy: number): string {
    const rowNums = Array.from(sheetXml.matchAll(/<row r="(\d+)"/g)).map(m => parseInt(m[1], 10)).filter(n => n >= fromRow).sort((a, b) => b - a);
    let xml = sheetXml;
    for (const n of rowNums) {
      const newNum = n + shiftBy;
      xml = xml.replace(new RegExp(`<row r="${n}"`), `<row r="${newNum}"`);
      xml = xml.replace(new RegExp(`r="([A-Z]+)${n}"`, "g"), (_m, col) => `r="${col}${newNum}"`);
    }
    return xml;
  }

  const shiftedWorkbook = openGtmWorkbook(templateBuffer);
  const shiftedPk = shiftRowsFrom(shiftedWorkbook.getSheetXml("Product Knowledge"), 55, 1);
  shiftedWorkbook.setSheetXml("Product Knowledge", shiftedPk);
  const motorRowAfter = findRowByLabel(shiftedWorkbook.getSheetXml("Product Knowledge"), shiftedWorkbook.sharedStrings, "A", "Motor Type");
  assert(motorRowAfter === 61, `after shifting rows 55+ down by one, Motor Type's label search finds it at its NEW row 61 (got ${motorRowAfter}), never the stale hardcoded 60`);

  const shiftedBuffer = generateGtmWorkbookBuffer(shiftedWorkbook);
  const shiftedResult = renderGtmWorkbook(shiftedBuffer, { fields, headerSku: null, collection: null, upc: null });
  const shiftedOutWorkbook = openGtmWorkbook(shiftedResult.buffer);
  assert(
    readCellText(shiftedOutWorkbook.getSheetXml("Product Knowledge"), shiftedOutWorkbook.sharedStrings, "C61") === "Brushless Motor (IN2 Digital Brushless Motor)",
    "a full export against the row-shifted copy still writes Motor Type's answer at its correct (shifted) row, not the original row 60"
  );

  // ---- Section 4: Round-trip — an edit is reflected in a re-export ----
  console.log("\n[4] Round-trip — editing a field's answer and re-exporting reflects the edit");
  const editedFields = { ...fields, warranty: a("2 Year Limited Warranty") };
  const reExported = renderGtmWorkbook(templateBuffer, { fields: editedFields, headerSku: "SC999X", collection: "Homie", upc: "012345678905" });
  const reExportedWorkbook = openGtmWorkbook(reExported.buffer);
  assert(
    readCellText(reExportedWorkbook.getSheetXml("BOX ONLY"), reExportedWorkbook.sharedStrings, "C21") === "2 Year Limited Warranty",
    "editing warranty's answer and re-exporting reflects the new value in the workbook"
  );
  assert(
    readCellText(reExportedWorkbook.getSheetXml("Product Knowledge"), reExportedWorkbook.sharedStrings, "C31") === "2 Year Limited Warranty",
    "the same edit is reflected in Product Knowledge's own Warranty row too"
  );

  console.log(`\n${passes} passed, ${failures} failed`);
  // GTM Multi-Template work — generateProductFaqs now internally resolves
  // the product's family (lib/gtm-product-faqs.ts), which transitively
  // imports lib/db/tool-types.ts -> lib/memoryDb.ts. memoryDb's constructor
  // starts a real setInterval (autosave), which keeps a plain Node script
  // alive forever unless it exits explicitly — previously a non-issue here
  // since nothing in this script's dependency graph touched memoryDb.
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
