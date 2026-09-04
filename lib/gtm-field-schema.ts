// The "Product Knowledge" spec sheet for the Go-To-Market tab — GTM Schema
// v3's full field inventory (see the repo owner's own numbered spec, GTM
// Schema v3). Single source of truth for both the generation pipeline
// (app/api/documents/generate, lib/gtm-derive.ts, lib/gtm-grounding.ts) and
// the UI grid (ProductKnowledgeSection in
// app/(app)/dashboard/projects/[id]/page.tsx) — every consumer must iterate
// this list, never hardcode the field count or IDs elsewhere.

export type GtmFieldKind = "grounded" | "written" | "internal";

export interface GtmField {
  id: string;
  section: string;
  question: string;
  // grounded = spec/number/color/qty fact — must trace back to an actual
  // source or become N/A (see lib/gtm-grounding.ts). written = narrative
  // copy that should be specific to this product, checked for
  // boilerplate/duplication against other products (see lib/text-similarity.ts).
  // internal = a genuine human/team decision (packaging engineering, final
  // approved price) that no source document, web search, or derivation can
  // ever answer — AI/web/derived/category tiers are skipped entirely for
  // these; unresolved ones surface as "Awaiting internal input", never N/A.
  kind: GtmFieldKind;
  // Default team owner for internal-kind fields only — shown next to the
  // "Awaiting internal input" chip so it's clear who to ask.
  owner?: string;
  // Muted caption rendered under the question label — for instructions that
  // must appear verbatim (e.g. Comparison Chart WEB ONLY's exact spec text),
  // rather than folded into the question itself.
  helperText?: string;
  // Marks a field whose UI control is NOT the default plain textarea — the
  // render loop in ProductKnowledgeSection special-cases these ids/kinds.
  // Every other field (the vast majority) is left undefined and renders the
  // generic textarea. "select" is generic (keyed off uiControl+options, not
  // a per-field-id branch); "sku_picker" is the one per-field-id exception
  // (Comparison Chart WEB ONLY).
  uiControl?: "sku_picker" | "select";
  // Fixed choices for uiControl:"select" fields — an AI/derived answer not
  // exactly matching one of these (case-insensitive) is treated as
  // unresolved rather than accepted as free text.
  options?: string[];
  // Marks one row of a repeatable-row group (Features/Cross Sell/Top 6/
  // Icons) — same document_fields row shape as every other field (own
  // Owner/Notes/history), just tagged so the UI can render row groups and
  // CSV/PDF can trim trailing empty rows. See lib/gtm-group-fields.ts.
  group?: { id: string; index: number; total: number };
  // GTM workbook export work — the official template has NO Axis Shield
  // rows at all (confirmed against the real file), so these 4 fields are
  // "legacy": still generated normally if a product genuinely has real
  // data for them, but hidden from the UI (and excluded from completion %)
  // when empty, rather than always showing an empty row. See
  // visibleGtmSchema() below.
  legacyOptional?: boolean;
  // GTM Multi-Template work — omitted means shared/common (every product
  // sees it, matching today's behavior exactly). 'clipper_trimmer_shaver'
  // marks a field the real BARBER workbook template has and the real
  // BEAUTY template does NOT (Blades/Lever/Guards/Charging — confirmed via
  // live inspection of both uploaded templates); 'beauty' marks a field
  // that's the reverse (Curling Iron/Flat Iron/Blow Dryer/Electrical &
  // Power/Control Settings specs — present only in the beauty template).
  // Orthogonal to primary_criterion (a Hair Dryer is family:beauty but
  // primary_criterion:motor) — see structurallyInapplicableFieldIds in
  // lib/gtm-generate.ts, which reads BOTH.
  family?: "clipper_trimmer_shaver" | "beauty";
}

export type GtmFamily = "clipper_trimmer_shaver" | "beauty";

// GTM Multi-Template work — the single source of truth for "which family
// applies to this product," reused everywhere a decision depends on it: the
// in-app field schema (visibleGtmSchema), the generation pipeline's N/A
// gating (structurallyInapplicableFieldIds), and workbook export template
// selection. `gtmTemplateOverride` (a project-level "Export using: Barber /
// Beauty" pin for mixed-collection products, e.g. a shaver marketed inside
// a beauty line) always wins over the tool type's own family when set;
// otherwise resolves from the matched tool type's `family` column
// (lib/db/tool-types.ts) — never from `project.industry`, which this
// codebase has repeatedly found unsuitable for branching (only 2
// substring-overlapping values, see lib/legacy-brand-registry.ts's own
// warning comment). Returns undefined when neither an override nor a
// resolvable tool type exists — callers treat that as "don't filter/gate on
// family," identical to today's pre-multi-template behavior.
export function resolveGtmFamily(
  project: { toolType?: string | null; gtmTemplateOverride?: string | null },
  toolTypes: { type_key: string; family: string | null }[]
): GtmFamily | undefined {
  if (project.gtmTemplateOverride === "barber") return "clipper_trimmer_shaver";
  if (project.gtmTemplateOverride === "beauty") return "beauty";
  const match = toolTypes.find(t => t.type_key === project.toolType);
  return (match?.family as GtmFamily | null | undefined) ?? undefined;
}

