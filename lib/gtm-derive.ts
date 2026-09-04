// Deterministic, code-only field derivation for the GTM Product Knowledge
// sheet — runs regardless of whether an AI provider is available/working.
// The AI (app/api/documents/generate/route.ts) still attempts all 77 fields
// and takes priority when it returns something real (after grounding
// verification); this is what backs the sheet when the AI is down/quota-
// exhausted, and what the AI's own answers get checked against as a floor.
// Only maps fields that the project record or TDS/Sales Kit/Active Report
// genuinely contain structured data for — everything else is left for the
// AI or "N/A", never guessed.
//
// Source hierarchy (highest authority first): the project record itself
// (name, description, category, motorFamily/motorBrandedName (or legacy
// motorTech), keyDiff, pricePoint, companyContext — entered directly by the
// team) > project documents
// (Competitive Analysis, TDS, Sales Kit) > real web search (all 77 fields
// are eligible — see lib/gtm-generate.ts's callAi/applyWebSearchFallback)
// > N/A.
//
// `tds` is a flat field_id -> answer map (TDS's document_fields rows,
// see lib/db/documents.ts) — TDS's spec-field ids are deliberately
// identical to the GTM ids used below (lib/tds-field-schema.ts), so this
// is a direct same-key lookup, not a translation between two vocabularies.
import { GtmFieldAnswer, GtmFieldSource } from "./gtm-field-schema";
import { pick, firstOf } from "./field-pick";

// Re-exported for backward compatibility — pick/firstOf moved to
// lib/field-pick.ts to break a circular import (this module needs to import
// computeTiers/parsePriceToNumber FROM lib/pricing-analysis.ts, which itself
// already imported firstOf from here).
export { pick, firstOf };

export interface ProjectRecord {
  productName: string;
  description?: string | null;
  category?: string | null;
  toolType?: string | null;
  // Canonical motor family key (lib/validations.ts's MOTOR_FAMILY_VALUES) +
  // optional display-only branded name — see motorLabel() below.
  // motorTech is the legacy free-text field, kept only as a fallback for
  // projects created before the canonical select existed.
  motorFamily?: string | null;
  motorBrandedName?: string | null;
  motorTech?: string | null;
  keyDiff?: string | null;
  pricePoint?: string | null;
  companyContext?: string | null;
  // "pro" | "consumer" | "both" — already captured on every project (the
  // analyze/new-project forms' Target Market select). Core Consumer's new
  // select control (GTM Schema v3) derives straight from this instead of
  // free AI narrative, since it's real, already-known data.
  targetMarket?: string | null;
  // Uploaded TDS Ingestion — a product with neither is "pre-launch/custom"
  // (no live web presence for the AI web-search tier to find anything),
  // which gates the <UPLOADED_TDS>-only narrative grounding rule and the
  // web-search skip in lib/gtm-generate.ts/lib/web-search-fallback.ts.
  productUrl?: string | null;
  asin?: string | null;
  // GTM Multi-Template work — mixed-collection override ('barber'|'beauty'),
  // see lib/gtm-field-schema.ts's resolveGtmFamily.
  gtmTemplateOverride?: string | null;
  // Reference Links — see lib/gtm-reference-links.ts.
  referenceUrls?: string[] | null;
  // Predecessor Product Reference — see lib/predecessor-product-context.ts.
  predecessorRef?: string | null;
  // org_id — needed to resolve predecessorRef Tier 1 (an existing project
  // in this same org with a matching name and a real GTM document).
  orgId?: string | null;
}

// Core Consumer's 3 fixed options map 1:1 onto the project's own
// targetMarket value — same mapping as analyze/page.tsx's MARKET_LABELS.
const CORE_CONSUMER_LABELS: Record<string, string> = {
  pro: "Pro",
  consumer: "Retail",
  both: "Both",
};

