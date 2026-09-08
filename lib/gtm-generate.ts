// Core GTM field-generation pipeline — shared by the full-document generate
// route and the single-field regenerate route. Field-resolution ladder:
// project record > project documents (TDS/Sales Kit/Competitive Analysis)
// > real web search (OpenAI's native web_search tool, same trust model
// already proven in lib/analysisEngine.ts/lib/product-news.ts) > computed
// derivation (good_better_best/hair_type) > category-level "typical for
// this kind of product" default > an honest "Not determinable — {reason}"
// terminal state (never a bare N/A/TBD). Every non-"internal" field is
// eligible for the web tier — previously only 7 were (the rest were
// contractually forced to N/A the moment the project's own documents
// didn't already contain the spec), which was the main reason most fields
// never completed. "internal"-kind fields (genuine human decisions —
// packaging specs, approved pricing) skip the AI/web/derived/category
// tiers entirely and terminate at "Awaiting internal input" instead.
import { callAiForFields, coerceAiAnswer } from "./ai-json-call";
import { GTM_FIELD_SCHEMA, GTM_SECTIONS, GtmField, GtmFieldAnswer, GtmFieldSource, GtmFamily, resolveGtmFamily } from "./gtm-field-schema";
import { deriveFieldsFromSources, ProjectRecord, motorLabel } from "./gtm-derive";
import { applyTier6Inference, CatalogLineupRow, CompetitorSpecSource, BrandNameHintInput, ComparisonChartCatalogRow } from "./gtm-tier6-inference";
import { getCategoryDefault, CATEGORY_DEFAULT_LABEL_PREFIX } from "./category-defaults";
import { applyWebSearchFallback } from "./web-search-fallback";
import { finalizeFieldAnswers } from "./field-finalize";
import { isRealAnswer } from "./field-answer-state";
import { verifyGrounding, checkConsistency, SourceTexts } from "./gtm-grounding";
import { textSimilarity, BOILERPLATE_SIMILARITY_THRESHOLD } from "./text-similarity";
import { meetsElaborationBar } from "./gtm-elaboration";
import { GENERIC_EXEMPLARS } from "./gtm-reference-exemplars";
import { hasCapsLead } from "./gtm-format-checks";
import { renderStyleExemplarBlock, GTM_STYLE_EXEMPLARS } from "./gtm-style-exemplars";
import { resolveBrandForProduct, getActiveVoiceGuide, buildVoiceBlock, buildToneDirectivesForFields, getToneForGtmField } from "./brand-voice";
import { applyDeterministicFixes, findDeterministicViolations } from "./brand-voice-lint";
import { DocumentFieldRow, getMostRecentOtherDocumentFields } from "./db/documents";
import { listToolTypes } from "./db/tool-types";
import { listCatalogProducts } from "./db/catalog-products";
import { listEnabledBrandNameHints } from "./db/brand-name-hints";
import { matchCatalogProductByName } from "./our-product-position";
import { extractOurSpecsFromTds } from "./spec-extraction";
import { parsePriceToNumber } from "./pricing-analysis";
import { applyFeaturesAndExpertTip, applyCollectionKernelAdaptation, applyCoreConsumerBothNote } from "./gtm-features-and-tip";
import { applyDeterministicNotesConventions } from "./gtm-notes-conventions";
import { applyBoxOnlyDerivation } from "./gtm-box-only";
import { getUploadedTdsContext, applyUploadedTdsFacts, buildUploadedTdsPromptBlock, buildPreLaunchGroundingRule, buildTdsGroundingBlock } from "./gtm-uploaded-tds";
import { getReferenceLinksContext, buildReferenceLinksPromptBlock } from "./gtm-reference-links";
import { getPredecessorProductContext } from "./predecessor-product-context";

// Vercel Hobby's function timeout is a fixed 60s and cannot be raised.
// Confirmed live that a 45s/45s split here still produced a hard 504 (the
// whole route killed by Vercel, worse than a graceful per-field N/A) —
// tightened so the fallback/quality-guard passes reliably bail out with
// real time still left before the platform limit, rather than racing it.
const PIPELINE_TIME_BUDGET_MS = 30_000;

// Hard ceiling for firing Tier 6.5's own AI calls at all — measured from
// the SAME pipelineStart clock as PIPELINE_TIME_BUDGET_MS above, but a
// later/larger checkpoint: by the time Tier 6.5 runs, Tier 1 (AI-per-
// section) has already had its own chance to run long (confirmed live,
// a single gpt-5 low-effort call can take 25-40s+ before its own
// timeout/retry gives up), on top of whatever Tier 5's web-search
// fallback used. Tier 6.5 was parallelized (see below) to stop it being a
// SEQUENTIAL 15-30s+ tax on top of that, but a parallelized block still
// takes as long as its slowest single call — with no budget check at
// all, it always fired regardless of how much of the route's 60s Vercel
// cap Tier 1/5 had already spent, risking a hard 504 (nothing saved for
// ANY tier) instead of a graceful skip (Tier 7/finalize still run and
// save whatever WAS resolved).
const TIER_6_5_HARD_DEADLINE_MS = 48_000;

// A single call covering all 77 fields with web search enabled was
// confirmed live to time out even at 38s (OpenAI's own request timeout) —
// once genuine web search is involved across that many fields, one call
// can't reliably finish inside any budget that still leaves room for the
// fallback/quality-guard passes and DB writes within the route's 60s
// ceiling. Split into small, evenly-sized chunks instead (see
// FIELDS_PER_CHUNK below) — each chunk's scope is small enough to
// realistically finish well inside its own timeout, and running them all
// via Promise.all means total wall-clock is bounded by the slowest chunk,
// not the sum of all of them.
const SECTION_CALL_TIMEOUT_MS = 28_000;

export interface GtmSources {
  project: ProjectRecord;
  salesKit: any | null;
  // Flat field_id -> answer map read from the TDS document's document_fields
  // rows (see lib/db/documents.ts's flattenDocumentFields) — TDS moved off
  // its old nested project_outputs blob onto the same documents/
  // document_fields model GTM uses, so this is no longer arbitrary JSON.
  tds: Record<string, string> | null;
  activeReport: { competitive_analysis?: any; pricing_analysis?: any; content_form?: any } | null;
  // Current document's already-resolved field answers (flattened, real
  // answers only) — only used by Expert Tip's grounding when regenerating
  // it in isolation (generateSingleField has no Features answer in scope
  // otherwise, since it's not part of that single-field call). Populated by
  // the regenerate route via lib/db/documents.ts's flattenDocumentFields.
  existingFieldAnswers?: Record<string, string> | null;
}

export function buildSourceTexts(sources: GtmSources, uploadedTdsBlock: string = "", referenceLinksBlock: string = "", predecessorProductBlock: string = ""): SourceTexts {
  return {
    projectRecord: JSON.stringify({
      productName: sources.project.productName,
      description: sources.project.description,
      category: sources.project.category,
      motorTech: sources.project.motorTech,
      keyDiff: sources.project.keyDiff,
      pricePoint: sources.project.pricePoint,
      companyContext: sources.project.companyContext,
    }),
    competitiveAnalysis: JSON.stringify(sources.activeReport?.competitive_analysis || {}),
    tds: JSON.stringify(sources.tds || {}),
    salesKit: JSON.stringify(sources.salesKit || {}),
    uploadedTds: uploadedTdsBlock,
    referenceLinks: referenceLinksBlock,
    predecessorProduct: predecessorProductBlock,
  };
}

