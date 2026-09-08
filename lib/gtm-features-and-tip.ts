// lib/gtm-features-and-tip.ts
// Tier 6.5 — Features (full list) 3-source merge (Change 3) + Expert Tip
// generated from the now-resolved Features (Change 4). Both need real AI
// calls (unlike lib/gtm-tier6-inference.ts's pure functions), so they live
// in their own module, run after Tier 6 in lib/gtm-generate.ts so
// Expert Tip has a real resolved Features list to ground against.
//
// Diagnosis for why features_full_list was chronically empty (Change 3):
// the old Tier-1 fill (lib/gtm-derive.ts) only ever read
// salesKit?.key_features — a Sales Kit project OUTPUT that frequently
// doesn't exist yet for a given project (Sales Kit generates separately,
// later, with no guarantee it exists before GTM's first run). When absent,
// the field fell straight through to the generic whole-document AI call
// with no field-specific instruction (unlike expert_tip, which already had
// one) and no deterministic floor to catch the miss — riding entirely on
// general AI reliability with zero redundancy. Fixed here with a
// deterministic floor that never depends on the Sales Kit existing at all,
// plus an AI competitor-informed top-up only when still short.
import { callAiForJson } from "./ai-json-call";
import { GtmField, GtmFieldAnswer } from "./gtm-field-schema";
import { isRealAnswer } from "./field-answer-state";
import { extractOurSpecsFromTds } from "./spec-extraction";
import type { FeatureComparable } from "./competitor-scoring";
import { matchesDifferentiator } from "./differentiator-match";
import type { CompetitorSpecSource } from "./gtm-tier6-inference";
import type { GtmSources } from "./gtm-generate";
import { findCollectionByName } from "./db/collections";
import { getToneDirective } from "./brand-voice";

export type FeatureBulletSource = "input" | "our_listing" | "competitor_informed" | "unconfirmed";
export interface FeatureBullet {
  text: string;
  source: FeatureBulletSource;
}

function dedupeAgainst(existing: string[], candidate: string): boolean {
  const lc = candidate.toLowerCase();
  return existing.some(e => {
    const el = e.toLowerCase();
    return el.includes(lc) || lc.includes(el);
  });
}

// Source #1 — our own input. Two real shapes exist for this text: a short
// comma/semicolon-separated callout list with no sentence punctuation at
// all (e.g. "EON Digital brushless motor up to 7,200rpm, Echo blade with
// shallow 2.0 cutter, full metal body" — see lib/memoryDb.ts's
// seedCatalogProductDefaults), and real multi-sentence prose (a project's
// free-text Description, or a catalog description written as actual
// sentences). Splitting a real sentence on every comma inside it produces
// a mid-sentence, no-punctuation fragment as its own "feature" (confirmed
// live — a comma right before "and irritation" split "Reduces razor
// bumps, and irritation. Its 2-in-1 design combines..." into a bare
// "Reduces razor bumps" bullet and an "and irritation. Its 2-in-1 design
// combines..." bullet). Split on sentence boundaries first whenever the
// text actually has any (a period/!/? followed by whitespace or the
// string's end) — only fall back to the comma/semicolon split when there's
// no sentence punctuation at all, i.e. it really is a short callout list.
function buildInputBullets(description: string | null | undefined): string[] {
  if (!description) return [];
  const looksLikeProse = /[.!?](\s|$)/.test(description);
  // The comma/semicolon fallback must not split a number's thousands
  // separator (e.g. "7,200rpm") in half — a real phrase-separating comma is
  // never immediately followed by a digit, so only split there.
  const parts = looksLikeProse
    ? description.split(/(?<=[.!?])\s+/)
    : description.split(/[,;](?!\d)/);
  return parts.map(s => s.trim()).filter(s => s.length > 3);
}

