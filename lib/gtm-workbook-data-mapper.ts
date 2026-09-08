// lib/gtm-workbook-data-mapper.ts
// GTM workbook export work — maps our GTM_FIELD_SCHEMA field answers onto
// the official workbook template's real row labels (Product Knowledge/BOX
// ONLY/Product FAQ), then drives lib/gtm-workbook-render.ts's writer.
//
// Labels below are the REAL template text (confirmed via a raw OOXML dump
// of the actual uploaded file, including its own typos — "Our
// Differrentiators", "Cam Follower Qtr", "Intial Quantities ordered: #" —
// which is why these are hand-transcribed here rather than derived from
// GTM_FIELD_SCHEMA's own (correctly-spelled) `question` text: the two serve
// different purposes and must be allowed to drift independently. Fields are
// listed in the template's own top-to-bottom row order — findRowByLabel's
// cursor walks forward through that order, which is what disambiguates a
// label reused across sections (Lids/Lever/Guards all have their own
// "Qty"/"Type"/"Color" row) without ever hardcoding a row number.
import { isRealAnswer, isAwaitingInternalInput } from "./field-answer-state";
import {
  openGtmWorkbook,
  generateGtmWorkbookBuffer,
  findRowByLabel,
  findAllRowsByLabel,
  writeCell,
  insertFaqRows,
  repositionAndRenameSheet,
  OpenGtmWorkbook,
} from "./gtm-workbook-render";

export interface WorkbookFieldSource {
  answer?: string;
  notes?: string | null;
}

export type WorkbookFields = Record<string, WorkbookFieldSource>;

export interface GtmWorkbookMapperInput {
  fields: WorkbookFields;
  headerSku: string | null; // resolved via lib/our-product-position.ts's resolveHeaderSku
  collection: string | null; // resolved via matchCatalogProductByName
  upc: string | null; // resolved via matchCatalogProductByName, or null -> "Awaiting internal input"
  // GTM Multi-Template work — the real BEAUTY template's BOX ONLY tab has
  // its own "SKU" row (absent from barber's BOX ONLY) — the project's own
  // SKU (lib/db/projects.ts), same source headerSku is derived from.
  sku?: string | null;
}

export interface WorkbookRepair {
  sheet: string;
  addr: string;
  oldFormula: string;
  newValue: string;
}

export interface GtmWorkbookRenderResult {
  buffer: Buffer;
  repairs: WorkbookRepair[];
  unmapped: { sheet: string; label: string }[];
}

function answerOf(fields: WorkbookFields, id: string): string {
  const v = fields[id]?.answer;
  // An unresolved "internal"-kind field (e.g. Lids/Lever/Guards/Charging/
  // Included in Box — real ops/packaging decisions generation never
  // guesses at) is written as the literal "Awaiting internal input" answer
  // so the in-app UI can show its own chip/owner — but that literal string
  // has no business appearing as cell text in the exported workbook. Leave
  // the cell genuinely blank instead, ready for direct manual entry.
  if (isAwaitingInternalInput(v)) return "";
  return isRealAnswer(v) ? v!.trim() : (v ?? "").trim();
}

type Step =
  // rowOffset: some labels (e.g. Product FAQ's "Our Differrentiators"/
  // "Selling Position") are pure section headers whose own row has no
  // value cell of its own — the real answer lives on the row right below.
  // Defaults to 0 (value lives on the same row as the label, the common
  // case for Product Knowledge/BOX ONLY's "Item | Answer" rows).
  | { kind: "field"; label: string; fieldId: string; writeNotes?: boolean; rowOffset?: number }
  | { kind: "group"; label: string; fieldIdPrefix: string; total: number; offset: 0 | 1 }
  | { kind: "combinedRow"; label: string; fieldIds: string[] }
  // Marketing Direction's "CHANNEL STRATEGY/CONTENT DELIVERABLES" row (merged
  // A15:D15) is a pure section-header label with NO corresponding field —
  // the first template label in this codebase with zero schema entry.
  // findRowByLabel's forward-only cursor search would naturally skip past an
  // unlisted label on its own, but an explicit step keeps the array
  // self-documenting and turns a future template regression (header row
  // deleted/renamed) into a visible `unmapped` warning instead of silent
  // drift, matching this module's own "never hardcode a row number" rule.
  | { kind: "skipRow"; label: string };