// Narrative fields — the rest of the schema defaults to "grounded".
const WRITTEN_FIELD_IDS = new Set([
  "why_creating_item",
  "positioning_statement",
  "product_name_origin",
  "name_story_tie",
  "new_line_or_current",
  "new_technology",
  "up_sell",
  "reason_to_buy",
  "expert_tip",
  // Product FAQ section (GTM workbook export work)
  "our_differentiators",
  "selling_position",
  "rep_talking_point_1",
  "rep_talking_point_2",
  "rep_talking_point_3",
  // faq_question_N/faq_answer_N are written too — added via WRITTEN_FIELD_IDS
  // below once the group ids are known (see the groupFields loop further
  // down), rather than listing all 20 ids by hand here.
  // Box Only section
  "box_main_statement",
  // Marketing Direction section (GTM workbook export work, 4th filled tab)
  "marketing_primary_goal",
  "marketing_success_kpis",
  "marketing_launch_timing",
  "marketing_core_audience",
  "marketing_secondary_audience",
  "marketing_consumer_barrier",
  "marketing_messaging_direction",
  "marketing_product_name_origin",
  "marketing_visual_direction",
  "marketing_content_ideas",
  "marketing_languages",
  "marketing_dos_donts",
  "marketing_web_coverage",
  "marketing_ad_channels",
  "marketing_print_material",
  "marketing_trade_show_launch",
]);
for (let i = 1; i <= 3; i++) {
  WRITTEN_FIELD_IDS.add(`faq_question_${i}`);
  WRITTEN_FIELD_IDS.add(`faq_answer_${i}`);
}
for (let i = 1; i <= 6; i++) {
  WRITTEN_FIELD_IDS.add(`box_feature_${i}`);
}

// Genuine internal-decision fields — never answerable by AI, web search, or
// derivation, only by a real team decision. See GtmFieldKind above.
export const INTERNAL_FIELD_IDS = new Set([
  "dieline",
  "box_type",
  "measurement_by",
  "pallet_tier_total",
  "pallets_high",
  "approved_pricing",
  "trademark_symbol",
  "rating_label",
  // Product FAQ section's margin/quantity rows — genuine business decisions
  // made after FAQ generation, not derivable from any source or web search.
  "dealer_gross_margin_pct",
  "retail_gross_margin_pct",
  "initial_quantities_ordered",
  // Marketing Direction section's sampling/promo rows — internal-decision
  // quantities (per spec: a recommended POSTURE like "Send to all educators"
  // may be proposed, but a genuine numeric count is never AI-invented).
  "marketing_educator_sampling",
  "marketing_influencer_sampling",
  "marketing_stylecraft_sales_team",
  "marketing_external_sales_rep_sampling",
  "marketing_key_accounts_sampling",
  "marketing_promo",
  // Lids / Customizable Parts, Lever, Guards, Charging, and the hand-
  // tailored Included in Box accessory rows — real packaging/hardware specs
  // that only Ops actually knows (guard comb sizes, lever color, charger
  // port type, which accessories genuinely ship in the box), never
  // something AI/web search should guess. Moved from "grounded" to
  // "internal" so generation never attempts them and they surface as
  // "Awaiting Internal Input" in-app (see INTERNAL_FIELD_OWNERS below) —
  // exported blank in the GTM workbook, ready for direct manual entry (see
  // lib/gtm-workbook-data-mapper.ts's answerOf). whats_in_box_list (a real
  // Amazon "what's in the box" fact) and included_summary (a pure
  // derivation of these same fields, already zero-AI) are deliberately left
  // out — they aren't guesses, so there's nothing to stop guessing.
  "lids_qty",
  "lids_colors",
  "lever_type",
  "lever_qty",
  "lever_color",
  "guards_type",
  "guards_qty",
  "guards_color",
  "charging_light_color",
  "charging_base_color",
  "charging_cord_color",
  "charging_cord_length",
  "charging_port",
  "charging_voltage",
  "charging_logo_color",
  "charging_led_function",
  "screw_driver_color",
  "screw_driver_brand",
  "screw_driver_other",
  "stretch_bracket_color",
  "axis_shield_qty",
  "axis_shield_color",
  "axis_shield_material",
  "axis_shield_description",
  "cam_follower_qty",
  "cam_follower_color",
  "cleaning_brush_qty",
  "cleaning_brush_color",
  "oil_bottle_qty",
  "extra_screws_qty",
  "extra_screws_color",
  "travel_bag_case",
  "heat_glove",
  "extra_filters",
  "attachments_list",
]);