// Source #2 — our own listing: spec-derived sentences from TDS's own
// motor/blade/heat-tech fields (no dedicated TDS "feature_bullets" array
// field exists — product_description is the closest real analog to a raw
// Amazon feature-bullets list, so its sentences count as "our listing" too).
const TDS_SPEC_BULLET_FIELDS: { id: string; format: (v: string) => string }[] = [
  { id: "motor_type", format: v => v },
  { id: "motor_rpm", format: v => `${v} motor speed` },
  { id: "motor_run_time", format: v => `${v} run time` },
  { id: "blade_name", format: v => `${v} blade` },
  { id: "material", format: v => `${v} construction` },
  { id: "plate_material", format: v => `${v} plates` },
  { id: "heater_type", format: v => `${v} heating element` },
  { id: "max_temp_class", format: v => `Up to ${v} heat` },
];

function buildOurListingBullets(tds: Record<string, string> | null): string[] {
  if (!tds) return [];
  const bullets: string[] = [];
  for (const { id, format } of TDS_SPEC_BULLET_FIELDS) {
    const v = tds[id];
    if (isRealAnswer(v)) bullets.push(format(v));
  }
  if (isRealAnswer(tds.product_description)) {
    const sentences = tds.product_description!.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 12);
    bullets.push(...sentences.slice(0, 4));
  }
  return bullets;
}

// GTM Schema v3 — Features (full list) is a 4-row repeatable group
// (features_full_list_1..4, see lib/gtm-field-schema.ts's groupFields)
// rather than one multi-line field. Each bullet becomes its own row/answer,
// tagged with its source exactly like before; trailing unused rows are
// simply never written (lib/gtm-group-fields.ts trims them from CSV/PDF).
export const FEATURES_FULL_LIST_GROUP_SIZE = 4;

// Provenance (which of the 4 FeatureBulletSource tiers a bullet came from)
// is stored separately in sourceDetail.source, and "needs review" is a real
// flagged chip in the UI (both already set where this is called) — a
// bracketed "[Input]"/"[Our listing]" suffix baked into the visible answer
// text itself was pure redundant clutter with no reader not already served
// by those, so the row's real content is the whole answer now.
function renderFeatureRowAnswer(bullet: FeatureBullet): string {
  return bullet.text;
}

// Still needed for Expert Tip grounding below: an EXISTING document
// generated before this change may still have a stale "[Input]"/"[Our
// listing]" suffix sitting in its stored answer — strip it defensively so
// it never leaks into Expert Tip's prompt content. A no-op on any answer
// generated after this change (nothing left to strip).
function stripSourceTag(rowAnswer: string): string {
  return rowAnswer.replace(/\s*\[[^\]]+\]\s*$/, "").trim();
}

// Deterministic floor — never depends on the Sales Kit or an AI call
// succeeding. Returns null only when literally nothing is available from
// either the catalog input or TDS (a brand-new project with no data yet).
// Two possible "input" sources, both real callout text a human already
// wrote (never AI-invented): the project's own free-text Description (typed
// on the analyze/new-project form) AND, when this product is linked to a
// catalog record, that record's own `description` — which lib/catalog-import.ts
// sometimes populates straight from a spreadsheet's "Features & Benefits"
// column, so it can carry real feature callouts even when the project's own
// Description was left sparse or blank. Merged and deduped rather than
// either replacing the other, since either one alone might be the richer of
// the two for a given project.
export function deriveFeaturesFullListDeterministic(
  projectDescription: string | null | undefined,
  tds: Record<string, string> | null,
  catalogDescription: string | null | undefined = null
): FeatureBullet[] {
  const projectBullets = buildInputBullets(projectDescription);
  const catalogBullets = buildInputBullets(catalogDescription).filter(b => !dedupeAgainst(projectBullets, b));
  const inputBullets = [...projectBullets, ...catalogBullets];
  const listingBulletsRaw = buildOurListingBullets(tds);
  const listingBullets = listingBulletsRaw.filter(b => !dedupeAgainst(inputBullets, b));

  return [
    ...inputBullets.map((text): FeatureBullet => ({ text, source: "input" })),
    ...listingBullets.map((text): FeatureBullet => ({ text, source: "our_listing" })),
  ];
}