// ---- Product Knowledge (Item=A, Owner=B, Answer=C, Notes=D) ----
const PRODUCT_KNOWLEDGE_STEPS: Step[] = [
  { kind: "field", label: "Core Consumer", fieldId: "core_consumer" },
  { kind: "field", label: "Why are we creating this item?", fieldId: "why_creating_item" },
  { kind: "field", label: "What is the positioning statement?", fieldId: "positioning_statement" },
  { kind: "field", label: "Product Name Origin", fieldId: "product_name_origin" },
  { kind: "field", label: "How does this product name tie to the story?", fieldId: "name_story_tie" },
  { kind: "field", label: "New Line or Current Collection?", fieldId: "new_line_or_current" },
  { kind: "field", label: "New Technology?", fieldId: "new_technology" },
  { kind: "field", label: "Approved Pricing", fieldId: "approved_pricing" },
  { kind: "field", label: "Good Better Best -Lineup", fieldId: "good_better_best" },
  { kind: "field", label: "Good Better Best -Performance", fieldId: "good_better_best_performance" },
  { kind: "field", label: "Hair Type", fieldId: "hair_type" },
  { kind: "group", label: "Features (full list)", fieldIdPrefix: "features_full_list", total: 4, offset: 0 },
  { kind: "field", label: "Up-sell (Sales play opportunity)", fieldId: "up_sell" },
  { kind: "combinedRow", label: "Cross Sell Products", fieldIds: Array.from({ length: 2 }, (_, i) => `cross_sell_${i + 1}`) },
  { kind: "field", label: "Reason to Buy", fieldId: "reason_to_buy" },
  { kind: "field", label: "Expert Tip", fieldId: "expert_tip" },
  { kind: "field", label: "Comparison Chart WEB ONLY", fieldId: "comparison_chart_web_only", writeNotes: false },
  { kind: "field", label: "Comps for Buying Guide", fieldId: "comps_buying_guide" },
  { kind: "field", label: "Trademark Symbol", fieldId: "trademark_symbol" },
  { kind: "field", label: "Warranty", fieldId: "warranty" },
  { kind: "field", label: "Certification Needed", fieldId: "certification_needed" },
  { kind: "field", label: "Rating Label", fieldId: "rating_label" },
  { kind: "field", label: "Dieline", fieldId: "dieline" },
  { kind: "field", label: "Box Type", fieldId: "box_type" },
  { kind: "field", label: "Product LxWxH", fieldId: "product_lwh" },
  { kind: "field", label: "Product Weight", fieldId: "product_weight" },
  { kind: "field", label: "Box LxWxH", fieldId: "box_lwh" },
  { kind: "field", label: "Measurement By", fieldId: "measurement_by" },
  { kind: "field", label: "Box Weight", fieldId: "box_weight" },
  { kind: "field", label: "Pallet Tier (Total)", fieldId: "pallet_tier_total" },
  { kind: "field", label: "Pallets High", fieldId: "pallets_high" },
  { kind: "field", label: "Product Title", fieldId: "product_title" },
  { kind: "field", label: "Material", fieldId: "material" },
  { kind: "group", label: "Top 6 Features in Priority Order", fieldIdPrefix: "top_6_features", total: 5, offset: 0 },
  { kind: "group", label: "6 Icons for the Features", fieldIdPrefix: "feature_icons", total: 5, offset: 0 },
  { kind: "field", label: "Care Directions", fieldId: "care_directions" },
  { kind: "field", label: "Motor Type", fieldId: "motor_type" },
  { kind: "field", label: "RPM", fieldId: "motor_rpm" },
  { kind: "field", label: "Run Time", fieldId: "motor_run_time" },
  { kind: "field", label: "Recharge Time", fieldId: "motor_recharge_time" },
  { kind: "field", label: "Speed", fieldId: "motor_speed" },
  { kind: "field", label: "Noise level", fieldId: "motor_noise_level" },
  { kind: "field", label: "Blade Name", fieldId: "blade_name" },
  { kind: "field", label: "Fixed Blade", fieldId: "fixed_blade" },
  { kind: "field", label: "Cutting Blade", fieldId: "cutting_blade" },
  { kind: "field", label: "Qty", fieldId: "lids_qty" },
  { kind: "field", label: "Colors", fieldId: "lids_colors" },
  { kind: "field", label: "Type", fieldId: "lever_type" },
  { kind: "field", label: "Qty", fieldId: "lever_qty" },
  { kind: "field", label: "Color", fieldId: "lever_color" },
  { kind: "field", label: "Type", fieldId: "guards_type" },
  { kind: "field", label: "Qty", fieldId: "guards_qty" },
  { kind: "field", label: "Color", fieldId: "guards_color" },
  { kind: "field", label: "Light Color", fieldId: "charging_light_color" },
  { kind: "field", label: "Base Color", fieldId: "charging_base_color" },
  { kind: "field", label: "Cord Color", fieldId: "charging_cord_color" },
  { kind: "field", label: "Cord Length", fieldId: "charging_cord_length" },
  { kind: "field", label: "Charging Port", fieldId: "charging_port" },
  { kind: "field", label: "Voltage", fieldId: "charging_voltage" },
  { kind: "field", label: "Logo Color", fieldId: "charging_logo_color" },
  { kind: "field", label: "LED Function", fieldId: "charging_led_function" },
  { kind: "field", label: "Screw Driver Color", fieldId: "screw_driver_color" },
  { kind: "field", label: "Screw Driver Brand", fieldId: "screw_driver_brand" },
  { kind: "field", label: "Screw Driver Other", fieldId: "screw_driver_other" },
  { kind: "field", label: "Stretch Bracket Color", fieldId: "stretch_bracket_color" },
  // The real template's own label is "Cam Follower Qtr" (a typo) — searching
  // on the shorter "Cam Follower" prefix matches it without depending on
  // that typo being reproduced exactly; the cursor then lands correctly on
  // "Cam Follower Color" next since it's searched with its own full (and
  // correctly spelled) text.
  { kind: "field", label: "Cam Follower", fieldId: "cam_follower_qty" },
  { kind: "field", label: "Cam Follower Color", fieldId: "cam_follower_color" },
  { kind: "field", label: "Cleaning Brush Qty", fieldId: "cleaning_brush_qty" },
  { kind: "field", label: "Cleaning Brush Color", fieldId: "cleaning_brush_color" },
  { kind: "field", label: "Oil Bottle Qty", fieldId: "oil_bottle_qty" },
  { kind: "field", label: "Extra Screws Qty", fieldId: "extra_screws_qty" },
  { kind: "field", label: "Extra Screws Color", fieldId: "extra_screws_color" },
  { kind: "field", label: "Included:", fieldId: "included_summary" },
];

