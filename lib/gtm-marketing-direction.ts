// lib/gtm-marketing-direction.ts
// GTM workbook export work — Marketing Direction section (4th filled tab),
// generated as the new "marketing_direction" pipeline phase
// (lib/project-generation-engine.ts) strictly after Product FAQ resolves, so
// every FAQ-derived fact (Our Differentiators/Selling Position/Rep Talking
// Points) is already-confirmed GTM data by the time this runs. Modeled on
// lib/gtm-box-only.ts's per-field derivation shape and
// lib/gtm-product-faqs.ts's "read sources -> call AI -> return a fields
// record" outer shape.
//
// The Marketing Direction exemplar excerpts live colocated in
// lib/gtm-style-exemplars.ts's existing SC x 360 Jeezy Trimmer entry (same
// real product, same corpus/gating/anti-copy-similarity infra) rather than a
// parallel module — see that file's own comment on the `marketing_*` keys.
import { callAiForJson } from "./ai-json-call";
import { GtmFieldAnswer } from "./gtm-field-schema";
import { isRealAnswer } from "./field-answer-state";
import { getToneDirective, VoiceContentType } from "./brand-voice";
import { checkVoiceCompliance, buildVoiceCorrectionInstruction } from "./ai-generation-guard";
import { textSimilarity } from "./text-similarity";
import { GTM_STYLE_EXEMPLARS, renderStyleExemplarBlock } from "./gtm-style-exemplars";
import type { GtmSources } from "./gtm-generate";
import { derivePriceRelation, parsePriceToNumber } from "./pricing-analysis";
import type { CatalogProductRow } from "./db/catalog-products";

// Same threshold as gtm-generate.ts's own (private) EXEMPLAR_COPY_SIMILARITY_THRESHOLD.
const EXEMPLAR_COPY_SIMILARITY_THRESHOLD = 0.8;

function isUnresolved(fields: Record<string, GtmFieldAnswer>, id: string): boolean {
  const current = fields[id];
  return !current || current.source === "none" || current.answer.toUpperCase() === "N/A";
}

// Local equivalent of gtm-generate.ts's private findExemplarCopyMatch — kept
// module-local (same discipline as gtm-box-only.ts) rather than exporting
// private internals from that file.
function exemplarCopySimilarity(fieldId: string, text: string): number {
  let max = 0;
  for (const ex of GTM_STYLE_EXEMPLARS) {
    const excerpt = ex.excerpts[fieldId];
    if (!excerpt) continue;
    max = Math.max(max, textSimilarity(text, excerpt));
  }
  return max;
}

// Local equivalent of gtm-product-faqs.ts's private collectBrandTokens/
// findBrandNameIn — same self-contained discipline as gtm-box-only.ts.
function collectBrandTokens(competitiveAnalysis: any): string[] {
  const competitors = [...(competitiveAnalysis?.large_brand_competitors || []), ...(competitiveAnalysis?.indie_emerging_competitors || [])];
  const tokens = new Set<string>();
  for (const c of competitors) {
    if (c?.brand) tokens.add(String(c.brand).trim().toLowerCase());
    if (c?.name) tokens.add(String(c.name).trim().toLowerCase());
  }
  return Array.from(tokens).filter(t => t.length > 2);
}

function findBrandNameIn(text: string, brandTokens: string[]): string | null {
  const lower = text.toLowerCase();
  return brandTokens.find(t => lower.includes(t)) ?? null;
}

const GROUNDED_FACT_FIELD_IDS = [
  "positioning_statement", "core_consumer", "reason_to_buy",
  "our_differentiators", "selling_position",
  "rep_talking_point_1", "rep_talking_point_2", "rep_talking_point_3",
  ...Array.from({ length: 4 }, (_, i) => `features_full_list_${i + 1}`),
  "motor_type", "motor_rpm", "motor_run_time", "motor_recharge_time", "motor_speed", "motor_noise_level",
  "blade_name", "fixed_blade", "cutting_blade",
];

function buildGroundedFactsBlock(gtmFields: Record<string, string>): string {
  return GROUNDED_FACT_FIELD_IDS
    .filter(id => isRealAnswer(gtmFields[id]))
    .map(id => `${id}: ${gtmFields[id]}`)
    .join("\n");
}

interface NarrativeSpec {
  key: string;
  fieldId: string;
  tone: VoiceContentType;
}