const INTERNAL_FIELD_OWNERS: Record<string, string> = {
  dieline: "Ops",
  box_type: "Ops",
  measurement_by: "Ops",
  pallet_tier_total: "Ops",
  pallets_high: "Ops",
  approved_pricing: "Sales",
  trademark_symbol: "Legal",
  rating_label: "Product Marketing",
  dealer_gross_margin_pct: "Sales",
  retail_gross_margin_pct: "Sales",
  initial_quantities_ordered: "Sales",
  marketing_educator_sampling: "Marketing",
  marketing_influencer_sampling: "Marketing",
  marketing_stylecraft_sales_team: "Marketing",
  marketing_external_sales_rep_sampling: "Marketing",
  marketing_key_accounts_sampling: "Marketing",
  marketing_promo: "Marketing",
  lids_qty: "Ops",
  lids_colors: "Ops",
  lever_type: "Ops",
  lever_qty: "Ops",
  lever_color: "Ops",
  guards_type: "Ops",
  guards_qty: "Ops",
  guards_color: "Ops",
  charging_light_color: "Ops",
  charging_base_color: "Ops",
  charging_cord_color: "Ops",
  charging_cord_length: "Ops",
  charging_port: "Ops",
  charging_voltage: "Ops",
  charging_logo_color: "Ops",
  charging_led_function: "Ops",
  screw_driver_color: "Ops",
  screw_driver_brand: "Ops",
  screw_driver_other: "Ops",
  stretch_bracket_color: "Ops",
  axis_shield_qty: "Ops",
  axis_shield_color: "Ops",
  axis_shield_material: "Ops",
  axis_shield_description: "Ops",
  cam_follower_qty: "Ops",
  cam_follower_color: "Ops",
  cleaning_brush_qty: "Ops",
  cleaning_brush_color: "Ops",
  oil_bottle_qty: "Ops",
  extra_screws_qty: "Ops",
  extra_screws_color: "Ops",
  travel_bag_case: "Ops",
  heat_glove: "Ops",
  extra_filters: "Ops",
  attachments_list: "Ops",
};

interface FieldExtra {
  helperText?: string;
  uiControl?: "sku_picker" | "select";
  options?: string[];
  group?: { id: string; index: number; total: number };
  legacyOptional?: boolean;
  // Default team owner for non-internal fields — Marketing Direction's
  // written fields all default to "Marketing" (the workbook template's own
  // hard-coded Owner column for that tab), shown in the in-app Owner
  // dropdown the same way internal-kind fields already show their owner.
  owner?: string;
  family?: "clipper_trimmer_shaver" | "beauty";
}

function field(id: string, section: string, question: string, extra?: FieldExtra): GtmField {
  const kind: GtmFieldKind = WRITTEN_FIELD_IDS.has(id) ? "written" : INTERNAL_FIELD_IDS.has(id) ? "internal" : "grounded";
  const owner = extra?.owner ?? (kind === "internal" ? INTERNAL_FIELD_OWNERS[id] : undefined);
  return { id, section, question, kind, ...(owner ? { owner } : {}), ...extra };
}

// Builds one repeatable-row group — N field entries sharing an id prefix,
// each independently editable (own Owner/Notes/history via the normal
// document_fields row) but visually and export-wise treated as one group
// (lib/gtm-group-fields.ts's filterTrailingEmptyGroupRows, the UI's group
// render branch in ProductKnowledgeSection).
function groupFields(idPrefix: string, section: string, rowLabel: string, total: number): GtmField[] {
  return Array.from({ length: total }, (_, i) => {
    const index = i + 1;
    return field(`${idPrefix}_${index}`, section, `${rowLabel} #${index}`, { group: { id: idPrefix, index, total } });
  });
}