// ---- Product Knowledge — BEAUTY variant. Confirmed via live inspection of
// the real uploaded beauty template that its Product Knowledge tab shares
// an IDENTICAL row order with barber's from Core Consumer through Care
// Directions (only "Collection" replaces barber's longer "New Line or
// Current Collection?" label — same field, renamed on the template — and an
// extra "COMPS" header row appears before "Comps for Buying Guide", handled
// below), then diverges completely: no Blades/Lever/Guards/Charging at all,
// replaced with Curling Irons/Flat Irons/Blow Dryer/(restricted) Motor/
// Electrical & Power/Customizable Parts (identical to barber's Lids)/
// Control Settings/beauty Included-in-Box items. See lib/gtm-field-
// schema.ts's family-tagged fields this list targets.
const PRODUCT_KNOWLEDGE_STEPS_BEAUTY: Step[] = [
  { kind: "field", label: "Core Consumer", fieldId: "core_consumer" },
  { kind: "field", label: "Why are we creating this item?", fieldId: "why_creating_item" },
  { kind: "field", label: "What is the positioning statement?", fieldId: "positioning_statement" },
  { kind: "field", label: "Product Name Origin", fieldId: "product_name_origin" },
  { kind: "field", label: "How does this product name tie to the story?", fieldId: "name_story_tie" },
  { kind: "field", label: "Collection", fieldId: "new_line_or_current" },
  { kind: "field", label: "New Technology?", fieldId: "new_technology" },
  { kind: "field", label: "Approved Pricing", fieldId: "approved_pricing" },
  { kind: "field", label: "Good Better Best -Lineup", fieldId: "good_better_best" },
  { kind: "field", label: "Good Better Best -Performance", fieldId: "good_better_best_performance" },
  { kind: "field", label: "Hair Type", fieldId: "hair_type" },
  { kind: "group", label: "Features (full list)", fieldIdPrefix: "features_full_list", total: 4, offset: 0 },
  { kind: "field", label: "Up-sell (Sales play opportunity)", fieldId: "up_sell" },
  { kind: "combinedRow", label: "Cross Sell Products", fieldIds: Array.from({ length: 2 }, (_, i) => `cross_sell_${i + 1}`) },
  { kind: "field", label: "Reason to Buy", fieldId: "reason_to_buy" },
  { kind: "field", label: "Expert Tip", fieldId: "expert_tip" },
  { kind: "field", label: "Comparison Chart WEB ONLY", fieldId: "comparison_chart_web_only", writeNotes: false },
  // Bare section-header row, no value cell of its own (confirmed via
  // inspection) — an explicit skipRow so a future template change surfaces
  // as an `unmapped` warning instead of silent drift, same discipline as
  // Marketing Direction's "CHANNEL STRATEGY..." skipRow below.
  { kind: "skipRow", label: "COMPS" },
  { kind: "field", label: "Comps for Buying Guide", fieldId: "comps_buying_guide" },
  { kind: "field", label: "Trademark Symbol", fieldId: "trademark_symbol" },
  { kind: "field", label: "Warranty", fieldId: "warranty" },
  { kind: "field", label: "Certification Needed", fieldId: "certification_needed" },
  { kind: "field", label: "Rating Label", fieldId: "rating_label" },
  { kind: "field", label: "Dieline", fieldId: "dieline" },
  { kind: "field", label: "Box Type", fieldId: "box_type" },
  { kind: "field", label: "Product LxWxH", fieldId: "product_lwh" },
  { kind: "field", label: "Product Weight", fieldId: "product_weight" },
  { kind: "field", label: "Box LxWxH", fieldId: "box_lwh" },
  { kind: "field", label: "Measurement By", fieldId: "measurement_by" },
  { kind: "field", label: "Box Weight", fieldId: "box_weight" },
  { kind: "field", label: "Pallet Tier (Total)", fieldId: "pallet_tier_total" },
  { kind: "field", label: "Pallets High", fieldId: "pallets_high" },
  { kind: "field", label: "Product Title", fieldId: "product_title" },
  { kind: "field", label: "Material", fieldId: "material" },
  { kind: "group", label: "Top 6 Features in Priority Order", fieldIdPrefix: "top_6_features", total: 5, offset: 0 },
  { kind: "group", label: "6 Icons for the Features", fieldIdPrefix: "feature_icons", total: 5, offset: 0 },
  { kind: "field", label: "Care Directions", fieldId: "care_directions" },
  // ---- Beauty-only suffix (confirmed via live inspection; no barber
  // equivalent past this point) ----
  { kind: "skipRow", label: "Curling Irons:" },
  { kind: "field", label: "Barrel Material", fieldId: "barrel_material" },
  { kind: "field", label: "Barrel Size", fieldId: "barrel_size" },
  { kind: "field", label: "Barrel Length", fieldId: "barrel_length" },
  { kind: "skipRow", label: "Flat Irons:" },
  { kind: "field", label: "Plates", fieldId: "plate_material" },
  { kind: "field", label: "Plate size", fieldId: "plate_size" },
  { kind: "skipRow", label: "Blow Dryer:" },
  { kind: "field", label: "# of Heat Settings", fieldId: "heat_settings_count" },
  { kind: "field", label: "# of Speed Settings", fieldId: "speed_settings_count" },
  // Real beauty Motor block only has these 4 rows (Run Time/Recharge Time/
  // Speed have no row here — confirmed via inspection; those fields still
  // exist in-app, just unmapped in the beauty export).
  { kind: "field", label: "Motor Type", fieldId: "motor_type" },
  { kind: "field", label: "RPM", fieldId: "motor_rpm" },
  { kind: "field", label: "Noise level db", fieldId: "motor_noise_level_db" },
  { kind: "field", label: "Noise level Description", fieldId: "motor_noise_level" },
  { kind: "field", label: "Voltage", fieldId: "electrical_voltage" },
  { kind: "field", label: "Dual Voltage", fieldId: "dual_voltage" },
  { kind: "field", label: "Wattage", fieldId: "wattage" },
  { kind: "field", label: "Swivel Cord", fieldId: "swivel_cord" },
  { kind: "field", label: "Power Cord Length", fieldId: "power_cord_length" },
  // "CUSTOMIZABLE PARTS / Qty / Colors" — identical labels to barber's own
  // Lids section (SHARED field ids, confirmed via inspection).
  { kind: "field", label: "Qty", fieldId: "lids_qty" },
  { kind: "field", label: "Colors", fieldId: "lids_colors" },
  { kind: "field", label: "Heat Range", fieldId: "control_heat_range" },
  { kind: "field", label: "Speed", fieldId: "control_speed_setting" },
  { kind: "field", label: "Temp Range", fieldId: "control_temp_range" },
  { kind: "field", label: "Color", fieldId: "control_color" },
  { kind: "field", label: "Lock Feature", fieldId: "control_lock_feature" },
  { kind: "field", label: "Off/On", fieldId: "control_off_on" },
  { kind: "field", label: "Cool Shot", fieldId: "control_cool_shot" },
  { kind: "field", label: "Auto Shut Off", fieldId: "control_auto_shut_off" },
  { kind: "field", label: "Auto Release", fieldId: "control_auto_release_heat_timer" },
  { kind: "field", label: "Heat Up Time", fieldId: "control_heat_up_time" },
  { kind: "field", label: "Travel Bag/Case", fieldId: "travel_bag_case" },
  { kind: "field", label: "Heat Glove", fieldId: "heat_glove" },
  { kind: "field", label: "Extra Filters", fieldId: "extra_filters" },
  { kind: "field", label: "List Attachments below", fieldId: "attachments_list" },
  // Real template's final row ("Distribted By:", a typo) has no data model
  // yet — genuinely unmapped, per the ticket's own "list for confirmation
  // rather than silently drop" instruction. No Step entry: the forward scan
  // simply never searches for it, so it surfaces nowhere and writes nothing
  // (a deliberate no-op, not a bug) — flagged here in this comment as the
  // one open item from the inspection this file is built from.
];