const FEATURE_TARGET_COUNT = 4;

interface CompetitorTopUpBullet { text: string; confirmed: boolean }

// Source #3 — competitor-informed top-up. Only called when still short of
// ~6 bullets after the deterministic floor. Phrases a competitor-mentioned
// feature as OUR spec-grounded equivalent ONLY where our own specs confirm
// it; anything unconfirmed is tagged "Category-expected (confirm): …" and
// flagged, never stated as fact.
async function topUpFeaturesWithCompetitors(
  productName: string,
  existingBullets: FeatureBullet[],
  ourSpecs: FeatureComparable,
  competitors: CompetitorSpecSource[],
  voiceBlock: string,
  tdsGroundingBlock: string = ""
): Promise<FeatureBullet[]> {
  if (existingBullets.length >= FEATURE_TARGET_COUNT || competitors.length === 0) return [];

  const competitorFeatureText = competitors
    .slice(0, 5)
    .map(c => (c.feature_bullets || []).join("; "))
    .filter(Boolean)
    .join("\n");
  if (!competitorFeatureText) return [];

  const needed = FEATURE_TARGET_COUNT - existingBullets.length;
  const systemInstruction = `You are extracting product features for "${productName}", a real physical product. You are given OUR product's CONFIRMED specs and features mentioned in COMPETITOR listings in the same category/price band.

Produce up to ${needed} ADDITIONAL feature bullets not already covered by the "ALREADY LISTED" set below.

Rules:
- If a competitor-mentioned feature is CONFIRMED by our own specs (a matching value), phrase it as OUR spec-grounded equivalent (e.g. competitor "cordless 3hr runtime" + our spec "3.5h run time" -> "Up to 3.5 hours cordless run time"), and set confirmed: true.
- If NOT confirmed by our specs, phrase it plainly as the feature itself (do not add any prefix yourself) and set confirmed: false.
- Never invent a spec value we don't have. Never state an unconfirmed feature as settled fact.

Return ONLY valid JSON: { "bullets": [{ "text": "...", "confirmed": true|false }] }${voiceBlock}\n${getToneDirective("launch")}${tdsGroundingBlock}`;

  const userContent = `OUR CONFIRMED SPECS: ${JSON.stringify(ourSpecs)}
ALREADY LISTED (do not repeat): ${existingBullets.map(b => b.text).join("; ") || "(none)"}
COMPETITOR FEATURES:
${competitorFeatureText}`;

  const raw = await callAiForJson<{ bullets?: CompetitorTopUpBullet[] }>(systemInstruction, userContent, "GTM-Features-TopUp", { timeoutMs: 20_000 });
  if (!raw?.bullets?.length) return [];

  return raw.bullets
    .filter(b => b && typeof b.text === "string" && b.text.trim())
    .slice(0, needed)
    .map((b): FeatureBullet =>
      b.confirmed
        ? { text: b.text.trim(), source: "competitor_informed" }
        : { text: `Category-expected (confirm): ${b.text.trim()}`, source: "unconfirmed" }
    );
}

// Returns the merged bullet list (deterministic floor + AI competitor
// top-up when still short), capped at the group's row count — the caller
// (applyFeaturesAndExpertTip) writes one bullet per row.
export async function deriveFeaturesFullList(sources: GtmSources, voiceBlock: string = "", tdsGroundingBlock: string = "", catalogDescription: string | null = null): Promise<FeatureBullet[]> {
  const floor = deriveFeaturesFullListDeterministic(sources.project.description, sources.tds, catalogDescription);
  const ca = sources.activeReport?.competitive_analysis || {};
  const competitors: CompetitorSpecSource[] = [...(ca.large_brand_competitors || []), ...(ca.indie_emerging_competitors || [])];
  const ourSpecs = extractOurSpecsFromTds(sources.tds);

  const topUp = await topUpFeaturesWithCompetitors(sources.project.productName, floor, ourSpecs, competitors, voiceBlock, tdsGroundingBlock);
  return [...floor, ...topUp].slice(0, FEATURES_FULL_LIST_GROUP_SIZE);
}