function sourceTextBlocks(sourceTexts: SourceTexts): string[] {
  return [sourceTexts.projectRecord, sourceTexts.competitiveAnalysis, sourceTexts.tds, sourceTexts.salesKit, sourceTexts.uploadedTds, sourceTexts.referenceLinks, sourceTexts.predecessorProduct];
}

// GTM Schema v3 — "structural N/A, skip scraping": a non-motorized
// product's Motor fields (and a non-heat-tech product's Heat/Plate
// Technology fields) can never have a real answer no matter how hard AI/
// web search looks — the schema file's own long-standing comment already
// promised this ("resolves to N/A the same way Motor already does") but
// nothing ever actually skipped the tiers. Derived from the resolved tool
// type's primary_criterion (lib/db/tool-types.ts) — only excludes a
// section when the criterion is KNOWN and definitively doesn't match, so
// an unresolved/custom tool type with no primary_criterion never loses
// legitimate access to either section.
const MOTOR_SECTION_FIELD_IDS = GTM_FIELD_SCHEMA.filter(f => f.section === "Motor").map(f => f.id);
const HEAT_TECH_SECTION_FIELD_IDS = GTM_FIELD_SCHEMA.filter(f => f.section === "Heat/Plate Technology").map(f => f.id);

// GTM style-corpus work — a non-tool product_kind (accessory/replacement
// part, e.g. SC559B, a foil head) structurally has none of these: confirmed
// against the real Homie Shaver Replacement Foil GTM sheet, whose Lids/
// Lever/Guards/Charging sections are ALL "N/A" and most Included in Box
// rows are "N/A" too. whats_in_box_list and screw_driver_* are deliberately
// KEPT eligible — an accessory can plausibly ship its own screwdriver/box
// contents (a real judgment call, not a blanket rule — confirmed by
// research finding no accessory-specific precedent that would justify
// excluding these two).
const LIDS_SECTION_FIELD_IDS = GTM_FIELD_SCHEMA.filter(f => f.section === "Lids / Customizable Parts").map(f => f.id);
const LEVER_SECTION_FIELD_IDS = GTM_FIELD_SCHEMA.filter(f => f.section === "Lever").map(f => f.id);
const GUARDS_SECTION_FIELD_IDS = GTM_FIELD_SCHEMA.filter(f => f.section === "Guards").map(f => f.id);
const CHARGING_SECTION_FIELD_IDS = GTM_FIELD_SCHEMA.filter(f => f.section === "Charging").map(f => f.id);
const ACCESSORY_NA_INCLUDED_IN_BOX_FIELD_IDS = [
  "stretch_bracket_color",
  "axis_shield_qty", "axis_shield_color", "axis_shield_material", "axis_shield_description",
  "cam_follower_qty", "cam_follower_color",
  "cleaning_brush_qty", "cleaning_brush_color",
  "oil_bottle_qty",
  "extra_screws_qty", "extra_screws_color",
];

// GTM Multi-Template work — the real BARBER and BEAUTY workbook templates
// each have whole sections the other doesn't (confirmed via live inspection
// of both uploaded files): barber has Blades/Lever/Guards/Charging + a
// barber-specific Included-in-Box accessory set; beauty has Curling Irons/
// Blow Dryer/Electrical & Power/Control Settings + Heat/Plate Technology's
// full field set + its own Included-in-Box items. Every one of those
// fields is already tagged with GtmField.family (lib/gtm-field-schema.ts) —
// reusing that tag here is a direct generalization of this function's own
// existing pattern (structural N/A on a KNOWN, definite mismatch only), not
// a new mechanism. Orthogonal to primaryCriterion/productKind below — all
// three axes compose (a Hair Dryer keeps Motor via primaryCriterion, keeps
// Blow Dryer/Electrical & Power via family, loses Blades/Charging via family).
const CLIPPER_ONLY_FIELD_IDS = GTM_FIELD_SCHEMA.filter(f => f.family === "clipper_trimmer_shaver").map(f => f.id);
const BEAUTY_ONLY_FIELD_IDS = GTM_FIELD_SCHEMA.filter(f => f.family === "beauty").map(f => f.id);

export function structurallyInapplicableFieldIds(primaryCriterion: string | null | undefined, productKind?: string | null, family?: GtmFamily | null): Set<string> {
  const ids = new Set<string>();
  if (primaryCriterion) {
    if (primaryCriterion !== "motor") MOTOR_SECTION_FIELD_IDS.forEach(id => ids.add(id));
    if (primaryCriterion !== "heat_technology") HEAT_TECH_SECTION_FIELD_IDS.forEach(id => ids.add(id));
  }
  if (family) {
    if (family !== "clipper_trimmer_shaver") CLIPPER_ONLY_FIELD_IDS.forEach(id => ids.add(id));
    if (family !== "beauty") BEAUTY_ONLY_FIELD_IDS.forEach(id => ids.add(id));
  }
  if (productKind && productKind !== "tool") {
    LIDS_SECTION_FIELD_IDS.forEach(id => ids.add(id));
    LEVER_SECTION_FIELD_IDS.forEach(id => ids.add(id));
    GUARDS_SECTION_FIELD_IDS.forEach(id => ids.add(id));
    CHARGING_SECTION_FIELD_IDS.forEach(id => ids.add(id));
    ACCESSORY_NA_INCLUDED_IN_BOX_FIELD_IDS.forEach(id => ids.add(id));
  }
  return ids;
}

// Resolves the linked catalog record's product_kind/collection for a
// generation call — the project itself has no product_kind field of its
// own (deliberately: adding one would mean analyze-form UI work out of
// scope for this pass), so this reuses the same fuzzy name-match the
// Manufacturer auto-detect cascade already relies on
// (lib/our-product-position.ts's matchCatalogProductByName). A project with
// no catalog link (ad-hoc/manual entry) resolves both to null, which is
// exactly today's behavior everywhere that reads them.
async function resolveCatalogProductKind(sources: GtmSources): Promise<{ productKind: string | null; collection: string | null; brand: string; description: string | null }> {
  const catalogProducts = await listCatalogProducts();
  const matched = matchCatalogProductByName(sources.project.productName, catalogProducts);
  // Brand Voice Guide work — reuses this SAME catalog match (no extra
  // fetch) rather than calling resolveBrandForProduct separately, which
  // would re-fetch listCatalogProducts() a second time.
  // description — real feature/callout text lib/catalog-import.ts can
  // populate straight from a spreadsheet's "Features & Benefits" column
  // (see lib/gtm-features-and-tip.ts's deriveFeaturesFullListDeterministic,
  // which merges this alongside the project's own free-text Description).
  return { productKind: matched?.product_kind ?? null, collection: matched?.collection ?? null, brand: matched?.brand || "StyleCraft", description: matched?.description ?? null };
}

// Text blob for lib/gtm-tier6-inference.ts's keyword-based hair_type
// inference — every source that could plausibly mention hair type in
// prose, not the structured spec fields already covered by gtm-derive.ts.
function buildHairTypeSourceText(sources: GtmSources): string {
  return [
    sources.tds?.product_description,
    (sources.salesKit?.key_features || []).map((f: any) => f.headline).filter(Boolean).join(" "),
    sources.project.category,
  ].filter(Boolean).join(" ");
}