// ---- BOX ONLY (Item=A, Owner=B, Copy=C, Notes=D) — most values re-export
// an existing Product Knowledge/catalog fact rather than needing their own
// storage; see supplyBoxOnlyFields() below for how those get folded in
// under a synthetic field id this step list can reference like any other.
const BOX_ONLY_STEPS: Step[] = [
  { kind: "field", label: "Product Name", fieldId: "box_product_name" },
  { kind: "field", label: "Collection Name", fieldId: "box_collection_name" },
  { kind: "field", label: "Main Statement", fieldId: "box_main_statement" },
  { kind: "group", label: "Features (6 Max)", fieldIdPrefix: "box_feature", total: 6, offset: 1 },
  { kind: "group", label: "Icons (6 Max)", fieldIdPrefix: "feature_icons", total: 5, offset: 1 },
  { kind: "field", label: "UPC", fieldId: "box_upc" },
  { kind: "field", label: "Warranty", fieldId: "warranty" },
  { kind: "field", label: "Includes", fieldId: "included_summary" },
  { kind: "field", label: "Certifications", fieldId: "certification_needed" },
  { kind: "field", label: "Charger Voltage", fieldId: "charging_voltage" },
];

// ---- BOX ONLY — BEAUTY variant. Confirmed via inspection: shares Product
// Name/Collection Name/Main Statement/Features/Icons/Includes/UPC/Warranty/
// Certifications with barber (same field ids reused), adds Product
// Description, a "SKU" row (barber has none), and reuses the beauty-only
// "Consumer Facing Feature Bullets - LONG" group (identical label/helper
// text to Final Copy's own — real content duplication in the template
// itself, not a mapping error). "Charger Voltage" maps to the beauty
// Electrical & Power section's Voltage field, not barber's charging_voltage
// (different concept — see lib/gtm-field-schema.ts). Several real rows
// (Three Call Outs, Infographic Details, Made In, Social Handles, Copyright
// Year, Distributed By) have no existing field/content decision behind them
// — genuinely unmapped, left with no Step entry rather than guessed, per
// the ticket's own instruction.
const BOX_ONLY_STEPS_BEAUTY: Step[] = [
  { kind: "field", label: "Product Name", fieldId: "box_product_name" },
  { kind: "field", label: "SKU", fieldId: "box_sku" },
  { kind: "field", label: "Collection Name", fieldId: "box_collection_name" },
  { kind: "field", label: "Product Description", fieldId: "product_description" },
  { kind: "field", label: "Main Statement", fieldId: "box_main_statement" },
  { kind: "group", label: "Features (6 Max)", fieldIdPrefix: "box_feature", total: 6, offset: 1 },
  { kind: "group", label: "Icons (6 Max)", fieldIdPrefix: "feature_icons", total: 5, offset: 1 },
  { kind: "group", label: "Consumer Facing Feature Bullets - LONG", fieldIdPrefix: "bullet_long", total: 6, offset: 0 },
  { kind: "field", label: "Includes", fieldId: "included_summary" },
  { kind: "field", label: "UPC", fieldId: "box_upc" },
  { kind: "field", label: "Warranty", fieldId: "warranty" },
  { kind: "field", label: "Charger Voltage", fieldId: "electrical_voltage" },
  { kind: "field", label: "Certifications", fieldId: "certification_needed" },
];