export const GTM_FIELD_SCHEMA: GtmField[] = [
  // General
  field("item", "General", "Item"),
  field("core_consumer", "General", "Core Consumer", { uiControl: "select", options: ["Pro", "Retail", "Both"] }),
  field("why_creating_item", "General", "Why are we creating this item? (consumer need, competitive product, etc.)"),
  field("positioning_statement", "General", "What is the positioning statement? (story)"),
  field("product_name_origin", "General", "Product Name Origin"),
  field("name_story_tie", "General", "How does this product name tie to the story?"),
  field("new_line_or_current", "General", "New Line or Current Collection?"),
  field("new_technology", "General", "New Technology?"),
  field("approved_pricing", "General", "Approved Pricing", { helperText: "Format: Salon: $X   Retail: $Y" }),
  field("good_better_best", "General", "Good Better Best (Lineup)"),
  field("good_better_best_performance", "General", "Good Better Best (Performance)"),
  field("hair_type", "General", "Hair Type"),
  ...groupFields("features_full_list", "General", "Feature", 5),
  field("up_sell", "General", "Up-sell (Sales play opportunity)"),
  ...groupFields("cross_sell", "General", "Cross Sell Product", 2),
  field("reason_to_buy", "General", "Reason to Buy (Unique Selling Points)"),
  field("expert_tip", "General", "Expert Tip"),
  field("comparison_chart_web_only", "General", "Comparison Chart WEB ONLY", {
    helperText: "Select two products to feature as comparisons on the DTC site and provide the SKUs. You may include products from either StyleCraft or Gamma+.",
    uiControl: "sku_picker",
  }),
  // Revived per GTM Schema v3 as a plain link/URL text field — distinct
  // from Comparison Chart WEB ONLY above (a picker), and from the removed
  // COMPS field from GTM Schema v2 (not restored; this is a fresh field).
  field("comps_buying_guide", "General", "Comps for Buying Guide"),
  field("trademark_symbol", "General", "Trademark Symbol"),
  field("warranty", "General", "Warranty"),
  field("certification_needed", "General", "Certification Needed"),
  field("rating_label", "General", "Rating Label"),
  field("manufacturer", "General", "Manufacturer"),

  // Packaging & Logistics
  field("dieline", "Packaging & Logistics", "Dieline"),
  field("box_type", "Packaging & Logistics", "Box Type"),
  field("product_lwh", "Packaging & Logistics", "Product LxWxH (in.)"),
  field("product_weight", "Packaging & Logistics", "Product Weight (lbs.)"),
  field("box_lwh", "Packaging & Logistics", "Box LxWxH (in.)"),
  field("measurement_by", "Packaging & Logistics", "Measurement By"),
  field("box_weight", "Packaging & Logistics", "Box Weight (lbs.)"),
  field("pallet_tier_total", "Packaging & Logistics", "Pallet Tier (Total)"),
  field("pallets_high", "Packaging & Logistics", "Pallets High"),

  // Tool Description
  // Header renders "{Product Title} — {SKU}" in the UI/CSV/PDF once a SKU is
  // set — SKU itself lives on the project record (lib/db/projects.ts), not
  // as its own GTM field, since it's not part of the 76-item inventory.
  field("product_title", "Tool Description", "Product Title"),
  field("material", "Tool Description", "Material"),
  ...groupFields("top_6_features", "Tool Description", "Top Feature", 5),
  ...groupFields("feature_icons", "Tool Description", "Icon", 5),
  field("care_directions", "Tool Description", "Care Directions"),
  // Grounded (verbatim from the Amazon listing), not written — see kind
  // classification above. Deliberately excluded from WRITTEN_FIELD_IDS.
  // Kept even though it isn't itemized in GTM Schema v3's inventory (same
  // "don't silently drop an existing valuable field" call as Heat/Plate
  // Technology below).
  field("product_description", "Tool Description", "Product Description"),

  // Motor — shared; the real BEAUTY template's own Motor block only carries
  // Motor Type/RPM/Noise (split into a db value + description) and drops
  // Run Time/Recharge Time/Speed entirely (confirmed via live inspection of
  // the uploaded beauty template) — those 3 simply have no beauty export
  // row (see lib/gtm-workbook-data-mapper.ts's beauty Step list), not a
  // structural N/A here (a motorized beauty product like a dryer can still
  // have a genuine run-time/speed value worth capturing in-app).
  field("motor_type", "Motor", "Motor Type"),
  field("motor_rpm", "Motor", "RPM"),
  field("motor_run_time", "Motor", "Run Time"),
  field("motor_recharge_time", "Motor", "Recharge Time"),
  field("motor_speed", "Motor", "Speed"),
  field("motor_noise_level", "Motor", "Noise level", { uiControl: "select", options: ["Ultra Quiet", "Low", "Moderate"] }),
  field("motor_noise_level_db", "Motor", "Noise Level (dB)", { family: "beauty" }),

  // Heat/Plate Technology — the parallel section for motorless styling
  // tools (flat iron/curling iron/hot brush, see lib/db/tool-types.ts's
  // primary_criterion column). Present in the schema for every product
  // like Motor is; resolves to "Not listed"/N/A for tool types where it
  // doesn't apply, the same way Motor already does for non-motorized ones.
  // plate_material/plate_size map to the beauty template's real "Flat
  // Irons: / Plates / Plate size" rows. heater_type/max_temp_class have NO
  // corresponding row in the real beauty template (confirmed via
  // inspection) — kept anyway per the ticket's own Part 2.3 ("feeds both
  // the beauty GTM sections AND the existing motorless primary-criterion
  // Heat Technology matching system"), just unmapped in the workbook export
  // (flagged, not silently dropped — see the beauty Step list's comment).
  field("plate_material", "Heat/Plate Technology", "Plate Material", { family: "beauty" }),
  field("plate_size", "Heat/Plate Technology", "Plate Size", { family: "beauty" }),
  field("heater_type", "Heat/Plate Technology", "Heater Type", { family: "beauty" }),
  field("max_temp_class", "Heat/Plate Technology", "Max Temp", { family: "beauty" }),

  // Curling Irons — real beauty template section, absent from barber.
  field("barrel_material", "Curling Irons", "Barrel Material", { family: "beauty" }),
  field("barrel_size", "Curling Irons", "Barrel Size", { family: "beauty" }),
  field("barrel_length", "Curling Irons", "Barrel Length", { family: "beauty" }),

  // Blow Dryer — real beauty template section, absent from barber.
  field("heat_settings_count", "Blow Dryer", "# of Heat Settings", { family: "beauty" }),
  field("speed_settings_count", "Blow Dryer", "# of Speed Settings", { family: "beauty" }),

  // Electrical & Power — real beauty template section, absent from barber
  // (barber's electrical facts live under Charging instead, a different
  // set of concerns — charger light/base/cord color, not device voltage).
  field("electrical_voltage", "Electrical & Power", "Voltage", { family: "beauty" }),
  field("dual_voltage", "Electrical & Power", "Dual Voltage", { family: "beauty" }),
  field("wattage", "Electrical & Power", "Wattage", { family: "beauty" }),
  field("swivel_cord", "Electrical & Power", "Swivel Cord", { family: "beauty" }),
  field("power_cord_length", "Electrical & Power", "Power Cord Length", { family: "beauty" }),

  // Control Settings — real beauty template section, absent from barber.
  field("control_heat_range", "Control Settings", "Heat Range", { family: "beauty" }),
  field("control_speed_setting", "Control Settings", "Speed", { family: "beauty" }),
  field("control_temp_range", "Control Settings", "Temp Range", { family: "beauty" }),
  field("control_color", "Control Settings", "Color", { family: "beauty" }),
  field("control_lock_feature", "Control Settings", "Lock Feature", { family: "beauty" }),
  field("control_off_on", "Control Settings", "Off/On", { family: "beauty" }),
  field("control_cool_shot", "Control Settings", "Cool Shot", { family: "beauty" }),
  field("control_auto_shut_off", "Control Settings", "Auto Shut Off", { family: "beauty" }),
  field("control_auto_release_heat_timer", "Control Settings", "Auto Release (Heat Timer)", { family: "beauty" }),
  field("control_heat_up_time", "Control Settings", "Heat Up Time", { family: "beauty" }),

  // Blades — real barber template section; the real beauty template has no
  // equivalent rows at all (confirmed via inspection).
  field("blade_name", "Blades", "Blade Name", { family: "clipper_trimmer_shaver" }),
  field("fixed_blade", "Blades", "Fixed Blade", { family: "clipper_trimmer_shaver" }),
  field("cutting_blade", "Blades", "Cutting Blade", { helperText: "Select the closest match, or choose Other and describe it in Notes.", family: "clipper_trimmer_shaver" }),

  // Lids / Customizable Parts — renamed to match the official GTM workbook
  // template's own section header (cosmetic label only, GTM_SECTIONS
  // derives from this automatically). SHARED — the real beauty template has
  // its own "CUSTOMIZABLE PARTS / Qty / Colors" rows with identical labels
  // (confirmed via inspection), so this section is not family-tagged.
  field("lids_qty", "Lids / Customizable Parts", "Qty"),
  field("lids_colors", "Lids / Customizable Parts", "Colors"),

  // Lever — real barber template section; absent from beauty.
  field("lever_type", "Lever", "Type", { family: "clipper_trimmer_shaver" }),
  field("lever_qty", "Lever", "Qty", { family: "clipper_trimmer_shaver" }),
  field("lever_color", "Lever", "Color", { family: "clipper_trimmer_shaver" }),

  // Guards — real barber template section; absent from beauty.
  field("guards_type", "Guards", "Type", { family: "clipper_trimmer_shaver" }),
  field("guards_qty", "Guards", "Qty", { family: "clipper_trimmer_shaver" }),
  field("guards_color", "Guards", "Color", { family: "clipper_trimmer_shaver" }),

  // Charging — real barber template section; absent from beauty (beauty's
  // own electrical facts live under Electrical & Power above instead).
  field("charging_light_color", "Charging", "Light Color", { family: "clipper_trimmer_shaver" }),
  field("charging_base_color", "Charging", "Base Color", { family: "clipper_trimmer_shaver" }),
  field("charging_cord_color", "Charging", "Cord Color", { family: "clipper_trimmer_shaver" }),
  field("charging_cord_length", "Charging", "Cord Length", { family: "clipper_trimmer_shaver" }),
  field("charging_port", "Charging", "Charging Port", { family: "clipper_trimmer_shaver" }),
  field("charging_voltage", "Charging", "Voltage", { family: "clipper_trimmer_shaver" }),
  field("charging_logo_color", "Charging", "Logo Color", { family: "clipper_trimmer_shaver" }),
  field("charging_led_function", "Charging", "LED Function", { family: "clipper_trimmer_shaver" }),

  // Included in Box — the hand-tailored barber-specific accessory fields
  // below (screwdriver/cam follower/cleaning brush/oil bottle — clipper
  // servicing accessories) are family-tagged; the real beauty template's
  // own Included in Box block has its own different items instead (Travel
  // Bag/Case, Heat Glove, Extra Filters, attachments list — added below).
  field("screw_driver_color", "Included in Box", "Screw Driver Color", { family: "clipper_trimmer_shaver" }),
  field("screw_driver_brand", "Included in Box", "Screw Driver Brand", { family: "clipper_trimmer_shaver" }),
  field("screw_driver_other", "Included in Box", "Screw Driver Other", { family: "clipper_trimmer_shaver" }),
  field("stretch_bracket_color", "Included in Box", "Stretch Bracket Color", { family: "clipper_trimmer_shaver" }),
  // legacyOptional — the official GTM workbook template has zero Axis
  // Shield rows (confirmed against the real file); still generated
  // normally when a product genuinely has real data, but hidden from the
  // UI/completion-% when empty rather than always showing an empty row.
  field("axis_shield_qty", "Included in Box", "Axis Shield Qty", { legacyOptional: true, family: "clipper_trimmer_shaver" }),
  field("axis_shield_color", "Included in Box", "Axis Shield Color", { legacyOptional: true, family: "clipper_trimmer_shaver" }),
  field("axis_shield_material", "Included in Box", "Axis Shield Material", { legacyOptional: true, family: "clipper_trimmer_shaver" }),
  field("axis_shield_description", "Included in Box", "Axis Shield Description", { legacyOptional: true, family: "clipper_trimmer_shaver" }),
  field("cam_follower_qty", "Included in Box", "Cam Follower Qty", { family: "clipper_trimmer_shaver" }),
  field("cam_follower_color", "Included in Box", "Cam Follower Color", { family: "clipper_trimmer_shaver" }),
  field("cleaning_brush_qty", "Included in Box", "Cleaning Brush Qty", { family: "clipper_trimmer_shaver" }),
  field("cleaning_brush_color", "Included in Box", "Cleaning Brush Color", { family: "clipper_trimmer_shaver" }),
  field("oil_bottle_qty", "Included in Box", "Oil Bottle Qty", { family: "clipper_trimmer_shaver" }),
  field("extra_screws_qty", "Included in Box", "Extra Screws Qty", { family: "clipper_trimmer_shaver" }),
  field("extra_screws_color", "Included in Box", "Extra Screws Color", { family: "clipper_trimmer_shaver" }),
  // Real beauty template's own Included in Box items (confirmed via
  // inspection) — absent from barber.
  field("travel_bag_case", "Included in Box", "Travel Bag/Case", { family: "beauty" }),
  field("heat_glove", "Included in Box", "Heat Glove", { family: "beauty" }),
  field("extra_filters", "Included in Box", "Extra Filters", { family: "beauty" }),
  field("attachments_list", "Included in Box", "Attachments", { family: "beauty" }),
  // Generic aggregate from Amazon's whats_in_the_box[] — kept alongside the
  // hand-tailored fields above (which are precise per-component slots for
  // this catalog's clipper products) rather than folded into them, since a
  // flat vendor list can't be reliably decomposed into those specific slots
  // without guessing. Serves non-clipper products and anything the
  // tailored fields miss.
  field("whats_in_box_list", "Included in Box", "What's in the Box (full list)"),
  // A one-line, comma-separated summary of whichever Included-in-Box fields
  // above have real values (e.g. "Clipper, USB-C cord, 2 guards, cleaning
  // brush, oil") — matches the official GTM workbook template's own
  // "Included:" row (102) and BOX ONLY's "Includes" row. Derived, not
  // written by AI — see lib/gtm-derive.ts's deriveIncludedSummary.
  field("included_summary", "Included in Box", "Included:"),

  // Marketing Direction — generated automatically after Product FAQ resolves
  // (new "marketing_direction" pipeline phase, lib/gtm-marketing-direction.ts),
  // matching the official GTM workbook template's "Marketing Direction" tab.
  // The template's own Owner column is hard-coded "Marketing" for every row
  // here; `owner: "Marketing"` below is the in-app UI's own default (the
  // export never reads it — see lib/gtm-workbook-data-mapper.ts). The
  // template's row-15 section header ("CHANNEL STRATEGY/CONTENT
  // DELIVERABLES") has no corresponding field here by design — it's a pure
  // label with no Answer/Notes cell, handled entirely by the exporter's
  // "skipRow" step.
  field("marketing_previous_product_reference", "Marketing Direction", "Previous Product Reference", { owner: "Marketing" }),
  field("marketing_primary_goal", "Marketing Direction", "Primary Goal (ex: Drive trial, awareness, revenue, retailer sell-in)", { owner: "Marketing" }),
  field("marketing_success_kpis", "Marketing Direction", "Success KPIs (ex: revenue, ROAS, traffic, engagement, new users)", { owner: "Marketing" }),
  field("marketing_launch_timing", "Marketing Direction", "Marketing Launch Timing (when should marketing kick off?)", { owner: "Marketing" }),
  field("marketing_core_audience", "Marketing Direction", "Core Audience (description of who we think this product should be advertised to - more than Pro or Retail)", { owner: "Marketing" }),
  field("marketing_secondary_audience", "Marketing Direction", "Secondary Audience (if applicable)", { owner: "Marketing" }),
  field("marketing_consumer_barrier", "Marketing Direction", "Consumer Barrier (what do we need our marketing to solve for or what question do we need to answer?)", { owner: "Marketing" }),
  field("marketing_messaging_direction", "Marketing Direction", "Messaging Direction (tone, messaging ideas or inspo)", { owner: "Marketing" }),
  field("marketing_product_name_origin", "Marketing Direction", "Product Name Origin", { owner: "Marketing" }),
  field("marketing_visual_direction", "Marketing Direction", "Visual direction (in-salon, lifestyle, product-focused, etc.)", { owner: "Marketing" }),
  field("marketing_content_ideas", "Marketing Direction", "Content ideas or territories (just direction not mandatory)", { owner: "Marketing" }),
  field("marketing_languages", "Marketing Direction", "Languages", { owner: "Marketing" }),
  field("marketing_dos_donts", "Marketing Direction", "Do's / Don'ts", { owner: "Marketing" }),
  field("marketing_web_coverage", "Marketing Direction", "Web Coverage", { owner: "Marketing" }),
  field("marketing_ad_channels", "Marketing Direction", "Where should we be advertising? (based on priority and budget)", { owner: "Marketing" }),
  field("marketing_print_material", "Marketing Direction", "Print Material?", { owner: "Marketing" }),
  field("marketing_trade_show_launch", "Marketing Direction", "Trade Show Launch", { owner: "Marketing" }),
  field("marketing_educator_sampling", "Marketing Direction", "Educator Sampling"),
  field("marketing_influencer_sampling", "Marketing Direction", "Influencer Sampling"),
  field("marketing_stylecraft_sales_team", "Marketing Direction", "Stylecraft Sales Team"),
  field("marketing_external_sales_rep_sampling", "Marketing Direction", "External Sales Rep Sampling"),
  field("marketing_key_accounts_sampling", "Marketing Direction", "Key Accounts Sampling"),
  field("marketing_promo", "Marketing Direction", "Promo"),

  // Product FAQ — generated automatically after GTM's own fields resolve
  // (new "faqs" pipeline phase, lib/gtm-product-faqs.ts), matching the
  // official GTM workbook template's "Product FAQ" tab.
  ...groupFields("faq_question", "Product FAQ", "Q", 3),
  ...groupFields("faq_answer", "Product FAQ", "A", 3),
  field("our_differentiators", "Product FAQ", "Our Differentiators"),
  field("selling_position", "Product FAQ", "Selling Position"),
  field("rep_talking_point_1", "Product FAQ", "Rep Talking Point 1"),
  field("rep_talking_point_2", "Product FAQ", "Rep Talking Point 2"),
  field("rep_talking_point_3", "Product FAQ", "Rep Talking Point 3"),
  field("dealer_gross_margin_pct", "Product FAQ", "Dealer Gross Margins: %"),
  field("retail_gross_margin_pct", "Product FAQ", "Retail Gross Margin: %"),
  field("initial_quantities_ordered", "Product FAQ", "Initial Quantities Ordered: #"),

  // Box Only — matches the official GTM workbook template's "BOX ONLY" tab.
  // Product Name/Collection Name/Icons/Warranty/Certifications/Includes/
  // Charger Voltage all re-export existing fields directly (product_title,
  // collection, feature_icons_1..6, warranty, certification_needed,
  // included_summary, charging_voltage) — only the box-length condensations
  // below need their own storage (lib/gtm-box-only.ts).
  field("box_main_statement", "Box Only", "Main Statement", { helperText: "One punchy box-front statement, ≤15 words, distilled from the Positioning Statement." }),
  ...groupFields("box_feature", "Box Only", "Box Feature", 6),
];