// Builds the 3 new GTM Schema v2 Tier-6 inputs (catalog lineup, competitor
// RPM performance, manufacturer cascade) — one shared helper since both
// generateAllFields and generateSingleField need identical construction.
// Fetches catalog products + brand hints once per call (cheap, small
// admin-managed tables) rather than threading them through every caller.
async function buildTier6ExtraInputs(sources: GtmSources, toolTypes: { type_key: string; label: string }[]) {
  const [catalogProducts, brandHints] = await Promise.all([listCatalogProducts(), listEnabledBrandNameHints()]);
  const catalogLineupRows: CatalogLineupRow[] = catalogProducts.map(p => ({ tool_type: p.tool_type, target_price: p.target_price, active: p.active, product_kind: p.product_kind }));

  const ourToolType = sources.project.toolType || null;
  const toolTypeLabel = toolTypes.find(t => t.type_key === ourToolType)?.label || ourToolType || "product";
  const ourPriceRaw = parsePriceToNumber(sources.activeReport?.pricing_analysis?.target_price);

  const ourRpm = extractOurSpecsFromTds(sources.tds).rpm ?? null;
  const ourMotorLabel = motorLabel(sources.project.motorFamily, sources.project.motorBrandedName) || sources.project.motorTech || "";
  const ca = sources.activeReport?.competitive_analysis || {};
  const competitors: CompetitorSpecSource[] = [...(ca.large_brand_competitors || []), ...(ca.indie_emerging_competitors || [])];

  const matchedCatalogProduct = matchCatalogProductByName(sources.project.productName, catalogProducts);
  const hints: BrandNameHintInput[] = brandHints.map(h => ({ brand: h.brand, namePrefixes: h.name_prefixes }));
  const comparisonChartRows: ComparisonChartCatalogRow[] = catalogProducts.map(p => ({
    name: p.name, brand: p.brand, sku: p.sku, tool_type: p.tool_type, target_price: p.target_price, motor_family: p.motor_family, active: p.active,
  }));

  return {
    catalogLineup: { ourToolType, ourPriceRaw, catalogProducts: catalogLineupRows, toolTypeLabel, ourProductKind: matchedCatalogProduct?.product_kind ?? null },
    performance: { ourRpm, ourMotorLabel, competitors },
    manufacturer: {
      productName: sources.project.productName,
      catalogBrand: matchedCatalogProduct?.brand ?? null,
      hints,
      tdsManufacturer: sources.tds?.manufacturer ?? null,
    },
    comparisonChart: { ourToolType, ourPriceRaw, ourMotorFamily: sources.project.motorFamily ?? null, catalogProducts: comparisonChartRows },
  };
}

function buildSystemInstruction(productName: string, schema: GtmField[], voiceBlock: string = "", preLaunchRule: string = "") {
  const fieldList = schema
    .map(f => `- ${f.id} [${f.section}] (${f.kind === "grounded" ? "HARD-GROUNDED" : "WRITTEN"}): ${f.question}`)
    .join("\n");

  // Real-exemplar style corpus (lib/gtm-style-exemplars.ts) — only attached
  // when this chunk actually contains a style-sensitive field, so purely
  // grounded/spec chunks (dimensions, packaging, etc.) don't pay the token
  // cost of a corpus they have no use for.
  const styleExemplarBlock = renderStyleExemplarBlock(schema.map(f => f.group?.id || f.id));

  // Brand Voice Guide (lib/brand-voice.ts) — same cost-gating discipline as
  // the style exemplar block above: only attached when the chunk has at
  // least one WRITTEN field (a pure spec/dimensions chunk has no voice of
  // its own to match). `voiceBlock` is pre-built by the caller (an async
  // DB fetch + regex condense, done once per generation run, not per
  // chunk) — this function stays synchronous.
  const hasWrittenField = schema.some(f => f.kind === "written");
  const voiceSection = hasWrittenField && voiceBlock ? voiceBlock + buildToneDirectivesForFields(schema) : "";

  return `You are generating a Go-To-Market Product Knowledge sheet for ONE specific product: ${productName}. Write it like a real product marketing team would — detailed and structured, never one-word or generic.

Rules:
- Answer every field using ONLY the labeled sources provided below. Cite the source per field.
- HARD-GROUNDED fields (specs: dimensions, weight, RPM, run time, voltage, cord length, blade names, quantities, colors, pricing, warranty, box/pallet data, included-in-box items): copy values exactly as they appear in the sources, units included. If a value is not present in any source, return "N/A". NEVER estimate, infer, or reuse a value from another product — EXCEPT the PREDECESSOR_PRODUCT block below (if provided), which exists specifically to be inherited from as a last resort; still mark such a field flagged/uncertain rather than stated as confirmed for this exact product.
- WRITTEN fields (positioning statement, story, reason to buy, expert tip, messaging): write them specifically about THIS product, referencing its actual named features and specs from the sources. Do not produce generic copy that could apply to any similar product — every claim must trace back to a real fact in the sources.
- Source priority, highest first: the Project Record > the team's own UPLOADED_TDS (if provided — an externally-authored Technical Data Sheet, the most authoritative source for hard specs) > REFERENCE_LINKS (if provided — specific product/competitor/brand pages the team has pointed you to; check these before general web search) > Competitive Analysis / TDS / Sales Kit documents > real web search > PREDECESSOR_PRODUCT (if provided — an existing product this one is a modified version of; absolute last resort, only after web search also found nothing). If a field's answer is not in the labeled sources below, use web search to find real, verifiable public information about this EXACT product (its official product page, retailer listings, spec sheets) — never general/world knowledge, never a guess, and never a value from a different or similar product (PREDECESSOR_PRODUCT is the one deliberate exception, per above). Mark any web-sourced field's "source" as "web" in your JSON response, and any PREDECESSOR_PRODUCT-sourced field's "source" as "predecessor_product". Only return "N/A" if the answer genuinely cannot be found anywhere, including PREDECESSOR_PRODUCT.
- Bias: specs/motor/blades/packaging/included-in-box come from TDS; positioning/pricing tiers/USPs/up-sell/expert tip come from Sales Kit; comps buying guide/competitive context come from Competitive Analysis. Fields still missing after checking all of these are exactly the ones worth a web search.

REQUIRED DEPTH for these specific fields (this describes FORMAT AND DEPTH ONLY — never copy this wording, it is not about the current product):
- why_creating_item: a numbered list of 4-6 concrete reasons (consumer need, competitive gap, identity/customization, credibility, system completion), each one sentence, specific to this product's real facts.
- positioning_statement: a 4-6 sentence narrative paragraph covering origin, goal, design considerations, and the product's role in the lineup — not a single generic sentence.
- product_name_origin / name_story_tie: 2-4 sentences connecting the actual product name to a real fact about the brand or product (skip gracefully to N/A if the sources give no real basis — never invent a naming story).
- up_sell: one selling-motion paragraph naming a specific premium companion/step-up option and a price-framing or recurring-revenue hook (e.g. a replacement-part subscription) — never a generic "upgrade for more value" line.
- reason_to_buy: 5-6 numbered claims, each starting with a short ALL-CAPS claim phrase followed by the supporting spec and a plain-language benefit (e.g. "ZERO-GAP PRECISION — 7,800rpm brushless motor cuts closer without snagging").
- expert_tip: 2-4 sentences of concrete, actionable usage/maintenance advice tied to this product's real features; for an accessory/replacement-part product (no motor of its own), frame it as a usage-context tip for the tool it attaches to, not a fabricated feature of the accessory itself.
- features_full_list_1..4 (each row is one feature): CAPS-lead phrase + exact spec value/unit, adding an "INCLUDES: ..." clause when the feature bundles a real included accessory.
Simple fields (good_better_best, warranty, certification_needed, etc.) stay short and exact — do not pad these with filler.

FIELD SCHEMA (id [section] (grounded|written): question):
${fieldList}

Return ONLY valid JSON — no markdown, no explanation — keyed by field id:
{ "<field_id>": { "answer": "...", "source": "project_record" | "competitive_analysis" | "tds" | "sales_kit" | "web" | "multiple" | "none" } }

If the answer genuinely cannot be found in the sources or via web search, return { "answer": "N/A", "source": "none" }. Every field id listed above must appear in your response.${styleExemplarBlock}${voiceSection}${preLaunchRule}`;
}