// ---- Product FAQ (Item=A, Value=B) — Q:/A: pairs are matched by position
// (Nth "Q:" -> faq_question_N) since the label itself repeats 10x after
// row insertion; every other row here has its own unique label.
const FAQ_LABELED_STEPS: Step[] = [
  // Real template typo, transcribed verbatim so the label search matches.
  // "Our Differrentiators"/"Selling Position" are pure section headers —
  // their own row has no value cell, the real answer lives one row below.
  { kind: "field", label: "Our Differrentiators", fieldId: "our_differentiators", rowOffset: 1 },
  { kind: "field", label: "Dealer Gross Margins: %", fieldId: "dealer_gross_margin_pct" },
  { kind: "field", label: "Retail Gross Margin: %", fieldId: "retail_gross_margin_pct" },
  // Real template typo ("Intial") + lowercase "ordered", transcribed verbatim.
  { kind: "field", label: "Intial Quantities ordered: #", fieldId: "initial_quantities_ordered" },
  { kind: "field", label: "Selling Position", fieldId: "selling_position", rowOffset: 1 },
  { kind: "field", label: "1:", fieldId: "rep_talking_point_1" },
  { kind: "field", label: "2:", fieldId: "rep_talking_point_2" },
  { kind: "field", label: "3:", fieldId: "rep_talking_point_3" },
];

// ---- Marketing Direction (Item=A, Owner=B, Answer=C, Notes=D) — a fixed
// 25-row layout (1 header + 24 content rows), confirmed against both the
// pristine template and a real filled exemplar. Row 15 (the section header)
// is a "skipRow" — see the Step union above.
const MARKETING_DIRECTION_STEPS: Step[] = [
  { kind: "field", label: "Previous Product Reference", fieldId: "marketing_previous_product_reference" },
  { kind: "field", label: "Primary Goal", fieldId: "marketing_primary_goal" },
  { kind: "field", label: "Success KPIs", fieldId: "marketing_success_kpis" },
  { kind: "field", label: "Marketing Launch Timing", fieldId: "marketing_launch_timing" },
  { kind: "field", label: "Core Audience", fieldId: "marketing_core_audience" },
  { kind: "field", label: "Secondary Audience", fieldId: "marketing_secondary_audience" },
  { kind: "field", label: "Consumer Barrier", fieldId: "marketing_consumer_barrier" },
  { kind: "field", label: "Messaging Direction", fieldId: "marketing_messaging_direction" },
  { kind: "field", label: "Product Name Origin", fieldId: "marketing_product_name_origin" },
  { kind: "field", label: "Visual direction", fieldId: "marketing_visual_direction" },
  { kind: "field", label: "Content ideas or territories", fieldId: "marketing_content_ideas" },
  { kind: "field", label: "Languages", fieldId: "marketing_languages" },
  // Real template uses curly apostrophes ("Do’s / Don’ts"), transcribed
  // verbatim so the label search matches (same discipline as Product FAQ's
  // "Our Differrentiators"/"Intial Quantities ordered" typos).
  { kind: "field", label: "Do’s / Don’ts", fieldId: "marketing_dos_donts" },
  { kind: "skipRow", label: "CHANNEL STRATEGY/CONTENT DELIVERABLES" },
  { kind: "field", label: "Web Coverage", fieldId: "marketing_web_coverage" },
  { kind: "field", label: "Where should we be advertising?", fieldId: "marketing_ad_channels" },
  { kind: "field", label: "Print Material?", fieldId: "marketing_print_material" },
  { kind: "field", label: "Trade Show Launch", fieldId: "marketing_trade_show_launch" },
  { kind: "field", label: "Educator Sampling", fieldId: "marketing_educator_sampling" },
  { kind: "field", label: "Influencer Sampling", fieldId: "marketing_influencer_sampling" },
  { kind: "field", label: "Stylecraft Sales Team", fieldId: "marketing_stylecraft_sales_team" },
  { kind: "field", label: "External Sales Rep Sampling", fieldId: "marketing_external_sales_rep_sampling" },
  { kind: "field", label: "Key Accounts Sampling", fieldId: "marketing_key_accounts_sampling" },
  { kind: "field", label: "Promo", fieldId: "marketing_promo" },
];