export const GTM_SECTIONS = Array.from(new Set(GTM_FIELD_SCHEMA.map(f => f.section)));

// Filters out a `legacyOptional` field (the 4 Axis Shield fields) when it
// has no real answer — used by the UI render loop (so an empty Axis Shield
// row simply never renders) and by every completion-percentage call site
// (so an empty legacy field never drags down the denominator). A product
// that genuinely has real Axis Shield data still shows/counts it normally.
// GTM Multi-Template work — also hides any field whose `family` doesn't
// match the resolved product's family (Blades/Lever/Guards/Charging for a
// beauty product; Curling Iron/Flat Iron/Electrical & Power/Control
// Settings for a barber product), never counted toward completion % either
// — same "never shown, never guessed" treatment as legacyOptional, just
// keyed off family instead of an empty answer. `resolvedFamily` omitted
// (undefined) keeps today's behavior exactly (every field visible) — every
// existing call site that hasn't resolved a family yet is unaffected.
export function visibleGtmSchema<T extends { id: string; legacyOptional?: boolean; family?: "clipper_trimmer_shaver" | "beauty" }>(
  schema: T[],
  fields: Record<string, { answer?: string | null } | undefined>,
  resolvedFamily?: "clipper_trimmer_shaver" | "beauty" | null
): T[] {
  return schema.filter(f => {
    if (f.family && resolvedFamily && f.family !== resolvedFamily) return false;
    if (!f.legacyOptional) return true;
    const answer = (fields[f.id]?.answer ?? "").toString().trim();
    return answer !== "" && answer.toUpperCase() !== "N/A";
  });
}