function buildUserContent(sourceTexts: SourceTexts) {
  // <UPLOADED_TDS> is the team's own externally-authored TDS/spec-sheet
  // file (lib/gtm-uploaded-tds.ts) — distinct from <TDS> above, which is
  // this app's OWN (currently disabled) TDS-generation document. Omitted
  // entirely when the project has no active uploaded source doc, so an
  // empty tag never confuses the model into thinking one was checked.
  const uploadedTdsBlock = sourceTexts.uploadedTds
    ? `\n\n<UPLOADED_TDS>\n${sourceTexts.uploadedTds}\n</UPLOADED_TDS>`
    : "";

  // Reference Links (lib/gtm-reference-links.ts) — team-pasted product/
  // competitor/brand page URLs, checked before general knowledge/web
  // search. Omitted entirely when the project has none, same convention
  // as <UPLOADED_TDS> above.
  const referenceLinksBlock = sourceTexts.referenceLinks
    ? `\n\n<REFERENCE_LINKS>\n${sourceTexts.referenceLinks}\n</REFERENCE_LINKS>`
    : "";

  // Predecessor Product (lib/predecessor-product-context.ts) — a modified/
  // refreshed version of an existing StyleCraft product names or links that
  // prior product. LAST in source order and its own text is already framed
  // as fallback-only (see getPredecessorProductContext's wrapFallbackBlock)
  // — check every source above first, only fall back to this, then web
  // search/general knowledge if this doesn't cover a field either.
  const predecessorProductBlock = sourceTexts.predecessorProduct
    ? `\n\n<PREDECESSOR_PRODUCT>\n${sourceTexts.predecessorProduct}\n</PREDECESSOR_PRODUCT>`
    : "";

  return `<PROJECT_RECORD>
${sourceTexts.projectRecord}
</PROJECT_RECORD>

<COMPETITIVE_ANALYSIS>
${sourceTexts.competitiveAnalysis}
</COMPETITIVE_ANALYSIS>

<TDS>
${sourceTexts.tds}
</TDS>

<SALES_KIT>
${sourceTexts.salesKit}
</SALES_KIT>${uploadedTdsBlock}${referenceLinksBlock}${predecessorProductBlock}`;
}

function callAi(systemInstruction: string, userContent: string, opts?: { timeoutMs?: number; maxToolCalls?: number; projectId?: string }) {
  return callAiForFields(systemInstruction, userContent, "GTM", {
    webSearch: true,
    maxToolCalls: opts?.maxToolCalls ?? 3,
    timeoutMs: opts?.timeoutMs ?? SECTION_CALL_TIMEOUT_MS,
    projectId: opts?.projectId,
  });
}

// Fixed-size chunks rather than by-section: sections range from 2 fields
// (Lids) to 22 (General) — confirmed live that grouping by section still
// produced a hard 504 (Vercel killed the whole route at its 60s ceiling,
// worse than a graceful per-field N/A), because the largest section alone
// was still too much for one call. Small, evenly-sized chunks keep every
// individual call's scope — and therefore its realistic completion time —
// uniform regardless of how the schema happens to be organized. Merges
// into the same {fieldId: {answer, source}} shape the rest of the
// pipeline already expects, so nothing downstream needs to know the call
// was split.
// Confirmed live: even 6 fields per chunk at a 28s timeout still let a
// handful of chunks time out (web-search-augmented multi-field extraction
// with gpt-5 has consistently run 20-50s for a single focused item all
// session, regardless of how few fields are asked for) — smaller chunks
// trade a few more concurrent requests for a real reduction in how often
// any one of them needs more time than it's given.
const FIELDS_PER_CHUNK = 4;

async function callAiPerSection(productName: string, schema: GtmField[], userContent: string, projectId: string, voiceBlock: string = "", preLaunchRule: string = ""): Promise<Record<string, { answer: string; source: string }> | null> {
  const chunks: GtmField[][] = [];
  for (let i = 0; i < schema.length; i += FIELDS_PER_CHUNK) chunks.push(schema.slice(i, i + FIELDS_PER_CHUNK));

  const results = await Promise.all(
    chunks.map(fields => callAi(buildSystemInstruction(productName, fields, voiceBlock, preLaunchRule), userContent, { maxToolCalls: 3, projectId }))
  );

  const merged: Record<string, { answer: string; source: string }> = {};
  let anySucceeded = false;
  for (const raw of results) {
    if (!raw) continue;
    anySucceeded = true;
    Object.assign(merged, raw);
  }
  return anySucceeded ? merged : null;
}

// A select-kind field's answer must exactly match one of its fixed
// options (case-insensitive) — never accepted as free text. Fields with no
// `options` (the vast majority) always pass.
export function matchesFieldOptions(schemaField: GtmField, answer: string): boolean {
  if (!schemaField.options) return true;
  return schemaField.options.some(o => o.toLowerCase() === answer.toLowerCase());
}

function mergeField(schemaField: GtmField, aiRaw: Record<string, { answer: string; source: string }> | null, derived: Record<string, GtmFieldAnswer>): { field: GtmFieldAnswer; fromAi: boolean } {
  const got = aiRaw?.[schemaField.id];
  const aiAnswer = coerceAiAnswer(got?.answer);
  const aiUsable = !!aiAnswer && aiAnswer.toUpperCase() !== "N/A" && aiAnswer.toUpperCase() !== "TBD" && matchesFieldOptions(schemaField, aiAnswer);
  if (aiUsable) {
    return { field: { answer: aiAnswer!, source: (got?.source as GtmFieldSource) || "multiple" }, fromAi: true };
  }
  if (derived[schemaField.id]) return { field: derived[schemaField.id], fromAi: false };
  return { field: { answer: "N/A", source: "none" }, fromAi: false };
}

// Tier 7 — mutates `fields` in place. Skips "internal"-kind fields (a
// category-typical guess about a packaging/pricing DECISION makes no
// sense) and anything that already has a real answer from an earlier tier.
function applyCategoryDefaults(fields: Record<string, GtmFieldAnswer>, schema: GtmField[], category: string | null | undefined) {
  for (const f of schema) {
    if (f.kind === "internal" || isRealAnswer(fields[f.id]?.answer)) continue;
    const value = getCategoryDefault(category, f.id);
    if (value) {
      fields[f.id] = { answer: `${CATEGORY_DEFAULT_LABEL_PREFIX}${value}`, source: "category_default" };
    }
  }
}