// ---- Final Copy (Item=A, Owner=B, Copy=C, Notes=D) — the Content Form
// tab's 15-field export (doc_type="content_form"). Labels/rows confirmed
// via a raw OOXML dump of the real fixture (scripts/fixtures/
// gtm-official-template.xlsx's xl/worksheets/sheet7.xml), listed here in
// the template's own top-to-bottom row order (6, 7, 9, 10, 16, 22, 29, 34,
// 35, 36, 40, 41, 42, 46, 50) — same forward-cursor-disambiguation
// requirement as every other sheet in this file. Ad Sheet Headline/Sub
// Header (Content Form item 13) has NO matching row anywhere in this sheet
// — generated and editable in-app only, deliberately never mapped here
// (not even as a `skipRow`, since there's no real row to skip past).
const FINAL_COPY_STEPS: Step[] = [
  { kind: "field", label: "Tagline/Headline - Sexy", fieldId: "sexy_tagline" },
  { kind: "field", label: "Tagline/Headline - Techie", fieldId: "techie_tagline" },
  { kind: "field", label: "Description (romance copy)", fieldId: "romance_copy" },
  { kind: "group", label: "Consumer Facing Feature Bullets - LONG", fieldIdPrefix: "bullet_long", total: 6, offset: 0 },
  { kind: "group", label: "Consumer Facing Feature Bullets - CONDENSED", fieldIdPrefix: "bullet_condensed", total: 6, offset: 0 },
  { kind: "group", label: "Consumer Facing Feature Bullets - TOP 3", fieldIdPrefix: "bullet_top3", total: 3, offset: 0 },
  { kind: "field", label: "Keyword Search Terms", fieldId: "keywords" },
  { kind: "field", label: "Amazon Long Title", fieldId: "amazon_long_title" },
  { kind: "field", label: "E-commerce Title", fieldId: "ecommerce_title" },
  { kind: "field", label: "Website Title", fieldId: "website_title" },
  { kind: "field", label: "Short Description", fieldId: "short_description" },
  { kind: "field", label: "Suggested Use", fieldId: "suggested_use" },
  { kind: "field", label: "Features & Benefits", fieldId: "features_benefits" },
  { kind: "group", label: "Feature Bullets Top 3 For Web", fieldIdPrefix: "website_copy_short", total: 3, offset: 1 },
  { kind: "group", label: "Feature Bullets Top 3 for Hot Spot", fieldIdPrefix: "website_copy_long", total: 3, offset: 1 },
];

function applyFieldStep(
  workbook: OpenGtmWorkbook,
  sheet: string,
  sheetXml: string,
  labelColumn: string,
  valueColumn: string,
  notesColumn: string | null,
  cursor: number,
  step: Extract<Step, { kind: "field" }>,
  fields: WorkbookFields,
  repairs: WorkbookRepair[],
  unmapped: { sheet: string; label: string }[]
): { xml: string; cursor: number } {
  const labelRow = findRowByLabel(sheetXml, workbook.sharedStrings, labelColumn, step.label, cursor);
  if (labelRow == null) {
    unmapped.push({ sheet, label: step.label });
    return { xml: sheetXml, cursor };
  }
  const valueRow = labelRow + (step.rowOffset ?? 0);
  const answer = answerOf(fields, step.fieldId);
  const { xml: afterAnswer, report } = writeCell(sheetXml, `${valueColumn}${valueRow}`, answer);
  let xml = afterAnswer;
  if (report.hadFormula) repairs.push({ sheet, addr: `${valueColumn}${valueRow}`, oldFormula: report.oldFormula!, newValue: answer });

  if (notesColumn && step.writeNotes !== false) {
    const notes = fields[step.fieldId]?.notes;
    if (notes && notes.trim()) {
      xml = writeCell(xml, `${notesColumn}${valueRow}`, notes.trim()).xml;
    }
  }
  return { xml, cursor: valueRow };
}

