// lib/content-form-generate.ts
// Content Form tab generation — Product Detail Page content (Amazon/website
// titles, taglines, descriptions, bullets, ad sheet copy, website copy
// block, keywords), grounded in the already-resolved GTM document's own
// fields. Runs as the new "content_form" pipeline phase, strictly after
// "gtm" (all 15 fields only need Product Knowledge facts, not FAQ/
// Marketing-Direction data). Modeled directly on lib/gtm-marketing-
// direction.ts's shape (per-group grouped AI calls, voice-guard retry,
// brand-token scrub, char-limit enforcement).
import { callAiForJson } from "./ai-json-call";
import { ContentFormAnswer } from "./content-form-field-schema";
import { isRealAnswer } from "./field-answer-state";
import { getToneDirective, VoiceContentType } from "./brand-voice";
import { checkVoiceCompliance, buildVoiceCorrectionInstruction } from "./ai-generation-guard";
import type { GtmSources } from "./gtm-generate";
import type { CatalogProductRow } from "./db/catalog-products";

const GROUNDED_FACT_FIELD_IDS = [
  "product_title", "positioning_statement", "reason_to_buy", "core_consumer", "material", "hair_type",
  "warranty", "care_directions",
  ...Array.from({ length: 5 }, (_, i) => `features_full_list_${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `top_6_features_${i + 1}`),
  "motor_type", "motor_rpm", "motor_run_time", "motor_recharge_time", "motor_speed", "motor_noise_level",
  "blade_name", "fixed_blade", "cutting_blade",
];

function buildGroundedFactsBlock(gtmFields: Record<string, string>): string {
  return GROUNDED_FACT_FIELD_IDS
    .filter(id => isRealAnswer(gtmFields[id]))
    .map(id => `${id}: ${gtmFields[id]}`)
    .join("\n");
}

// Local re-implementation of lib/gtm-product-faqs.ts's private
// collectBrandTokens/findBrandNameIn — same self-contained discipline as
// lib/gtm-box-only.ts/lib/gtm-marketing-direction.ts.
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

interface FieldSpec {
  key: string;
  fieldId: string;
  tone: VoiceContentType;
  charLimit?: number;
}

function truncateToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit).trim();
}

// One grouped call + at most one combined retry for whatever violated (voice
// rules, a competitor brand name, or an over-limit char field) — same
// single-retry discipline as lib/gtm-product-faqs.ts / lib/gtm-marketing-
// direction.ts.
async function runNarrativeGroup(
  specs: FieldSpec[],
  buildPrompt: (retryInstruction?: string) => string,
  productName: string,
  label: string,
  brandTokens: string[]
): Promise<Record<string, ContentFormAnswer>> {
  // 30s, not 25s — matches every sibling GTM narrative-group call
  // (lib/gtm-marketing-direction.ts, lib/gtm-product-faqs.ts). Confirmed
  // live (scripts/reproduce-content-form-gap.ts) that a real gpt-5
  // low-effort call for this shape of prompt can take 25s+ on its own,
  // making the OLD 25s primary timeout fire routinely rather than as a
  // rare edge case — each firing burns this group's Gemini fallback
  // attempt too (see lib/tds-doc-facts.ts's own note on this exact
  // failure mode), so titles/descriptions ended up permanently
  // finalized as "Not found" from ordinary latency, not a real absence
  // of grounding facts.
  const raw = await callAiForJson<Record<string, any>>(buildPrompt(), `Product: ${productName}`, label, { timeoutMs: 30_000 });
  if (!raw) return {};

  const drafts: Record<string, string> = {};
  const checks: Record<string, ReturnType<typeof checkVoiceCompliance>> = {};
  for (const s of specs) {
    const v = raw[s.key];
    if (typeof v !== "string" || !v.trim() || v.trim().toUpperCase() === "N/A") continue;
    const check = checkVoiceCompliance(v.trim(), s.tone);
    drafts[s.key] = s.charLimit ? truncateToLimit(check.text, s.charLimit) : check.text;
    checks[s.key] = check;
  }

  const violation = (s: FieldSpec) => {
    const text = drafts[s.key];
    if (text == null) return null;
    const brand = findBrandNameIn(text, brandTokens);
    const voiceViolations = checks[s.key]?.violations || [];
    const overLimit = s.charLimit != null && (raw[s.key]?.length ?? 0) > s.charLimit;
    if (!brand && voiceViolations.length === 0 && !overLimit) return null;
    return { brand, voiceViolations, overLimit };
  };

  const violating = specs.map(s => ({ s, v: violation(s) })).filter(x => x.v);

  if (violating.length > 0) {
    const reasons: string[] = [];
    if (violating.some(x => x.v!.brand)) {
      reasons.push("At least one answer named a specific competitor brand — describe generically instead, never name a brand.");
    }
    const allVoiceViolations = violating.flatMap(x => x.v!.voiceViolations);
    if (allVoiceViolations.length > 0) reasons.push(buildVoiceCorrectionInstruction(allVoiceViolations));
    if (violating.some(x => x.v!.overLimit)) {
      reasons.push("At least one field exceeded its stated character limit — rewrite it to genuinely fit within the limit, do not just truncate mid-word.");
    }

    const retryRaw = await callAiForJson<Record<string, any>>(buildPrompt(reasons.join(" ")), `Product: ${productName}`, `${label}-Retry`, { timeoutMs: 30_000 });
    if (retryRaw) {
      for (const { s } of violating) {
        const v = retryRaw[s.key];
        if (typeof v !== "string" || !v.trim()) continue;
        const check = checkVoiceCompliance(v.trim(), s.tone);
        const text = s.charLimit ? truncateToLimit(check.text, s.charLimit) : check.text;
        const brand = findBrandNameIn(text, brandTokens);
        if (!brand && check.violations.length === 0) {
          drafts[s.key] = text;
          checks[s.key] = check;
        }
      }
    }
  }

  const result: Record<string, ContentFormAnswer> = {};
  for (const s of specs) {
    if (drafts[s.key] == null) continue;
    const v = violation(s);
    result[s.fieldId] = {
      answer: drafts[s.key],
      source: "derived",
      flagged: !!v,
      sourceDetail: v
        ? { reason: v.brand ? "possible-competitor-brand-name" : v.overLimit ? "char-limit-truncated" : "voice_violation", brand: v.brand || undefined }
        : (checks[s.key]?.autoFixed ? { voiceAutoFixed: true } : undefined),
    };
  }
  return result;
}

function buildTitlesPrompt(
  productName: string, factsBlock: string, namingConvention: string, voiceBlock: string, tdsGroundingBlock: string, retryInstruction?: string
): string {
  return `Write e-commerce titles and taglines for ${productName}, grounded ONLY in the facts below — no invented specs/claims.

FACTS:
${factsBlock}
${namingConvention}

Produce:
1. "amazon_long_title": a full Amazon listing title. Never use the word "size" anywhere in this title.
2. "ecommerce_title": a shorter e-commerce marketplace title.
3. "website_title": a website product-page title. Never use the word "size" anywhere in this title.
4. "sexy_tagline": one punchy, aspirational tagline/headline.
5. "techie_tagline": one spec-forward, technical tagline/headline.
${retryInstruction ? `\n${retryInstruction}` : ""}

Return ONLY valid JSON: { "amazon_long_title": "...", "ecommerce_title": "...", "website_title": "...", "sexy_tagline": "...", "techie_tagline": "..." }${voiceBlock}\n${getToneDirective("launch")}${tdsGroundingBlock}`;
}

function buildDescriptionsPrompt(
  productName: string, factsBlock: string, voiceBlock: string, tdsGroundingBlock: string, retryInstruction?: string
): string {
  return `Write Product Detail Page description copy for ${productName}, grounded ONLY in the facts below.

FACTS:
${factsBlock}

Produce (respect every character limit EXACTLY, including spaces):
1. "short_description": at most 229 characters.
2. "features_benefits": at most 115 characters.
3. "suggested_use": at most 200 characters, written in a clear, instructional/educational register (how to use the product).
4. "romance_copy": a longer narrative description, at most 2000 characters.
${retryInstruction ? `\n${retryInstruction}` : ""}

Return ONLY valid JSON: { "short_description": "...", "features_benefits": "...", "suggested_use": "...", "romance_copy": "..." }${voiceBlock}\n${getToneDirective("product_detail")}${tdsGroundingBlock}`;
}

function buildBulletsPrompt(
  productName: string, factsBlock: string, voiceBlock: string, tdsGroundingBlock: string, retryInstruction?: string
): string {
  return `Write consumer-facing feature bullets for ${productName}, grounded ONLY in the facts below — no invented specs.

FACTS:
${factsBlock}

Produce THREE separate bullet sets, each as an array of strings in that exact order:
1. "bullet_top3": exactly 3 bullets — the 3 main points, in priority order.
2. "bullet_long": exactly 6 bullets — each one a CAPITALIZED, BOLDED-STYLE highlighted feature name leading into 1-2 sentences of detail (e.g. "ULTRA-QUIET MOTOR — runs quieter than category average, easing all-day use.").
3. "bullet_condensed": exactly 6 bullets — each one just a highlighted feature plus 1-4 words, no colons and no periods (e.g. "Ultra-quiet motor").
${retryInstruction ? `\n${retryInstruction}` : ""}

Return ONLY valid JSON: { "bullet_top3": ["...","...","..."], "bullet_long": ["...","...","...","...","...","..."], "bullet_condensed": ["...","...","...","...","...","..."] }${voiceBlock}\n${getToneDirective("launch")}${tdsGroundingBlock}`;
}

function buildAdSheetAndWebPrompt(
  productName: string, factsBlock: string, voiceBlock: string, tdsGroundingBlock: string, retryInstruction?: string
): string {
  return `Write ad-sheet and website copy-block content for ${productName}, grounded ONLY in the facts below. Never repeat the same word across "keywords", and never name a specific competitor brand anywhere.

FACTS:
${factsBlock}

Produce:
1. "ad_sheet_headline": one short ad headline.
2. "ad_sheet_sub_header": one short ad sub-header, complementing the headline (not repeating it).
3. "website_copy_short": an array of exactly 3 strings, each combining a short feature header + a brief marketing description in ONE string (e.g. "Ultra-Quiet Motor — Barely audible operation for focused, all-day use.").
4. "website_copy_long": an array of exactly 3 strings, same header+description combined format as website_copy_short, but each with a longer description (2-3 sentences).
5. "keywords": a single comma-separated string of real, relevant search keywords — no repeated words, no competitor brand names.
${retryInstruction ? `\n${retryInstruction}` : ""}

Return ONLY valid JSON: { "ad_sheet_headline": "...", "ad_sheet_sub_header": "...", "website_copy_short": ["...","...","..."], "website_copy_long": ["...","...","..."], "keywords": "..." }${voiceBlock}\n${getToneDirective("launch")}${tdsGroundingBlock}`;
}

// Bullet/array-shaped groups need their own merge logic (each key holds an
// array, not a scalar string) — separate from runNarrativeGroup's scalar
// per-field handling above.
async function runBulletsGroup(
  productName: string, factsBlock: string, voiceBlock: string, tdsGroundingBlock: string, brandTokens: string[]
): Promise<Record<string, ContentFormAnswer>> {
  const raw = await callAiForJson<{ bullet_top3?: string[]; bullet_long?: string[]; bullet_condensed?: string[] }>(
    buildBulletsPrompt(productName, factsBlock, voiceBlock, tdsGroundingBlock), `Product: ${productName}`, "ContentForm-Bullets", { timeoutMs: 30_000 }
  );
  if (!raw) return {};

  const result: Record<string, ContentFormAnswer> = {};
  const groups: { key: "bullet_top3" | "bullet_long" | "bullet_condensed"; prefix: string; total: number }[] = [
    { key: "bullet_top3", prefix: "bullet_top3", total: 3 },
    { key: "bullet_long", prefix: "bullet_long", total: 6 },
    { key: "bullet_condensed", prefix: "bullet_condensed", total: 6 },
  ];
  for (const g of groups) {
    const arr = raw[g.key];
    if (!Array.isArray(arr)) continue;
    arr.slice(0, g.total).forEach((text, i) => {
      if (typeof text !== "string" || !text.trim()) return;
      const check = checkVoiceCompliance(text.trim(), "launch");
      const brand = findBrandNameIn(check.text, brandTokens);
      result[`${g.prefix}_${i + 1}`] = {
        answer: check.text,
        source: "derived",
        flagged: !!brand,
        sourceDetail: brand ? { reason: "possible-competitor-brand-name", brand } : (check.autoFixed ? { voiceAutoFixed: true } : undefined),
      };
    });
  }
  return result;
}

async function runAdSheetAndWebGroup(
  productName: string, factsBlock: string, voiceBlock: string, tdsGroundingBlock: string, brandTokens: string[]
): Promise<Record<string, ContentFormAnswer>> {
  const raw = await callAiForJson<{ ad_sheet_headline?: string; ad_sheet_sub_header?: string; website_copy_short?: string[]; website_copy_long?: string[]; keywords?: string }>(
    buildAdSheetAndWebPrompt(productName, factsBlock, voiceBlock, tdsGroundingBlock), `Product: ${productName}`, "ContentForm-AdSheetWeb", { timeoutMs: 30_000 }
  );
  if (!raw) return {};

  const result: Record<string, ContentFormAnswer> = {};

  for (const [key, fieldId] of [["ad_sheet_headline", "ad_sheet_headline"], ["ad_sheet_sub_header", "ad_sheet_sub_header"]] as const) {
    const v = (raw as any)[key];
    if (typeof v !== "string" || !v.trim()) continue;
    const check = checkVoiceCompliance(v.trim(), "launch");
    const brand = findBrandNameIn(check.text, brandTokens);
    result[fieldId] = { answer: check.text, source: "derived", flagged: !!brand, sourceDetail: brand ? { reason: "possible-competitor-brand-name", brand } : undefined };
  }

  const webGroups: { key: "website_copy_short" | "website_copy_long"; prefix: string }[] = [
    { key: "website_copy_short", prefix: "website_copy_short" },
    { key: "website_copy_long", prefix: "website_copy_long" },
  ];
  for (const g of webGroups) {
    const arr = raw[g.key];
    if (!Array.isArray(arr)) continue;
    arr.slice(0, 3).forEach((text, i) => {
      if (typeof text !== "string" || !text.trim()) return;
      const check = checkVoiceCompliance(text.trim(), "launch");
      const brand = findBrandNameIn(check.text, brandTokens);
      result[`${g.prefix}_${i + 1}`] = { answer: check.text, source: "derived", flagged: !!brand, sourceDetail: brand ? { reason: "possible-competitor-brand-name", brand } : undefined };
    });
  }

  if (typeof raw.keywords === "string" && raw.keywords.trim()) {
    const brand = findBrandNameIn(raw.keywords, brandTokens);
    result.keywords = { answer: raw.keywords.trim(), source: "derived", flagged: !!brand, sourceDetail: brand ? { reason: "possible-competitor-brand-name", brand } : undefined };
  }

  return result;
}

export async function generateContentForm(
  sources: GtmSources,
  gtmFieldsFlat: Record<string, string>,
  matchedProduct: CatalogProductRow | null,
  voiceBlock: string = "",
  tdsGroundingBlock: string = ""
): Promise<Record<string, ContentFormAnswer>> {
  const result: Record<string, ContentFormAnswer> = {};
  const productName = sources.project.productName;
  const factsBlock = buildGroundedFactsBlock(gtmFieldsFlat);
  const brandTokens = collectBrandTokens(sources.activeReport?.competitive_analysis);

  if (!factsBlock) return result;

  // Naming convention "[Collection] + [Type] + with + [Named Technology]" —
  // resolved from real catalog/GTM data, never guessed. Omitted entirely
  // when any part is unavailable rather than injecting a half-true template.
  const namedTechnology = matchedProduct?.motor_branded || matchedProduct?.heat_tech_branded || null;
  const namingConvention = matchedProduct?.collection && matchedProduct?.tool_type && namedTechnology
    ? `Where natural, favor the naming pattern "${matchedProduct.collection} ${matchedProduct.tool_type} with ${namedTechnology}" for the titles/taglines.`
    : "";

  const titleSpecs: FieldSpec[] = [
    { key: "amazon_long_title", fieldId: "amazon_long_title", tone: "launch" },
    { key: "ecommerce_title", fieldId: "ecommerce_title", tone: "launch" },
    { key: "website_title", fieldId: "website_title", tone: "launch" },
    { key: "sexy_tagline", fieldId: "sexy_tagline", tone: "launch" },
    { key: "techie_tagline", fieldId: "techie_tagline", tone: "launch" },
  ];
  const descriptionSpecs: FieldSpec[] = [
    { key: "short_description", fieldId: "short_description", tone: "product_detail", charLimit: 229 },
    { key: "features_benefits", fieldId: "features_benefits", tone: "product_detail", charLimit: 115 },
    { key: "suggested_use", fieldId: "suggested_use", tone: "education", charLimit: 200 },
    { key: "romance_copy", fieldId: "romance_copy", tone: "product_detail", charLimit: 2000 },
  ];

  const [titles, descriptions, bullets, adSheetAndWeb] = await Promise.all([
    runNarrativeGroup(
      titleSpecs,
      retry => buildTitlesPrompt(productName, factsBlock, namingConvention, voiceBlock, tdsGroundingBlock, retry),
      productName, "ContentForm-Titles", brandTokens
    ),
    runNarrativeGroup(
      descriptionSpecs,
      retry => buildDescriptionsPrompt(productName, factsBlock, voiceBlock, tdsGroundingBlock, retry),
      productName, "ContentForm-Descriptions", brandTokens
    ),
    runBulletsGroup(productName, factsBlock, voiceBlock, tdsGroundingBlock, brandTokens),
    runAdSheetAndWebGroup(productName, factsBlock, voiceBlock, tdsGroundingBlock, brandTokens),
  ]);

  Object.assign(result, titles, descriptions, bullets, adSheetAndWeb);
  return result;
}

const TITLE_FIELD_IDS = new Set(["amazon_long_title", "ecommerce_title", "website_title", "sexy_tagline", "techie_tagline"]);
const DESCRIPTION_FIELD_IDS = new Set(["short_description", "features_benefits", "suggested_use", "romance_copy"]);
function isBulletFieldId(id: string): boolean {
  return id.startsWith("bullet_top3_") || id.startsWith("bullet_long_") || id.startsWith("bullet_condensed_");
}
function isAdSheetOrWebFieldId(id: string): boolean {
  return id === "ad_sheet_headline" || id === "ad_sheet_sub_header" || id === "keywords"
    || id.startsWith("website_copy_short_") || id.startsWith("website_copy_long_");
}

// Single-field regenerate — re-runs the WHOLE group the field belongs to
// (same grouped prompt as the bulk generation pass) and returns only that
// one field's answer. Reuses every prompt/retry/voice-guard/brand-scrub
// path above with zero duplication, at the cost of regenerating (and
// discarding) its sibling fields' answers too — an acceptable trade-off
// for a field count this size, matching this repo's own "don't build 15
// near-duplicate single-field prompts" discipline.
export async function regenerateContentFormField(
  fieldId: string,
  sources: GtmSources,
  gtmFieldsFlat: Record<string, string>,
  matchedProduct: CatalogProductRow | null,
  voiceBlock: string = "",
  tdsGroundingBlock: string = ""
): Promise<ContentFormAnswer | null> {
  const all = await generateContentForm(sources, gtmFieldsFlat, matchedProduct, voiceBlock, tdsGroundingBlock);
  return all[fieldId] ?? null;
}

export function isContentFormFieldRegeneratable(fieldId: string): boolean {
  return TITLE_FIELD_IDS.has(fieldId) || DESCRIPTION_FIELD_IDS.has(fieldId) || isBulletFieldId(fieldId) || isAdSheetOrWebFieldId(fieldId);
}