// Full 77-field generation: AI (if available) -> deterministic derivation
// floor -> grounding verification -> cross-source consistency check ->
// anti-boilerplate rewrite pass for written fields.
//
// Grounding verification only ever runs against AI-provided answers.
// Deterministically-derived answers are direct field copies from the
// source objects (see gtm-derive.ts) — they cannot hallucinate by
// construction, and substring-checking them against the raw source JSON
// produces false rejections whenever the derivation formats/joins multiple
// sub-fields (e.g. warranty duration + coverage joined with " — ").
export async function generateAllFields(productName: string, sources: GtmSources, projectId: string): Promise<Record<string, GtmFieldAnswer>> {
  const pipelineStart = Date.now();
  const toolTypes = await listToolTypes();
  const schema = GTM_FIELD_SCHEMA;

  // Structural N/A — resolved once up front, then threaded through every
  // remaining tier as an exclusion so nothing (AI, web, Tier 6/6.5,
  // category defaults) ever revisits these fields; see
  // structurallyInapplicableFieldIds above.
  const primaryCriterion = toolTypes.find(t => t.type_key === sources.project.toolType)?.primary_criterion;
  const family = resolveGtmFamily(sources.project, toolTypes);
  const { productKind, collection, brand, description: catalogDescription } = await resolveCatalogProductKind(sources);
  const structuralNaIds = structurallyInapplicableFieldIds(primaryCriterion, productKind, family);
  const pipelineSchema = schema.filter(f => !structuralNaIds.has(f.id));

  // Brand Voice Guide — resolved once per generation run (not once per
  // chunk), so every chunk's system instruction reuses the same
  // already-fetched, already-condensed block. voiceGuide's id/version is
  // returned to the caller so the document row can record which guide
  // version it was actually written against (documents.voice_guide_id/
  // voice_guide_version — see lib/db/documents.ts).
  const voiceGuide = await getActiveVoiceGuide(brand);
  const voiceBlock = buildVoiceBlock(voiceGuide);

  // Uploaded TDS Ingestion — resolved once per generation run, same
  // caching-by-call-shape discipline as the voice guide above. A
  // "pre-launch/custom" product (no productUrl/asin AND no Reference Links
  // — genuinely no external grounding for the AI web-search tier below to
  // find anything) gets the hard "no market/web claims" narrative rule and
  // skips Tier 5 (web fallback) with an honest, specific reason rather than
  // searching for nothing; the fact override itself (applyUploadedTdsFacts
  // below) applies regardless of pre-launch status. Reference Links count
  // as real web presence here — a project with none typed into productUrl/
  // asin but with team-supplied reference pages is NOT "no web presence",
  // and treating it as such was surfacing a confusing literal "Not found —
  // pre-launch: no web presence" answer on fields those reference pages
  // could have actually answered.
  const uploadedTdsContext = await getUploadedTdsContext(projectId);
  const uploadedTdsPromptText = buildUploadedTdsPromptBlock(uploadedTdsContext);

  // Reference Links — fetched fresh each run, same discipline as
  // uploadedTdsContext above (never cached across phases/regenerates).
  const referenceLinksContext = await getReferenceLinksContext(sources.project.referenceUrls);
  const referenceLinksPromptText = buildReferenceLinksPromptBlock(referenceLinksContext);

  const isPreLaunch = !sources.project.productUrl && !sources.project.asin && !referenceLinksContext.hasLinks;
  const preLaunchRule = buildPreLaunchGroundingRule(isPreLaunch && uploadedTdsContext.hasFacts);

  // Predecessor Product Reference — fetched fresh each run, same discipline
  // as everything else above. orgId is required to resolve Tier 1 (an
  // existing project of this same org); absent it, resolution still works
  // via Tier 2/3 (catalog/URL), just skips the project-match tier.
  const predecessorContext = await getPredecessorProductContext(sources.project.predecessorRef, sources.project.orgId || "");
  const sourceTexts = buildSourceTexts(sources, uploadedTdsPromptText, referenceLinksPromptText, predecessorContext.text || "");
  const userContent = buildUserContent(sourceTexts);

  // "internal"-kind fields (dieline, approved pricing, etc.) are never
  // asked of the AI — nothing about a packaging/pricing DECISION is
  // answerable by reading sources or web search. They still go through
  // mergeField below via the FULL schema, so the deterministic `derived`
  // floor (tiers 1-4) can still populate them from real TDS/project data.
  const aiEligibleSchema = pipelineSchema.filter(f => f.kind !== "internal");
  const aiRaw = await callAiPerSection(productName, aiEligibleSchema, userContent, projectId, voiceBlock, preLaunchRule);
  const derived = deriveFieldsFromSources(sources.project, sources.salesKit, sources.tds, sources.activeReport);

  const merged: Record<string, GtmFieldAnswer> = {};
  const aiSourcedIds = new Set<string>();
  for (const f of schema) {
    if (structuralNaIds.has(f.id)) {
      merged[f.id] = { answer: "N/A", source: "none" };
      continue;
    }
    const { field: value, fromAi } = mergeField(f, aiRaw, derived);
    merged[f.id] = value;
    // Web-sourced answers are real (OpenAI's own web_search tool actually
    // searched and read a page — same trust model as
    // lib/analysisEngine.ts/lib/product-news.ts), but they won't literally
    // appear in the internal project/TDS/sales-kit JSON blocks the
    // substring check below compares against — excluding them here avoids
    // rejecting genuinely-correct web answers as "ungrounded".
    if (fromAi && value.source !== "web") aiSourcedIds.add(f.id);
  }

  const groundedAiOnly = verifyGrounding(merged, schema.filter(f => aiSourcedIds.has(f.id)), sourceTextBlocks(sourceTexts));
  const grounded = { ...merged, ...groundedAiOnly };

  const conflicts = checkConsistency(aiRaw, derived, schema);
  for (const [fieldId, info] of Object.entries(conflicts)) {
    if (grounded[fieldId]) {
      grounded[fieldId] = {
        ...grounded[fieldId],
        flagged: true,
        sourceDetail: { ...(grounded[fieldId].sourceDetail || {}), conflict: info.values },
      };
    }
  }

  // Uploaded TDS Ingestion — overrides grounded/spec fields verbatim from
  // the team's own uploaded source doc(s), the top-priority external
  // source (only a literal project-record value outranks it). Re-verifies
  // grounding against the doc's own stored text — but ONLY for AI-extracted
  // facts, never a user's explicit correction, whose whole point is to
  // override what the document itself says.
  const uploadedTdsSourcedIds = applyUploadedTdsFacts(grounded, pipelineSchema, uploadedTdsContext);
  const uploadedTdsUnconfirmedIds = new Set(Array.from(uploadedTdsSourcedIds).filter(id => !grounded[id]?.sourceDetail?.confirmedByUser));
  if (uploadedTdsUnconfirmedIds.size > 0) {
    const groundedUploadedTds = verifyGrounding(
      grounded,
      pipelineSchema.filter(f => uploadedTdsUnconfirmedIds.has(f.id)),
      uploadedTdsContext.fullTextBlocks
    );
    Object.assign(grounded, groundedUploadedTds);
  }

  // Tier 5 — web fallback fills genuinely-unanswered fields before the
  // quality guard runs, so a web-sourced answer still gets checked for
  // depth/genericness like any other written-field answer. Internal fields
  // are excluded from the eligible schema, same reasoning as the AI call.
  // Pre-launch products (no web presence) skip the attempt entirely and
  // log why, rather than searching for something that can't exist.
  await applyWebSearchFallback(
    grounded,
    aiEligibleSchema,
    productName,
    pipelineStart,
    PIPELINE_TIME_BUDGET_MS,
    toolTypes,
    sources.project?.toolType as any,
    isPreLaunch ? "pre-launch — add a product URL/ASIN or a Reference Link under Sources to fill this in" : undefined,
    voiceBlock
  );

  // Tier 6 (computed derivation, e.g. good_better_best/hair_type) runs
  // strictly after the web-search tier — these are pure/free to compute
  // but must never preempt a real web search result the way an eager
  // pre-AI derivation would (see lib/gtm-tier6-inference.ts).
  const tier6Extra = await buildTier6ExtraInputs(sources, toolTypes);
  applyTier6Inference(grounded, pipelineSchema, {
    hairTypeSourceText: buildHairTypeSourceText(sources),
    ...tier6Extra,
  });

  // Tier 6.5 — Features (full list) 3-source merge + Expert Tip generated
  // from the now-resolved Features, collection-kernel name adaptation,
  // Core Consumer "Both" note, and Box Only derivation. Runs after Tier 6
  // (manufacturer/lineup/performance already settled) so Expert Tip's
  // grounding has a real, resolved feature list to reference — see
  // lib/gtm-features-and-tip.ts. These 4 calls are genuinely independent —
  // each reads only fields already resolved by Tier ≤6 (never another Tier
  // 6.5 call's own output) and writes to its own disjoint field set
  // (features_full_list_*/expert_tip vs. product_name_origin/name_story_tie
  // vs. core_consumer's notes vs. box_main_statement/box_feature_*) — so
  // they run concurrently instead of sequentially. Confirmed live: running
  // them one-at-a-time (each its own multi-second AI call, some with their
  // own internal retry) was stacking into 15-30+ extra seconds on top of
  // the main AI call, a major contributor to GTM generation routinely
  // running long/timing out.
  const tdsGroundingBlock = buildTdsGroundingBlock(uploadedTdsContext, isPreLaunch) + (referenceLinksPromptText ? `\n\nREFERENCE SOURCES:\n${referenceLinksPromptText}` : "");
  if (Date.now() - pipelineStart < TIER_6_5_HARD_DEADLINE_MS) {
    await Promise.all([
      applyFeaturesAndExpertTip(grounded, pipelineSchema, sources, productName, pipelineStart, voiceBlock, tdsGroundingBlock, catalogDescription),
      applyCollectionKernelAdaptation(grounded, pipelineSchema, productName, collection, voiceBlock, tdsGroundingBlock),
      applyCoreConsumerBothNote(grounded, pipelineSchema, productName, voiceBlock, tdsGroundingBlock),
      applyBoxOnlyDerivation(grounded, pipelineSchema, productName, voiceBlock, tdsGroundingBlock),
    ]);
  } else {
    console.warn(`[gtm-generate] Skipping Tier 6.5 (Features/ExpertTip/CollectionKernel/CoreConsumer/BoxOnly) — ${Date.now() - pipelineStart}ms already elapsed, leaving too little of the route's 60s budget to risk a hard 504. Tier 7/finalize will still run for whatever these fields fall through to.`);
  }

  // Tier 7 — category-level "typical for this kind of product" default,
  // the last and lowest-confidence fill before an honest "not determinable".
  // Uses pipelineSchema (not the full schema) so a structurally-N/A field
  // (e.g. Motor Type on a non-motorized product) never gets a category-
  // typical guess layered on top of its already-final "N/A".
  applyCategoryDefaults(grounded, pipelineSchema, sources.project.category);

  await guardWrittenFieldsQuality(grounded, pipelineSchema, sources, productName, projectId, pipelineStart, voiceBlock, preLaunchRule);

  // Part E — deterministic Notes conventions (No lever./No guards.,
  // assembled-on-unit qty phrasing). Runs last, after every AI/web/derived
  // tier has settled, since it reads each field's final resolved answer.
  applyDeterministicNotesConventions(grounded, pipelineSchema, sources, productKind);

  // Terminal step — converts anything still unresolved into
  // "Not found — checked {K} sources" ("Awaiting internal input" for
  // internal-kind fields) instead of a bare N/A/TBD. Structurally-N/A
  // fields are excluded from `pipelineSchema` so their literal "N/A" from
  // above is never promoted to this terminal state. K=4: AI + web search +
  // Tier 6/6.5 + category default, the 4 tiers every eligible field here
  // actually passed through above.
  return finalizeFieldAnswers(grounded, pipelineSchema, 4, isPreLaunch ? "pre-launch — add a product URL/ASIN or a Reference Link under Sources to fill this in" : undefined);
}