function applySteps(
  workbook: OpenGtmWorkbook,
  sheet: string,
  labelColumn: string,
  valueColumn: string,
  notesColumn: string | null,
  steps: Step[],
  fields: WorkbookFields,
  repairs: WorkbookRepair[],
  unmapped: { sheet: string; label: string }[]
): void {
  let xml = workbook.getSheetXml(sheet);
  let cursor = 0;

  for (const step of steps) {
    if (step.kind === "field") {
      const result = applyFieldStep(workbook, sheet, xml, labelColumn, valueColumn, notesColumn, cursor, step, fields, repairs, unmapped);
      xml = result.xml;
      cursor = result.cursor;
    } else if (step.kind === "group") {
      const anchorRow = findRowByLabel(xml, workbook.sharedStrings, labelColumn, step.label, cursor);
      if (anchorRow == null) {
        unmapped.push({ sheet, label: step.label });
        continue;
      }
      for (let i = 0; i < step.total; i++) {
        const rowNum = anchorRow + step.offset + i;
        const answer = answerOf(fields, `${step.fieldIdPrefix}_${i + 1}`);
        xml = writeCell(xml, `${valueColumn}${rowNum}`, answer).xml;
      }
      cursor = anchorRow + step.offset + step.total - 1;
    } else if (step.kind === "combinedRow") {
      const row = findRowByLabel(xml, workbook.sharedStrings, labelColumn, step.label, cursor);
      if (row == null) {
        unmapped.push({ sheet, label: step.label });
        continue;
      }
      cursor = row;
      const combined = step.fieldIds.map(id => answerOf(fields, id)).filter(v => v && v.toUpperCase() !== "N/A").join("\n");
      xml = writeCell(xml, `${valueColumn}${row}`, combined).xml;
    } else {
      // skipRow — advance the cursor past a schema-less label (e.g.
      // Marketing Direction's merged section-header row) without writing
      // anything.
      const row = findRowByLabel(xml, workbook.sharedStrings, labelColumn, step.label, cursor);
      if (row == null) {
        unmapped.push({ sheet, label: step.label });
        continue;
      }
      cursor = row;
    }
  }

  workbook.setSheetXml(sheet, xml);
}

// Folds re-exported/catalog-sourced values (Product Title, Collection,
// UPC) into the same WorkbookFields map under synthetic ids the BOX ONLY
// step list references — keeps applySteps generic (it only ever reads
// `fields[id].answer`), rather than special-casing these 3 rows.
function supplyBoxOnlyFields(input: GtmWorkbookMapperInput): WorkbookFields {
  return {
    ...input.fields,
    box_product_name: { answer: answerOf(input.fields, "product_title") },
    box_collection_name: { answer: input.collection || "" },
    box_upc: { answer: input.upc || "Awaiting internal input" },
    // Beauty-only BOX ONLY row (see BOX_ONLY_STEPS_BEAUTY) — harmless no-op
    // for barber, whose BOX_ONLY_STEPS never references box_sku.
    box_sku: { answer: input.sku || "Awaiting internal input" },
  };
}

const FAQ_PAIR_COUNT = 3;
const FAQ_LAST_TEMPLATE_TRIAD_END_ROW = 12; // rows 4/5/6, 7/8/9, 10/11/12 — 3rd pair's blank row

function applyProductTitleHeaderSku(fields: WorkbookFields, headerSku: string | null): WorkbookFields {
  if (!headerSku) return fields;
  const title = answerOf(fields, "product_title");
  if (!title || title.toUpperCase() === "N/A") return fields;
  return { ...fields, product_title: { ...fields.product_title, answer: `${title} — ${headerSku}` } };
}