// CHANGE 4 — Expert Tip, generated FROM the now-resolved Features (never
// the other way around) so it can only ever reference a feature that's
// actually in the sheet. Grounding is bespoke (written-kind fields are
// otherwise exempt from lib/gtm-grounding.ts's generic verifyGrounding) —
// reuses lib/differentiator-match.ts's matchesDifferentiator token-overlap
// check rather than a new implementation, treating the referenced feature
// text as the "differentiator" the tip must genuinely be about.
async function generateExpertTip(productName: string, confirmedFeatureLines: string[], voiceBlock: string, tdsGroundingBlock: string = ""): Promise<string | null> {
  if (confirmedFeatureLines.length === 0) return null;
  const topFeatures = confirmedFeatureLines.slice(0, 3);

  const systemInstruction = `Write ONE expert tip (1-2 sentences) for barbers/stylists using ${productName}, built on these confirmed features: ${topFeatures.join("; ")}.

The tip MUST reference a real feature from that list and give actionable technique advice a professional would use. No invented capabilities — only use what's in the confirmed features above.

Return ONLY valid JSON: { "tip": "..." }${voiceBlock}\n${getToneDirective("education")}${tdsGroundingBlock}`;

  const raw = await callAiForJson<{ tip?: string }>(systemInstruction, `Confirmed features: ${topFeatures.join("; ")}`, "GTM-ExpertTip", { timeoutMs: 20_000 });
  const tip = raw?.tip?.trim();
  return tip && tip.toUpperCase() !== "N/A" ? tip : null;
}

export function isGroundedInFeatures(tip: string, confirmedFeatureLines: string[]): boolean {
  return confirmedFeatureLines.some(feature => matchesDifferentiator(feature, tip));
}

// Mutates `fields` in place, same convention as
// lib/gtm-tier6-inference.ts's applyTier6Inference. Only fills fields
// that are part of the passed schema AND still unresolved once every
// earlier tier (AI, web, Tier 6) has had its turn.
function isUnresolved(fields: Record<string, GtmFieldAnswer>, id: string): boolean {
  const current = fields[id];
  return !current || current.source === "none" || current.answer.toUpperCase() === "N/A";
}

// GTM style-corpus work, Part C — collection narrative kernel adaptation.
// The real Homie Clipper/Shaver/Foil GTM sheets all repeat-and-adapt the
// SAME origin paragraph rather than each inventing an unrelated story —
// this mirrors that: when a product's catalog `collection` matches a
// stored kernel (lib/db/collections.ts), Product Name Origin /
// name-ties-to-story get the kernel fed in as REQUIRED source material
// with an explicit adapt-don't-invent-don't-copy instruction. Runs after
// the main AI call (same isUnresolved gating as the rest of Tier 6.5) so
// it only fills in when the general-purpose AI declined to answer (the
// expected outcome per buildSystemInstruction's own rule: "skip gracefully
// to N/A if the sources give no real basis — never invent a naming
// story" — a collection-less/AI-only attempt has no real basis, but the
// kernel gives it one). Marks its answer's sourceDetail.collectionKernelAdapted
// so guardWrittenFieldsQuality's anti-copy check (which would otherwise
// treat "reusing" the kernel's own wording as exemplar copying) exempts it
// — this is the one sanctioned content reuse in the whole corpus system.
const COLLECTION_KERNEL_FIELD_IDS = ["product_name_origin", "name_story_tie"] as const;