// Regenerates exactly one field through the same pipeline.
export async function generateSingleField(fieldId: string, sources: GtmSources, projectId: string): Promise<GtmFieldAnswer> {
  const toolTypes = await listToolTypes();
  const productName = sources.project.productName;
  const schemaField = GTM_FIELD_SCHEMA.find(f => f.id === fieldId);
  if (!schemaField) throw new Error(`Unknown field id: ${fieldId}`);

  // Structural N/A — a non-motorized product's Motor fields (and a non-
  // heat-tech product's Heat/Plate Technology fields) can never have a
  // real answer, so a regenerate of one of these skips AI/web entirely,
  // same as the full-document pipeline. See structurallyInapplicableFieldIds.
  const primaryCriterion = toolTypes.find(t => t.type_key === sources.project.toolType)?.primary_criterion;
  const family = resolveGtmFamily(sources.project, toolTypes);
  const { productKind, collection, brand, description: catalogDescription } = await resolveCatalogProductKind(sources);
  if (structurallyInapplicableFieldIds(primaryCriterion, productKind, family).has(fieldId)) {
    return { answer: "N/A", source: "none" };
  }
  const voiceBlock = buildVoiceBlock(await getActiveVoiceGuide(brand));

  // Uploaded TDS Ingestion — same resolution as generateAllFields above.
  const uploadedTdsContext = await getUploadedTdsContext(projectId);
  const uploadedTdsPromptText = buildUploadedTdsPromptBlock(uploadedTdsContext);

  // Reference Links — same resolution as generateAllFields above; also
  // counts as real web presence for isPreLaunch, same reasoning as there.
  const referenceLinksContext = await getReferenceLinksContext(sources.project.referenceUrls);
  const isPreLaunch = !sources.project.productUrl && !sources.project.asin && !referenceLinksContext.hasLinks;
  const preLaunchRule = buildPreLaunchGroundingRule(isPreLaunch && uploadedTdsContext.hasFacts);
  const referenceLinksPromptText = buildReferenceLinksPromptBlock(referenceLinksContext);
  const tdsGroundingBlock = buildTdsGroundingBlock(uploadedTdsContext, isPreLaunch) + (referenceLinksPromptText ? `\n\nREFERENCE SOURCES:\n${referenceLinksPromptText}` : "");

  const derived = deriveFieldsFromSources(sources.project, sources.salesKit, sources.tds, sources.activeReport);

  // "internal"-kind fields are genuine human decisions — the API route
  // itself also rejects a direct regenerate request for one of these (see
  // app/api/documents/gtm/[id]/fields/[fieldId]/regenerate/route.ts); this
  // is defense in depth. Only tier 1-4 (the deterministic `derived` floor)
  // applies — never AI/web/computed-derivation/category tiers.
  if (schemaField.kind === "internal") {
    const finalized = finalizeFieldAnswers(
      { [fieldId]: derived[fieldId] || { answer: "N/A", source: "none" } },
      [schemaField],
      0 // internal-kind terminal is always "Awaiting internal input" — count is unused
    );
    return finalized[fieldId];
  }

  const predecessorContext = await getPredecessorProductContext(sources.project.predecessorRef, sources.project.orgId || "");
  const sourceTexts = buildSourceTexts(sources, uploadedTdsPromptText, referenceLinksPromptText, predecessorContext.text || "");
  const systemInstruction = buildSystemInstruction(productName, [schemaField], voiceBlock, preLaunchRule);
  const userContent = buildUserContent(sourceTexts);

  // Skip the AI call entirely when a grounded (spec) field's deterministic
  // derivation floor (project record/TDS/sales kit/competitive analysis —
  // see gtm-derive.ts) already has a real, complete answer. "Fill remaining
  // fields" loops this once per blank field, and burning a full OpenAI call
  // just to reconfirm a value already known from the project's own records
  // was confirmed as needless spend — mergeField (below) already falls back
  // to `derived` whenever aiRaw has nothing usable, so passing null here
  // reuses that exact path with zero behavior change for the final answer.
  // Written (narrative) fields always still need real generation, and a
  // grounded field with no derived value still gets its normal AI call.
  //
  // A single field also needs far less search than the full 77-field sweep
  // when a real call IS made — this route's own maxDuration is 45s, and the
  // web-fallback/quality-guard passes below still need their share of it.
  const skipAiForKnownGroundedValue = schemaField.kind === "grounded" && isRealAnswer(derived[fieldId]?.answer);
  const aiRaw = skipAiForKnownGroundedValue
    ? null
    : await callAi(systemInstruction, userContent, { timeoutMs: 30_000, projectId });
  const { field: mergedField, fromAi } = mergeField(schemaField, aiRaw, derived);

  let grounded = fromAi && mergedField.source !== "web"
    ? verifyGrounding({ [fieldId]: mergedField }, [schemaField], sourceTextBlocks(sourceTexts))[fieldId]
    : mergedField;

  // Uploaded TDS Ingestion — same verbatim-override + re-verification as
  // generateAllFields, scoped to this one field.
  if (schemaField.kind === "grounded" && grounded.source !== "project_record") {
    const singleFieldMap: Record<string, GtmFieldAnswer> = { [fieldId]: grounded };
    const overridden = applyUploadedTdsFacts(singleFieldMap, [schemaField], uploadedTdsContext);
    if (overridden.has(fieldId)) {
      grounded = singleFieldMap[fieldId].sourceDetail?.confirmedByUser
        ? singleFieldMap[fieldId]
        : verifyGrounding(singleFieldMap, [schemaField], uploadedTdsContext.fullTextBlocks)[fieldId];
    }
  }

  // Web fallback + tier-6 inference + category default apply regardless of
  // field kind — a single regenerated "grounded" field deserves the same
  // second-chance tiers the full 77-field sweep already gives it above.
  const guarded = { [fieldId]: grounded };
  await applyWebSearchFallback(
    guarded, [schemaField], productName, Date.now(), PIPELINE_TIME_BUDGET_MS, toolTypes, sources.project?.toolType as any,
    isPreLaunch ? "pre-launch — add a product URL/ASIN or a Reference Link under Sources to fill this in" : undefined,
    voiceBlock
  );
  const tier6Extra = await buildTier6ExtraInputs(sources, toolTypes);
  applyTier6Inference(guarded, [schemaField], {
    hairTypeSourceText: buildHairTypeSourceText(sources),
    ...tier6Extra,
  });
  // Same independence as generateAllFields' Tier 6.5 block above — at most
  // one of these 4 ever does real work for a single regenerated field
  // (each guards on its own distinct field id(s)), but running them
  // concurrently is still strictly no worse and keeps both call sites consistent.
  await Promise.all([
    applyFeaturesAndExpertTip(guarded, [schemaField], sources, productName, Date.now(), voiceBlock, tdsGroundingBlock, catalogDescription),
    applyCollectionKernelAdaptation(guarded, [schemaField], productName, collection, voiceBlock, tdsGroundingBlock),
    applyCoreConsumerBothNote(guarded, [schemaField], productName, voiceBlock, tdsGroundingBlock),
    applyBoxOnlyDerivation(guarded, [schemaField], productName, voiceBlock, tdsGroundingBlock),
  ]);
  applyCategoryDefaults(guarded, [schemaField], sources.project.category);

  if (schemaField.kind === "written") {
    await guardWrittenFieldsQuality(guarded, [schemaField], sources, productName, projectId, Date.now(), voiceBlock, preLaunchRule);
  }

  applyDeterministicNotesConventions(guarded, [schemaField], sources, productKind);

  // AI + web search + Tier 6/6.5 + category default — the 4 tiers this
  // single-field regenerate actually ran above.
  const finalized = finalizeFieldAnswers(guarded, [schemaField], 4, isPreLaunch ? "pre-launch — add a product URL/ASIN or a Reference Link under Sources to fill this in" : undefined);
  return finalized[fieldId];
}