// GTM Multi-Template work — Marketing Direction/Product FAQ/Final Copy are
// confirmed (via live inspection of both uploaded templates) to share
// IDENTICAL row order/labels between barber and beauty, so they need no
// per-industry variant; only Product Knowledge and BOX ONLY genuinely
// diverge (see the _BEAUTY arrays above).
export function renderGtmWorkbook(templateBuffer: Buffer, input: GtmWorkbookMapperInput, industry: "barber" | "beauty" = "barber"): GtmWorkbookRenderResult {
  const workbook = openGtmWorkbook(templateBuffer);
  const repairs: WorkbookRepair[] = [];
  const unmapped: { sheet: string; label: string }[] = [];

  const productKnowledgeSteps = industry === "beauty" ? PRODUCT_KNOWLEDGE_STEPS_BEAUTY : PRODUCT_KNOWLEDGE_STEPS;
  const boxOnlySteps = industry === "beauty" ? BOX_ONLY_STEPS_BEAUTY : BOX_ONLY_STEPS;

  const pkFields = applyProductTitleHeaderSku(input.fields, input.headerSku);
  applySteps(workbook, "Product Knowledge", "A", "C", "D", productKnowledgeSteps, pkFields, repairs, unmapped);

  const boxFields = supplyBoxOnlyFields(input);
  applySteps(workbook, "BOX ONLY", "A", "C", null, boxOnlySteps, boxFields, repairs, unmapped);

  applySteps(workbook, "Marketing Direction", "A", "C", "D", MARKETING_DIRECTION_STEPS, input.fields, repairs, unmapped);

  // Content Form fields are merged into the same input.fields map by the
  // caller (field ids don't collide with GTM_FIELD_SCHEMA's own ids) —
  // applySteps only ever reads fields[id].answer, so no separate parameter
  // is needed here.
  applySteps(workbook, "Final Copy", "A", "C", "D", FINAL_COPY_STEPS, input.fields, repairs, unmapped);

  // Product FAQ's template already has exactly FAQ_PAIR_COUNT (3)
  // pre-built Q:/A:/blank triads, so no row growth is needed anymore —
  // this insertion step is now a no-op in practice, kept so a future
  // increase to FAQ_PAIR_COUNT still grows the sheet correctly.
  const faqXmlBeforeInsert = workbook.getSheetXml("Product FAQ");
  const existingQRows = findAllRowsByLabel(faqXmlBeforeInsert, workbook.sharedStrings, "A", "Q:");
  const newPairsNeeded = Math.max(0, FAQ_PAIR_COUNT - existingQRows.length);
  const faqXmlInserted = newPairsNeeded > 0
    ? insertFaqRows(faqXmlBeforeInsert, FAQ_LAST_TEMPLATE_TRIAD_END_ROW, newPairsNeeded)
    : faqXmlBeforeInsert;
  workbook.setSheetXml("Product FAQ", faqXmlInserted);

  let faqXml = workbook.getSheetXml("Product FAQ");
  const qRows = findAllRowsByLabel(faqXml, workbook.sharedStrings, "A", "Q:");
  const aRows = findAllRowsByLabel(faqXml, workbook.sharedStrings, "A", "A:");
  for (let i = 0; i < Math.min(FAQ_PAIR_COUNT, qRows.length); i++) {
    faqXml = writeCell(faqXml, `B${qRows[i]}`, answerOf(input.fields, `faq_question_${i + 1}`)).xml;
  }
  for (let i = 0; i < Math.min(FAQ_PAIR_COUNT, aRows.length); i++) {
    faqXml = writeCell(faqXml, `B${aRows[i]}`, answerOf(input.fields, `faq_answer_${i + 1}`)).xml;
  }
  workbook.setSheetXml("Product FAQ", faqXml);
  applySteps(workbook, "Product FAQ", "A", "B", null, FAQ_LABELED_STEPS, input.fields, repairs, unmapped);

  // Content Form / "Final Copy" — the request was to surface this tab
  // right next to BOX ONLY, labeled "Content Form", so the whole GTM +
  // Content Form output lives in one downloaded workbook instead of two
  // separate exports. This ONLY reorders/relabels the tab in the output
  // file (see repositionAndRenameSheet's own comment) — every write above
  // already happened against the sheet's real, original name ("Final
  // Copy"), so this must run last. ad_sheet_headline/ad_sheet_sub_header
  // still have no destination row anywhere in the real uploaded template
  // (see FINAL_COPY_STEPS' own comment) — inserting new rows here was
  // evaluated and deliberately NOT done: the sheet's later sections
  // (WEB ONLY - SPEC CHART at row 62, and 3 more repeated form copies with
  // their own merge cells/data validations through row 113) all reference
  // absolute row numbers that a mid-sheet insertion would need to shift
  // correctly, with no way to confirm the sheet's <drawing> part has no
  // row-anchored content in that range without importing and auditing
  // xl/drawings/drawing1.xml too — a real risk to a delicate, real
  // business template for 2 of 33 fields. Those 2 remain in-app-only.
  repositionAndRenameSheet(workbook.zip, "Final Copy", "BOX ONLY", "Content Form");

  return { buffer: generateGtmWorkbookBuffer(workbook), repairs, unmapped };
}

// GTM Multi-Template work — the BARBER template's own known labels, used as
// the "reference" side of a newly-uploaded (beauty) template's upload-time
// inspection diff (lib/gtm-workbook-inspection.ts). Barber is the reference
// because it's today's already-proven, already-integrated template.
function stepsToLabels(steps: Step[]): string[] {
  return steps.map(s => s.label);
}

export function getReferenceLabelsForSheet(sheetName: string): string[] {
  switch (sheetName) {
    case "Product Knowledge": return stepsToLabels(PRODUCT_KNOWLEDGE_STEPS);
    case "BOX ONLY": return stepsToLabels(BOX_ONLY_STEPS);
    case "Marketing Direction": return stepsToLabels(MARKETING_DIRECTION_STEPS);
    case "Product FAQ": return stepsToLabels(FAQ_LABELED_STEPS);
    case "Final Copy": return stepsToLabels(FINAL_COPY_STEPS);
    default: return [];
  }
}
