// The Technical Data Sheet (TDS) field schema — a live, real-time snapshot
// of the product's actual specs (scraped from the official product page
// and/or the Amazon listing), never a marketing narrative and never
// estimated. Every field is "grounded": it must trace back to the
// product's `product_snapshots` row or the project record, or read
// "Not listed on product page" (see lib/tds-generate.ts). TDS has no
// regenerate path — only manual edits with history, and an explicit
// "re-capture snapshot" action that creates a new snapshot version.
//
// Spec-field ids that TDS shares in concept with GTM (motor, blades,
// lids, lever, guards, charging, included-in-box, packaging, pricing,
// warranty, certification) are DELIBERATELY IDENTICAL to
// lib/gtm-field-schema.ts's ids, reused directly from GTM_FIELD_SCHEMA
// below — GTM's deterministic derivation (lib/gtm-derive.ts) reads TDS's
// document_fields by these same ids, so there is exactly one vocabulary
// for "what a spec field is called," not two that need translating.
import { GTM_FIELD_SCHEMA, GtmFieldKind } from "./gtm-field-schema";

export interface TdsField {
  id: string;
  section: string;
  question: string;
  // Inherited from the matching GTM field where one exists, EXCEPT
  // TDS_KEEPS_GROUNDED_IDS below (real spec facts that legitimately appear
  // in a scraped listing even though GTM treats them as internal-only) —
  // TDS-only fields default to "grounded" since none of them are
  // internal-decision fields.
  kind: GtmFieldKind;
  owner?: string;
}

function field(id: string, section: string, question: string): TdsField {
  return { id, section, question, kind: "grounded" };
}

// Ids pulled from GTM_FIELD_SCHEMA — technical spec facts only, never the
// marketing/narrative fields (positioning, USPs, story, etc.) that live
// exclusively on the GTM sheet.
const REUSED_GTM_FIELD_IDS = [
  // General — identification/spec facts only
  "product_title", "approved_pricing", "trademark_symbol", "warranty", "certification_needed", "manufacturer",
  // Packaging & Logistics
  "dieline", "box_type", "product_lwh", "product_weight", "box_lwh", "measurement_by", "box_weight", "pallet_tier_total", "pallets_high",
  // Tool Description
  "material", "care_directions", "product_description",
  // Motor
  "motor_type", "motor_rpm", "motor_run_time", "motor_speed",
  // Heat/Plate Technology
  "plate_material", "heater_type", "max_temp_class",
  // Blades
  "blade_name", "fixed_blade", "cutting_blade",
  // Lids
  "lids_qty", "lids_colors",
  // Lever
  "lever_type", "lever_qty", "lever_color",
  // Guards
  "guards_type", "guards_qty", "guards_color",
  // Charging
  "charging_light_color", "charging_base_color", "charging_cord_color", "charging_cord_length", "charging_port", "charging_voltage", "charging_logo_color", "charging_led_function",
  // Included in Box
  "screw_driver_color", "screw_driver_brand", "screw_driver_other", "stretch_bracket_color",
  "axis_shield_qty", "axis_shield_color", "axis_shield_material", "axis_shield_description",
  "cam_follower_qty", "cam_follower_color", "cleaning_brush_qty", "cleaning_brush_color",
  "oil_bottle_qty", "extra_screws_qty", "extra_screws_color", "whats_in_box_list",
];

const gtmById = new Map(GTM_FIELD_SCHEMA.map(f => [f.id, f]));

// Lids/Lever/Guards/Charging/hand-tailored Included in Box became
// "internal"-kind on the GTM side (real ops/packaging specs — see
// lib/gtm-field-schema.ts's INTERNAL_FIELD_IDS) so GTM's own AI/web-search
// tier stops guessing at them, letting a human fill them in directly.
// TDS's relationship to these same ids is different: TDS never "guesses" —
// it only ever scrapes the real product-page/Amazon-listing content or
// says "Not listed" — and this exact info (guard comb sizes, lever color,
// charger port type, what ships in the box) commonly IS present in a real
// listing. Blindly inheriting GTM's "internal" kind here would silently
// stop TDS from scraping real, genuinely-findable spec data for no reason
// tied to TDS at all — so these ids are pinned back to "grounded" for TDS
// specifically, overriding whatever GTM_FIELD_SCHEMA currently says.
const TDS_KEEPS_GROUNDED_IDS = new Set([
  "lids_qty", "lids_colors",
  "lever_type", "lever_qty", "lever_color",
  "guards_type", "guards_qty", "guards_color",
  "charging_light_color", "charging_base_color", "charging_cord_color", "charging_cord_length", "charging_port", "charging_voltage", "charging_logo_color", "charging_led_function",
  "screw_driver_color", "screw_driver_brand", "screw_driver_other", "stretch_bracket_color",
  "axis_shield_qty", "axis_shield_color", "axis_shield_material", "axis_shield_description",
  "cam_follower_qty", "cam_follower_color", "cleaning_brush_qty", "cleaning_brush_color",
  "oil_bottle_qty", "extra_screws_qty", "extra_screws_color",
]);

// Fields that only exist on the TDS (no GTM counterpart).
const TDS_ONLY_FIELDS: TdsField[] = [
  field("model_number", "General", "Model Number"),
  field("country_of_origin", "General", "Country of Origin"),
  field("safety_notes", "Tool Description", "Safety Notes"),
];

export const TDS_FIELD_SCHEMA: TdsField[] = [
  ...REUSED_GTM_FIELD_IDS.map(id => {
    const f = gtmById.get(id);
    if (!f) throw new Error(`TDS_FIELD_SCHEMA: "${id}" no longer exists in GTM_FIELD_SCHEMA`);
    const kind = TDS_KEEPS_GROUNDED_IDS.has(id) ? "grounded" : f.kind;
    const owner = kind === "internal" ? f.owner : undefined;
    return { id: f.id, section: f.section, question: f.question, kind, owner };
  }),
  ...TDS_ONLY_FIELDS,
];

export const TDS_SECTIONS = Array.from(new Set(TDS_FIELD_SCHEMA.map(f => f.section)));

export type TdsFieldSource = "product_snapshot" | "amazon" | "official_site" | "project_record" | "manual_edit" | "web" | "gtm_cross_fill" | "none";

export interface TdsFieldAnswer {
  answer: string;
  source: TdsFieldSource;
  sourceDetail?: any;
  flagged?: boolean;
}