// One grouped call + at most one combined retry for whatever violated —
// same single-retry discipline as lib/gtm-product-faqs.ts's brand-name/
// voice-violation handling, generalized to also catch exemplar-copy leakage.
async function runNarrativeGroup(
  specs: NarrativeSpec[],
  buildPrompt: (retryInstruction?: string) => string,
  productName: string,
  label: string,
  brandTokens: string[]
): Promise<Record<string, GtmFieldAnswer>> {
  const raw = await callAiForJson<Record<string, string>>(buildPrompt(), `Product: ${productName}`, label, { timeoutMs: 30_000 });
  if (!raw) return {};

  const drafts: Record<string, string> = {};
  const checks: Record<string, ReturnType<typeof checkVoiceCompliance>> = {};
  for (const s of specs) {
    const v = raw[s.key];
    if (typeof v !== "string" || !v.trim() || v.trim().toUpperCase() === "N/A") continue;
    const check = checkVoiceCompliance(v.trim(), s.tone);
    drafts[s.key] = check.text;
    checks[s.key] = check;
  }

  const violation = (s: NarrativeSpec) => {
    const text = drafts[s.key];
    if (text == null) return null;
    const brand = findBrandNameIn(text, brandTokens);
    const voiceViolations = checks[s.key]?.violations || [];
    const copySim = exemplarCopySimilarity(s.fieldId, text) >= EXEMPLAR_COPY_SIMILARITY_THRESHOLD;
    if (!brand && voiceViolations.length === 0 && !copySim) return null;
    return { brand, voiceViolations, copySim };
  };

  const violating = specs.map(s => ({ s, v: violation(s) })).filter(x => x.v);

  if (violating.length > 0) {
    const reasons: string[] = [];
    if (violating.some(x => x.v!.brand)) {
      reasons.push("At least one answer named a specific competitor brand — describe the category/alternative generically instead, never name a brand.");
    }
    const allVoiceViolations = violating.flatMap(x => x.v!.voiceViolations);
    if (allVoiceViolations.length > 0) reasons.push(buildVoiceCorrectionInstruction(allVoiceViolations));
    if (violating.some(x => x.v!.copySim)) {
      reasons.push("At least one answer echoed the style-exemplar reference text too closely — those exemplars describe OTHER products; write fresh copy grounded in THIS product's own facts, matching only their depth/format.");
    }

    const retryRaw = await callAiForJson<Record<string, string>>(buildPrompt(reasons.join(" ")), `Product: ${productName}`, `${label}-Retry`, { timeoutMs: 30_000 });
    if (retryRaw) {
      for (const { s } of violating) {
        const v = retryRaw[s.key];
        if (typeof v !== "string" || !v.trim()) continue;
        const check = checkVoiceCompliance(v.trim(), s.tone);
        const brand = findBrandNameIn(check.text, brandTokens);
        const copySim = exemplarCopySimilarity(s.fieldId, check.text) >= EXEMPLAR_COPY_SIMILARITY_THRESHOLD;
        if (!brand && check.violations.length === 0 && !copySim) {
          drafts[s.key] = check.text;
          checks[s.key] = check;
        }
      }
    }
  }

  const result: Record<string, GtmFieldAnswer> = {};
  for (const s of specs) {
    if (drafts[s.key] == null) continue;
    const v = violation(s);
    result[s.fieldId] = {
      answer: drafts[s.key],
      source: "derived",
      flagged: !!v,
      sourceDetail: v
        ? { reason: v.brand ? "possible-competitor-brand-name" : v.copySim ? "exemplar-similarity" : "voice_violation", brand: v.brand || undefined, voiceViolations: v.voiceViolations.length ? v.voiceViolations.map(x => x.rule) : undefined }
        : (checks[s.key]?.autoFixed ? { voiceAutoFixed: true } : undefined),
    };
  }
  return result;
}

// Deterministic Consumer Barrier framing from a real price relation — split
// out (like lib/pricing-analysis.ts's derivePriceRelation) so it's directly
// unit-testable without needing a live AI call.
export function deriveBarrierFraming(relation: "above" | "below" | "at" | null): string {
  return relation === "above"
    ? "This product is priced ABOVE the category median — the barrier is a PRICE-JUSTIFICATION question (why it costs more, what the buyer gets for the premium)."
    : relation === "below" || relation === "at"
    ? "This product is priced at or below the category median — the barrier is a CREDIBILITY question (why trust this over a bigger/established name), not a price-justification one."
    : "No pricing benchmark data is available — answer generically from the product's own real differentiators, without claiming a premium or value position.";
}

// Do's/Don'ts tool-type-confusion guard clause, generalized from the
// exemplar's hardcoded "clipper vs trimmer" into whatever this product's
// real collection siblings actually are — "" when there are none, never a
// fabricated confusion pair. Split out for direct unit-testability.
export function deriveToolTypeGuardClause(ourToolType: string | null, siblingToolTypes: string[]): string {
  return siblingToolTypes.length > 0
    ? ` Include one Do/Don't guardrail against confusing this product's tool type (${ourToolType}) with its sibling type(s) in the same collection (${siblingToolTypes.join(", ")}) — never blend their messaging.`
    : "";
}