// Mutates `fields` in place. Three independent reasons flag a written
// field for one retry attempt: (1) too similar to the same field on the
// most recently generated OTHER project (cross-product boilerplate),
// (2) fails the minimum elaboration depth for that field
// (lib/gtm-elaboration.ts), (3) too similar to a deliberately generic
// reference exemplar (lib/gtm-reference-exemplars.ts) — i.e. lazy,
// could-apply-to-any-product copy. All three share the SAME single retry
// attempt, not one round trip per reason.
//
// All retries fire concurrently (Promise.all), not one-at-a-time — with up
// to 9 written fields, a sequential loop of individual AI round-trips was
// blowing well past Vercel's fixed 60s function timeout on top of the
// initial full-document generation call, producing a hard 504 instead of
// a JSON response. If the pipeline is already close to the time budget
// (e.g. the main generation call itself ran long), retries are skipped
// entirely and the fields are just flagged — never silently exceed the cap.
// GTM Schema v3's CAPS-lead claim format — only Reason to Buy's numbered
// claims are checked (majority of lines must lead with an ALL-CAPS phrase);
// every other written field stays free narrative prose, no format
// convention to enforce. See lib/gtm-format-checks.ts.
const FORMAT_CONVENTION_FIELD_IDS = new Set(["reason_to_buy"]);

function meetsFormatConvention(fieldId: string, answer: string): boolean {
  if (!FORMAT_CONVENTION_FIELD_IDS.has(fieldId)) return true;
  const lines = answer.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  const capsLeadCount = lines.filter(hasCapsLead).length;
  return capsLeadCount / lines.length >= 0.5;
}

// Anti-copy guard against the real exemplar corpus (lib/gtm-style-exemplars.ts)
// — distinct from GENERIC_EXEMPLARS' single generic-filler check above.
// Compares against ALL 4 real products' text for this same field id;
// >0.8 similarity means the model leaned on the exemplar's own wording
// instead of writing fresh copy for THIS product. Collection-kernel
// adaptations (lib/gtm-features-and-tip.ts) are the one sanctioned reuse
// and are exempted by the caller before this ever runs on their answer.
const EXEMPLAR_COPY_SIMILARITY_THRESHOLD = 0.8;

function findExemplarCopyMatch(fieldOrGroupId: string, answer: string): string | null {
  for (const ex of GTM_STYLE_EXEMPLARS) {
    const text = ex.excerpts[fieldOrGroupId];
    if (text && textSimilarity(answer, text) > EXEMPLAR_COPY_SIMILARITY_THRESHOLD) return text;
  }
  return null;
}