async function adaptCollectionKernelField(
  fieldId: string,
  productName: string,
  collectionName: string,
  kernel: { narrative_kernel: string; logo_meaning: string; voice_notes: string },
  voiceBlock: string,
  tdsGroundingBlock: string = ""
): Promise<string | null> {
  const askedFor =
    fieldId === "product_name_origin"
      ? "where the product's name comes from / what it's rooted in"
      : "how the product's name ties back to the collection's story (why the name earns its place, not just what it is)";

  const systemInstruction = `You are writing the "${fieldId}" field for "${productName}", part of the "${collectionName}" collection.

COLLECTION NARRATIVE KERNEL (the shared origin story for every product in this collection):
${kernel.narrative_kernel}
Logo meaning: ${kernel.logo_meaning}
Voice: ${kernel.voice_notes}

Write 2-4 sentences answering: ${askedFor}. ADAPT the kernel above to THIS specific product (name-check ${productName} and, if the kernel mentions sibling products, place this one naturally among them) — do not invent a different, unrelated story, and do not copy the kernel's sentences verbatim. Match the collection's voice.

Return ONLY valid JSON: { "text": "..." }${voiceBlock}\n${getToneDirective("product_detail")}\n(The collection's own voice notes above are a narrower flavor within this brand voice — follow both; the collection notes never override the brand's hard rules.)${tdsGroundingBlock}`;

  const raw = await callAiForJson<{ text?: string }>(systemInstruction, `Product: ${productName}\nCollection: ${collectionName}`, "GTM-CollectionKernel", { timeoutMs: 20_000 });
  const text = raw?.text?.trim();
  return text && text.toUpperCase() !== "N/A" ? text : null;
}

export async function applyCollectionKernelAdaptation(
  fields: Record<string, GtmFieldAnswer>,
  schema: GtmField[],
  productName: string,
  collection: string | null | undefined,
  voiceBlock: string = "",
  tdsGroundingBlock: string = ""
): Promise<void> {
  if (!collection) return;
  const kernelRow = await findCollectionByName(collection);
  if (!kernelRow || !kernelRow.narrative_kernel) return;

  // product_name_origin and name_story_tie are independent adaptations of
  // the SAME kernel onto two different fields — no shared state between
  // them, so they run concurrently instead of one-after-another (each is
  // its own multi-second AI call).
  const fieldIdsToFill = COLLECTION_KERNEL_FIELD_IDS.filter(fieldId => schema.some(f => f.id === fieldId) && isUnresolved(fields, fieldId));
  await Promise.all(
    fieldIdsToFill.map(async fieldId => {
      const text = await adaptCollectionKernelField(fieldId, productName, kernelRow.name, kernelRow, voiceBlock, tdsGroundingBlock);
      if (text) {
        fields[fieldId] = {
          answer: text,
          source: "derived",
          sourceDetail: { label: `Adapted from ${kernelRow.name} collection kernel`, collectionKernelAdapted: true },
        };
      }
    })
  );
}

// GTM style-corpus work, Part D — Core Consumer "Both" reason/direction.
// core_consumer is already deterministic (the project's own targetMarket,
// see lib/gtm-derive.ts) — confirmed against the real Homie Clipper/Shaver
// GTM sheets that "Both (Include reason & directon in Notes)" is the exact
// stored convention, with the Notes column itself left blank in both real
// docs (a human convention that was never actually followed — this fills
// it for real). Writes ONLY `notes` via GtmFieldAnswer.notes, never
// touches `answer` — the select stays exactly "Both". Uses the same
// FieldAnswerLike.notes -> saveDocumentFields plumbing as everything else
// in Part D/E, so an existing human Notes value is never overwritten.
async function generateCoreConsumerBothNote(productName: string, voiceBlock: string, tdsGroundingBlock: string = ""): Promise<string | null> {
  const systemInstruction = `"${productName}"'s Core Consumer is "Both" — it's sold to Pro and Retail buyers alike. Write ONE sentence giving the reason/direction for targeting both audiences with this specific product (e.g. its price point, use case, or positioning that makes it work for both).

Return ONLY valid JSON: { "note": "..." }${voiceBlock}\n${getToneDirective("product_detail")}${tdsGroundingBlock}`;
  const raw = await callAiForJson<{ note?: string }>(systemInstruction, `Product: ${productName}`, "GTM-CoreConsumerBothNote", { timeoutMs: 15_000 });
  const note = raw?.note?.trim();
  return note && note.toUpperCase() !== "N/A" ? note : null;
}