export type GtmFieldSource = "project_record" | "sales_kit" | "tds" | "active_report" | "web" | "multiple" | "none" | "derived" | "category_default" | "manual_edit" | "uploaded_tds" | "predecessor_product";

// Human-readable provenance labels — shared by the field-grid UI
// (ProductKnowledgeSection) and the CSV export route so both present the
// same "Source" wording instead of maintaining two copies of this map.
export const GTM_SOURCE_LABELS: Record<string, string> = {
  project_record: "Project",
  sales_kit: "Sales Kit",
  tds: "TDS",
  active_report: "Active Report",
  web: "Web — verify",
  multiple: "Multiple",
  none: "N/A",
  derived: "Derived",
  category_default: "Category Typical",
  manual_edit: "Manual",
  uploaded_tds: "Uploaded TDS",
  predecessor_product: "Predecessor Product — verify",
};

export interface GtmFieldAnswer {
  answer: string;
  source: GtmFieldSource;
  sourceDetail?: any;
  flagged?: boolean;
  // GTM style-corpus work, Part D — a deriver-written Notes value (e.g.
  // Core Consumer "Both"'s reason, or Part E's deterministic conventions).
  // lib/db/documents.ts's saveDocumentFields only ever uses this to fill a
  // genuinely empty Notes slot — a human's existing Notes always wins.
  notes?: string;
}

export interface ProductKnowledge {
  fields: Record<string, GtmFieldAnswer>;
  completedCount: number;
  generatedAt: string;
}