async function guardWrittenFieldsQuality(
  fields: Record<string, GtmFieldAnswer>,
  schema: GtmField[],
  sources: GtmSources,
  productName: string,
  projectId: string,
  pipelineStart: number,
  voiceBlock: string = "",
  preLaunchRule: string = ""
) {
  const writtenFields = schema.filter(f => f.kind === "written");
  if (writtenFields.length === 0) return;

  const otherFields = await getMostRecentOtherDocumentFields(projectId, "gtm");
  const otherByFieldId = new Map(otherFields.map(f => [f.field_id, f]));

  const facts = [sources.project.motorTech, sources.project.keyDiff, sources.project.pricePoint]
    .filter(Boolean)
    .map(v => String(v));

  type Reason = { kind: "boilerplate" | "shallow" | "generic" | "unformatted" | "exemplar_copy" | "voice_violation"; detail?: string };
  const retryReasons = new Map<string, Reason>();

  for (const f of writtenFields) {
    const current = fields[f.id];
    if (!current?.answer || current.answer.toUpperCase() === "N/A") continue;
    // Collection-kernel adaptations (lib/gtm-features-and-tip.ts) are the
    // one sanctioned reuse of another product's text — never run the
    // exemplar-copy check (or any boilerplate-style check) against them.
    if (current.sourceDetail?.collectionKernelAdapted) continue;

    // Always-safe voice auto-fix (S|C standardization etc) applied in place
    // before any similarity/depth checks below — never gated on a retry.
    const fixed = applyDeterministicFixes(current.answer);
    if (fixed.fixes.length > 0) {
      current.answer = fixed.text;
      fields[f.id] = { ...current, sourceDetail: { ...(current.sourceDetail || {}), voiceAutoFixed: true } };
    }

    const other = otherByFieldId.get(f.id);
    if (other?.answer && other.answer.toUpperCase() !== "N/A" && textSimilarity(current.answer, other.answer) > BOILERPLATE_SIMILARITY_THRESHOLD) {
      retryReasons.set(f.id, { kind: "boilerplate", detail: other.answer });
      continue;
    }
    if (!meetsElaborationBar(f.id, current.answer)) {
      retryReasons.set(f.id, { kind: "shallow" });
      continue;
    }
    const exemplar = GENERIC_EXEMPLARS[f.id];
    if (exemplar && textSimilarity(current.answer, exemplar) > BOILERPLATE_SIMILARITY_THRESHOLD) {
      retryReasons.set(f.id, { kind: "generic" });
      continue;
    }
    const exemplarCopyMatch = findExemplarCopyMatch(f.group?.id || f.id, current.answer);
    if (exemplarCopyMatch) {
      retryReasons.set(f.id, { kind: "exemplar_copy", detail: exemplarCopyMatch });
      continue;
    }
    if (!meetsFormatConvention(f.id, current.answer)) {
      retryReasons.set(f.id, { kind: "unformatted" });
      continue;
    }
    const voiceContentType = getToneForGtmField(f.id, f.group?.id);
    if (voiceContentType) {
      const violations = findDeterministicViolations(current.answer, voiceContentType);
      if (violations.length > 0) {
        retryReasons.set(f.id, { kind: "voice_violation", detail: violations.map(v => v.rule).join(", ") });
      }
    }
  }

  if (retryReasons.size === 0) return;
  const needsRetry = writtenFields.filter(f => retryReasons.has(f.id));

  const flagAsIs = (f: GtmField, extraReason: string) => {
    const reason = retryReasons.get(f.id)!;
    fields[f.id] = {
      ...fields[f.id],
      flagged: true,
      sourceDetail: {
        ...(fields[f.id].sourceDetail || {}),
        reason: extraReason,
        similarTo: reason.detail,
        ...(reason.kind === "voice_violation" ? { voiceReview: true, voiceViolations: reason.detail?.split(", ") } : {}),
      },
    };
  };

  if (Date.now() - pipelineStart > PIPELINE_TIME_BUDGET_MS) {
    for (const f of needsRetry) flagAsIs(f, `${retryReasons.get(f.id)!.kind}-retry-skipped-timeout`);
    return;
  }

  const sourceTexts = buildSourceTexts(sources);
  const userContent = buildUserContent(sourceTexts);

  await Promise.all(
    needsRetry.map(async (f) => {
      const current = fields[f.id];
      const reason = retryReasons.get(f.id)!;
      const other = otherByFieldId.get(f.id);
      const instructionByReason = {
        boilerplate: `The previous draft was too generic — it closely matched another product's copy for this field.`,
        shallow: `The previous draft was too short/shallow — it needs real depth (see the REQUIRED DEPTH guidance above for this field).`,
        generic: `The previous draft read like generic, could-apply-to-any-product marketing filler.`,
        unformatted: `The previous draft didn't follow the required format — each claim must start with a short ALL-CAPS claim phrase (e.g. "ZERO-GAP PRECISION — cuts closer without snagging"), followed by the supporting spec and a plain-language benefit.`,
        exemplar_copy: `The previous draft copied or too closely paraphrased one of the STYLE EXEMPLAR documents' own text. Those describe a DIFFERENT product — write fresh copy grounded ONLY in ${productName}'s own real facts, matching the exemplars' depth/format/voice but never their actual wording.`,
        voice_violation: `The previous draft violated brand voice rules (${reason.detail}). Rewrite it to fix these specific issues — keep every fact/spec/number exactly as given, change only the voice/tone problem.`,
      }[reason.kind];
      const retryInstruction = `${buildSystemInstruction(productName, [f], voiceBlock, preLaunchRule)}\n\n${instructionByReason} Rewrite it using these specific facts about ${productName}: ${facts.join("; ") || "(use the specs and description from the sources above)"}.`;
      // These retries run concurrently for up to 9 written fields — a
      // shorter timeout each keeps the whole Promise.all safely inside the
      // pipeline's remaining time budget (checked just above this block).
      const retryRaw = await callAi(retryInstruction, userContent, { timeoutMs: 20_000 });
      let retryAnswer = coerceAiAnswer(retryRaw?.[f.id]?.answer);
      let retryAutoFixed = false;
      if (retryAnswer) {
        const retryFixed = applyDeterministicFixes(retryAnswer);
        retryAnswer = retryFixed.text;
        retryAutoFixed = retryFixed.fixes.length > 0;
      }

      const exemplar = GENERIC_EXEMPLARS[f.id];
      const stillBoilerplate = other?.answer && retryAnswer ? textSimilarity(retryAnswer, other.answer) > BOILERPLATE_SIMILARITY_THRESHOLD : false;
      const stillShallow = retryAnswer ? !meetsElaborationBar(f.id, retryAnswer) : true;
      const stillGeneric = exemplar && retryAnswer ? textSimilarity(retryAnswer, exemplar) > BOILERPLATE_SIMILARITY_THRESHOLD : false;
      const stillUnformatted = retryAnswer ? !meetsFormatConvention(f.id, retryAnswer) : true;
      const stillExemplarCopy = retryAnswer ? !!findExemplarCopyMatch(f.group?.id || f.id, retryAnswer) : true;
      const voiceContentType = getToneForGtmField(f.id, f.group?.id);
      const stillVoiceViolation = retryAnswer && voiceContentType ? findDeterministicViolations(retryAnswer, voiceContentType).length > 0 : false;

      if (retryAnswer && retryAnswer.toUpperCase() !== "N/A" && !stillBoilerplate && !stillShallow && !stillGeneric && !stillUnformatted && !stillExemplarCopy && !stillVoiceViolation) {
        fields[f.id] = {
          answer: retryAnswer,
          source: (retryRaw?.[f.id]?.source as GtmFieldSource) || current.source,
          sourceDetail: retryAutoFixed ? { voiceAutoFixed: true } : undefined,
        };
      } else {
        flagAsIs(f, reason.kind);
      }
    })
  );
}