export async function applyCoreConsumerBothNote(
  fields: Record<string, GtmFieldAnswer>,
  schema: GtmField[],
  productName: string,
  voiceBlock: string = "",
  tdsGroundingBlock: string = ""
): Promise<void> {
  if (!schema.some(f => f.id === "core_consumer")) return;
  const current = fields["core_consumer"];
  if (!current || current.answer !== "Both" || current.notes) return;
  const note = await generateCoreConsumerBothNote(productName, voiceBlock, tdsGroundingBlock);
  if (note) fields["core_consumer"] = { ...current, notes: note };
}

export async function applyFeaturesAndExpertTip(
  fields: Record<string, GtmFieldAnswer>,
  schema: GtmField[],
  sources: GtmSources,
  productName: string,
  pipelineStart: number,
  voiceBlock: string = "",
  tdsGroundingBlock: string = "",
  catalogDescription: string | null = null
): Promise<void> {
  // Features (full list) is a 4-row group — gate on row 1 as the
  // representative "still needs deriving" check, same as any other field.
  const wantsFeatures = schema.some(f => f.id === "features_full_list_1") && isUnresolved(fields, "features_full_list_1");
  if (wantsFeatures) {
    const bullets = await deriveFeaturesFullList(sources, voiceBlock, tdsGroundingBlock, catalogDescription);
    bullets.forEach((bullet, i) => {
      fields[`features_full_list_${i + 1}`] = {
        answer: renderFeatureRowAnswer(bullet),
        source: "derived",
        sourceDetail: { source: bullet.source },
        flagged: bullet.source === "unconfirmed",
      };
    });
  }

  const wantsTip = schema.some(f => f.id === "expert_tip") && isUnresolved(fields, "expert_tip");
  if (!wantsTip) return;

  // Expert Tip's grounding basis: whichever features_full_list_N rows are
  // real right now — either just-resolved above (full-document generation
  // always resolves Features first in the same pass) or, for a single-field
  // regenerate of ONLY expert_tip (no Features rows in `fields` at all),
  // the document's existing answers (sources.existingFieldAnswers,
  // populated by the regenerate route).
  const confirmedFeatureLines: string[] = [];
  for (let i = 1; i <= FEATURES_FULL_LIST_GROUP_SIZE; i++) {
    const rowAnswer = fields[`features_full_list_${i}`]?.answer ?? sources.existingFieldAnswers?.[`features_full_list_${i}`];
    if (!isRealAnswer(rowAnswer)) continue;
    const line = stripSourceTag(rowAnswer!);
    if (line && !line.startsWith("Category-expected")) confirmedFeatureLines.push(line);
  }
  if (confirmedFeatureLines.length === 0) return;

  const tip = await generateExpertTip(productName, confirmedFeatureLines, voiceBlock, tdsGroundingBlock);
  if (!tip) return;

  if (isGroundedInFeatures(tip, confirmedFeatureLines)) {
    fields["expert_tip"] = { answer: tip, source: "derived", sourceDetail: { label: "Generated from key features" } };
    return;
  }

  // One retry with a stricter, more explicit prompt before giving up —
  // same single-retry discipline as guardWrittenFieldsQuality's written-
  // field quality guard in lib/gtm-generate.ts.
  const retryTip = await generateExpertTip(productName, confirmedFeatureLines.slice(0, 1), voiceBlock, tdsGroundingBlock);
  if (retryTip && isGroundedInFeatures(retryTip, confirmedFeatureLines)) {
    fields["expert_tip"] = { answer: retryTip, source: "derived", sourceDetail: { label: "Generated from key features" } };
  }
  // Otherwise leave unresolved — falls through to the terminal
  // "Not determinable" state in lib/field-finalize.ts, never ships an
  // ungrounded tip.
}