// The 7 canonical family labels, fixed by design — mirrors
// lib/validations.ts's MOTOR_FAMILY_VALUES and the seed labels in
// supabase_schema.sql's Section 25 / lib/memoryDb.ts's
// seedMotorFamilyDefaults. Duplicated as a small static map here (rather
// than fetching lib/db/motor-families.ts's live table) because this module
// must stay synchronous/DB-free — every other field here is derived from
// plain in-memory sources, and this list never changes independently of a
// code change anyway.
const MOTOR_FAMILY_LABELS: Record<string, string> = {
  magnetic: "Magnetic Motor",
  pivot: "Pivot Motor",
  rotary: "Rotary Motor",
  brushless: "Brushless Motor",
  vector: "Vector Motor",
  ac_motor: "AC Motor",
  dc_motor: "DC Motor",
};

// Canonical family label, plus the branded name in parens when given (e.g.
// "Brushless Motor (EON Digital Brushless Motor)") — never the branded name
// alone, so grounding/display always leads with the universal type. Returns
// "" when motorFamily isn't one of the 7 canonical keys (a legacy project
// with only free-text motorTech), letting the caller fall back to that.
export function motorLabel(motorFamily?: string | null, motorBrandedName?: string | null): string {
  const label = motorFamily ? MOTOR_FAMILY_LABELS[motorFamily] : undefined;
  if (!label) return "";
  return motorBrandedName?.trim() ? `${label} (${motorBrandedName.trim()})` : label;
}