function buildStrategyPrompt(
  productName: string,
  factsBlock: string,
  barrierFraming: string,
  styleBlock: string,
  voiceBlock: string,
  tdsGroundingBlock: string,
  retryInstruction?: string
): string {
  return `Write launch-marketing strategy content for ${productName}, grounded ONLY in the facts below — no invented specs/claims/numbers.

FACTS:
${factsBlock}

Produce:
1. "primary_goal": 1-2 sentences naming the product BY NAME, stating the primary marketing goal (drive trial/awareness/revenue/retailer sell-in as appropriate to this product).
2. "success_kpis": 1-2 sentences listing KPI CATEGORIES only (e.g. revenue/sell-through, ROAS, traffic, engagement, new users) — never invent a specific numeric target.
3. "launch_timing": 1-2 sentences on when marketing should kick off relative to in-market date, including ONE concrete, product-appropriate launch mechanic or activation idea — vary the mechanic to fit THIS product; do not default to an embargo/seeding strategy unless it genuinely fits.
4. "core_audience": 1-2 sentences on who this should be marketed to, more specific than just "Pro" or "Retail".
5. "secondary_audience": 1-2 sentences on a plausible secondary audience, if a real one exists given the facts — "N/A" if none does.
6. "consumer_barrier": 1-2 sentences on the real question marketing must answer for this buyer. ${barrierFraming}
${retryInstruction ? `\n${retryInstruction}` : ""}

Return ONLY valid JSON: { "primary_goal": "...", "success_kpis": "...", "launch_timing": "...", "core_audience": "...", "secondary_audience": "...", "consumer_barrier": "..." }${voiceBlock}\n${getToneDirective("peer_selling")}${styleBlock}${tdsGroundingBlock}`;
}

function buildMessagingPrompt(
  productName: string,
  factsBlock: string,
  toolTypeGuardClause: string,
  styleBlock: string,
  voiceBlock: string,
  tdsGroundingBlock: string,
  retryInstruction?: string
): string {
  return `Write creative/messaging direction for ${productName}, grounded ONLY in the facts below.

FACTS:
${factsBlock}

Produce:
1. "messaging_direction": 2-4 sentences — tone words, point of view, what to focus messaging on, what to avoid, matching the brand's own voice.
2. "visual_direction": 2-4 sentences covering Primary/Secondary/Lifestyle/Mood/Avoid guidance for photography and video direction.
3. "content_ideas": a NUMBERED list of 6-8 distinct content ideas or territories, each grounded in a real differentiator/feature/audience insight from the facts above — concrete and specific to this product, never generic marketing filler.
4. "dos_donts": one string shaped like "DO: ...; DO: ...; ... DON'T: ...; DON'T: ..." with 5 or so of each, covering tone/visual/audience guardrails specific to this product.${toolTypeGuardClause}
${retryInstruction ? `\n${retryInstruction}` : ""}

Return ONLY valid JSON: { "messaging_direction": "...", "visual_direction": "...", "content_ideas": "...", "dos_donts": "..." }${voiceBlock}\n${getToneDirective("launch")}${styleBlock}${tdsGroundingBlock}`;
}

function buildChannelPrompt(
  productName: string,
  factsBlock: string,
  styleBlock: string,
  voiceBlock: string,
  tdsGroundingBlock: string,
  retryInstruction?: string
): string {
  return `Write channel/distribution marketing direction for ${productName}, grounded ONLY in the facts below.

FACTS:
${factsBlock}

Produce:
1. "web_coverage": 1-3 sentences of concrete web actions (PDP refresh, product-family/category page updates, cross-references) naming this product where relevant.
2. "ad_channels": a P1/P2 priority structure listing recommended paid/owned channels (e.g. "P1 Launch: Paid Social ..."), grounded in the audience/goal above — no invented budget numbers.
3. "print_material": 1-3 sentences on real print collateral candidates (sell sheet, trade show flyer, POS/shelf card, box insert) relevant to this product/channel mix.
4. "trade_show_launch": start with "Yes" or "No", then 1-2 sentences of reasoning/concept.
${retryInstruction ? `\n${retryInstruction}` : ""}

Return ONLY valid JSON: { "web_coverage": "...", "ad_channels": "...", "print_material": "...", "trade_show_launch": "..." }${voiceBlock}\n${getToneDirective("product_detail")}${styleBlock}${tdsGroundingBlock}`;
}