export function deriveFieldsFromSources(
  project: ProjectRecord,
  salesKit: any | null,
  tds: Record<string, string> | null,
  activeReport: { competitive_analysis?: any; pricing_analysis?: any; content_form?: any } | null
): Record<string, GtmFieldAnswer> {
  const fields: Record<string, GtmFieldAnswer> = {};
  const set = (id: string, value: GtmFieldAnswer | null) => {
    if (value) fields[id] = value;
  };
  // Fills a repeatable-row group's rows 1..N from a plain string list —
  // stops at however many real items exist, never force-fills a trailing
  // row (see lib/gtm-group-fields.ts's trailing-empty-row trim downstream).
  const setGroup = (idPrefix: string, items: string[], source: GtmFieldSource) => {
    items.forEach((text, i) => set(`${idPrefix}_${i + 1}`, pick(text, source)));
  };

  const t = tds || {};
  const ca = activeReport?.competitive_analysis || {};
  const pricing = activeReport?.pricing_analysis || {};
  // Canonical family + branded name combined for display — "" for a legacy
  // project with no motorFamily, letting the firstOf() calls below fall
  // back to the old free-text motorTech.
  const motorTypeLabel = motorLabel(project.motorFamily, project.motorBrandedName);

  // General — project record wins where it directly answers the field.
  set("item", firstOf([project.productName, "project_record"]));
  set("product_title", firstOf([project.productName, "project_record"], [t.product_title, "tds"]));
  set("core_consumer", pick(project.targetMarket ? CORE_CONSUMER_LABELS[project.targetMarket] : null, "project_record"));
  set("positioning_statement", pick(ca.positioning_recommendation, "active_report"));
  set("approved_pricing", firstOf([project.pricePoint, "project_record"], [t.approved_pricing, "tds"], [pricing.price_positioning, "active_report"]));
  // features_full_list is now a 5-row group (features_full_list_1..5) —
  // its 3-source merge deriver lives in lib/gtm-features-and-tip.ts's
  // deriveFeaturesFullList, run as an async Tier 6.5 step, not here.
  // up_sell/cross_sell_1..2 have no structured source today — left for AI/N/A.
  set("reason_to_buy", firstOf([salesKit?.elevator_pitch, "sales_kit"], [project.keyDiff, "project_record"]));
  set("warranty", pick(t.warranty, "tds"));
  set("certification_needed", pick(t.certification_needed, "tds"));
  set("trademark_symbol", pick(t.trademark_symbol, "tds"));
  set("manufacturer", pick(t.manufacturer, "tds"));

  // Packaging & Logistics — TDS carries product (not box/pallet) dimensions
  set("dieline", pick(t.dieline, "tds"));
  set("box_type", pick(t.box_type, "tds"));
  set("product_lwh", pick(t.product_lwh, "tds"));
  set("product_weight", pick(t.product_weight, "tds"));
  set("box_lwh", pick(t.box_lwh, "tds"));
  set("measurement_by", pick(t.measurement_by, "tds"));
  set("box_weight", pick(t.box_weight, "tds"));
  set("pallet_tier_total", pick(t.pallet_tier_total, "tds"));
  set("pallets_high", pick(t.pallets_high, "tds"));

  // Tool Description
  set("material", pick(t.material, "tds"));
  setGroup("top_6_features", (salesKit?.key_features || []).slice(0, 5).map((f: any) => f.headline).filter(Boolean), "sales_kit");
  set("care_directions", pick(t.care_directions, "tds"));
  set("product_description", pick(t.product_description, "tds"));

  // Motor — the canonical family (+ branded name in parens, team-entered)
  // outranks TDS's captured specs; a legacy project with no motorFamily
  // falls back to the old free-text motorTech.
  set("motor_type", firstOf([motorTypeLabel || project.motorTech, "project_record"], [t.motor_type, "tds"]));
  set("motor_rpm", pick(t.motor_rpm, "tds"));
  set("motor_run_time", pick(t.motor_run_time, "tds"));
  set("motor_speed", pick(t.motor_speed, "tds"));

  // Blades
  set("blade_name", pick(t.blade_name, "tds"));
  set("fixed_blade", pick(t.fixed_blade, "tds"));
  set("cutting_blade", pick(t.cutting_blade, "tds"));

  // Lids
  set("lids_qty", pick(t.lids_qty, "tds"));
  set("lids_colors", pick(t.lids_colors, "tds"));

  // Lever
  set("lever_type", pick(t.lever_type, "tds"));
  set("lever_qty", pick(t.lever_qty, "tds"));
  set("lever_color", pick(t.lever_color, "tds"));

  // Guards
  set("guards_type", pick(t.guards_type, "tds"));
  set("guards_qty", pick(t.guards_qty, "tds"));
  set("guards_color", pick(t.guards_color, "tds"));

  // Charging
  set("charging_light_color", pick(t.charging_light_color, "tds"));
  set("charging_base_color", pick(t.charging_base_color, "tds"));
  set("charging_cord_color", pick(t.charging_cord_color, "tds"));
  set("charging_cord_length", pick(t.charging_cord_length, "tds"));
  set("charging_port", pick(t.charging_port, "tds"));
  set("charging_voltage", pick(t.charging_voltage, "tds"));
  set("charging_logo_color", pick(t.charging_logo_color, "tds"));
  set("charging_led_function", pick(t.charging_led_function, "tds"));

  // Included in Box
  set("screw_driver_color", pick(t.screw_driver_color, "tds"));
  set("screw_driver_brand", pick(t.screw_driver_brand, "tds"));
  set("screw_driver_other", pick(t.screw_driver_other, "tds"));
  set("stretch_bracket_color", pick(t.stretch_bracket_color, "tds"));
  set("axis_shield_qty", pick(t.axis_shield_qty, "tds"));
  set("axis_shield_color", pick(t.axis_shield_color, "tds"));
  set("axis_shield_material", pick(t.axis_shield_material, "tds"));
  set("axis_shield_description", pick(t.axis_shield_description, "tds"));
  set("cam_follower_qty", pick(t.cam_follower_qty, "tds"));
  set("cam_follower_color", pick(t.cam_follower_color, "tds"));
  set("cleaning_brush_qty", pick(t.cleaning_brush_qty, "tds"));
  set("cleaning_brush_color", pick(t.cleaning_brush_color, "tds"));
  set("oil_bottle_qty", pick(t.oil_bottle_qty, "tds"));
  set("extra_screws_qty", pick(t.extra_screws_qty, "tds"));
  set("extra_screws_color", pick(t.extra_screws_color, "tds"));
  set("whats_in_box_list", pick(t.whats_in_box_list, "tds"));

  return fields;
}