export async function generateMarketingDirection(
  sources: GtmSources,
  gtmFieldsFlat: Record<string, string>,
  collection: string | null,
  catalogProducts: CatalogProductRow[],
  matchedProductId: string | null,
  languagesDefault: string,
  voiceBlock: string = "",
  tdsGroundingBlock: string = ""
): Promise<Record<string, GtmFieldAnswer>> {
  const result: Record<string, GtmFieldAnswer> = {};
  const productName = sources.project.productName;
  const factsBlock = buildGroundedFactsBlock(gtmFieldsFlat);
  const brandTokens = collectBrandTokens(sources.activeReport?.competitive_analysis);

  // Collection siblings — same product/catalog data every other cross-sell
  // lookup in this codebase already has access to, just never filtered this
  // way before now.
  const siblings = collection ? catalogProducts.filter(p => p.collection === collection && p.id !== matchedProductId) : [];

  // Previous Product Reference — a factual lookup, never an AI guess.
  // Exactly one sibling resolves cleanly; zero/ambiguous falls through to
  // finalizeFieldAnswers' honest "Not found" terminal.
  if (siblings.length === 1) {
    result.marketing_previous_product_reference = { answer: siblings[0].name, source: "derived" };
  }

  // Product Name Origin — re-export the already-resolved GTM field verbatim
  // (zero AI call), same idiom as Box Only's box_product_name.
  if (isRealAnswer(gtmFieldsFlat.product_name_origin)) {
    result.marketing_product_name_origin = { answer: gtmFieldsFlat.product_name_origin, source: "derived" };
  }

  // Languages — seeded from the org default, never AI-guessed.
  result.marketing_languages = { answer: languagesDefault, source: "category_default" };

  // Consumer Barrier framing — deterministic from real pricing data, never
  // guessed. Falls back to a neutral instruction when no pricing benchmarks
  // exist at all (pre-launch products, or a report with no compared prices).
  const pricing = sources.activeReport?.pricing_analysis;
  const targetPriceRaw = parsePriceToNumber(pricing?.target_price);
  const relation = derivePriceRelation(targetPriceRaw, pricing?.competitor_prices || []);
  const barrierFraming = deriveBarrierFraming(relation);

  const ourToolType = sources.project.toolType || null;
  const siblingToolTypes = Array.from(new Set(siblings.map(s => s.tool_type).filter(t => t && t !== ourToolType)));
  const toolTypeGuardClause = deriveToolTypeGuardClause(ourToolType, siblingToolTypes);

  const strategySpecs: NarrativeSpec[] = [
    { key: "primary_goal", fieldId: "marketing_primary_goal", tone: "peer_selling" },
    { key: "success_kpis", fieldId: "marketing_success_kpis", tone: "peer_selling" },
    { key: "launch_timing", fieldId: "marketing_launch_timing", tone: "peer_selling" },
    { key: "core_audience", fieldId: "marketing_core_audience", tone: "peer_selling" },
    { key: "secondary_audience", fieldId: "marketing_secondary_audience", tone: "peer_selling" },
    { key: "consumer_barrier", fieldId: "marketing_consumer_barrier", tone: "peer_selling" },
  ];
  const messagingSpecs: NarrativeSpec[] = [
    { key: "messaging_direction", fieldId: "marketing_messaging_direction", tone: "launch" },
    { key: "visual_direction", fieldId: "marketing_visual_direction", tone: "launch" },
    { key: "content_ideas", fieldId: "marketing_content_ideas", tone: "launch" },
    { key: "dos_donts", fieldId: "marketing_dos_donts", tone: "launch" },
  ];
  const channelSpecs: NarrativeSpec[] = [
    { key: "web_coverage", fieldId: "marketing_web_coverage", tone: "product_detail" },
    { key: "ad_channels", fieldId: "marketing_ad_channels", tone: "product_detail" },
    { key: "print_material", fieldId: "marketing_print_material", tone: "product_detail" },
    { key: "trade_show_launch", fieldId: "marketing_trade_show_launch", tone: "product_detail" },
  ];

  if (factsBlock) {
    const [strategyFields, messagingFields, channelFields] = await Promise.all([
      runNarrativeGroup(
        strategySpecs,
        retry => buildStrategyPrompt(productName, factsBlock, barrierFraming, renderStyleExemplarBlock(strategySpecs.map(s => s.fieldId)), voiceBlock, tdsGroundingBlock, retry),
        productName, "GTM-MarketingDirection-Strategy", brandTokens
      ),
      runNarrativeGroup(
        messagingSpecs,
        retry => buildMessagingPrompt(productName, factsBlock, toolTypeGuardClause, renderStyleExemplarBlock(messagingSpecs.map(s => s.fieldId)), voiceBlock, tdsGroundingBlock, retry),
        productName, "GTM-MarketingDirection-Messaging", brandTokens
      ),
      runNarrativeGroup(
        channelSpecs,
        retry => buildChannelPrompt(productName, factsBlock, renderStyleExemplarBlock(channelSpecs.map(s => s.fieldId)), voiceBlock, tdsGroundingBlock, retry),
        productName, "GTM-MarketingDirection-Channel", brandTokens
      ),
    ]);
    Object.assign(result, strategyFields, messagingFields, channelFields);
  }

  return result;
}
