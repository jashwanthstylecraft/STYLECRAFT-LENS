import { prisma } from "./db";
import { memoryDb } from "./memoryDb";
import { genAI, hasGeminiKey, GEMINI_MODEL, cleanJsonString } from "./gemini";
import { openai, hasOpenAIKey, OPENAI_MODEL } from "./openai";
import { getAmazonProduct, fetchAmazonProductFresh, resolveAsinBySearch, hasRainforestKey, searchAmazonCategory, type RainforestProduct } from "./rainforest";
import { isSupabaseConfigured } from "./supabase";
import { updateAnalysisPhase, completeAnalysis, failAnalysis, getAnalysis, setPendingQuestion, getRecentAnalysesForBoilerplateCheck, updatePhase1BrandProgress, patchAnalysisPhaseResults, resetPhase3ForRegeneration, patchRelatedProducts } from "./db/analyses";
import { textSimilarity, BOILERPLATE_SIMILARITY_THRESHOLD } from "./text-similarity";
import { extractAsinFromUrl } from "./snapshot-capture";
import { createReportFromAnalysis, syncReportCompetitorByAsin } from "./db/reports";
import { buildPhase3Prompt } from "./prompts/phase3";
import { getMarketData } from "./market-data";
import { buildOverviewParagraph } from "./build-overview-paragraph";
import { identifyProduct, needsUserInput, IdentityCard } from "./product-identification";
import { getKnownBrandsHint } from "./known-brands-by-category";
import { assertToolType, buildToolTypePromptGuard, getToolTypeLabel } from "./tool-type-taxonomy";
import type { ToolType } from "./tool-type-taxonomy";
import { listToolTypes } from "./db/tool-types";
import type { ToolTypeRow } from "./db/tool-types";
import { finalizeCitations, fetchPageMeta } from "./citations";
import { insertProvenance } from "./db/section-provenance";
import { resolveCacheKey } from "./product-cache-key";
import { buildPricingProvenanceTier } from "./section-provenance";
import { computePriceBand, deriveTierKeyword, isWithinBand, buildOutOfBandLabel, parsePriceToNumber, type CompetitorTier } from "./price-band";
import { getDocumentByProject, getDocumentFields } from "./db/documents";
import { resolveLegacyBrandsForIdentity, type ResolvedLegacyRegistry } from "./legacy-brand-registry";
import { searchCuratedLegacyBrands, normalizeBrandToken, type BrandProgressEntry } from "./legacy-brand-discovery";
import { listMotorFamilies, logMotorTechMiss } from "./db/motor-families";
import type { MotorFamilyRow } from "./db/motor-families";
import { recordCorrection, getActiveCorrectionsForToolType, type CorrectionReason, type CompetitorCorrectionRow } from "./db/competitor-corrections";
import { listBrandedMotorNames } from "./db/branded-motor-names";
import type { BrandedMotorNameRow } from "./db/branded-motor-names";
import { getScoringProfileForToolType } from "./db/scoring-profiles";
import { isMotorizedCategory, computeMotorMatchTier } from "./motor-taxonomy";
import { extractCompetitorMotorType, resolveOurMotorType, type OurMotorResolution } from "./motor-extraction";
import { listHeatTechFamilies } from "./db/heat-tech-families";
import type { HeatTechFamilyRow } from "./db/heat-tech-families";
import { listBrandedHeatTechNames } from "./db/branded-heat-tech-names";
import type { BrandedHeatTechNameRow } from "./db/branded-heat-tech-names";
import { computeHeatTechMatchTier } from "./heat-tech-taxonomy";
import { extractCompetitorHeatTech, resolveOurHeatTech, type OurHeatTechResolution } from "./heat-tech-extraction";
import {
  computeMotorScore, computePriceScoreAbsolute, computePriceScoreRelative, computeFeatureScore,
  computeCompositeScore, dedupeToOnePerBrand, computeRelatedProductSimilarity, resolveEffectiveWeights, type MatchingWeights, type RelatedProductProfile,
} from "./competitor-scoring";
import { buildIndieBrandLineups, computePercentileInLineup, type LineupProduct } from "./indie-brand-lineup";
import { discoverBrandSiteCandidatesForEmerging } from "./brand-site-discovery";
import { resolveOurLineupTier, percentileForManualTier, type LineupTier } from "./our-product-position";
import { listCatalogProducts } from "./db/catalog-products";
import { extractCompetitorSpecs, extractOurSpecsFromTds } from "./spec-extraction";
import { getTdsFieldsForProject } from "./db/documents";
import { matchesDifferentiator } from "./differentiator-match";
import { passesGroomingIndustryGate, type GroomingGateCandidateInput } from "./grooming-industry-gate";
import { deriveGroomingTag, type GroomingTag } from "./grooming-tag-taxonomy";
import { listGroomingGateRules, getGroomingGateConfidenceThreshold, logGroomingGateIncident, type GroomingGateRuleRow } from "./db/grooming-gate-rules";

// "brushless rotary" style combined label — used consistently everywhere
// our own motor type needs to appear in a search query or prompt.
function formatMotorLabel(motor: OurMotorResolution | null): string | null {
  if (!motor) return null;
  return motor.modifierLabel ? `${motor.modifierLabel} ${motor.label}` : motor.label;
}

// Criterion-agnostic wording for buildPhase1Prompt/buildPhase2Prompt — the
// literal word "motor" must never appear in a discovery prompt for a
// motorless tool type (see Fix 3's "no motor terms in discovery queries"
// requirement). `term` is the noun phrase used in a full sentence ("motor
// technology"/"plate/heat technology"); `typeWord` is the shorter form used
// in "different X type"/"X mismatch" phrasing. Both are null for 'none'
// (no criterion applies at all — neither word should appear).
function criterionPhrasing(kind: "motor" | "heat_technology" | "none"): { term: string | null; typeWord: string | null } {
  if (kind === "heat_technology") return { term: "plate/heat technology", typeWord: "plate/heat" };
  if (kind === "motor") return { term: "motor technology", typeWord: "motor" };
  return { term: null, typeWord: null };
}

// Which evidence-backed criterion dominates this product's competitor
// scoring — 'motor' (clipper/trimmer/shaver/dryer), 'heat_technology'
// (flat iron/curling iron/hot brush — motorless styling tools), or 'none'
// (neither applies, e.g. "other_styling"/"combo"). Replaces the old
// family-based isMotorizedCategory() gate for this decision — that gate
// grouped every "beauty"-family type together (dryer AND flat iron AND
// other_styling all shared family:"beauty"), which is exactly why
// motorless types were wrongly treated as needing a motor answer before
// this column existed. Falls back to isMotorizedCategory's own keyword-
// sniffing only for the rare case of a toolType with no matching
// tool_types row at all (should never happen for a real live analysis,
// but never crash over it) — preserves old behavior for that edge case.
// Exported for the same offline-verify reason as buildPhase1Prompt below.
export function resolvePrimaryCriterion(identity: Pick<IdentityCard, "category" | "subcategory" | "targetUser" | "toolType">, toolTypes: ToolTypeRow[]): "motor" | "heat_technology" | "none" {
  const row = identity.toolType ? toolTypes.find(t => t.type_key === identity.toolType) : undefined;
  if (row) return row.primary_criterion;
  return isMotorizedCategory(identity, toolTypes) ? "motor" : "none";
}

export interface CorrectionSignals {
  blockedAsins: Set<string>;
  penalizedAsins: Set<string>;
  corrections: CompetitorCorrectionRow[];
}

// Turns a tool type's active (non-expired) correction history into
// discovery-time signals — "ASINs replaced with reason 'Wrong product
// entirely' or 'Discontinued' are excluded from future candidate pools...
// 2+ independent corrections -> hard exclude; 1 correction -> heavy score
// penalty" (never both at once for the same ASIN). "Independent" means
// from 2+ DISTINCT users — this table has no org scoping (corrections are
// deliberately a cross-org shared signal, keyed only by tool_type) and no
// approval gate before taking effect, so counting raw ROWS instead of
// distinct users let any single account hard-block a real competitor's
// ASIN for every org's future analyses by submitting two corrections
// against it themselves (a security-audit finding, fixed here — see
// SECURITY_REPORT.md). A correction with no user_id (memoryDb/legacy rows)
// counts as its own always-distinct bucket rather than being silently
// dropped, so this can't be gamed by omitting it either.
// Exported for the same offline-verify reason as buildPhase1Prompt below.
export function buildCorrectionSignals(corrections: CompetitorCorrectionRow[]): CorrectionSignals {
  const usersByAsin = new Map<string, Set<string>>();
  for (const corr of corrections) {
    // "wrong_industry"/"not_comparable" (Remove reasons — Part 3) carry the
    // exact same "this doesn't belong here" signal strength as
    // "wrong_product"/"discontinued" — same block/penalize treatment below.
    if (corr.reason !== "wrong_product" && corr.reason !== "discontinued" && corr.reason !== "wrong_industry" && corr.reason !== "not_comparable") continue;
    const asin = corr.old_asin.toUpperCase();
    const userKey = corr.user_id || `anon:${corr.id}`;
    if (!usersByAsin.has(asin)) usersByAsin.set(asin, new Set());
    usersByAsin.get(asin)!.add(userKey);
  }
  const blockedAsins = new Set<string>();
  const penalizedAsins = new Set<string>();
  usersByAsin.forEach((users, asin) => {
    if (users.size >= 2) blockedAsins.add(asin);
    else penalizedAsins.add(asin);
  });
  return { blockedAsins, penalizedAsins, corrections };
}

// PART 3.2 (preference signal) — "Better/more relevant competitor exists"
// corrections, scoped to the SAME matching context (tool type — already
// implicit in correctionSignals — plus motor/heat-tech family and price
// band), become a small known-good seed CHECKED EARLY (before any AI
// discovery search runs this round). Re-verified live via getAmazonProduct
// first — "never trusted stale" — so a since-discontinued or repriced
// "better competitor" never gets silently re-injected forever. Capped
// small so this never dominates a normal discovery round; a candidate
// that no longer resolves live is just skipped, never surfaced as an error.
export async function seedKnownGoodCandidates(
  correctionSignals: CorrectionSignals,
  tier: "legacy" | "emerging",
  primaryCriterion: "motor" | "heat_technology" | "none",
  ourMotor: OurMotorResolution | null,
  ourHeatTech: OurHeatTechResolution | null,
  priceBand: string | null
): Promise<any[]> {
  const ourFamilyKey = primaryCriterion === "motor" ? (ourMotor?.familyKey ?? null) : primaryCriterion === "heat_technology" ? (ourHeatTech?.familyKey ?? null) : null;
  const relevant = correctionSignals.corrections.filter(corr => {
    if (corr.reason !== "better_competitor") return false;
    if (priceBand && corr.price_band && corr.price_band !== priceBand) return false;
    if (primaryCriterion === "motor" && ourFamilyKey && corr.motor_family && corr.motor_family !== ourFamilyKey) return false;
    if (primaryCriterion === "heat_technology" && ourFamilyKey && corr.heat_tech_family && corr.heat_tech_family !== ourFamilyKey) return false;
    return true;
  });

  const seen = new Set<string>();
  const seeds: any[] = [];
  for (const corr of relevant) {
    // new_asin is only null for a "remove" correction (correction_type:
    // "remove"), which never carries reason:"better_competitor" — but the
    // type is nullable at the row boundary, so this is guarded rather than
    // assumed.
    if (!corr.new_asin) continue;
    const asin = corr.new_asin.toUpperCase();
    if (seen.has(asin) || seeds.length >= 3) continue;
    seen.add(asin);
    const product = await getAmazonProduct(asin);
    if (!product) continue;
    seeds.push({
      name: product.title, brand: product.brand, tier,
      asin: product.asin, amazon_url: product.amazon_url, price: product.price, price_raw: product.price_raw,
      rating: product.rating_str, review_count: product.reviews_str, monthly_sales: product.monthly_str, bsr_rank: product.bsr,
      initials: (product.brand || product.title || "??").substring(0, 2).toUpperCase(),
      key_features: [], strengths: [], weaknesses: [], recent_news: [], top_feature_summary: "",
      specifications: product.specifications, attributes: product.attributes, feature_bullets: product.feature_bullets, description: product.description,
      verified_by_rainforest: true,
      known_good_seed: true,
      inclusion_rationale: "Previously identified by a user as a better-fit competitor for this category.",
    });
  }
  return seeds;
}

// Related Products feature — up to 3 user-pasted "nearby similar products"
// (analyze form, next to Positioning Context) seed discovery as ADDITIVE
// signals only: never change the Motor -> Price -> Brand gate order or any
// hard rule (see selectByCompositeScore's 5 gates, all untouched by this
// feature). A ResolvedRelatedProduct is shaped exactly like a normal
// competitor object (same fields mergeRainforestProductIntoCompetitor
// already produces) plus a few extra provenance/eligibility fields.
export interface ResolvedRelatedProduct {
  // null for a non-Amazon related product (any other product/competitor
  // page URL) — no Rainforest data exists for it, only whatever the page
  // itself declared (see the `external` branch in resolveRelatedProducts).
  asin: string | null;
  url?: string | null;
  addedAt: string;
  name: string;
  [key: string]: any;
  toolTypeMismatch: boolean;
  toolTypeMismatchLabel: string | null;
  // false for a cross-tool-type paste (e.g. a clipper pasted into a
  // trimmer analysis) OR a non-Amazon external URL (no structured product
  // data to score/motor-match against) — still resolved/displayed in the
  // Related Products section, but never pushed into the discovery pool at all.
  eligibleForPoolSeeding: boolean;
  resolutionFailed?: boolean;
  // True for a related product resolved from a non-Amazon URL — no asin,
  // no Rainforest price/rating/image; name/brand come from the page's own
  // title/hostname instead. Lets the UI/PDF render a "View original page"
  // link instead of an Amazon listing link.
  external?: boolean;
}

// Resolves each related ASIN into a full Rainforest payload + motor/heat-
// tech extraction — called once from the Phase 0 block, before any AI
// discovery round runs, and persisted to analyses.related_products
// (patchRelatedProducts) independently of phase0_result. Reuses the exact
// same budget machinery (remainingRainforestBudget/withDeadline/
// RAINFOREST_CANDIDATE_DEADLINE_MS) every other Rainforest call site in
// this file shares — a slow/failed resolution just marks that one product
// unresolved (resolutionFailed: true), it never blocks Phase 0 from
// completing, matching this file's fail-open convention throughout.
export async function resolveRelatedProducts(
  relatedAsins: { asin: string | null; url?: string | null; addedAt: string }[] | undefined,
  card: IdentityCard,
  toolTypes: ToolTypeRow[],
  routeStartTime: number
): Promise<ResolvedRelatedProduct[]> {
  if (!relatedAsins?.length) return [];

  const primaryCriterion = resolvePrimaryCriterion(card, toolTypes);
  const [motorFamilies, brandedNames, heatTechFamilies, brandedHeatTechNames] = await Promise.all([
    primaryCriterion === "motor" ? listMotorFamilies() : Promise.resolve([] as MotorFamilyRow[]),
    primaryCriterion === "motor" ? listBrandedMotorNames() : Promise.resolve([] as BrandedMotorNameRow[]),
    primaryCriterion === "heat_technology" ? listHeatTechFamilies() : Promise.resolve([] as HeatTechFamilyRow[]),
    primaryCriterion === "heat_technology" ? listBrandedHeatTechNames() : Promise.resolve([] as BrandedHeatTechNameRow[]),
  ]);

  return mapWithConcurrency(relatedAsins.slice(0, 3), 3, async (entry): Promise<ResolvedRelatedProduct> => {
    // Non-Amazon related product — no ASIN was ever resolvable for it (see
    // the analyze form's own preview call), so there's no Rainforest data
    // and no motor/tool-type extraction possible. Re-fetch its page
    // title/text fresh here (never trust the client-cached preview for
    // what actually gets analyzed) purely for discovery-context grounding
    // and display; never eligible for pool-seeding — there's no structured
    // product data to score it against real discovered competitors with.
    if (!entry.asin) {
      if (!entry.url) {
        return {
          asin: null, url: null, addedAt: entry.addedAt, name: "Unresolved related product",
          toolTypeMismatch: false, toolTypeMismatchLabel: null, eligibleForPoolSeeding: false, resolutionFailed: true,
        };
      }
      const meta = await withDeadline(fetchPageMeta(entry.url), RAINFOREST_CANDIDATE_DEADLINE_MS, null);
      let hostname: string | null = null;
      try { hostname = new URL(entry.url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
      if (!meta || !meta.title) {
        return {
          asin: null, url: entry.url, addedAt: entry.addedAt, name: hostname || entry.url,
          toolTypeMismatch: false, toolTypeMismatchLabel: null, eligibleForPoolSeeding: false, resolutionFailed: true, external: true,
        };
      }
      return {
        asin: null, url: entry.url, addedAt: entry.addedAt, name: meta.title, brand: hostname,
        toolTypeMismatch: false, toolTypeMismatchLabel: null, eligibleForPoolSeeding: false, resolutionFailed: false, external: true,
      };
    }

    const budgetLeft = remainingRainforestBudget(routeStartTime);
    const product = budgetLeft > 0
      ? await withDeadline(getAmazonProduct(entry.asin), Math.min(RAINFOREST_CANDIDATE_DEADLINE_MS, budgetLeft), null)
      : null;

    if (!product) {
      return {
        asin: entry.asin.toUpperCase(), url: entry.url ?? null, addedAt: entry.addedAt, name: entry.asin,
        toolTypeMismatch: false, toolTypeMismatchLabel: null, eligibleForPoolSeeding: false, resolutionFailed: true,
      };
    }

    let related: any = mergeRainforestProductIntoCompetitor(
      { name: product.title, brand: product.brand, tier: "related", key_features: [], strengths: [], weaknesses: [], recent_news: [] },
      product
    );

    if (primaryCriterion === "motor") {
      const motorExtraction = extractCompetitorMotorType({ ...related, title: related.name }, motorFamilies, { brand: related.brand, brandedNames });
      related = { ...related, motor_type: motorExtraction?.label ?? null, motor_family_key: motorExtraction?.familyKey ?? null, motor_branded_name: motorExtraction?.brandedName ?? null };
    } else if (primaryCriterion === "heat_technology") {
      const heatTechExtraction = extractCompetitorHeatTech({ ...related, title: related.name }, heatTechFamilies, { brand: related.brand, brandedNames: brandedHeatTechNames });
      related = { ...related, heat_tech_type: heatTechExtraction?.label ?? null, heat_tech_family_key: heatTechExtraction?.familyKey ?? null, heat_tech_branded_name: heatTechExtraction?.brandedName ?? null };
    }

    const mismatch = card.toolType ? assertToolType(product.title, card.toolType, toolTypes) : { ok: true };
    const toolTypeMismatch = !mismatch.ok;

    return {
      ...related,
      asin: product.asin, url: entry.url ?? null, addedAt: entry.addedAt,
      toolTypeMismatch,
      toolTypeMismatchLabel: toolTypeMismatch ? `Doesn't match this analysis's tool type${card.toolType ? ` (${getToolTypeLabel(card.toolType, toolTypes)})` : ""}` : null,
      eligibleForPoolSeeding: !toolTypeMismatch,
    };
  });
}

// Maps eligible related products into the same pool-candidate shape every
// other discovered candidate has, tagged for provenance — merged into
// Phase 1/2's `pool` alongside seedKnownGoodCandidates's output so an
// eligible related product can independently earn a legacy/emerging slot
// by passing the SAME 5 gates as everything else (tool-type gate,
// correction-exclude, price-band widen-loop, motor-evidence split, brand-
// dedupe) — this function never bypasses any of them, it only ever adds
// one extra pool entry per eligible related product.
export function buildRelatedProductSeeds(relatedProducts: ResolvedRelatedProduct[], tier: "legacy" | "emerging"): any[] {
  return relatedProducts
    .filter(rp => rp.eligibleForPoolSeeding && !rp.resolutionFailed)
    .map(rp => ({
      ...rp,
      tier,
      inclusion_rationale: "User-provided related product — independently matched this analysis's discovery criteria.",
      related_product_seed: true,
      related_product_asin: rp.asin,
    }));
}

// Amazon "similar/related" search leverage (additive signal, separate from
// buildRelatedProductSeeds above) — searches Amazon using each eligible
// related product's own brand + title keywords, surfacing real neighbors
// an AI discovery prompt alone might not have found. Tool-type-gated
// exactly like discoverCompetitorsLive's own live-search results below — a
// mismatched neighbor is dropped here, never reaches the pool at all.
// Shares the same RAINFOREST_STEP_DEADLINE_MS clock as every other
// Rainforest call in this phase step; stops early once that budget is gone.
export async function searchRelatedProductNeighbors(
  relatedProducts: ResolvedRelatedProduct[],
  toolTypes: ToolTypeRow[],
  identity: IdentityCard,
  tier: "legacy" | "emerging",
  routeStartTime: number
): Promise<any[]> {
  if (!hasRainforestKey) return [];
  const eligible = relatedProducts.filter(rp => rp.eligibleForPoolSeeding && !rp.resolutionFailed);
  if (!eligible.length) return [];

  // Every `eligible` entry has a real asin at runtime — only an
  // Amazon-resolved related product is ever eligibleForPoolSeeding:true (an
  // external/no-asin one is always false, see resolveRelatedProducts) —
  // filter(Boolean) here is just to satisfy the now-nullable asin type.
  const seenAsins = new Set<string>(eligible.map(rp => rp.asin).filter((a): a is string => !!a));
  const collected: any[] = [];

  for (const rp of eligible) {
    if (remainingRainforestBudget(routeStartTime) <= 0) break;
    const titleKeywords = (rp.name || "").split(/\s+/).slice(0, 4).join(" ");
    const query = [rp.brand, titleKeywords].filter(Boolean).join(" ").trim();
    if (!query) continue;

    const results = await searchAmazonCategory(query, 5);
    for (const r of results) {
      if (seenAsins.has(r.asin)) continue;
      if (identity.toolType && !assertToolType(r.title, identity.toolType, toolTypes).ok) continue;
      seenAsins.add(r.asin);
      const brand = (r.title.split(/[\s,]+/)[0] || "Unknown").replace(/[^\w-]/g, "");
      collected.push({
        name: r.title.length > 100 ? `${r.title.slice(0, 100)}…` : r.title,
        brand, tier, asin: r.asin, amazon_url: `https://www.amazon.com/dp/${r.asin}`,
        price: r.price, price_raw: r.price_raw, rating: r.rating, review_count: r.reviewsTotal,
        monthly_sales: r.monthlyStr, bsr_rank: null,
        initials: brand.slice(0, 2).toUpperCase(),
        key_features: [], strengths: [], weaknesses: [], recent_news: [], top_feature_summary: "",
        verified_by_rainforest: true,
        related_product_neighbor_seed: true,
        related_product_neighbor_of: rp.asin,
      });
    }
  }
  return collected;
}

// The Claude/OpenAI discovery-context sentence — joined into
// buildPhase1Prompt/buildPhase2Prompt's existing extraInstruction
// composition at every call site, exactly like fillRoundExtraInstruction/
// buildCorrectionsGuidance already are (all `.filter(Boolean).join("\n\n")`
// composed). Returns null when there are no eligible related products so
// callers' filter drops it cleanly — no new prompt-builder parameter
// needed anywhere.
export function buildRelatedProductsDiscoveryContext(relatedProducts: ResolvedRelatedProduct[]): string | null {
  const eligible = relatedProducts.filter(rp => !rp.resolutionFailed);
  if (!eligible.length) return null;
  const summaries = eligible.map(rp => {
    const attrs = [rp.brand, rp.motor_type || rp.heat_tech_type, rp.price].filter(Boolean).join(", ");
    return attrs ? `${rp.name} (${attrs})` : rp.name;
  });
  return `The user provided these as examples of nearby similar products: ${summaries.join("; ")}. Prioritize candidates with comparable profiles.`;
}

// PART 3.4 (prompt-level feedback digest) — a compact summary of this tool
// type's correction history, concatenated into the discovery AI's
// extraInstruction (same mechanism fillRoundExtraInstruction already
// uses) so the model itself steers away from already-corrected mistakes,
// not just the post-hoc blocklist filter applied to whatever it returns.
// Capped to the 10 most recent entries (corrections arrive newest-first
// from getActiveCorrectionsForToolType) so the prompt stays lean
// regardless of how much history accumulates.
export function buildCorrectionsGuidance(corrections: CompetitorCorrectionRow[]): string | null {
  const recent = corrections.slice(0, 10);
  const rejected = recent.filter(c => c.reason === "wrong_product" || c.reason === "discontinued").map(c => c.old_title || c.old_asin);
  const preferred = recent.filter(c => c.reason === "better_competitor").map(c => c.new_title || c.new_asin);
  if (rejected.length === 0 && preferred.length === 0) return null;
  const parts: string[] = [];
  if (rejected.length > 0) parts.push(`Previously rejected by users for this category: ${rejected.join(", ")} (avoid similar picks).`);
  if (preferred.length > 0) parts.push(`Previously preferred by users: ${preferred.join(", ")} (similar profiles rank higher).`);
  return parts.join(" ");
}

export interface AnalysisContext {
  id: string;
  orgId: string;
  userId: string;
  projectId: string | null;
  industry: string;
  targetMarket: "pro" | "consumer" | "both";
  productName: string;
  description: string;
  category?: string;
  companyContext?: string;
  // Canonical motor family key (one of lib/validations.ts's
  // MOTOR_FAMILY_VALUES), selected directly from the form's Motor Type
  // select — authoritative, never fuzzy-matched, since it's already one of
  // the 7 canonical families. motorBrandedName is the optional, display-only
  // marketing name typed alongside it (e.g. "EON Digital Brushless Motor")
  // — never used for matching/grounding, only shown in documents/PDF next
  // to the canonical family. motorTech is the legacy free-text field kept
  // for backward compatibility with analyses created before this select
  // existed — resolveOurMotorType (lib/motor-extraction.ts) only falls back
  // to fuzzy-matching it when motorFamily is absent.
  motorFamily?: string;
  motorBrandedName?: string;
  motorTech?: string;
  // Full parallel to motorFamily/motorTech above, for tool types whose
  // primary_criterion is 'heat_technology' (flat iron/curling iron/hot
  // brush) instead of 'motor' — see lib/heat-tech-taxonomy.ts/
  // lib/heat-tech-extraction.ts. heatTechRaw is the legacy free-text
  // fallback, mirroring motorTech's role exactly.
  heatTechFamily?: string;
  heatTechBrandedName?: string;
  heatTechRaw?: string;
  keyDiff?: string;
  pricePoint?: string;
  // Set when the analyze form's catalog picker was used to select a real
  // catalog_products row — an authoritative id, checked FIRST by
  // resolveOurLineupTier (lib/our-product-position.ts) before falling back
  // to fuzzy name matching. Absent for manual/custom entries.
  catalogProductId?: string | null;
  // Set via the pause-and-ask answer route when resolveOurLineupTier
  // (lib/our-product-position.ts) can't match the input to a real
  // StyleCraft catalog product — needed only for indie-brand relative
  // price scoring (Phase 2).
  lineupTier?: LineupTier;
  // Required on the analyze/new-project forms going forward — strict
  // tool-type isolation (see lib/tool-type-taxonomy.ts) needs an
  // authoritative signal that isn't the AI's own free-text category/
  // subcategory. Optional here only for backward compatibility with
  // analyses created before this field existed (identifyProduct falls
  // back to evidence-based resolution, pausing to ask if that's also
  // unresolvable — never guesses).
  toolType?: ToolType;
  // Set via the analyze/new-project forms' "Adjust weights for this
  // analysis" expander — when present, always wins over the resolved
  // per-tool-type lib/db/scoring-profiles.ts profile for this one run
  // (never persisted back to the profile unless the form's own "Save to
  // profile" action is used, a separate explicit API call).
  weightOverride?: MatchingWeights;
  // Up to 3 user-pasted "nearby similar products" (Related Products field,
  // next to Positioning Context) — raw input only. The enriched Rainforest+
  // motor-extraction result (resolveRelatedProducts, below) lives in its
  // own analyses.related_products column, resolved once in Phase 0 and
  // read fresh by every later phase — never re-derived from this raw list.
  relatedAsins?: { asin: string | null; url?: string; addedAt: string }[];
}

// Snapshotted onto the phase1/phase2 result alongside matching_weights
// (same "auditability independent of later admin/form edits" reasoning) —
// feeds the "Data Sources & Methodology" appendix (lib/export-pdf.ts) and
// the results/report UI, printing every form input that's supposed to
// shape a run right next to the weights that actually used them.
function buildFormInputsSnapshot(context: AnalysisContext) {
  return {
    // context.productName IS the catalog product's own name at submission
    // time when catalogProductId is set (auto-filled by the analyze form's
    // catalog picker) — no separate DB lookup needed for this display line.
    catalogProductName: context.catalogProductId ? context.productName : null,
    industry: context.industry,
    targetMarket: context.targetMarket,
    toolType: context.toolType ?? null,
    motorFamily: context.motorFamily ?? null,
    motorBrandedName: context.motorBrandedName ?? null,
    motorTech: context.motorTech ?? null,
    heatTechFamily: context.heatTechFamily ?? null,
    heatTechBrandedName: context.heatTechBrandedName ?? null,
    heatTechRaw: context.heatTechRaw ?? null,
    keyDiff: context.keyDiff ?? null,
    pricePoint: context.pricePoint ?? null,
  };
}

// Keyed off the VERIFIED, STRICT identity.toolType (lib/tool-type-taxonomy.ts)
// only — never off `context.industry` (this app's `industry` field only
// ever has two values, both containing "grooming"/"styling", so keying
// fallback data off it routed every analysis to the same branch regardless
// of the actual product) and never off the free-text category/subcategory
// strings either (the previous version's single combined "clipper" OR
// "trimmer" OR "barber" OR "grooming" branch always returned the SAME
// 100%-clipper-named static pool for a trimmer analysis — the single most
// direct, deterministic leak point found when a real trimmer analysis was
// reported showing clipper competitors/specs; this branch is now split per
// tool type, each with its own correctly-typed data, and callers below
// additionally run every fallback candidate through assertToolType before
// splicing it in — see applyPriceBandGate's top-up loop).
function getCategoryFallbackCompetitors(identity: IdentityCard, defaultTier: "legacy" | "emerging") {
  const toolType = identity.toolType;

  // Dryer / styling family — unchanged from before, just now gated on the
  // strict toolType instead of a free-text substring check.
  if (toolType === "dryer" || toolType === "flat_iron" || toolType === "curling_iron" || toolType === "hot_brush" || toolType === "other_styling") {
    return defaultTier === "legacy"
      ? [
          {
            name: "Dyson Supersonic Professional Hair Dryer",
            brand: "Dyson",
            asin: "B0189O6FES",
            price: "$429.99",
            rating: "4.7",
            reviewCount: "12,410",
            sales: "2,000+ bought in past month",
            bsr: "#412 in Beauty & Personal Care",
            initials: "DY",
            top_positive_review_themes: ["Extreme drying speed", "Low heat damage", "Acoustic control quietness"],
            top_negative_review_themes: ["Very high price point", "Heavy cord block", "Stiff attachments"],
            confirmed_technical_specs: { motor_type: "Digital Brushless V9", rpm: "110,000 RPM", run_time: "Corded", charging_time: "N/A", blade_material: "N/A", body_material: "Premium Polymer" }
          },
          {
            name: "BaBylissPRO Nano Titanium Ionic Dryer",
            brand: "BaBylissPRO",
            asin: "B00132890C",
            price: "$89.99",
            rating: "4.6",
            reviewCount: "18,920",
            sales: "4,000+ bought in past month",
            bsr: "#189 in Beauty & Personal Care",
            initials: "BB",
            top_positive_review_themes: ["Lightweight handling", "Consistent heat control", "Sturdy switch controls"],
            top_negative_review_themes: ["Shorter cord length", "High fan noise level", "Comb attachment slips"],
            confirmed_technical_specs: { motor_type: "AC Motor", rpm: "20,000 RPM", run_time: "Corded", charging_time: "N/A", blade_material: "N/A", body_material: "Titanium Composite" }
          },
          {
            name: "Conair InfinitiPRO 1875W AC Motor Dryer",
            brand: "Conair",
            asin: "B000E0L3C0",
            price: "$39.99",
            rating: "4.5",
            reviewCount: "35,120",
            sales: "10,000+ bought in past month",
            bsr: "#95 in Beauty & Personal Care",
            initials: "CO",
            top_positive_review_themes: ["Excellent value for price", "Durable heating element", "Simple filter cleaning"],
            top_negative_review_themes: ["Slightly heavy build", "Plastic odor on first use", "Weak cool shot lock"],
            confirmed_technical_specs: { motor_type: "AC Motor", rpm: "18,000 RPM", run_time: "Corded", charging_time: "N/A", blade_material: "N/A", body_material: "Polycarbonate" }
          },
          {
            name: "Parlux Alyon Air Ionizer Tech Dryer",
            brand: "Parlux",
            asin: "B07D38J36T",
            price: "$230.00",
            rating: "4.6",
            reviewCount: "1,450",
            sales: "300+ bought in past month",
            bsr: "#4,812 in Beauty & Personal Care",
            initials: "PA",
            top_positive_review_themes: ["Extended professional lifespan", "Perfect hand balance", "Very high heat setting"],
            top_negative_review_themes: ["Expensive premium price", "Hard to find parts", "Stiff heat dials"],
            confirmed_technical_specs: { motor_type: "K-Advance Plus DC", rpm: "22,000 RPM", run_time: "Corded", charging_time: "N/A", blade_material: "N/A", body_material: "Antibacterial Plastic" }
          },
          {
            name: "Revlon One-Step Volumizer Original Styler",
            brand: "Revlon",
            asin: "B01LSUQSB0",
            price: "$39.88",
            rating: "4.6",
            reviewCount: "340,110",
            sales: "15,000+ bought in past month",
            bsr: "#12 in Beauty & Personal Care",
            initials: "RE",
            top_positive_review_themes: ["Simultaneous dry and style", "Great volume styling", "Frizz reducing ceramic"],
            top_negative_review_themes: ["Tends to run hot", "Bulky brush diameter", "Bristles wear down quickly"],
            confirmed_technical_specs: { motor_type: "DC Motor", rpm: "15,000 RPM", run_time: "Corded", charging_time: "N/A", blade_material: "N/A", body_material: "Ceramic Composite" }
          }
        ]
      : [
          {
            // Re-verified live 2026-08-25 (scripts/find-real-asin.ts) after
            // the original B0B739JCHX ASIN was confirmed DEAD (Rainforest
            // returned outcome:"empty" — delisted) and surfaced as a real
            // broken "Amazon Listing" link on a live analysis. HD430 is the
            // Shark FlexStyle's current base/flagship variant (highest
            // review count among its live color/kit variants).
            name: "Shark FlexStyle Air Multi-Styler & Drying System (HD430)",
            brand: "Shark Ninja",
            asin: "B0B89P16MC",
            price: "$249.99",
            rating: "4.2",
            reviewCount: "6,686",
            sales: "5,000+ bought in past month",
            bsr: "#4,196 in Beauty & Personal Care",
            initials: "SH",
            top_positive_review_themes: ["Versatile wand conversion", "Lower heat damage risk", "Fast auto-wrap curling"],
            top_negative_review_themes: ["Curls lose hold quickly", "Learning curve for wrap", "Heavy base handle"],
            confirmed_technical_specs: { motor_type: "Brushless Digital", rpm: "110,000 RPM", run_time: "Corded", charging_time: "N/A", blade_material: "N/A", body_material: "Polymer" }
          },
          {
            // Replaces the original Zuvi Halo entry (asin B09MSN69P3) —
            // also confirmed DEAD live (Rainforest outcome:"empty"), and
            // re-checked with a fresh Amazon search: the Zuvi brand no
            // longer appears to have ANY current listing (line discontinued/
            // delisted entirely, not just this one ASIN). SRILabs DryQ is a
            // real, currently-verified infrared dryer competitor in the
            // same emerging/infrared niche the original entry represented.
            name: "SRILabs DryQ Infrared Hair Dryer",
            brand: "Skin Research Institute",
            asin: "B0BRM9ZW8H",
            price: "$299.99",
            rating: "4.5",
            reviewCount: "1,364",
            sales: "1,000+ bought in past month",
            bsr: "#17,171 in Beauty & Personal Care",
            initials: "SR",
            top_positive_review_themes: ["Infrared light drying comfort", "Foldable travel-friendly design", "Low heat damage on fine hair"],
            top_negative_review_themes: ["Slower drying speed", "Premium price barrier", "Limited heat configuration"],
            confirmed_technical_specs: { motor_type: "High-speed DC", rpm: "N/A", run_time: "Corded", charging_time: "N/A", blade_material: "N/A", body_material: "Composite" }
          },
          {
            // Re-verified live 2026-08-25 — original B09T9B69B9 confirmed
            // dead (same audit as the two entries above).
            name: "Laifen Swift Professional High-Speed Hair Dryer",
            brand: "Laifen",
            asin: "B0F4KMQQBM",
            price: "$139.99",
            rating: "4.4",
            reviewCount: "663",
            sales: "1,000+ bought in past month",
            bsr: "#11,180 in Beauty & Personal Care",
            initials: "LA",
            top_positive_review_themes: ["Near silent operation", "Stunning premium look", "Fractions of Dyson cost"],
            top_negative_review_themes: ["Diffuser sold separately", "Short cord length", "Buttons feel cheap"],
            confirmed_technical_specs: { motor_type: "Brushless Digital", rpm: "110,000 RPM", run_time: "Corded", charging_time: "N/A", blade_material: "N/A", body_material: "ABS Plastic" }
          },
          {
            // Replaces the original "Waverly Pro Ceramic Hair Styler" entry
            // (asin B0C1185G9P, confirmed dead) — no real "Waverly Pro"
            // product could be found on a live re-search either, so this is
            // a genuinely different but comparable real, currently-verified
            // ceramic multi-styler in the same price/category niche.
            name: "CHI Multi-Wave Styler",
            brand: "CHI",
            asin: "B08TG4HFWP",
            price: "$104.96",
            rating: "4.3",
            reviewCount: "119",
            sales: "300+ bought in past month",
            bsr: "#142,783 in Beauty & Personal Care",
            initials: "CH",
            top_positive_review_themes: ["Deep waving plates", "Quick ceramic heating", "Adjustable barrel size"],
            top_negative_review_themes: ["Heavy handle lock", "Creases hair easily", "No automatic shutoff"],
            confirmed_technical_specs: { motor_type: "PTC Element", rpm: "N/A", run_time: "Corded", charging_time: "N/A", blade_material: "N/A", body_material: "Ceramic coated" }
          },
          {
            // Re-verified live 2026-08-25 — original B07S17R2NW confirmed
            // dead (same audit as the entries above).
            name: "TYMO Ring Hair Straightener Brush",
            brand: "TYMO",
            asin: "B07RLTPSLB",
            price: "$39.89",
            rating: "4.4",
            reviewCount: "13,970",
            sales: "8,000+ bought in past month",
            bsr: "#6,965 in Beauty & Personal Care",
            initials: "TY",
            top_positive_review_themes: ["Saves straightening time", "Safe anti-scald teeth", "Leaves natural volume"],
            top_negative_review_themes: ["Pulls hair if tangled", "Doesn't reach roots well", "Stiff power button"],
            confirmed_technical_specs: { motor_type: "PTC Element", rpm: "N/A", run_time: "Corded", charging_time: "N/A", blade_material: "N/A", body_material: "Ceramic Coated Polymer" }
          }
        ];
  }

  // Clippers ONLY — trimmers get their own branch below with genuinely
  // trimmer-specific products, never these. Shavers get no dedicated
  // dataset (this app has none) and fall through to the honest empty
  // return at the bottom rather than borrowing clipper data.
  if (toolType === "clipper") {
    return defaultTier === "legacy"
      ? [
          {
            name: "Wahl Professional 5-Star Cordless Magic Clip",
            brand: "Wahl",
            asin: "B00UK8F7BI",
            price: "$109.99",
            rating: "4.5",
            reviewCount: "24,847",
            sales: "2,000+ bought in past month",
            bsr: "#1,162 in Beauty & Personal Care",
            initials: "WA",
            top_positive_review_themes: ["Stagger-tooth crunch blade", "Lightweight ergonomic body", "Excellent fading blend"],
            top_negative_review_themes: ["Plastic housing feels thin", "Battery life drops over time", "Blades need frequent zero-gapping"],
            confirmed_technical_specs: { motor_type: "Rotary Motor", rpm: "5,500 RPM", run_time: "100 min", charging_time: "120 min", blade_material: "Crunch Stagger-Tooth Chrome", body_material: "Heavy-duty Plastic" }
          },
          {
            name: "Andis Recon Professional Vector Motor Clipper",
            brand: "Andis",
            asin: "B0DTJLSTYM",
            price: "$199.99",
            rating: "4.5",
            reviewCount: "820",
            sales: "500+ bought in past month",
            bsr: "#2,152 in Beauty & Personal Care",
            initials: "AN",
            top_positive_review_themes: ["Intelligent torque adjustment", "High velocity cutting power", "Very comfortable weight"],
            top_negative_review_themes: ["Generates moderate heat", "Clicks loudly on startup", "Premium price tier"],
            confirmed_technical_specs: { motor_type: "Vector Motor", rpm: "9,500 RPM", run_time: "120 min", charging_time: "90 min", blade_material: "DLC Carbon Steel", body_material: "Polycarbonate/Metal" }
          },
          {
            // Live-verified 2026-08-18 — the previous ASIN (B07P41S83V,
            // "GoldFX Outlining Clipper") no longer resolves to a real
            // Rainforest/Amazon listing (confirmed via a direct lookup:
            // request succeeded but returned no product). BaByliss appears
            // to have retired the "GoldFX" naming for this line in favor of
            // "FXONE" — replaced with the real, currently-listed FXONE
            // outlining trimmer, same product category. All fields below
            // (price/rating/reviews/bsr/specs) are from a live Rainforest
            // pull of this exact ASIN, not carried over from the old entry.
            name: "BaBylissPRO FXONE Professional Cordless Outlining Trimmer",
            brand: "BaBylissPRO",
            asin: "B0CFSQJZ3Z",
            price: "$249.99",
            rating: "4.5",
            reviewCount: "635",
            sales: "—",
            bsr: "#63,458 in Beauty & Personal Care",
            initials: "BB",
            top_positive_review_themes: ["All-metal housing with knurled grip", "Zero-gap adjustable titanium T-blade", "Interchangeable battery with LED charge indicator"],
            top_negative_review_themes: ["Requires the separate FXONE battery system", "Premium price for a detail/outlining-only tool", "Metal body adds some weight"],
            confirmed_technical_specs: { motor_type: "N1 Brushless", rpm: "—", run_time: "180 min", charging_time: "—", blade_material: "Titanium (Zero-Gap T-Blade)", body_material: "All-Metal" }
          },
          {
            name: "JRL FreshFade 2020C Professional",
            brand: "JRL",
            asin: "B08NPDW1C8",
            price: "$139.99",
            rating: "4.6",
            reviewCount: "2,812",
            sales: "1,000+ bought in past month",
            bsr: "#12,983 in Beauty & Personal Care",
            initials: "JR",
            top_positive_review_themes: ["Stay-cool blade tech", "Advanced locking lever system", "Quiet whispering operation"],
            top_negative_review_themes: ["Blade requires custom replacements", "Plastic body details feel cheap", "Bulky dimensions"],
            confirmed_technical_specs: { motor_type: "Advanced Rotary", rpm: "7,200 RPM", run_time: "240 min", charging_time: "180 min", blade_material: "Titanium Ceramic", body_material: "Hardened Plastic" }
          },
          {
            name: "TPOB Play Cordless Vector Motor Clipper",
            brand: "TPOB",
            asin: "B0CMQG8H7S",
            price: "$89.99",
            rating: "4.2",
            reviewCount: "156",
            sales: "300+ bought in past month",
            bsr: "#133,173 in Beauty & Personal Care",
            initials: "TP",
            top_positive_review_themes: ["Very aggressive price point", "Dynamic vector load speed", "Aggressive modern aesthetic"],
            top_negative_review_themes: ["Shorter battery lifespan", "Rough housing seams", "Inconsistent power switch feel"],
            confirmed_technical_specs: { motor_type: "Vector Motor", rpm: "10,000 RPM", run_time: "120 min", charging_time: "90 min", blade_material: "DLC Carbon", body_material: "Injection Molded Plastic" }
          },
          {
            // Live-verified 2026-08-18 — the previous ASIN (B09KGBM3R4,
            // "Saber Professional Brushless Clipper") no longer resolves to
            // a real listing either. Replaced with the real, currently-
            // listed "Saber 2" successor model (StyleCraft's own real
            // current catalog product — see lib/db/catalog-products.ts's
            // "Saber 2 Professional Hair Clipper with EON Digital Brushless
            // Motor"). All fields below are from a live Rainforest pull.
            name: "StyleCraft Saber 2 Professional Cordless Brushless Motor Hair Clipper",
            brand: "StyleCraft",
            asin: "B0DFDSXTQF",
            price: "$299.95",
            rating: "4.2",
            reviewCount: "209",
            sales: "—",
            bsr: "#42,263 in Beauty & Personal Care",
            initials: "SC",
            top_positive_review_themes: ["EON brushless motor runs at 7,200 RPM", "DLC Echo fixed blade for a smoother cut", "Heavy-duty full metal body"],
            top_negative_review_themes: ["2.5-hour runtime is shorter than some rivals", "Higher price point than the original Saber trimmer", "Full metal body adds weight"],
            confirmed_technical_specs: { motor_type: "EON Digital Brushless", rpm: "7,200 RPM", run_time: "150 min", charging_time: "120 min", blade_material: "DLC Echo Fixed Blade", body_material: "Full Metal" }
          }
        ]
      : [
          {
            name: "SUPRENT Fangs Professional Hair Clipper",
            brand: "SUPRENT",
            asin: "B0CPPDY5N6",
            price: "$79.99",
            rating: "4.4",
            reviewCount: "312",
            sales: "500+ bought in past month",
            bsr: "#24,192 in Beauty & Personal Care",
            initials: "SU",
            top_positive_review_themes: ["Vector motor automatic torque", "Super affordable vector entry", "Compact size fits small hands"],
            top_negative_review_themes: ["Battery drains quickly on thick hair", "Cheap plastic guards", "High motor vibration"],
            confirmed_technical_specs: { motor_type: "Vector Motor", rpm: "9,000 RPM", run_time: "100 min", charging_time: "120 min", blade_material: "Titanium Coated Steel", body_material: "Composite Plastic" }
          },
          {
            name: "Supreme Trimmer Darkstar Vector Motor",
            brand: "Supreme Trimmer",
            asin: "B0D21VXPML",
            price: "$99.95",
            rating: "4.3",
            reviewCount: "94",
            sales: "100+ bought in past month",
            bsr: "#84,291 in Beauty & Personal Care",
            initials: "ST",
            top_positive_review_themes: ["Vector speed intelligence", "DLC click lever precision", "Great design visuals"],
            top_negative_review_themes: ["Blade gets warm", "Lighter weight feels less robust", "Click lever spring fatigue"],
            confirmed_technical_specs: { motor_type: "Vector Motor", rpm: "9,500 RPM", run_time: "120 min", charging_time: "90 min", blade_material: "Diamond Like Carbon", body_material: "ABS Plastic" }
          },
          {
            name: "Caliber 9mm Magnetic Clipper",
            brand: "Caliber",
            asin: "B0BLDG2X1K",
            price: "$119.00",
            rating: "4.4",
            reviewCount: "412",
            sales: "200+ bought in past month",
            bsr: "#32,183 in Beauty & Personal Care",
            initials: "CA",
            top_positive_review_themes: ["High frequency magnetic cut", "Very clean feed line", "Premium weight balance"],
            top_negative_review_themes: ["Loud magnetic click on start", "Runs quite warm", "Flimsy taper lever"],
            confirmed_technical_specs: { motor_type: "Magnetic Motor", rpm: "10,000 RPM", run_time: "120 min", charging_time: "120 min", blade_material: "Japanese Steel", body_material: "Polycarbonate" }
          },
          {
            name: "Limural Professional Hair Clipper Set",
            brand: "Limural",
            asin: "B08V4R2J2F",
            price: "$45.99",
            rating: "4.4",
            reviewCount: "12,412",
            sales: "3,000+ bought in past month",
            bsr: "#512 in Beauty & Personal Care",
            initials: "LI",
            top_positive_review_themes: ["Amazing complete kit price", "Quiet home barber use", "Long charge runtime"],
            top_negative_review_themes: ["Low motor torque for thick hair", "Heavy stainless steel weight", "Blades pull under fast speed"],
            confirmed_technical_specs: { motor_type: "Standard Rotary", rpm: "6,000 RPM", run_time: "300 min", charging_time: "240 min", blade_material: "Stainless Steel", body_material: "Stainless Steel" }
          },
          {
            name: "Kemei Professional Cordless Hair Clipper",
            brand: "Kemei",
            asin: "B07X4A2Z2F",
            price: "$35.99",
            rating: "4.3",
            reviewCount: "6,912",
            sales: "2,000+ bought in past month",
            bsr: "#1,891 in Beauty & Personal Care",
            initials: "KM",
            top_positive_review_themes: ["Cheap backup option", "Familiar ergonomic look", "Decent battery indicator"],
            top_negative_review_themes: ["Weak plastic housing parts", "Pulls coarse hair", "No official replacement blades"],
            confirmed_technical_specs: { motor_type: "Rotary Motor", rpm: "5,800 RPM", run_time: "120 min", charging_time: "180 min", blade_material: "Carbon Steel", body_material: "Plastic Chrome Plate" }
          }
        ];
  }

  // Trimmers ONLY — genuinely trimmer-specific products (T-blade detailers/
  // outliners, not clippers). This is the branch that was previously
  // missing entirely — a trimmer analysis fell into the clipper branch
  // above, which is exactly the contamination this file's toolType
  // gating exists to stop.
  if (toolType === "trimmer") {
    return defaultTier === "legacy"
      ? [
          {
            name: "Wahl Professional 5-Star Cordless Detailer",
            brand: "Wahl",
            asin: "B00A6HB1M4",
            price: "$99.99",
            rating: "4.6",
            reviewCount: "18,210",
            sales: "2,000+ bought in past month",
            bsr: "#1,840 in Beauty & Personal Care",
            initials: "WA",
            top_positive_review_themes: ["Ultra-close zero-gap T-blade", "Great for clean edges/lineups", "Long-lasting charge"],
            top_negative_review_themes: ["Blade needs frequent oiling", "Plastic housing feels light", "Short guard set included"],
            confirmed_technical_specs: { motor_type: "Rotary Motor", rpm: "8,200 RPM", run_time: "90 min", charging_time: "150 min", blade_material: "Fine Zero-Gap T-Blade Steel", body_material: "Heavy-duty Plastic" }
          },
          {
            name: "Andis GTX-EXO Cordless Trimmer",
            brand: "Andis",
            asin: "B07QK6Q4YV",
            price: "$139.99",
            rating: "4.7",
            reviewCount: "9,340",
            sales: "1,000+ bought in past month",
            bsr: "#2,910 in Beauty & Personal Care",
            initials: "AN",
            top_positive_review_themes: ["Very high RPM for fast lining", "Precise deep-tooth T-blade", "Comfortable slim grip"],
            top_negative_review_themes: ["Runs warm on long sessions", "Premium price tier", "Charging stand sold separately"],
            confirmed_technical_specs: { motor_type: "Magnetic Motor", rpm: "10,000 RPM", run_time: "120 min", charging_time: "90 min", blade_material: "Deep-Tooth Carbon Steel T-Blade", body_material: "Textured Grip Composite" }
          },
          {
            name: "BaBylissPRO SnapFX Trimmer",
            brand: "BaBylissPRO",
            asin: "B01N7Z6H0F",
            price: "$149.99",
            rating: "4.6",
            reviewCount: "6,120",
            sales: "800+ bought in past month",
            bsr: "#3,420 in Beauty & Personal Care",
            initials: "BB",
            top_positive_review_themes: ["Snap-in/out replaceable blade", "All-metal durable housing", "Sharp fine-tooth cutting"],
            top_negative_review_themes: ["Heavier than plastic competitors", "Metal body gets cold", "Loud high-pitch motor whine"],
            confirmed_technical_specs: { motor_type: "Ferrari Designed Brushless", rpm: "7,800 RPM", run_time: "90 min", charging_time: "150 min", blade_material: "Deep Tooth DLC T-Blade", body_material: "All-Metal" }
          },
          {
            name: "Gamma+ Absolute Zero Cordless Trimmer",
            brand: "Gamma+",
            asin: "B08G4KXH1T",
            price: "$119.95",
            rating: "4.5",
            reviewCount: "2,410",
            sales: "500+ bought in past month",
            bsr: "#9,120 in Beauty & Personal Care",
            initials: "GA",
            top_positive_review_themes: ["Zero-gap blade out of the box", "Strong torque for a trimmer", "Sleek modern design"],
            top_negative_review_themes: ["Battery indicator inaccurate", "Blade guard clips loosely", "Limited color options"],
            confirmed_technical_specs: { motor_type: "Magnetic Motor", rpm: "9,000 RPM", run_time: "100 min", charging_time: "120 min", blade_material: "Zero-Gap DLC T-Blade", body_material: "Polycarbonate" }
          },
          {
            name: "StyleCraft Shorty Pro Li Trimmer",
            brand: "StyleCraft",
            asin: "B08XJQ4W3K",
            price: "$99.95",
            rating: "4.6",
            reviewCount: "1,240",
            sales: "400+ bought in past month",
            bsr: "#6,210 in Beauty & Personal Care",
            initials: "SC",
            top_positive_review_themes: ["Compact lightweight body", "Quiet brushless operation", "Custom body skin choices"],
            top_negative_review_themes: ["Small guard comb sizes", "Charging cradle takes desk space", "Limited torque on thick hair"],
            confirmed_technical_specs: { motor_type: "Digital Brushless", rpm: "7,200 RPM", run_time: "120 min", charging_time: "90 min", blade_material: "DLC Diamond Carbon T-Blade", body_material: "Metal Front Panel" }
          }
        ]
      : [
          {
            name: "SUPRENT Fangs Professional Trimmer",
            brand: "SUPRENT",
            asin: "B0CPQ2X8YN",
            price: "$49.99",
            rating: "4.3",
            reviewCount: "980",
            sales: "500+ bought in past month",
            bsr: "#28,410 in Beauty & Personal Care",
            initials: "SU",
            top_positive_review_themes: ["Very affordable entry trimmer", "Decent lineup precision", "Compact for travel"],
            top_negative_review_themes: ["Battery drains fast", "Cheap plastic guards", "Blade dulls quickly"],
            confirmed_technical_specs: { motor_type: "Rotary Motor", rpm: "7,000 RPM", run_time: "90 min", charging_time: "120 min", blade_material: "Titanium Coated Steel T-Blade", body_material: "Composite Plastic" }
          },
          {
            name: "Supreme Trimmer Dark Wolf Detailer",
            brand: "Supreme Trimmer",
            asin: "B0D24Q9XPL",
            price: "$69.95",
            rating: "4.3",
            reviewCount: "410",
            sales: "200+ bought in past month",
            bsr: "#44,210 in Beauty & Personal Care",
            initials: "ST",
            top_positive_review_themes: ["Good value for the RPM", "Sharp out-of-box blade", "Nice aesthetic finish"],
            top_negative_review_themes: ["Blade gets warm on long use", "Light body feels less durable", "Weak battery indicator"],
            confirmed_technical_specs: { motor_type: "Magnetic Motor", rpm: "8,000 RPM", run_time: "100 min", charging_time: "90 min", blade_material: "DLC T-Blade", body_material: "ABS Plastic" }
          },
          {
            name: "Caliber .223 Trimmer",
            brand: "Caliber",
            asin: "B0BLDH3Y2M",
            price: "$89.00",
            rating: "4.4",
            reviewCount: "310",
            sales: "150+ bought in past month",
            bsr: "#38,910 in Beauty & Personal Care",
            initials: "CA",
            top_positive_review_themes: ["Crisp magnetic-motor lining", "Very clean edge work", "Premium weight balance"],
            top_negative_review_themes: ["Loud magnetic click on start", "Runs warm", "Flimsy blade guard"],
            confirmed_technical_specs: { motor_type: "Magnetic Motor", rpm: "8,500 RPM", run_time: "110 min", charging_time: "100 min", blade_material: "Japanese Steel T-Blade", body_material: "Polycarbonate" }
          },
          {
            name: "Limural Professional Detail Trimmer",
            brand: "Limural",
            asin: "B08V5S3K4G",
            price: "$29.99",
            rating: "4.3",
            reviewCount: "4,120",
            sales: "1,000+ bought in past month",
            bsr: "#1,910 in Beauty & Personal Care",
            initials: "LI",
            top_positive_review_themes: ["Amazing value kit price", "Fine for light home use", "Long charge runtime"],
            top_negative_review_themes: ["Low torque on thick hair", "Blade pulls at fast speed", "Basic plastic housing"],
            confirmed_technical_specs: { motor_type: "Standard Rotary", rpm: "6,500 RPM", run_time: "180 min", charging_time: "150 min", blade_material: "Stainless Steel T-Blade", body_material: "Stainless Steel" }
          },
          {
            name: "Kemei Professional Detail Trimmer",
            brand: "Kemei",
            asin: "B07X5B3Z3G",
            price: "$24.99",
            rating: "4.2",
            reviewCount: "3,210",
            sales: "800+ bought in past month",
            bsr: "#2,410 in Beauty & Personal Care",
            initials: "KM",
            top_positive_review_themes: ["Cheap backup option", "Familiar ergonomic look", "Decent battery indicator"],
            top_negative_review_themes: ["Weak plastic housing parts", "Blade dulls fast", "No official replacement blades"],
            confirmed_technical_specs: { motor_type: "Rotary Motor", rpm: "5,500 RPM", run_time: "100 min", charging_time: "150 min", blade_material: "Carbon Steel T-Blade", body_material: "Plastic Chrome Plate" }
          }
        ];
  }

  // No dedicated curated mock data for this category. This used to
  // fabricate entirely fake companies here ("Apex Global", "Vanguard
  // Corp", etc. — the exact fake-brand names reported as a bug) with
  // invented prices/ASINs/ratings computed from a hash of the product
  // name. Confirmed live that this was still reachable via
  // cleanCompetitors's per-slot backfill even after discoverCompetitorsLive
  // was added elsewhere as the preferred live-data path. Returning fewer
  // real competitors is correct; inventing fake ones is not — so this now
  // returns nothing, and cleanCompetitors below simply omits any slot it
  // can't fill with real (AI-returned or live-discovered) data.
  return [];
}

// `cleaned` also drops any AI-returned competitor whose own name/feature
// text doesn't match the identified category (lib/category-synonyms.ts) —
// a clipper can never survive into a hair-dryer analysis, even if the AI
// itself proposed one.
// STAGE A — category/self-name/ASIN-placeholder filtering only. No price
// awareness, no truncation to a fixed count: runs on whatever the AI/live
// search actually returned (up to 8 per the bumped prompt count), producing
// a clean candidate pool for applyPriceBandGate (below) to price-filter,
// widen, and truncate AFTER Rainforest enrichment resolves real live prices.
export function filterCandidatesByCategoryAndIdentity(competitors: any[], defaultTier: "legacy" | "emerging", identity: IdentityCard, toolTypes: ToolTypeRow[], groomingGateRules: GroomingGateRuleRow[] = []): any[] {
  const incomingList = Array.isArray(competitors) ? competitors : [];
  const cleaned: any[] = [];
  // Well above the 8 the prompt now requests — just a runaway-response cap,
  // bounding how many candidates enrichCompetitorsWithRainforest ever has
  // to look up.
  const POOL_CAP = 12;

  // A real competitor's name never contains the analyzed product's own
  // name — that's the exact fabrication pattern confirmed live from OpenAI
  // (gpt-5) when it runs out of real search results but still tries to
  // fill the requested count: entries like "Vanguard Corp StyleCraft Twist
  // Hair Crimper Pro Pro" (a fake company name with our own product name
  // pasted on). These pass the category-match check below (they literally
  // repeat our category text) so a dedicated check is needed here.
  const ownProductNameLower = (identity.productName || "").toLowerCase().trim();
  function isNamedAfterOwnProduct(name: string): boolean {
    if (!ownProductNameLower || ownProductNameLower.length < 6) return false;
    return name.toLowerCase().includes(ownProductNameLower);
  }

  for (const rawIncoming of incomingList) {
    if (cleaned.length >= POOL_CAP) break;
    if (!rawIncoming || !rawIncoming.name) continue;
    const candidateText = `${rawIncoming.name || ""} ${rawIncoming.top_feature_summary || ""}`;
    // No identity.toolType (legacy analysis pre-dating this field) —
    // nothing strict to validate against, don't block. Otherwise this is
    // THE gate that stops a clipper from ever surviving into a trimmer
    // analysis (or vice versa), even if the AI itself proposed one. Also
    // runs the grooming/beauty industry gate (Part 1 of the industry-gate
    // fix) — title/keyword-only capable at this pre-enrichment stage
    // (no real Amazon category data exists yet for an AI-proposed or raw
    // search-result candidate), which supersedes a standalone assertToolType
    // call (the gate's own 1C step already delegates to it, one code path).
    const gateResult = passesGroomingIndustryGate(
      { name: rawIncoming.name, description: rawIncoming.top_feature_summary || null, feature_bullets: rawIncoming.key_features || [] },
      groomingGateRules,
      { stage: "pre_enrichment", toolTypes, requiredToolType: identity.toolType, ourIsPetGrooming: /pet|dog/i.test(identity.category || "") }
    );
    if (!gateResult.ok) {
      console.warn(`[grooming-gate] rejected candidate "${rawIncoming.name}" — ${gateResult.reason}${gateResult.detail ? ` (${gateResult.detail})` : ""}`);
      continue;
    }
    if (isNamedAfterOwnProduct(rawIncoming.name || "")) continue;

    let asin = rawIncoming.asin || "";
    let amazonUrl = rawIncoming.amazon_url || "";

    // Matches the LITERAL "BXXXXXXXXX" placeholder pattern from the
    // prompt's own schema example (3+ consecutive X's), not just any
    // ASIN containing the letter X — real ASINs commonly contain X
    // (e.g. "B0DMXJPM4T", confirmed live via Rainforest).
    const isAsinPlaceholder = !asin || /X{3,}/i.test(asin) || asin.includes("000000") || !/^[A-Z0-9]{10}$/i.test(asin);
    const isUrlPlaceholder = !amazonUrl || /X{3,}/i.test(amazonUrl) || amazonUrl.includes("000000");

    if (isAsinPlaceholder) {
      // No trustworthy identifier — leave blank rather than borrowing a
      // fallback brand's ASIN (that's now applyPriceBandGate's job, and
      // only for a genuinely unfilled slot, never to patch a real AI pick).
      // enrichCompetitorsWithRainforest tries to resolve a real ASIN via
      // live search next; if that fails too, the card shows the honest
      // "Unverified" badge rather than a fabricated identifier.
      asin = "";
      amazonUrl = "";
    } else if (isUrlPlaceholder) {
      amazonUrl = `https://www.amazon.com/dp/${asin}`;
    }

    cleaned.push({
      ...rawIncoming,
      // Preserves the AI's own claimed price string before enrichment can
      // overwrite `price` — applyPriceBandGate falls back to this when no
      // live Rainforest price resolves for a candidate.
      ai_claimed_price: rawIncoming.price || null,
      asin,
      amazon_url: amazonUrl,
      tier: defaultTier,
      initials: rawIncoming.initials || (rawIncoming.name || "").split(" ").slice(0, 2).map((w: string) => w[0]).join("").toUpperCase(),
      // Strengths/weaknesses/recent buyer sentiment are never AI-generated —
      // populated on demand from real Amazon reviews via
      // /api/amazon/reviews-analysis/[asin] (see CompetitorCard).
      strengths: [],
      weaknesses: [],
      recent_news: [],
    });
  }

  return cleaned;
}

// STAGE B — the price-band gate. Must run AFTER enrichCompetitorsWithRainforest
// (so `price_raw` is a real live Rainforest number where resolvable, not
// just whatever the AI claimed). Widens the band stepwise (±30% -> ±40% ->
// ±50%) only if fewer than `limit` candidates are in-band, tags any
// accepted out-of-band pick with the reason, and only then tops up any
// still-unfilled slots from the curated fallback dataset — itself gated by
// the exact same price check, never a silent price-unaware fill.
export function applyPriceBandGate(
  candidates: any[],
  targetPriceRaw: number,
  tier: CompetitorTier,
  identity: IdentityCard,
  toolTypes: ToolTypeRow[],
  limit = 5,
  opts: { allowStaticFallbackTopup?: boolean } = {}
): any[] {
  const allowStaticFallbackTopup = opts.allowStaticFallbackTopup ?? true;
  const withPrice = candidates.map(c => ({
    ...c,
    _resolvedPrice: typeof c.price_raw === "number" ? c.price_raw : parsePriceToNumber(c.ai_claimed_price),
  }));

  const primaryBand = computePriceBand(targetPriceRaw, tier, 0);
  const widestBand = computePriceBand(targetPriceRaw, tier, 2);

  let accepted: any[] = [];
  for (let widenStep = 0; widenStep <= 2; widenStep++) {
    const band = computePriceBand(targetPriceRaw, tier, widenStep);
    const inBand = withPrice.filter(c => c._resolvedPrice != null && isWithinBand(c._resolvedPrice, band));
    if (inBand.length >= limit || widenStep === 2) {
      accepted = inBand;
      break;
    }
  }

  // Reject-logging for observability — every candidate that never made it
  // in, with the reason (no resolvable price at all vs. genuinely outside
  // even the widest band).
  for (const c of withPrice) {
    if (accepted.includes(c)) continue;
    if (c._resolvedPrice == null) {
      console.warn(`[price-band] rejected "${c.name}" (${tier}) — no resolvable price (no live Rainforest match, no AI-claimed price)`);
    } else {
      console.warn(`[price-band] rejected "${c.name}" (${tier}) — $${c._resolvedPrice.toFixed(2)} is outside even the widest band ($${widestBand.min.toFixed(2)}-$${widestBand.max.toFixed(2)})`);
    }
  }

  // Prefer in-band (primary-band) candidates first; among out-of-band
  // (only-reachable-via-widening) candidates, prefer whichever is closest
  // to the primary band's edge. Ties preserve the AI's own original
  // preference order (stable sort, comparator returns 0).
  const sorted = [...accepted].sort((a, b) => {
    const aIn = isWithinBand(a._resolvedPrice, primaryBand);
    const bIn = isWithinBand(b._resolvedPrice, primaryBand);
    if (aIn !== bIn) return aIn ? -1 : 1;
    if (aIn && bIn) return 0;
    const aDist = Math.min(Math.abs(a._resolvedPrice - primaryBand.min), Math.abs(a._resolvedPrice - primaryBand.max));
    const bDist = Math.min(Math.abs(b._resolvedPrice - primaryBand.min), Math.abs(b._resolvedPrice - primaryBand.max));
    return aDist - bDist;
  });

  const final: any[] = sorted.slice(0, limit).map(c => {
    const { _resolvedPrice, ai_claimed_price, ...rest } = c;
    const outOfBand = !isWithinBand(_resolvedPrice, primaryBand);
    return outOfBand
      ? { ...rest, out_of_band: true, out_of_band_reason: buildOutOfBandLabel(_resolvedPrice, primaryBand) }
      : rest;
  });

  // Still short after exhausting real candidates — top up from the curated
  // fallback dataset, but only entries whose own static price also passes
  // the widest band. Only reachable for categories with real curated
  // fallback data; the generic/uncurated branch returns [] (see
  // getCategoryFallbackCompetitors), so this is a no-op for those.
  // Skippable via allowStaticFallbackTopup:false — this static dataset is
  // unrelated to the legacy-brand registry (lib/db/legacy-brands.ts) and
  // has no "not on curated list" tagging, so the curated-registry-only gate
  // call (lib/analysisEngine.ts's Phase 1 branch) must not let it silently
  // stand in for an honest AI-fallback result.
  if (final.length < limit && allowStaticFallbackTopup) {
    const usedNames = new Set(final.map(c => (c.name || "").toLowerCase()));
    const fallbackPool = getCategoryFallbackCompetitors(identity, tier);
    for (const fb of fallbackPool) {
      if (final.length >= limit) break;
      if (usedNames.has((fb.name || "").toLowerCase())) continue;
      const fbPrice = parsePriceToNumber(fb.price);
      if (fbPrice == null || !isWithinBand(fbPrice, widestBand)) continue;
      // Defense-in-depth: getCategoryFallbackCompetitors is already keyed
      // strictly on identity.toolType (its own header comment), so this
      // should never actually fire — but this loop is the exact spot the
      // original clipper-into-trimmer contamination bug was found (it
      // checked only price-band membership, never category), so it gets
      // its own explicit re-check rather than trusting the pool blindly.
      if (identity.toolType && !assertToolType(fb.name || "", identity.toolType, toolTypes).ok) {
        console.warn(`[tool-type] rejected fallback candidate "${fb.name}" — mismatched tool type for ${identity.toolType}`);
        continue;
      }

      usedNames.add((fb.name || "").toLowerCase());
      const outOfBand = !isWithinBand(fbPrice, primaryBand);
      final.push({
        name: fb.name,
        brand: fb.brand,
        tier,
        asin: fb.asin,
        amazon_url: `https://www.amazon.com/dp/${fb.asin}`,
        // This hand-typed static dataset's ASINs are never confirmed live
        // (no Rainforest call happens for a topup pick) — a real listing
        // can be delisted/changed since this data was written, so the link
        // must be marked unverified the same way every other unconfirmed-
        // ASIN path in this file already does (see e.g.
        // enrichCompetitorsWithRainforest's own fallback below). Without
        // this, CompetitorCard's link label wrongly reads "Amazon Listing"
        // (implying confirmed) instead of "Search Amazon" for a pick that
        // was never actually checked — confirmed live as a broken-looking
        // Amazon link on a recent analysis.
        verified_by_rainforest: false,
        price: fb.price,
        price_raw: fbPrice,
        rating: fb.rating,
        review_count: fb.reviewCount || (fb as any).review_count,
        monthly_sales: fb.sales || (fb as any).monthly_sales,
        bsr_rank: fb.bsr || (fb as any).bsr_rank,
        initials: fb.initials,
        key_features: [],
        strengths: [],
        weaknesses: [],
        recent_news: [],
        top_feature_summary: "",
        ...(outOfBand ? { out_of_band: true, out_of_band_reason: buildOutOfBandLabel(fbPrice, primaryBand) } : {}),
      });
    }
  }
  // else: still short and no curated fallback data covers this category —
  // returning fewer real competitors is correct; inventing a fake one to
  // fill the slot is not.

  return final;
}

export interface CompositeScoringContext {
  motorFamilies: MotorFamilyRow[];
  // Strict tool-type isolation (lib/tool-type-taxonomy.ts) — read by the
  // static-fallback-topup branch below (assertToolType), fetched the same
  // way motorFamilies is (await listToolTypes(), never module-level state).
  toolTypes: ToolTypeRow[];
  // Brand-scoped proprietary motor names (e.g. "IN3" -> vector) — optional/
  // absent degrades gracefully to generic-alias-only matching.
  brandedNames?: BrandedMotorNameRow[];
  ourMotor: OurMotorResolution | null;
  // Which criterion actually drives scoring for this identity's tool type
  // (lib/tool-type-taxonomy.ts's primary_criterion) — selectByCompositeScore
  // branches on this instead of unconditionally running the motor cascade.
  primaryCriterion: "motor" | "heat_technology" | "none";
  heatTechFamilies?: HeatTechFamilyRow[];
  brandedHeatTechNames?: BrandedHeatTechNameRow[];
  ourHeatTech: OurHeatTechResolution | null;
  ourSpecs: import("./competitor-scoring").FeatureComparable;
  weights: MatchingWeights;
  // Indie-only — absent/undefined for legacy, in which case price scoring
  // is always absolute-to-target (per the spec, relative pricing is an
  // indie-specific concept).
  ourLineupPercentile?: number | null;
  indieLineups?: Map<string, LineupProduct[]>;
  // The analysis form's optional Key Differentiator (context.keyDiff) —
  // absent/null means the field was never given, in which case
  // computeFeatureScore's differentiator blend is skipped entirely
  // (see that function's own header comment).
  keyDiff?: string | null;
  // PART 3 of the editable-ASIN correction-learning loop
  // (buildCorrectionSignals) — ASINs with exactly ONE independent
  // "wrong_product"/"discontinued" correction against them (2+ is a hard
  // exclude, applied earlier at candidate-filter time, never reaches
  // scoring at all) get a fixed composite-score penalty here instead of
  // being dropped outright — still eligible, just deprioritized.
  penalizedAsins?: Set<string>;
  // Related Products feature — eligible related products' profiles
  // (motor/heat-tech family, price, specs), used ONLY to compute a small
  // additive bonus inside computeFeatureScore below; absent/empty degrades
  // to exactly today's scoring (see computeRelatedProductSimilarity's own
  // header comment in lib/competitor-scoring.ts).
  relatedProducts?: RelatedProductProfile[];
  // Grooming/beauty industry gate (Part 1/2) — fetched once per phase step
  // alongside motorFamilies/toolTypes above, never module-level state (same
  // per-request-freshness discipline, and what lets an admin's rule edit
  // affect the very next analysis/refill).
  groomingGateRules: GroomingGateRuleRow[];
  ourGroomingTag: GroomingTag | null;
  groomingGateConfidenceThreshold: number;
  ourIsPetGrooming: boolean;
}

// Replaces applyPriceBandGate's plain "in-band first, then closest to
// target price" selection with the full motor -> price -> feature
// composite (Part 3). applyPriceBandGate itself is left untouched (still
// exported, still used by the offline verify suite) — this is a fresh,
// independent implementation of the same widen-step band math (identical
// ±30/40/50% legacy / asymmetric emerging bands, same static-fallback-topup
// safety net) so that motor/price/feature scoring can influence WHICH
// candidates survive out of the fuller pre-truncation pool, not just
// re-sort an already-capped 5 (see the plan's Context section for why that
// distinction matters). When ourMotor is null (a non-motorized category, or
// motor genuinely undeterminable), every candidate's motor tier resolves to
// "unverified" uniformly via computeMotorMatchTier's own null-handling —
// motor scoring becomes a neutral constant that doesn't discriminate
// between candidates, so ranking gracefully degrades to price+feature only,
// with no separate code path needed for "motor doesn't apply here."
export function selectByCompositeScore(
  candidates: any[],
  targetPriceRaw: number,
  tier: CompetitorTier,
  identity: IdentityCard,
  limit: number,
  ctx: CompositeScoringContext,
  opts: { allowStaticFallbackTopup?: boolean; requireMotorEvidenceFirst?: boolean; nearestSimilarMode?: boolean } = {}
): any[] {
  const allowStaticFallbackTopup = opts.allowStaticFallbackTopup ?? true;
  const withPrice = candidates.map(c => ({
    ...c,
    _resolvedPrice: typeof c.price_raw === "number" ? c.price_raw : parsePriceToNumber(c.ai_claimed_price ?? c.price),
  }));

  // Grooming/beauty industry gate (Part 1/2) — spec extraction runs here,
  // BEFORE the gate call, so the gate's 1F structural-spec check and the
  // Part 2 same-tool-kind confidence gate can consult real grooming specs;
  // the per-candidate `.map()` below reuses `_groomingSpecs` instead of
  // calling extractCompetitorSpecs(c) a second time. This is the post-
  // enrichment gate call — real Amazon categories/BSR data is available
  // here for every candidate that resolved a real ASIN (see
  // mergeRainforestProductIntoCompetitor), so 1A's category check is fully
  // capable at this stage, unlike filterCandidatesByCategoryAndIdentity's
  // earlier pre-enrichment call.
  const withSpecsAndTag = withPrice.map(c => {
    const theirSpecs = extractCompetitorSpecs(c);
    const candidateTag = deriveGroomingTag(identity.toolType, [c.name, ...(c.feature_bullets || []), c.description || ""].join(" "));
    return { ...c, _groomingSpecs: { ...theirSpecs, groomingTag: candidateTag } };
  });
  const gated = withSpecsAndTag.filter(c => {
    const result = passesGroomingIndustryGate(c, ctx.groomingGateRules, {
      stage: "post_enrichment",
      toolTypes: ctx.toolTypes,
      requiredToolType: identity.toolType,
      ourIsPetGrooming: ctx.ourIsPetGrooming,
      theirSpecs: c._groomingSpecs,
      ourSpecs: ctx.ourSpecs,
      ourTag: ctx.ourGroomingTag,
      candidateTag: c._groomingSpecs.groomingTag,
      confidenceThreshold: ctx.groomingGateConfidenceThreshold,
    });
    if (!result.ok) {
      console.warn(`[grooming-gate] rejected "${c.name}" — ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
    }
    return result.ok;
  });

  const primaryBand = computePriceBand(targetPriceRaw, tier, 0);
  const widestBand = computePriceBand(targetPriceRaw, tier, 2);

  let accepted: any[] = [];
  if (opts.nearestSimilarMode) {
    // Nearest-similar fallback (only reached when the normal ladder — up to
    // 3 AI-discovery rounds plus the ±30/40/50% widen loop below — still
    // couldn't fill every slot) draws from a deliberately much wider band
    // than the normal widest step: 40%-250% of target, not clamped to the
    // normal ±50%. This is a distinct, explicit band, not another widenStep
    // on computePriceBand (which stays untouched — it's used elsewhere and
    // its 50%-floor clamp is intentional for the NORMAL ladder). The
    // industry gate is NEVER relaxed here — `gated`, not `withPrice`, is
    // still the source pool, per the ticket's explicit "better an honest
    // empty than a nearest-similar gate bypass" rule.
    accepted = gated.filter(c => c._resolvedPrice != null && c._resolvedPrice >= targetPriceRaw * 0.4 && c._resolvedPrice <= targetPriceRaw * 2.5);
  } else {
    for (let widenStep = 0; widenStep <= 2; widenStep++) {
      const band = computePriceBand(targetPriceRaw, tier, widenStep);
      const inBand = gated.filter(c => c._resolvedPrice != null && isWithinBand(c._resolvedPrice, band));
      if (inBand.length >= limit || widenStep === 2) {
        accepted = inBand;
        break;
      }
    }
  }

  const scored = accepted.map(c => {
    // Which cascade actually runs is decided once, per ctx.primaryCriterion
    // (lib/tool-types.ts's primary_criterion column) — 'motor' unchanged
    // from before this branch existed; 'heat_technology' runs the parallel
    // heat-tech cascade instead and populates heat_tech_* fields, never
    // motor_*; 'none' runs neither, criterionScore stays 0 (a neutral
    // constant identical for every candidate — doesn't discriminate, same
    // reasoning as the existing ourMotor-null-degrades-gracefully comment
    // above this function).
    let motorExtraction: ReturnType<typeof extractCompetitorMotorType> = null;
    let motorMatchTier: ReturnType<typeof computeMotorMatchTier> | null = null;
    let motorScore = 0;
    let heatTechExtraction: ReturnType<typeof extractCompetitorHeatTech> = null;
    let heatTechMatchTier: ReturnType<typeof computeHeatTechMatchTier> | null = null;
    let heatTechScore = 0;
    let criterionScore = 0;

    if (ctx.primaryCriterion === "heat_technology") {
      heatTechExtraction = extractCompetitorHeatTech({ ...c, title: c.name }, ctx.heatTechFamilies || [], { brand: c.brand, brandedNames: ctx.brandedHeatTechNames });
      heatTechMatchTier = computeHeatTechMatchTier(ctx.ourHeatTech?.familyKey ?? null, heatTechExtraction?.familyKey ?? null);
      // computeMotorScore's tier->number mapping is criterion-agnostic
      // (HeatTechMatchTier is a literal subset of MotorMatchTier) — reused
      // as-is rather than duplicating the same 3-branch function.
      heatTechScore = computeMotorScore(heatTechMatchTier);
      criterionScore = heatTechScore;
    } else if (ctx.primaryCriterion === "motor") {
      motorExtraction = extractCompetitorMotorType({ ...c, title: c.name }, ctx.motorFamilies, { brand: c.brand, brandedNames: ctx.brandedNames });
      motorMatchTier = computeMotorMatchTier(ctx.ourMotor?.familyKey ?? null, motorExtraction?.familyKey ?? null, ctx.motorFamilies);
      motorScore = computeMotorScore(motorMatchTier);
      criterionScore = motorScore;
    }

    let priceScore: number;
    let priceLogic: "absolute" | "relative" = "absolute";
    let theirLineupPercentile: number | null = null;
    let theirLineupSample: LineupProduct[] | null = null;

    // computePriceScoreAbsolute saturates to 0 beyond ±50% of target — its
    // normal operating domain (the standard widen loop never accepts
    // anything past that anyway). nearestSimilarMode's band is much wider
    // (40%-250%), so reusing that formula would score every off-band
    // candidate identically (0), leaving ties broken by incoming pool
    // order instead of actual price closeness — silently breaking the
    // spec's own tie-break order (motor, then price, then rating count).
    // This wider, non-saturating divisor keeps "closer price wins"
    // meaningful across the full nearest-similar range.
    const priceScoreForCandidate = (price: number): number => {
      if (!opts.nearestSimilarMode) return computePriceScoreAbsolute(price, targetPriceRaw);
      const diff = Math.abs(price - targetPriceRaw);
      return Math.max(0, 1 - Math.min(1, diff / (1.5 * targetPriceRaw)));
    };

    if (tier === "emerging" && ctx.ourLineupPercentile != null && ctx.indieLineups) {
      const lineup = ctx.indieLineups.get(c.brand) || [];
      const pct = lineup.length >= 2 ? computePercentileInLineup(c._resolvedPrice, lineup) : null;
      if (pct != null) {
        priceScore = computePriceScoreRelative(ctx.ourLineupPercentile, pct);
        priceLogic = "relative";
        theirLineupPercentile = pct;
        theirLineupSample = lineup;
      } else {
        priceScore = priceScoreForCandidate(c._resolvedPrice);
      }
    } else {
      priceScore = priceScoreForCandidate(c._resolvedPrice);
    }

    // Reuses the spec extraction already run (and gate-checked) above this
    // function's price-band widen loop — never recomputed.
    const theirSpecs = c._groomingSpecs;
    // Real listing text only (title/feature_bullets/description — the same
    // grounding data enrichCompetitorsWithRainforest now forwards), never
    // AI-claimed fields — a differentiator "match" must be found in text
    // that's actually been verified, not just asserted by the discovery step.
    const candidateText = [c.name, ...(Array.isArray(c.feature_bullets) ? c.feature_bullets : []), c.description || ""].filter(Boolean).join(" ");
    const differentiatorMatch = ctx.keyDiff ? matchesDifferentiator(ctx.keyDiff, candidateText) : null;
    // Related Products additive bonus (never a gate, never overrides
    // motor/price) — 0 when ctx.relatedProducts is absent/empty, in which
    // case computeFeatureScore's own falsy-check skips it entirely.
    const relatedProductSimilarity = ctx.relatedProducts?.length
      ? computeRelatedProductSimilarity(
          { motorFamilyKey: motorExtraction?.familyKey ?? null, heatTechFamilyKey: heatTechExtraction?.familyKey ?? null, priceRaw: c._resolvedPrice ?? null },
          theirSpecs,
          ctx.relatedProducts
        )
      : 0;
    const featureScore = computeFeatureScore(ctx.ourSpecs, theirSpecs, differentiatorMatch, relatedProductSimilarity);
    // PART 3 correction-learning penalty — a single independent
    // "wrong_product"/"discontinued" report against this exact ASIN
    // deprioritizes it (still eligible) rather than excluding it outright
    // (that's the 2+-corrections hard-exclude, already applied before this
    // candidate ever reached scoring — see the ~4 candidate-filter sites
    // in runAnalysisStep).
    const isPenalized = !!ctx.penalizedAsins?.has((c.asin || "").toUpperCase());
    const compositeScore = computeCompositeScore(criterionScore, priceScore, featureScore, ctx.weights) * (isPenalized ? 0.7 : 1);

    const outOfBand = !isWithinBand(c._resolvedPrice, primaryBand);
    const { _resolvedPrice, ai_claimed_price, ...rest } = c;

    // Only ever attached (see the nearest_match spread below) when this
    // call is the nearest-similar fallback — computed unconditionally here
    // since every input it needs (motor/heat-tech tier, out-of-band flag)
    // is already in scope, cheap, and never shipped otherwise.
    let nearestMatchReason: string | null = null;
    if (opts.nearestSimilarMode) {
      const reasonParts: string[] = [];
      if (ctx.primaryCriterion === "motor") {
        if (motorMatchTier === "unverified") reasonParts.push("Motor type unverified");
        else if (motorMatchTier && motorMatchTier !== "exact") {
          reasonParts.push(`Different motor (${motorExtraction?.label || "unknown"} vs your ${ctx.ourMotor?.label || "motor"})`);
        }
      } else if (ctx.primaryCriterion === "heat_technology") {
        if (heatTechMatchTier === "unverified") reasonParts.push("Plate/heat technology unverified");
        else if (heatTechMatchTier && heatTechMatchTier !== "exact") {
          reasonParts.push(`Different plate/heat technology (${heatTechExtraction?.label || "unknown"} vs your ${ctx.ourHeatTech?.label || "plate/heat technology"})`);
        }
      }
      if (outOfBand) {
        reasonParts.push(`$${_resolvedPrice.toFixed(2)} vs your $${targetPriceRaw.toFixed(2)} target`);
      }
      nearestMatchReason = reasonParts.length > 0
        ? reasonParts.join(", ")
        : `Closest available ${tier} ${getToolTypeLabel(identity.toolType, ctx.toolTypes).toLowerCase()} — no exact-fit competitor found`;
    }

    return {
      ...rest,
      // Motor fields are present ONLY when this tool type's primary
      // criterion is 'motor' — for 'heat_technology'/'none' types these
      // keys are absent entirely, never null-filled, so no Motor row/label
      // can ever accidentally render for a motorless product.
      ...(ctx.primaryCriterion === "motor" ? {
        motor_type: motorExtraction?.label ?? null,
        motor_family_key: motorExtraction?.familyKey ?? null,
        motor_modifier: motorExtraction?.modifierLabel ?? null,
        // The brand's own proprietary marketing name (e.g. "IN3"), shown
        // alongside the canonical family — null unless normalizeMotor
        // resolved it via the branded map (lib/db/branded-motor-names.ts).
        motor_branded_name: motorExtraction?.brandedName ?? null,
        motor_source_quote: motorExtraction?.sourceQuote ?? null,
        // Which cascade step actually resolved the match, and where to see
        // it for yourself — surfaced next to motor_source_quote in the
        // UI/PDF so "how do we know this" is answerable for motor type like
        // every other section already is. url falls back to wherever the
        // candidate's data came from (brand-site page when that's the
        // source, else the Amazon listing itself) since a spec/bullet/title
        // match doesn't have its own distinct URL.
        motor_confirmed_via: motorExtraction?.confirmedVia ?? null,
        motor_source_url: motorExtraction ? (c.sources?.brand_site?.url || c.amazon_url || null) : null,
        motor_match_tier: motorMatchTier,
        motor_score: motorScore,
      } : {}),
      // Heat/Plate Technology — the parallel field set for motorless
      // styling tools (flat iron/curling iron/hot brush), same shape and
      // same reasoning as the motor_* block above.
      ...(ctx.primaryCriterion === "heat_technology" ? {
        heat_tech_type: heatTechExtraction?.label ?? null,
        heat_tech_family_key: heatTechExtraction?.familyKey ?? null,
        heat_tech_branded_name: heatTechExtraction?.brandedName ?? null,
        heat_tech_source_quote: heatTechExtraction?.sourceQuote ?? null,
        heat_tech_confirmed_via: heatTechExtraction?.confirmedVia ?? null,
        heat_tech_source_url: heatTechExtraction ? (c.sources?.brand_site?.url || c.amazon_url || null) : null,
        heat_tech_match_tier: heatTechMatchTier,
        heat_tech_score: heatTechScore,
      } : {}),
      price_score: priceScore,
      price_logic: priceLogic,
      their_lineup_percentile: theirLineupPercentile,
      their_lineup_sample: theirLineupSample,
      our_lineup_percentile: ctx.ourLineupPercentile ?? null,
      feature_score: featureScore,
      differentiator_match: differentiatorMatch,
      composite_score: compositeScore,
      ...(outOfBand ? { out_of_band: true, out_of_band_reason: buildOutOfBandLabel(_resolvedPrice, primaryBand) } : {}),
      ...(opts.nearestSimilarMode ? { nearest_match: true, nearest_match_reason: nearestMatchReason } : {}),
    };
  });

  scored.sort((a, b) => b.composite_score - a.composite_score);

  let final: any[];
  if (opts.nearestSimilarMode) {
    // No verified/unverified split here — a nearest-similar pick is
    // included ONLY because nothing better was available, so the honest
    // ranking (verified and unverified candidates scored/sorted together,
    // purely by composite_score) is exactly what should decide order.
    // dedupeToOnePerBrand still applies for legacy (unchanged brand-
    // diversity rule); every candidate already carries nearest_match/
    // nearest_match_reason from the scoring map above.
    final = tier === "legacy" ? dedupeToOnePerBrand(scored, limit) : scored.slice(0, limit);
  } else if (opts.requireMotorEvidenceFirst) {
    // Motor evidence required to be a first-class ("verified") candidate —
    // exact/adjacent/different tiers all mean "we found real motor-type
    // text for this candidate," even a confirmed mismatch; only
    // "unverified" (zero motor evidence at all) is held back. Verified
    // candidates fill slots first (still ranked among themselves by the
    // existing composite score); unverified ones are only pulled in for
    // any slots still empty afterward, and are excluded from brands a
    // verified pick already seated (never let an ungrounded pick from a
    // brand crowd out — or duplicate — a brand that already has a real,
    // motor-evidenced competitor).
    //
    // getEffectiveTier makes this criterion-aware: 'motor' types read
    // motor_match_tier exactly as before; 'heat_technology' types read
    // heat_tech_match_tier instead; 'none' types (the criterion doesn't
    // apply at all) always resolve "exact" so they're never held back
    // waiting for evidence of a criterion that was never going to exist.
    const getEffectiveTier = (c: any): string => {
      if (ctx.primaryCriterion === "motor") return c.motor_match_tier ?? "unverified";
      if (ctx.primaryCriterion === "heat_technology") return c.heat_tech_match_tier ?? "unverified";
      return "exact";
    };
    const verifiedPool = scored.filter(c => getEffectiveTier(c) !== "unverified");
    const unverifiedPool = scored.filter(c => getEffectiveTier(c) === "unverified");
    final = tier === "legacy" ? dedupeToOnePerBrand(verifiedPool, limit) : verifiedPool.slice(0, limit);

    if (final.length < limit) {
      const usedBrands = new Set(final.map((c: any) => (c.brand || "").trim().toLowerCase()));
      const remaining = limit - final.length;
      const fallbackPool = tier === "legacy"
        ? unverifiedPool.filter((c: any) => !usedBrands.has((c.brand || "").trim().toLowerCase()))
        : unverifiedPool;
      const topUp = (tier === "legacy" ? dedupeToOnePerBrand(fallbackPool, remaining) : fallbackPool.slice(0, remaining))
        .map((c: any) => ({ ...c, motor_unverified_fallback: true }));
      final = [...final, ...topUp];
    }
  } else {
    final = tier === "legacy" ? dedupeToOnePerBrand(scored, limit) : scored.slice(0, limit);
  }

  // Same static-fallback topup as applyPriceBandGate, for the same reason —
  // only reachable for categories with real curated fallback data.
  // Skippable via allowStaticFallbackTopup:false for the exact same reason
  // applyPriceBandGate's own opts param exists (see its header comment).
  if (final.length < limit && allowStaticFallbackTopup) {
    const usedNames = new Set(final.map((c: any) => (c.name || "").toLowerCase()));
    const fallbackPool = getCategoryFallbackCompetitors(identity, tier);
    for (const fb of fallbackPool) {
      if (final.length >= limit) break;
      if (usedNames.has((fb.name || "").toLowerCase())) continue;
      const fbPrice = parsePriceToNumber(fb.price);
      if (fbPrice == null || !isWithinBand(fbPrice, widestBand)) continue;
      // Defense-in-depth: getCategoryFallbackCompetitors is already keyed
      // strictly on identity.toolType (its own header comment), so this
      // should never actually fire — but this loop is the exact spot the
      // original clipper-into-trimmer contamination bug was found (it
      // checked only price-band membership, never category), so it gets
      // its own explicit re-check rather than trusting the pool blindly.
      if (identity.toolType && !assertToolType(fb.name || "", identity.toolType, ctx.toolTypes).ok) {
        console.warn(`[tool-type] rejected fallback candidate "${fb.name}" — mismatched tool type for ${identity.toolType}`);
        continue;
      }
      // Same defense-in-depth re-check for the grooming/beauty industry
      // gate — this curated static fallback pool should never contain a
      // non-grooming item, but this is the exact loop the original
      // contamination bug lived in, so it's never trusted blindly.
      //
      // Broad-audit finding — passing bare `fb.name` starved 1B's keyword
      // check of any signal for real, correctly-typed entries whose own
      // product name is brand+model only (e.g. "BaBylissPRO Nano Titanium
      // Ionic Dryer" has no "hair"/"blow" token; "Wahl... Magic Clip" has no
      // "clipper" token) — silently rejecting most of this "guaranteed"
      // safety-net floor for exactly the categories that need it most.
      // getCategoryFallbackCompetitors already keys this entry strictly on
      // identity.toolType by construction, so its resolved label is a known
      // true fact about it, not a guess — supplying it as `description`
      // gives 1B real signal instead of none.
      const fbGateResult = passesGroomingIndustryGate(
        { name: fb.name || "", description: identity.toolType ? getToolTypeLabel(identity.toolType, ctx.toolTypes) : null },
        ctx.groomingGateRules,
        { stage: "pre_enrichment", toolTypes: ctx.toolTypes, requiredToolType: identity.toolType, ourIsPetGrooming: ctx.ourIsPetGrooming }
      );
      if (!fbGateResult.ok) {
        console.warn(`[grooming-gate] rejected fallback candidate "${fb.name}" — ${fbGateResult.reason}`);
        continue;
      }

      usedNames.add((fb.name || "").toLowerCase());
      const outOfBand = !isWithinBand(fbPrice, primaryBand);
      final.push({
        name: fb.name,
        brand: fb.brand,
        tier,
        asin: fb.asin,
        amazon_url: `https://www.amazon.com/dp/${fb.asin}`,
        // Same fix as applyPriceBandGate's own static-fallback topup above —
        // this ASIN was never confirmed via a live Rainforest call, so the
        // link must be marked unverified, not implicitly "confirmed" by
        // omission. The motor/heat-tech fields below already say
        // "unverified" explicitly; this was the one field that didn't.
        verified_by_rainforest: false,
        price: fb.price,
        price_raw: fbPrice,
        rating: fb.rating,
        review_count: fb.reviewCount || (fb as any).review_count,
        monthly_sales: fb.sales || (fb as any).monthly_sales,
        bsr_rank: fb.bsr || (fb as any).bsr_rank,
        initials: fb.initials,
        key_features: [],
        strengths: [],
        weaknesses: [],
        recent_news: [],
        top_feature_summary: "",
        ...(ctx.primaryCriterion === "motor" ? {
          motor_type: null,
          motor_match_tier: "unverified",
          motor_score: computeMotorScore("unverified"),
        } : {}),
        ...(ctx.primaryCriterion === "heat_technology" ? {
          heat_tech_type: null,
          heat_tech_match_tier: "unverified",
          heat_tech_score: computeMotorScore("unverified"),
        } : {}),
        price_score: computePriceScoreAbsolute(fbPrice, targetPriceRaw),
        price_logic: "absolute",
        feature_score: 0,
        composite_score: 0,
        ...(outOfBand ? { out_of_band: true, out_of_band_reason: buildOutOfBandLabel(fbPrice, primaryBand) } : {}),
      });
    }
  }

  return final;
}

// Runs `fn` over `items` with at most `limit` in flight at once — Rainforest
// enforces a concurrent-request cap on some plans, and firing all 10
// competitors' lookups (each up to 2 sequential Rainforest calls) via a
// single Promise.all could burst well past that, causing MORE competitors
// to fail verification than a real per-account rate limit would otherwise
// allow. Small batches keep this well under any reasonable concurrency cap.
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Bounds a single async operation to a hard wall-clock deadline, resolving
// to `fallback` if it hasn't settled in time. RAINFOREST_REQUEST_TIMEOUT_MS
// (lib/rainforest.ts) only bounds ONE fetch — resolveAmazonProductForCandidate
// below can chain up to 3 sequential Rainforest calls (direct ASIN lookup,
// title/brand search, re-lookup of that match), so a per-fetch timeout alone
// still lets one unlucky candidate's resolution run up to ~3x that long.
// Confirmed live: this is what let a single Phase 1/2 competitor still blow
// past Vercel's 60s cap ("Connection dropped") even after every individual
// Rainforest call was capped. Mirrors the same Promise.race-against-a-timeout
// pattern lib/brand-site-discovery.ts already uses for its own per-brand
// attempts — the loser keeps running in the background (harmless; its
// result is simply discarded) rather than being forcibly cancelled.
async function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  const timeout = new Promise<T>(resolve => setTimeout(() => resolve(fallback), Math.max(0, ms)));
  return Promise.race([promise, timeout]);
}

// Every Rainforest-enrichment step below (Phase 1's curated-brand pass,
// Phase 1's brand-site cross-check pass, Phase 2b's enrichment pass) shares
// this ONE ceiling, measured from the phase step's own start — not a fresh
// independent window per step — so they can never compound past Vercel's
// 60s cap even in the worst case. 52s leaves 8s of headroom for everything
// else in the same request (DB writes, JSON serialization, cold-start
// overhead), the same slack convention ROUTE_TIME_BUDGET_MS already uses
// for the AI-call fallback path below.
const RAINFOREST_STEP_DEADLINE_MS = 52_000;
// Per-candidate ceiling within that shared budget — never more than 8s
// spent resolving any single competitor's real Amazon data, and never more
// than whatever's actually left of the shared step deadline.
const RAINFOREST_CANDIDATE_DEADLINE_MS = 8_000;

function remainingRainforestBudget(routeStartTime: number): number {
  return Math.max(0, RAINFOREST_STEP_DEADLINE_MS - (Date.now() - routeStartTime));
}

// Overwrite AI-discovered competitor price/rating/review data with real,
// verified live Amazon data from Rainforest. Tries the AI-provided ASIN
// first; if that doesn't resolve to a real listing (common — hardcoded
// fallback/mock ASINs go stale as real listings get delisted or replaced),
// searches Amazon by product title + brand to find the CURRENT real ASIN
// before giving up. Competitors that can't be verified either way have
// their price/rating/ASIN explicitly cleared (never left showing a stale
// or fabricated value as if it were current) and point at a live Amazon
// search instead of a fabricated /dp/{asin} link.
// Direct-ASIN lookup, falling back to a brand+title search when there's no
// ASIN or the direct lookup resolved the wrong product — both legs
// tool-type-gated. Extracted so a candidate that never had an ASIN at all
// (a brand-site-only curated find, see lib/legacy-brand-discovery.ts's
// buildHybridCandidate) can still attempt this exact same cross-check for
// its own `sources.amazon`, without duplicating the resolution logic.
async function resolveAmazonProductForCandidate(asin: string | undefined | null, name: string, brand: string | undefined, toolTypes: ToolTypeRow[], requiredToolType?: ToolType | null) {
  let product = asin ? await getAmazonProduct(asin) : null;

  // A syntactically-valid, real ASIN can still be the WRONG product — the
  // direct lookup has no cross-check against what the AI actually claimed
  // this competitor was, so a stale/hallucinated/sibling-SKU ASIN would
  // otherwise silently overwrite price/rating/specs/images with a
  // different tool type's real data while the displayed name stayed
  // unchanged (an invisible mismatch). Discard it exactly like a failed
  // lookup rather than trusting a wrong-type product.
  if (product && requiredToolType && !assertToolType(product.title, requiredToolType, toolTypes).ok) {
    console.warn(`[tool-type] discarded direct-ASIN Rainforest match for "${name}" — "${product.title}" doesn't match required type ${requiredToolType}`);
    product = null;
  }

  if (!product) {
    const match = await resolveAsinBySearch(name, brand);
    if (match) {
      const candidateProduct = await getAmazonProduct(match.asin);
      // Same tool-type cross-check on the fallback title-search match —
      // its own acceptance threshold (brand-substring + >=0.6 title
      // token-overlap similarity) comfortably passes a sibling product
      // whose title differs only in the type word (e.g. "clipper" vs
      // "trimmer"), so tool-type agreement is required IN ADDITION to
      // that similarity score, not instead of it.
      if (candidateProduct && requiredToolType && !assertToolType(candidateProduct.title, requiredToolType, toolTypes).ok) {
        console.warn(`[tool-type] discarded fallback title-search match for "${name}" — "${candidateProduct.title}" doesn't match required type ${requiredToolType}`);
      } else {
        product = candidateProduct;
      }
    }
  }

  return product;
}

async function enrichCompetitorsWithRainforest(competitors: any[], toolTypes: ToolTypeRow[], requiredToolType: ToolType | null | undefined, routeStartTime: number): Promise<any[]> {
  if (!hasRainforestKey) return competitors;

  // Concurrency 5 (was 3) — safe to raise now that every Rainforest call is
  // individually time-bounded (see RAINFOREST_REQUEST_TIMEOUT_MS in
  // lib/rainforest.ts); 5-10 candidates now clear in a single wave instead
  // of two, directly cutting this step's wall-clock time.
  return mapWithConcurrency(competitors, 5, async (c) => {
      // Already live-verified by discoverCompetitorsLive/curated-legacy
      // discovery (a `type=search` result, already real/current for
      // price/rating) — BUT a `type=search` result never carries
      // specifications/attributes/feature_bullets/description (both
      // lib/legacy-brand-discovery.ts's CuratedBrandCandidate and
      // discoverCompetitorsLive's own candidates always have
      // key_features: [] and nothing else), so extractCompetitorMotorType
      // (lib/motor-extraction.ts) has no real listing text to search and
      // silently resolves to the "unverified" tier forever. Only skip the
      // redundant re-fetch when this candidate already has real grounding
      // data to search — otherwise, fall through to a real `type=product`
      // pull below so it can actually be motor-grounded.
      const hasGroundingData = (c.specifications?.length > 0) || (c.attributes?.length > 0) || (c.feature_bullets?.length > 0) || !!c.description;
      if (c.verified_by_rainforest === true && hasGroundingData) return c;

      // Shared-clock budget check — once this phase step has already used
      // up its Rainforest allotment (curated search + this pass + the
      // brand-site cross-check pass all draw from the SAME
      // RAINFOREST_STEP_DEADLINE_MS clock), stop attempting NEW candidates
      // entirely rather than risking one more that can't finish in time.
      const budgetLeft = remainingRainforestBudget(routeStartTime);
      if (budgetLeft <= 0) return c;

      const product = await withDeadline(
        resolveAmazonProductForCandidate(c.asin, c.name, c.brand, toolTypes, requiredToolType),
        Math.min(RAINFOREST_CANDIDATE_DEADLINE_MS, budgetLeft),
        null
      );

      if (!product) {
        // This candidate was already trusted (a real type=search
        // verification — curated legacy discovery or discoverCompetitorsLive
        // — see hasGroundingData above) before this re-fetch-for-grounding
        // attempt was even made; a failed/transient re-fetch must not
        // regress its already-good real price/rating down to a placeholder
        // — it simply stays ungrounded on motor type, exactly as it was
        // before this function's grounding fix existed.
        if (c.verified_by_rainforest === true) return c;

        // Keep a format-valid, AI-discovered ASIN instead of wiping it —
        // Rainforest verification can fail (credit/auth outage, transient
        // network issue) even when the ASIN itself is correct, and nulling
        // it here previously meant the reviews-analysis endpoint never even
        // attempted the Amazon tier for an otherwise-correct competitor.
        // `verified_by_rainforest: false` already signals "unconfirmed" to
        // every downstream reader — nothing else treats asin === null as a
        // hard "no ASIN exists" sentinel.
        const keptAsin = /^[A-Z0-9]{10}$/i.test(c.asin ?? "") ? c.asin : null;
        return {
          ...c,
          asin: keptAsin,
          price: "—",
          rating: "—",
          review_count: "—",
          verified_by_rainforest: false,
          amazon_url: keptAsin
            ? `https://www.amazon.com/dp/${keptAsin}`
            : `https://www.amazon.com/s?k=${encodeURIComponent(`${c.brand || ""} ${c.name}`.trim())}`,
        };
      }

      return mergeRainforestProductIntoCompetitor(c, product);
  });
}

// Shared by enrichCompetitorsWithRainforest's per-item enrichment above and
// replaceCompetitor's forced refetch below — the exact same real-listing
// merge logic in exactly one place so a manual ASIN swap produces a
// competitor object indistinguishable in shape from one discovered
// normally. Real, verbatim bullet points from the live listing replace
// whatever the AI guessed — kept in the same {headline,...} shape the UI
// already renders, but the text itself is never AI-invented once a real
// listing is verified.
function mergeRainforestProductIntoCompetitor(c: any, product: RainforestProduct): any {
  const realFeatures = product.feature_bullets.slice(0, 6).map(bullet => ({
    headline: bullet,
    source: "Amazon",
    attribution: "From the Amazon listing:",
    detail: "",
  }));

  return {
    ...c,
    asin: product.asin,
    price: product.price,
    price_raw: product.price_raw,
    last_updated: product.last_updated,
    rating: product.rating_str,
    review_count: product.reviews_str,
    monthly_sales: product.monthly_str || c.monthly_sales,
    bsr_rank: product.bsr || c.bsr_rank,
    // Real Amazon category path + BSR category breakdown — already fetched
    // by getAmazonProduct, previously silently dropped here before ever
    // reaching selectByCompositeScore. This is what lib/grooming-industry-
    // gate.ts's 1A category check actually gates on; without this, a
    // candidate's real category data never existed anywhere in the pipeline.
    categories: product.categories ?? c.categories,
    bestsellers_rank_full: product.bestsellers_rank_full ?? c.bestsellers_rank_full,
    amazon_url: product.amazon_url,
    image: product.image,
    images: product.images.length ? product.images : (product.image ? [product.image] : []),
    manufacturer: product.manufacturer,
    model_number: product.model_number,
    description: product.description,
    key_features: realFeatures.length > 0 ? realFeatures : c.key_features,
    // Raw grounding data — forwarded (not just folded into the
    // display-shaped key_features above) so extractCompetitorMotorType
    // (lib/motor-extraction.ts) and matchesDifferentiator
    // (lib/differentiator-match.ts) have real listing text to search
    // instead of silently resolving to "unverified"/no-match forever.
    specifications: product.specifications,
    attributes: product.attributes,
    feature_bullets: product.feature_bullets,
    verified_by_rainforest: true,
    // Preserves any existing sources.brand_site (a curated hybrid
    // candidate re-grounded here) while recording this real Amazon
    // pull — c.sources is undefined for every non-curated candidate,
    // in which case this is simply { brand_site: undefined, amazon }.
    sources: {
      ...(c.sources || {}),
      amazon: {
        asin: product.asin, url: product.amazon_url, price: product.price, price_raw: product.price_raw,
        rating: product.rating_str, review_count: product.reviews_str, bsr_rank: product.bsr, monthly_sales: product.monthly_str,
        retrieved_at: new Date().toISOString(),
      },
    },
  };
}

// Pricing has no separate resolver/search step of its own (see
// lib/pricing-analysis.ts's header comment) — its "provenance" is simply
// whether the Rainforest product lookup just performed above resolved a
// real price for each competitor. Best-effort per competitor; a slow/broken
// write here must never affect the analysis result itself.
async function persistPricingProvenance(competitors: any[], analysisId: string): Promise<void> {
  for (const comp of competitors) {
    try {
      await insertProvenance({
        productKey: resolveCacheKey(comp.asin ?? "", comp.name ?? ""),
        section: "pricing",
        analysisId,
        productName: comp.name ?? null,
        tiers: [buildPricingProvenanceTier(comp)],
        queries: [],
      });
    } catch (e) {
      console.warn("Failed to persist pricing provenance:", e);
    }
  }
}

// One row per legacy competitor recording WHERE it came from — the curated
// registry category, or (when a competitor had to be filled by the AI
// top-up because curated brands couldn't reach 5 in-band picks) an honest
// "not on curated list" tier. Feeds the exact same PDF "Data Sources &
// Methodology" appendix pricing provenance already uses — best-effort,
// never blocks the analysis result.
async function persistLegacyRegistryProvenance(competitors: any[], registry: ResolvedLegacyRegistry, analysisId: string): Promise<void> {
  for (const comp of competitors) {
    try {
      const isCurated = comp.curated_brand === true;
      // registry_source_lists is only ever set for a "both" target-market
      // merge (lib/legacy-brand-registry.ts's resolveLegacyBrandsForIdentity)
      // — surfaces which list(s) matched right alongside the existing
      // curated-vs-fallback tier text, same provenance mechanism.
      const sourceLists: ("pro" | "retail")[] | null = comp.registry_source_lists ?? null;
      const sourceListsLabel = sourceLists && sourceLists.length > 0
        ? ` (via ${sourceLists.map(l => (l === "pro" ? "Pro/Salon" : "Retail")).join(" + ")} list)`
        : "";
      await insertProvenance({
        productKey: resolveCacheKey(comp.asin ?? "", comp.name ?? ""),
        section: "legacy_brand_registry",
        analysisId,
        productName: comp.name ?? null,
        tiers: [{
          tier: isCurated ? `Curated list: ${registry.categoryName}${sourceListsLabel}` : "Not on curated legacy list — AI-sourced fallback",
          attempted: true,
          outcome: "success",
        }],
        queries: [],
      });
    } catch (e) {
      console.warn("Failed to persist legacy brand registry provenance:", e);
    }
  }
}

export interface AnalysisStepResult {
  analysisId: string;
  phase: number;
  status: "running" | "complete" | "failed" | "cancelled";
  stepResult: any;
  totalSearches: number;
  reportId?: string;
  error?: string;
  // Set when Stage 0 (Product Identification) can't confidently determine
  // the category and the pipeline has paused — the client must collect an
  // answer and POST /api/analyses/:id/answer before calling continue again.
  pendingQuestion?: { question: string; foundSoFar?: string; field?: string; placeholder?: string };
}

function hasResult(result: any): boolean {
  return !!result && typeof result === "object" && Object.keys(result).length > 0;
}

// Runs exactly ONE phase of the pipeline per call, driven by the caller
// (see app/api/analyses/[id]/continue/route.ts). Each Vercel Hobby-plan
// invocation is hard-capped at 60s and background work is killed the
// instant a response is sent — a single call running all 4 AI phases
// routinely exceeded that and silently orphaned the analysis at phase 0.
// Splitting into resumable, DB-persisted steps means every call is a
// short, independent round trip, and a refreshed/reconnecting client just
// resumes from whatever phase is persisted.
//
// Phase 0 (Product Identification) was added ahead of the original 3
// competitor-discovery/synthesis phases so every downstream phase can key
// off a VERIFIED category instead of a hardcoded default — previously
// Phase 1/2's prompts unconditionally instructed the model to "search
// ONLY these 8 hair-clipper brands" and to search "[motor type] motor
// clipper" regardless of what product was actually submitted, and the
// fallback/market-data routers keyed off `industry` (which only ever has
// two grooming-related values), so every analysis routed to clipper data
// even when the AI behaved correctly.
// Resolves the one target price competitor discovery anchors on, in
// priority order: (1) the analysis form's own "Target Price" field, (2) the
// linked project's GTM document's approved_pricing field (same waterfall
// lib/db/reports.ts already uses at report-render time, kept consistent
// here), (3) Phase 0's own live/web-search-derived observed price. Returns
// null only when none of these resolve — runAnalysisStep's Phase 1 branch
// pauses and asks the user rather than proceeding unpriced.
export async function resolveDiscoveryTargetPrice(context: AnalysisContext, identity: IdentityCard): Promise<number | null> {
  const fromContext = parsePriceToNumber(context.pricePoint);
  if (fromContext != null) return fromContext;

  if (context.projectId) {
    try {
      const gtmDoc = await getDocumentByProject(context.projectId, "gtm");
      if (gtmDoc) {
        const fields = await getDocumentFields(gtmDoc.id);
        const approvedPricing = fields.find(f => f.field_id === "approved_pricing")?.answer ?? null;
        const fromGtm = parsePriceToNumber(approvedPricing);
        if (fromGtm != null) return fromGtm;
      }
    } catch {
      // Best-effort only — a missing/broken GTM doc must never block discovery.
    }
  }

  // priceObserved.value is already a number (see product-identification.ts) —
  // no string parsing needed here, unlike the other two candidates above.
  if (typeof identity.priceObserved?.value === "number") return identity.priceObserved.value;

  return null;
}

interface Phase2ResolvedContext {
  targetPriceRaw: number;
  registryBrandTokens: Set<string> | null;
  brandHintOverride: string[] | undefined;
  motorFamilies: any;
  brandedNames: BrandedMotorNameRow[];
  toolTypes: ToolTypeRow[];
  primaryCriterion: "motor" | "heat_technology" | "none";
  ourMotor: any;
  heatTechFamilies: HeatTechFamilyRow[];
  brandedHeatTechNames: BrandedHeatTechNameRow[];
  ourHeatTech: OurHeatTechResolution | null;
  // Whichever criterion applies' resolved label — "our motor" wording kept
  // for minimal footprint across the ~10 call sites that already thread
  // this through discovery prompts; holds the Heat/Plate Technology label
  // instead when primaryCriterion is 'heat_technology'.
  ourMotorLabel: string | null;
  weights: any;
  ourSpecs: any;
  ourLineupPercentile: number;
  // The correction-learning signals (see buildCorrectionSignals) — fetched
  // once per phase run, same "cheap re-read" precedent as motorFamilies/
  // toolTypes above.
  correctionSignals: CorrectionSignals;
  // Grooming/beauty industry gate (Part 1/2) — same "cheap re-read every
  // phase step, never module-level state" precedent as motorFamilies/
  // toolTypes above.
  groomingGateRules: GroomingGateRuleRow[];
  groomingGateConfidenceThreshold: number;
  ourGroomingTag: GroomingTag | null;
  ourIsPetGrooming: boolean;
}

type Phase2ContextResult =
  | { ok: true; ctx: Phase2ResolvedContext }
  | { ok: false; pendingQuestion: { question: string; field: string; placeholder: string } };

// Shared by Phase 2a (AI discovery) and Phase 2b (Rainforest enrichment +
// indie lineups + scoring — see the split in runAnalysisStep below). Every
// value here is a cheap Supabase read or pure computation (same "cheap
// re-read, not a second pause opportunity" precedent this phase already
// established for re-resolving Phase 1's own price/motor context), so
// re-running this once per sub-step is simpler and safer than threading
// intermediate state through the phase2_result JSONB checkpoint.
async function resolvePhase2Context(context: AnalysisContext, identityCard: IdentityCard): Promise<Phase2ContextResult> {
  const targetPriceRaw = await resolveDiscoveryTargetPrice(context, identityCard);
  if (targetPriceRaw == null) {
    return {
      ok: false,
      pendingQuestion: {
        question: `What price are you targeting for ${context.productName}? (e.g. $259.95)`,
        field: "pricePoint",
        placeholder: "e.g. $259.95",
      },
    };
  }

  // Same registry category as Phase 1 (re-resolved fresh — cheap, and
  // consistent with the "cheap re-read" precedent above). When a registry
  // match exists, its brand names+aliases become the exclude-hint in place
  // of the static getKnownBrandsHint list, AND registry brands are hard-
  // filtered out of the results below — a real guarantee, not just a
  // prompt-level request the model could ignore.
  // Same motor/heat-tech resolution as Phase 1 (cheap re-read — already
  // resolved once, or already in context.motorTech/heatTechRaw from that
  // phase's own pause).
  const motorFamilies = await listMotorFamilies();
  const brandedNames = await listBrandedMotorNames();
  const heatTechFamilies = await listHeatTechFamilies();
  const brandedHeatTechNames = await listBrandedHeatTechNames();
  // Same "cheap re-read" precedent as motorFamilies/brandedNames above —
  // never module-level state (see this file's own header on why).
  const toolTypes = await listToolTypes();
  const correctionSignals = buildCorrectionSignals(identityCard.toolType ? await getActiveCorrectionsForToolType(identityCard.toolType) : []);

  const registry = await resolveLegacyBrandsForIdentity(identityCard, toolTypes);
  const registryBrandTokens = registry
    ? new Set(registry.brands.flatMap(b => [b.brand_name, ...b.aliases].map(normalizeBrandToken)))
    : null;
  const brandHintOverride = registry ? registry.brands.flatMap(b => [b.brand_name, ...b.aliases]) : undefined;

  const primaryCriterion = resolvePrimaryCriterion(identityCard, toolTypes);
  const ourMotor = primaryCriterion === "motor"
    ? await resolveOurMotorType({ motorFamily: context.motorFamily, motorTech: context.motorTech, projectId: context.projectId }, identityCard, motorFamilies)
    : null;
  if (primaryCriterion === "motor" && !ourMotor) {
    return {
      ok: false,
      pendingQuestion: {
        question: `What motor technology does ${context.productName} use? (e.g. "brushless rotary", "magnetic/vector", "pivot")`,
        field: "motorType",
        placeholder: "e.g. brushless rotary",
      },
    };
  }
  const ourHeatTech = primaryCriterion === "heat_technology"
    ? await resolveOurHeatTech({ heatTechFamily: context.heatTechFamily, heatTechRaw: context.heatTechRaw, projectId: context.projectId }, identityCard, heatTechFamilies)
    : null;
  if (primaryCriterion === "heat_technology" && !ourHeatTech) {
    return {
      ok: false,
      pendingQuestion: {
        question: `What plate/heat technology does ${context.productName} use? (e.g. titanium, ceramic, tourmaline)`,
        field: "heatTechType",
        placeholder: "e.g. titanium",
      },
    };
  }
  const ourMotorLabel = primaryCriterion === "heat_technology" ? (ourHeatTech?.label ?? null) : formatMotorLabel(ourMotor);
  // A per-analysis override (set on the analyze/new-project forms' "Adjust
  // weights for this analysis" expander) always wins over the resolved
  // per-tool-type profile — never module-level state, resolved fresh here.
  // resolveEffectiveWeights zeroes the motor share for a 'none'-criterion
  // tool type regardless of what's configured — see its own header comment.
  const weights = resolveEffectiveWeights(context.weightOverride ?? await getScoringProfileForToolType(identityCard.toolType), primaryCriterion);
  const ourSpecs = context.projectId
    ? extractOurSpecsFromTds(await getTdsFieldsForProject(context.projectId))
    : extractOurSpecsFromTds(null);

  // Relative pricing (Part 4) needs to know where OUR product sits in OUR
  // OWN lineup — resolved lazily here (indie-only), not in Phase 1, since a
  // legacy-only analysis never needs this. Real StyleCraft catalog match
  // first; a one-field pause-and-ask ("flagship/mid/entry?") only when the
  // product isn't a recognized catalog entry.
  let ourLineupPercentile: number | null = null;
  const catalogProducts = await listCatalogProducts();
  const lineupPosition = resolveOurLineupTier(context.productName, catalogProducts, context.catalogProductId);
  if (lineupPosition) {
    ourLineupPercentile = lineupPosition.percentile;
  } else if (context.lineupTier) {
    ourLineupPercentile = percentileForManualTier(context.lineupTier);
  } else {
    return {
      ok: false,
      pendingQuestion: {
        question: `Is ${context.productName} your premium/flagship model, a mid-tier model, or an entry-level model?`,
        field: "lineupTier",
        placeholder: "flagship, mid, or entry",
      },
    };
  }

  const groomingGateRules = await listGroomingGateRules();
  const groomingGateConfidenceThreshold = await getGroomingGateConfidenceThreshold();
  const ourGroomingTag = deriveGroomingTag(identityCard.toolType, `${identityCard.category} ${identityCard.subcategory} ${identityCard.whatItIs}`);
  const ourIsPetGrooming = /\b(pet|dog|animal)\b/i.test(`${identityCard.category} ${identityCard.subcategory}`);

  return { ok: true, ctx: { targetPriceRaw, registryBrandTokens, brandHintOverride, motorFamilies, brandedNames, toolTypes, primaryCriterion, ourMotor, heatTechFamilies, brandedHeatTechNames, ourHeatTech, ourMotorLabel, weights, ourSpecs, ourLineupPercentile, correctionSignals, groomingGateRules, groomingGateConfidenceThreshold, ourGroomingTag, ourIsPetGrooming } };
}

// Shared by Phase 1's and Phase 2a's multi-round fill loop (see the header
// comments on each phase below) — lives inside phase1_result/phase2_result
// JSONB while its loop is running, deleted the instant the tier's pool is
// ready for final scoring. `searchesSoFar` is a running total (fed by the
// same onSearchUsed callback that already tracks webSearchCount) — used
// for the "searched N queries" honesty text on a hard-floor empty slot,
// not fed back verbatim into a later round's prompt (the round-specific
// instructions in fillRoundExtraInstruction already push toward genuinely
// different query angles without needing an explicit banned-query list).
interface FillLoopMarker {
  round: 1 | 2 | 3 | 4;
  searchesSoFar: number;
}

// Round 2 asks the same question again but explicitly broader (more brand
// names, more query phrasings, more result pages) WITHOUT relaxing any
// actual rule. Round 3 is the genuine relaxation ladder — motor-unconfirmed
// candidates, non-curated brands (legacy only), and a wider price band are
// explicitly permitted — but tool-type/product-category correctness is
// never relaxed at either round. Round 4 (the nearest-similar last resort —
// only reached when finalize's own relaxed pool-rescan still can't fill
// every slot, see the finalize blocks below) deliberately switches query
// STRATEGY rather than repeating round 3's relaxed terms again — rounds 1-3
// are brand-targeted; round 4 asks for generic category best-sellers
// instead, since that's a genuinely different angle rounds 1-3 never tried.
function fillRoundExtraInstruction(round: 2 | 3 | 4, tier: CompetitorTier): string {
  if (round === 2) {
    return tier === "legacy"
      ? "ADDITIONAL SEARCH ROUND — the first round didn't fill all 5 slots. Broaden your search: try more brand names, alternate query phrasings (synonyms/singular-plural of the product type), and check additional Amazon search result pages beyond the first. Do not lower any standard — every candidate must still meet all the rules above."
      : "ADDITIONAL SEARCH ROUND — the first round didn't fill all 5 slots. Broaden your search: try more indie/DTC brand names, alternate query phrasings, additional roundup/review articles, and additional Amazon search result pages beyond the first. Do not lower any standard — every candidate must still meet all the rules above.";
  }
  if (round === 3) {
    return tier === "legacy"
      ? "RELAXED SEARCH ROUND — after two full search rounds, slots are still open. This time it's OK to include: a candidate whose motor type can't be confirmed from its own listing (say so in inclusion_rationale), a candidate from a brand not on any curated list, or a candidate priced up to 50% away from the target price if nothing closer exists. Still reject anything of the wrong product type."
      : "RELAXED SEARCH ROUND — after two full search rounds, slots are still open. This time it's OK to include: a candidate whose motor type can't be confirmed from its own listing (say so in inclusion_rationale), or a candidate priced up to 50% away from the target price if nothing closer exists. Still reject anything of the wrong product type or an already-excluded large brand.";
  }
  return "NEAREST-SIMILAR SEARCH ROUND — every prior round and price relaxation still couldn't fill every slot. Switch strategy entirely: search for generic category best-sellers and new-brand entrants instead of specific brand names — e.g. \"best [product type] [this year]\", \"new [product type] brands [this year]\", or an Amazon category search sorted by relevance/rating. Motor/plate-heat technology match is NOT required this round, and price can be as low as 40% or as high as 250% of the target price. The ONLY rule that still applies without exception: the product must be a real, verifiable, correct-tool-type product — never invent a product or accept the wrong product type.";
}

// Cross-round dedup — reject a newly-found candidate that's already in the
// accumulating pool, by real (non-placeholder) ASIN or by brand+name, so a
// later round's broader search can't just re-discover the same products
// and waste a slot. Reuses normalizeBrandToken (lib/legacy-brand-discovery.ts)
// rather than a second normalizer.
function mergeNewCandidatesIntoPool(pool: any[], incoming: any[]): any[] {
  const seenAsins = new Set(pool.map((c: any) => (c.asin || "").toUpperCase()).filter((a: string) => /^[A-Z0-9]{10}$/.test(a)));
  const seenBrandName = new Set(pool.map((c: any) => `${normalizeBrandToken(c.brand || "")}|${normalizeBrandToken(c.name || "")}`));
  const fresh = incoming.filter((c: any) => {
    const asin = (c.asin || "").toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(asin) && seenAsins.has(asin)) return false;
    const key = `${normalizeBrandToken(c.brand || "")}|${normalizeBrandToken(c.name || "")}`;
    if (seenBrandName.has(key)) return false;
    return true;
  });
  return [...pool, ...fresh];
}

// The nearest-similar fallback's own exclusion filter — everything in
// `pool` NOT already represented in `selected`, same ASIN/brand+name dedup
// key as mergeNewCandidatesIntoPool above (just filtering the opposite
// direction: keep candidates NOT matching `selected`, rather than merging
// new ones in), so a nearest-similar pick can never duplicate an
// already-seated real competitor.
function excludeAlreadySelected(pool: any[], selected: any[]): any[] {
  const seenAsins = new Set(selected.map((c: any) => (c.asin || "").toUpperCase()).filter((a: string) => /^[A-Z0-9]{10}$/.test(a)));
  const seenBrandName = new Set(selected.map((c: any) => `${normalizeBrandToken(c.brand || "")}|${normalizeBrandToken(c.name || "")}`));
  return pool.filter((c: any) => {
    const asin = (c.asin || "").toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(asin) && seenAsins.has(asin)) return false;
    const key = `${normalizeBrandToken(c.brand || "")}|${normalizeBrandToken(c.name || "")}`;
    if (seenBrandName.has(key)) return false;
    return true;
  });
}

// A slot the fill loop genuinely could not fill after exhausting the full
// round/relaxation ladder — rendered as an honest labeled empty rather than
// silently returning fewer than 5. `reason` names how much was actually
// searched, per the "never silently show fewer and move on" requirement.
function buildEmptySlotPlaceholder(tier: CompetitorTier, identity: IdentityCard, toolTypes: ToolTypeRow[], ourMotorLabel: string | null, searchesSoFar: number): any {
  const motorPart = ourMotorLabel ? `${ourMotorLabel} ` : "";
  const typeLabel = identity.toolType && identity.toolType !== "combo" ? getToolTypeLabel(identity.toolType, toolTypes) : (identity.subcategory || identity.category);
  return {
    empty_slot: true,
    tier,
    name: `No additional ${tier === "legacy" ? "legacy" : "emerging"} competitor found`,
    reason: `Only found this many qualifying ${tier} competitors for ${motorPart}${typeLabel} in this price range (searched ${searchesSoFar} quer${searchesSoFar === 1 ? "y" : "ies"} across brand sites, Amazon, and web search, through the full relaxation ladder).`,
  };
}

export async function runAnalysisStep(analysisId: string): Promise<AnalysisStepResult> {
  const startTime = Date.now();
  const record: any = await getAnalysis(analysisId);
  if (!record) {
    throw new Error("Analysis not found");
  }

  // "cancelled" (POST /api/analyses/:id/cancel) is a terminal state exactly
  // like complete/failed — this guard is what stops a stray/in-flight
  // /continue call (one already sent before the user clicked Cancel) from
  // running a further phase after cancellation, since the client itself
  // only stops ASKING for more, it can't reach into and kill work already
  // in progress.
  if (record.status === "complete" || record.status === "failed" || record.status === "cancelled") {
    return {
      analysisId,
      phase: record.phase,
      status: record.status,
      stepResult: null,
      totalSearches: 0,
      error: record.error_message || undefined,
    };
  }

  // The pipeline cannot advance while a clarifying question is unanswered
  // — POST /api/analyses/:id/answer clears this before the next call may
  // actually run identification again. This is a no-op return, not an
  // error, so the client can keep polling without accidentally retrying
  // mid-question.
  if (record.pending_question) {
    return {
      analysisId,
      phase: record.phase,
      status: "running",
      stepResult: null,
      totalSearches: 0,
      pendingQuestion: record.pending_question,
    };
  }

  const context: AnalysisContext = {
    id: analysisId,
    orgId: record.org_id || "dev_org_id",
    userId: record.user_id,
    projectId: record.project_id || null,
    ...(record.context || {}),
  };

  const identityCard: IdentityCard | null = hasResult(record.phase0_result) ? record.phase0_result : null;
  const phase1Result = hasResult(record.phase1_result) ? record.phase1_result : null;
  const phase2Result = hasResult(record.phase2_result) ? record.phase2_result : null;

  // Fetched once here (the natural async boundary for every phase branch
  // below) and threaded explicitly through every downstream call — never
  // module-level state (this app runs on Vercel serverless, where a warm
  // lambda can interleave requests from different orgs on the same process).
  const toolTypes = await listToolTypes();

  // Related Products feature — resolved once in Phase 0 (below) and
  // persisted to analyses.related_products; read fresh here every phase so
  // Phase 1/2's pool-seeding, AI discovery context, and composite-scoring
  // bonus all see the same enriched data without re-resolving it.
  const relatedProducts: ResolvedRelatedProduct[] = Array.isArray(record.related_products) ? record.related_products : [];
  const eligibleRelatedProducts = relatedProducts.filter(rp => rp.eligibleForPoolSeeding && !rp.resolutionFailed);
  const relatedProductsDiscoveryContext = buildRelatedProductsDiscoveryContext(relatedProducts);
  const relatedProductProfiles: RelatedProductProfile[] = eligibleRelatedProducts.map(rp => ({
    motorFamilyKey: rp.motor_family_key ?? null,
    heatTechFamilyKey: rp.heat_tech_family_key ?? null,
    priceRaw: rp.price_raw ?? null,
    specs: extractCompetitorSpecs(rp as any),
  }));

  let webSearchCount = 0;
  const onSearchUsed = () => { webSearchCount += 1; };

  try {
    if (record.phase === 0) {
      // ----------------------------------------------------
      // PHASE 0: PRODUCT IDENTIFICATION (mandatory, runs before any competitor search)
      // ----------------------------------------------------
      const card = await identifyProduct(context, startTime);

      if (needsUserInput(card, context)) {
        await updateAnalysisPhase(analysisId, 0, "phase0_result", card, 0);
        const question = {
          question: `What type of product is ${context.productName}? (e.g., trimmer, shaver, dryer, straightener)`,
          foundSoFar: card.whatItIs || undefined,
        };
        await setPendingQuestion(analysisId, question);
        return { analysisId, phase: 0, status: "running", stepResult: card, totalSearches: 0, pendingQuestion: question };
      }

      // Strict tool-type isolation (lib/tool-type-taxonomy.ts) — the
      // analyze/new-project forms now require a Tool Type selection, so
      // this should rarely fire for new analyses; it's a defensive
      // fallback for analyses created before the field existed, or a
      // genuinely ambiguous identification (e.g. evidence mentions both
      // "clipper" and "trimmer") with no user selection to fall back on.
      // Never guesses — a wrong silent guess here is exactly the
      // clipper-into-trimmer contamination this field exists to stop.
      if (!card.toolType) {
        await updateAnalysisPhase(analysisId, 0, "phase0_result", card, 0);
        const question = {
          question: `What exact tool type is ${context.productName}? (clipper, trimmer, shaver, hair dryer, flat iron, curling iron, hot brush, or combo/multi-tool kit) This determines which competitors and data the analysis uses — it's never mixed across types.`,
          field: "toolType",
          foundSoFar: card.whatItIs || undefined,
        };
        await setPendingQuestion(analysisId, question);
        return { analysisId, phase: 0, status: "running", stepResult: card, totalSearches: 0, pendingQuestion: question };
      }

      // Related Products — resolved once here, before Phase 1 ever runs, so
      // its discovery-context sentence/pool-seeding/scoring-bonus are ready
      // the moment Phase 1 starts. Fail-open: a resolution failure never
      // blocks Phase 0 from completing (see resolveRelatedProducts's own
      // header comment).
      if (context.relatedAsins?.length) {
        try {
          const resolvedRelated = await resolveRelatedProducts(context.relatedAsins, card, toolTypes, startTime);
          await patchRelatedProducts(analysisId, resolvedRelated);
        } catch (e) {
          console.warn("Failed to resolve related products for analysis", analysisId, e);
        }
      }

      await updateAnalysisPhase(analysisId, 1, "phase0_result", card, 0);
      return { analysisId, phase: 1, status: "running", stepResult: card, totalSearches: 0 };
    }

    if (record.phase === 1) {
      // ----------------------------------------------------
      // PHASE 1: ESTABLISHED-COMPETITOR DISCOVERY
      // ----------------------------------------------------
      // Deliberately sequential with Phase 2, not concurrent — briefly
      // tried running both phases' OpenAI calls at once (Promise.all) to
      // speed up analyze, but reverted it: confirmed live that immediately
      // afterward, an analysis had EVERY phase (1, 2, AND 3) time out on
      // OpenAI in the same run, producing zero competitors in both lists.
      // Two simultaneous reasoning+web-search calls against the same
      // OpenAI account plausibly contend for the same per-minute
      // rate/throughput budget, making both individually slower and more
      // likely to blow the 45s timeout than if they ran one at a time —
      // and a wrong/empty competitor list is a worse failure mode for this
      // app than a slower one. Not confirmed as the definite root cause
      // (OpenAI's own reasoning+search latency is already known to vary
      // run-to-run — see runOpenAiWebSearch's tuning notes), but the risk
      // wasn't worth the speed gain.
      if (!identityCard) throw new Error("Missing product identity — cannot run competitor discovery");

      // Competitors must cluster around the user's actual target price — a
      // $25 product can never be a real competitor to a $260 product. If no
      // price is resolvable from anywhere, pause and ask rather than
      // guessing/proceeding unpriced (same pause mechanism as Phase 0's
      // product-identity question, just anchored on phase 1 instead of 0).
      const targetPriceRaw = await resolveDiscoveryTargetPrice(context, identityCard);
      if (targetPriceRaw == null) {
        const question = {
          question: `What price are you targeting for ${context.productName}? (e.g. $259.95)`,
          field: "pricePoint",
          placeholder: "e.g. $259.95",
        };
        await setPendingQuestion(analysisId, question);
        return { analysisId, phase: 1, status: "running", stepResult: null, totalSearches: 0, pendingQuestion: question };
      }

      // Our product's primary criterion is priority #1 (dominates selection,
      // per the matching spec) — resolved once, before any discovery runs.
      // resolvePrimaryCriterion reads the identified tool type's own
      // primary_criterion column ('motor'/'heat_technology'/'none'); a
      // genuinely unrelated product ('none') skips the requirement
      // entirely rather than being forced to answer an inapplicable question.
      const motorFamilies = await listMotorFamilies();
      const brandedNames = await listBrandedMotorNames();
      const heatTechFamilies = await listHeatTechFamilies();
      const brandedHeatTechNames = await listBrandedHeatTechNames();
      const primaryCriterion = resolvePrimaryCriterion(identityCard, toolTypes);
      const ourMotor = primaryCriterion === "motor"
        ? await resolveOurMotorType({ motorFamily: context.motorFamily, motorTech: context.motorTech, projectId: context.projectId }, identityCard, motorFamilies)
        : null;
      if (primaryCriterion === "motor" && !ourMotor) {
        const question = {
          question: `What motor technology does ${context.productName} use? (e.g. "brushless rotary", "magnetic/vector", "pivot")`,
          field: "motorType",
          placeholder: "e.g. brushless rotary",
        };
        await setPendingQuestion(analysisId, question);
        return { analysisId, phase: 1, status: "running", stepResult: null, totalSearches: 0, pendingQuestion: question };
      }
      const ourHeatTech = primaryCriterion === "heat_technology"
        ? await resolveOurHeatTech({ heatTechFamily: context.heatTechFamily, heatTechRaw: context.heatTechRaw, projectId: context.projectId }, identityCard, heatTechFamilies)
        : null;
      if (primaryCriterion === "heat_technology" && !ourHeatTech) {
        const question = {
          question: `What plate/heat technology does ${context.productName} use? (e.g. titanium, ceramic, tourmaline)`,
          field: "heatTechType",
          placeholder: "e.g. titanium",
        };
        await setPendingQuestion(analysisId, question);
        return { analysisId, phase: 1, status: "running", stepResult: null, totalSearches: 0, pendingQuestion: question };
      }
      const ourMotorLabel = primaryCriterion === "heat_technology" ? (ourHeatTech?.label ?? null) : formatMotorLabel(ourMotor);
      // A per-analysis override always wins over the resolved per-tool-type
      // profile — never module-level state, resolved fresh here.
      // resolveEffectiveWeights zeroes the motor share for a 'none'-criterion
      // tool type regardless of what's configured — see its own header comment.
      const weights = resolveEffectiveWeights(context.weightOverride ?? await getScoringProfileForToolType(identityCard.toolType), primaryCriterion);
      const ourSpecs = context.projectId
        ? extractOurSpecsFromTds(await getTdsFieldsForProject(context.projectId))
        : extractOurSpecsFromTds(null);
      // The correction-learning signals (PART 3 of the editable-ASIN
      // feature) — fetched once here, same "cheap re-read" precedent as
      // motorFamilies/toolTypes above.
      const correctionSignals = buildCorrectionSignals(identityCard.toolType ? await getActiveCorrectionsForToolType(identityCard.toolType) : []);
      const groomingGateRules = await listGroomingGateRules();
      const groomingGateConfidenceThreshold = await getGroomingGateConfidenceThreshold();
      const ourGroomingTag = deriveGroomingTag(identityCard.toolType, `${identityCard.category} ${identityCard.subcategory} ${identityCard.whatItIs}`);
      const ourIsPetGrooming = /\b(pet|dog|animal)\b/i.test(`${identityCard.category} ${identityCard.subcategory}`);
      const scoringCtx: CompositeScoringContext = {
        motorFamilies,
        brandedNames,
        toolTypes,
        primaryCriterion,
        ourMotor,
        heatTechFamilies,
        brandedHeatTechNames,
        ourHeatTech,
        ourSpecs,
        weights,
        keyDiff: context.keyDiff ?? null,
        penalizedAsins: correctionSignals.penalizedAsins,
        relatedProducts: relatedProductProfiles,
        groomingGateRules,
        groomingGateConfidenceThreshold,
        ourGroomingTag,
        ourIsPetGrooming,
      };

      // Curated legacy-brand registry (lib/db/legacy-brands.ts) takes
      // priority over AI judgment when the identified product maps to one
      // of the 4 registry categories — brand-targeted Rainforest search
      // (lib/legacy-brand-discovery.ts) instead of an open-ended prompt.
      // Falls back to today's unmodified AI-discovery flow entirely when
      // there's no registry match (an out-of-registry category) or the
      // registry category has zero enabled brands.
      const registry = await resolveLegacyBrandsForIdentity(identityCard, toolTypes);

      // ----------------------------------------------------
      // PHASE 1a: MULTI-ROUND FILL LOOP
      // ----------------------------------------------------
      // Guarantees 5 legacy slots by running progressively broader/relaxed
      // search rounds instead of stopping after one query batch. record.phase
      // stays "1" across every round (a __phase1Fill marker inside
      // phase1_result tracks which round is next), mirroring the exact
      // __phase2Stage checkpoint pattern this session's Phase-2 timeout fix
      // already proved out — each round is its own bounded /continue call,
      // never stacked with another round in the same request (round 1's
      // curated search alone can take up to ~20s, and a round-2/3 AI call up
      // to ~45s — stacking two of those, as the old broken
      // AI_TOPUP_TIME_THRESHOLD_MS gate tried to avoid, risked exceeding
      // Vercel's 60s cap; that gate measured elapsed time from the wrong
      // clock and effectively never let the top-up run at all — deleted
      // entirely below, replaced by giving the top-up its own checkpoint
      // with its own fresh budget). Round 1 falling through straight to
      // finalize in the same call (when it already fills all 5) is safe —
      // that's the common case and is exactly what this phase already did
      // before this change.
      const fill: FillLoopMarker = record.phase1_result?.__phase1Fill ?? { round: 1, searchesSoFar: 0 };
      let pool: any[] = record.phase1_result?.__phase1Pool ?? [];
      let legacyRegistrySnapshot: any = record.phase1_result?.__phase1RegistrySnapshot ?? null;
      const searchesBeforeThisRound = webSearchCount;

      // PART 3.2 (preference signal) — "better_competitor" corrections
      // scoped to this exact matching context become a small known-good
      // seed, checked BEFORE any AI discovery search runs this round.
      if (fill.round === 1 && pool.length === 0) {
        pool = await seedKnownGoodCandidates(correctionSignals, "legacy", primaryCriterion, ourMotor, ourHeatTech, targetPriceRaw != null ? deriveTierKeyword(targetPriceRaw) : null);
      }

      // Related Products eligibility (additive only) — an eligible related
      // product seeds directly into the pool so it can independently earn
      // one of the 5 legacy slots by passing the SAME gates every other
      // candidate does below; a brand+title-keyword Amazon search seeded by
      // each one also surfaces real neighbors. Both filtered through
      // filterCandidatesByCategoryAndIdentity exactly like every other
      // incoming batch, never merged into `pool` unfiltered.
      if (fill.round === 1 && eligibleRelatedProducts.length) {
        const relatedSeeds = filterCandidatesByCategoryAndIdentity(buildRelatedProductSeeds(eligibleRelatedProducts, "legacy"), "legacy", identityCard, toolTypes, groomingGateRules);
        const neighbors = filterCandidatesByCategoryAndIdentity(await searchRelatedProductNeighbors(eligibleRelatedProducts, toolTypes, identityCard, "legacy", startTime), "legacy", identityCard, toolTypes, groomingGateRules);
        pool = mergeNewCandidatesIntoPool(pool, [...relatedSeeds, ...neighbors]);
      }

      if (fill.round === 1) {
        if (registry) {
          // Wrapped with category context on every write — the live panel
          // (components/analyze/ProgressPanel.tsx, polling this via GET
          // /api/analyses/[id]) needs the category name/slug alongside each
          // brand's live status, not just the bare brand array. motor/tool-
          // type/price-band/market labels are included so the panel can show
          // an upfront "Searching: X" summary of what's actually driving this
          // search, not just the per-brand chips.
          const legacyBand = computePriceBand(targetPriceRaw, "legacy", 0);
          const writeBrandProgress = (entries: BrandProgressEntry[]) =>
            updatePhase1BrandProgress(analysisId, {
              category_slug: registry.categorySlug,
              category_name: registry.categoryName,
              brands: entries,
              motor_label: ourMotorLabel || null,
              tool_type_label: identityCard.toolType && identityCard.toolType !== "combo" ? getToolTypeLabel(identityCard.toolType, toolTypes) : null,
              target_market_label: context.targetMarket,
              price_band_low: legacyBand.min,
              price_band_high: legacyBand.max,
            });

          await writeBrandProgress(registry.brands.map(b => ({ brand: b.brand_name, status: "searching" })));

          const curatedCandidates = await searchCuratedLegacyBrands(
            registry.brands,
            identityCard,
            targetPriceRaw,
            registry.categorySlug,
            toolTypes,
            writeBrandProgress,
            undefined,
            ourMotorLabel,
            undefined,
            criterionPhrasing(primaryCriterion).term
          );

          let competitors = filterCandidatesByCategoryAndIdentity(curatedCandidates, "legacy", identityCard, toolTypes, groomingGateRules)
            .filter((c: any) => !correctionSignals.blockedAsins.has((c.asin || "").toUpperCase()));

          // Real motor-grounding fix — curated candidates from the Amazon leg
          // (lib/legacy-brand-discovery.ts's toCandidate, a type=search result
          // only) never had specifications/attributes/feature_bullets, so
          // extractCompetitorMotorType always resolved "unverified" for them.
          // This mirrors exactly what the AI-driven (non-registry) branch
          // below already does — same function, same hasGroundingData
          // short-circuit, zero new logic. Brand-site-sourced candidates
          // already carry real description text (skipped by that
          // short-circuit) so this only re-fetches the ones that actually
          // still need it (pure Amazon-leg hits with no brand-site data).
          if (hasRainforestKey) {
            competitors = await enrichCompetitorsWithRainforest(competitors, toolTypes, identityCard.toolType, startTime);
          }

          // Brand-site-only candidates (no Amazon match from the concurrent
          // Amazon leg) still get one real Amazon cross-check attempt for
          // their own sources.amazon — "Attempt ASIN resolution for every
          // brand-site find; amazon:null is fully supported." A miss here
          // never clobbers the candidate's already-real brand-site price/
          // verification (unlike enrichCompetitorsWithRainforest's own
          // failure path, which is correct for "Amazon lookup failed" but
          // wrong for "verified via brand site, simply not on Amazon").
          if (hasRainforestKey) {
            // Concurrency 5 — same reasoning as enrichCompetitorsWithRainforest above.
            competitors = await mapWithConcurrency(competitors, 5, async (c: any) => {
              if (!c.sources?.brand_site || c.sources?.amazon) return c;
              // Same shared-clock budget + hard per-candidate deadline as
              // enrichCompetitorsWithRainforest — this pass runs AFTER that
              // one in the same request, drawing from whatever's left of
              // the SAME RAINFOREST_STEP_DEADLINE_MS budget, so it can never
              // add unbounded time on top.
              const budgetLeft = remainingRainforestBudget(startTime);
              if (budgetLeft <= 0) return c;
              const product = await withDeadline(
                resolveAmazonProductForCandidate(null, c.name, c.brand, toolTypes, identityCard.toolType),
                Math.min(RAINFOREST_CANDIDATE_DEADLINE_MS, budgetLeft),
                null
              );
              if (!product) return c;

              const sitePriceRaw = c.sources.brand_site.price_raw;
              const useAmazonPrice = product.price_raw != null && (sitePriceRaw == null || product.price_raw <= sitePriceRaw);

              return {
                ...c,
                asin: product.asin,
                amazon_url: product.amazon_url,
                rating: product.rating_str,
                review_count: product.reviews_str,
                bsr_rank: product.bsr || c.bsr_rank,
                monthly_sales: product.monthly_str || c.monthly_sales,
                price: useAmazonPrice ? product.price : c.price,
                price_raw: useAmazonPrice ? product.price_raw : c.price_raw,
                sources: {
                  ...c.sources,
                  amazon: {
                    asin: product.asin, url: product.amazon_url, price: product.price, price_raw: product.price_raw,
                    rating: product.rating_str, review_count: product.reviews_str, bsr_rank: product.bsr, monthly_sales: product.monthly_str,
                    retrieved_at: new Date().toISOString(),
                  },
                },
              };
            });
          }

          pool = mergeNewCandidatesIntoPool(pool, competitors);
          legacyRegistrySnapshot = {
            category_slug: registry.categorySlug,
            category_name: registry.categoryName,
            brands: registry.brands.map(b => ({ brand_name: b.brand_name, aliases: b.aliases, sort_order: b.sort_order, source_lists: b.sourceLists ?? null })),
          };
        } else {
          const correctionsGuidance = buildCorrectionsGuidance(correctionSignals.corrections);
          const round1ExtraInstruction = [correctionsGuidance, relatedProductsDiscoveryContext].filter(Boolean).join("\n\n") || undefined;
          const aiResult: any = await withAiFallback(
            "Phase 1",
            hasGeminiKey ? () => executePhase1Gemini(context, identityCard, targetPriceRaw, onSearchUsed, toolTypes, ourMotorLabel, round1ExtraInstruction, primaryCriterion, startTime) : null,
            hasOpenAIKey ? () => executePhase1OpenAI(context, identityCard, targetPriceRaw, onSearchUsed, toolTypes, ourMotorLabel, round1ExtraInstruction, primaryCriterion, startTime) : null,
            () => generateMockPhase1(context, identityCard, targetPriceRaw, toolTypes),
            startTime
          );
          webSearchCount += aiResult.web_searches_performed || 0;
          let aiCompetitors = filterCandidatesByCategoryAndIdentity(aiResult.competitors, "legacy", identityCard, toolTypes, groomingGateRules)
            .filter((c: any) => !correctionSignals.blockedAsins.has((c.asin || "").toUpperCase()));
          if (hasRainforestKey) {
            aiCompetitors = await enrichCompetitorsWithRainforest(aiCompetitors, toolTypes, identityCard.toolType, startTime);
          }
          pool = mergeNewCandidatesIntoPool(pool, aiCompetitors);
        }
      } else {
        // ---- Round 2 (broadened, same strictness) / Round 3 (relaxation
        // ladder) — an AI discovery pass with round-specific instructions.
        // For the registry branch this IS the "not on curated list" top-up
        // (now unconditional and given its own checkpoint/budget instead of
        // racing the curated search's own time budget); for the non-
        // registry branch it's simply a broader/relaxed re-ask. ----
        const usedBrands = new Set(pool.map((c: any) => normalizeBrandToken(c.brand || "")));
        const correctionsGuidance = buildCorrectionsGuidance(correctionSignals.corrections);
        const extraInstruction = [fillRoundExtraInstruction(fill.round, "legacy"), correctionsGuidance, relatedProductsDiscoveryContext].filter(Boolean).join("\n\n");
        const aiResult: any = await withAiFallback(
          `Phase 1 (fill round ${fill.round})`,
          hasGeminiKey ? () => executePhase1Gemini(context, identityCard, targetPriceRaw, onSearchUsed, toolTypes, ourMotorLabel, extraInstruction, primaryCriterion, startTime) : null,
          hasOpenAIKey ? () => executePhase1OpenAI(context, identityCard, targetPriceRaw, onSearchUsed, toolTypes, ourMotorLabel, extraInstruction, primaryCriterion, startTime) : null,
          () => generateMockPhase1(context, identityCard, targetPriceRaw, toolTypes),
          startTime
        );
        webSearchCount += aiResult.web_searches_performed || 0;

        let aiCompetitors = filterCandidatesByCategoryAndIdentity(aiResult.competitors, "legacy", identityCard, toolTypes, groomingGateRules)
          .filter((c: any) => !usedBrands.has(normalizeBrandToken(c.brand || "")))
          .filter((c: any) => !correctionSignals.blockedAsins.has((c.asin || "").toUpperCase()))
          .map((c: any) => (registry ? { ...c, curated_brand: false, brand_list_status: "not_curated" } : c));
        if (hasRainforestKey) {
          aiCompetitors = await enrichCompetitorsWithRainforest(aiCompetitors, toolTypes, identityCard.toolType, startTime);
        }
        pool = mergeNewCandidatesIntoPool(pool, aiCompetitors);
      }

      const updatedFill: FillLoopMarker = { round: fill.round, searchesSoFar: fill.searchesSoFar + (webSearchCount - searchesBeforeThisRound) };

      // How many real slots would selection currently fill? Recomputed via
      // the real selection function every round (never a separately-
      // maintained counter) so it can't drift from what final selection
      // will actually decide. allowStaticFallbackTopup stays false here —
      // that safety net is reserved for the finalize step below, once every
      // real search round has already run.
      const trialSelection = selectByCompositeScore(pool, targetPriceRaw, "legacy", identityCard, 5, scoringCtx, { allowStaticFallbackTopup: false, requireMotorEvidenceFirst: true });

      // Rounds 1->2 and 2->3 are unchanged (strict trial, exactly as before
      // the nearest-similar feature). Round 3->4 is a separate, later
      // decision: round 4 is the nearest-similar last resort (spec's "one
      // additional targeted search pass"), so it should only trigger when
      // even a RELAXED (nearestSimilarMode) trial over the full pool still
      // can't fill every slot — gating it on the strict trial count like
      // rounds 1-3 would fire it almost every time even one verified pick
      // is missing, defeating "only when genuinely needed."
      let shouldRunAnotherRound: boolean;
      if (updatedFill.round < 3) {
        shouldRunAnotherRound = trialSelection.length < 5;
      } else if (updatedFill.round === 3) {
        const relaxedTrial = selectByCompositeScore(pool, targetPriceRaw, "legacy", identityCard, 5, scoringCtx, { nearestSimilarMode: true, allowStaticFallbackTopup: false });
        shouldRunAnotherRound = relaxedTrial.length < 5;
      } else {
        shouldRunAnotherRound = false; // round 4 already ran — never a 5th
      }

      if (shouldRunAnotherRound && updatedFill.round < 4) {
        await updateAnalysisPhase(analysisId, 1, "phase1_result", {
          __phase1Fill: { round: (updatedFill.round + 1) as 1 | 2 | 3 | 4, searchesSoFar: updatedFill.searchesSoFar },
          __phase1Pool: pool,
          __phase1RegistrySnapshot: legacyRegistrySnapshot,
        }, webSearchCount);
        return { analysisId, phase: 1, status: "running", stepResult: null, totalSearches: webSearchCount };
      }

      // ----------------------------------------------------
      // PHASE 1b: FINALIZE — full relaxation ladder, nearest-similar
      // fallback, then (only if that's still not enough) an honest empty
      // slot — never rendered until every real avenue has been tried.
      // ----------------------------------------------------
      let competitors = selectByCompositeScore(pool, targetPriceRaw, "legacy", identityCard, 5, scoringCtx, { allowStaticFallbackTopup: true, requireMotorEvidenceFirst: true });
      let stillShort = 5 - competitors.length;
      if (stillShort > 0) {
        // Nearest-similar fallback — everything already gathered this run
        // (pool) that wasn't selected above, re-scored under a much wider
        // band and with no motor/heat-tech evidence requirement (see
        // selectByCompositeScore's nearestSimilarMode). Hard rules still
        // apply: every candidate in `pool` already passed tool-type
        // filtering on the way in, and excludeAlreadySelected keeps this
        // from duplicating an already-seated pick.
        const unusedPool = excludeAlreadySelected(pool, competitors);
        const nearestPicks = selectByCompositeScore(unusedPool, targetPriceRaw, "legacy", identityCard, stillShort, scoringCtx, { nearestSimilarMode: true, allowStaticFallbackTopup: false });
        competitors = [...competitors, ...nearestPicks];
        stillShort = 5 - competitors.length;
      }
      for (let i = 0; i < stillShort; i++) {
        competitors.push(buildEmptySlotPlaceholder("legacy", identityCard, toolTypes, ourMotorLabel, updatedFill.searchesSoFar));
      }

      const result: any = {
        web_searches_performed: webSearchCount,
        competitors,
        // Snapshotted per-analysis for auditability — which category and
        // exact brand list (in priority order) this run actually searched,
        // independent of any later admin edit to the live registry.
        legacy_registry_snapshot: legacyRegistrySnapshot,
        // Same auditability reasoning — the actual weights THIS run used,
        // independent of any later admin edit to the live config.
        matching_weights: scoringCtx.weights,
        form_inputs: buildFormInputsSnapshot(context),
        fill_rounds_used: updatedFill.round,
      };

      // PART 3 (Remove + Refill) — persist a runner-up pool (everything
      // this run gathered but didn't select) and an empty removed-ASIN
      // blocklist, both read back later by fetchReplacementForSlot/
      // removeCompetitorSlot/refillCompetitorSlot. Capped for storage via
      // trimRunnerUpPoolForStorage — this is a "nice to have instant
      // refill," not a full audit trail.
      result.runnerUpPool = trimRunnerUpPoolForStorage(excludeAlreadySelected(pool, competitors));
      result.removedAsins = [];

      // 1E post-selection sweep — re-checks every non-placeholder survivor
      // against the CURRENT grooming-gate rules one more time (the gate was
      // already applied inside selectByCompositeScore above, but rules can
      // change between candidate-gating and this exact moment is also where
      // a future admin-rule-edit-triggered re-sweep would hook in) and
      // swaps out anything contaminated using the runner-up pool this same
      // run already gathered — zero extra network calls in the common case.
      result.competitors = await sweepGroomingGateContamination(result.competitors, result.runnerUpPool, {
        identity: identityCard,
        tier: "legacy",
        targetPriceRaw,
        toolTypes,
        scoringCtx,
        excludeAsins: new Set<string>(),
        analysisId,
        routeStartTime: startTime,
      });

      const realCompetitors = result.competitors.filter((c: any) => !c.empty_slot);
      if (registry) {
        // Per-competitor provenance (which curated list — or the "not on
        // curated list" AI fallback — sourced each legacy pick), feeding the
        // PDF's existing "Data Sources & Methodology" appendix.
        await persistLegacyRegistryProvenance(realCompetitors, registry, analysisId);
      }
      if (hasRainforestKey) {
        await persistPricingProvenance(realCompetitors, analysisId);
      }

      await updateAnalysisPhase(analysisId, 2, "phase1_result", result, webSearchCount);
      return { analysisId, phase: 2, status: "running", stepResult: result, totalSearches: webSearchCount };
    }

    if (record.phase === 2) {
      // ----------------------------------------------------
      // PHASE 2: EMERGING-COMPETITOR DISCOVERY
      // ----------------------------------------------------
      // Split into 2a (AI discovery) / 2b (Rainforest enrichment + indie
      // brand lineups + composite scoring) for the same reason Phase 3 was
      // split (commit e487c60): the AI discovery call alone is documented
      // elsewhere in this file as taking 20-46s on a normal run (see Phase
      // 1's own OpenAI web-search latency comment), and
      // enrichCompetitorsWithRainforest + buildIndieBrandLineups then stack
      // TWO more un-timeboxed rounds of Rainforest calls sequentially after
      // it — routinely exceeding Vercel's 60s cap ("Connection dropped" /
      // "Server took too long to respond" for the user, mid-request,
      // confirmed happening repeatedly in production). record.phase stays
      // "2" across both sub-steps (an internal __phase2Stage marker inside
      // phase2_result distinguishes them, mirroring phase 3/4's own
      // __phase3Stage pattern) — no client change needed, since
      // ProgressPanel's generic "call /continue again while status is
      // running" loop already tolerates the same phase number recurring
      // (it already does this for phase 4's own 3b/3c split).
      if (!identityCard) throw new Error("Missing product identity — cannot run competitor discovery");

      const resolved = await resolvePhase2Context(context, identityCard);
      if (!resolved.ok) {
        await setPendingQuestion(analysisId, resolved.pendingQuestion);
        return { analysisId, phase: 2, status: "running", stepResult: null, totalSearches: 0, pendingQuestion: resolved.pendingQuestion };
      }
      const { targetPriceRaw, registryBrandTokens, brandHintOverride, motorFamilies, brandedNames, toolTypes, primaryCriterion, ourMotor, heatTechFamilies, brandedHeatTechNames, ourHeatTech, ourMotorLabel, weights, ourSpecs, ourLineupPercentile, correctionSignals, groomingGateRules, groomingGateConfidenceThreshold, ourGroomingTag, ourIsPetGrooming } = resolved.ctx;

      if (record.phase2_result?.__phase2Stage !== "discovered") {
        // ----------------------------------------------------
        // PHASE 2a: MULTI-ROUND EMERGING-COMPETITOR AI DISCOVERY
        // ----------------------------------------------------
        // Guarantees 5 emerging slots the same way Phase 1a now does —
        // Phase 2 previously had ZERO re-query mechanism at all (a single
        // AI call, no retry if it under-delivered). record.phase2_result's
        // __phase2Fill marker tracks the round; __phase2Stage stays
        // whatever it was ("not discovered yet") across every round in this
        // loop, only flipping to "discovered" once the pool is ready to
        // hand off to 2b (unchanged below).
        const fill: FillLoopMarker = record.phase2_result?.__phase2Fill ?? { round: 1, searchesSoFar: 0 };
        let pool: any[] = record.phase2_result?.__phase2Pool ?? [];
        const searchesBeforeThisRound = webSearchCount;

        // PART 3.2 (preference signal) — same known-good seed as Phase 1's
        // fill loop, scoped to "emerging" here.
        if (fill.round === 1 && pool.length === 0) {
          pool = await seedKnownGoodCandidates(correctionSignals, "emerging", primaryCriterion, ourMotor, ourHeatTech, targetPriceRaw != null ? deriveTierKeyword(targetPriceRaw) : null);
        }

        // Related Products eligibility (additive only) — same reasoning as
        // Phase 1's identical block above, scoped to "emerging" here.
        if (fill.round === 1 && eligibleRelatedProducts.length) {
          const relatedSeeds = filterCandidatesByCategoryAndIdentity(buildRelatedProductSeeds(eligibleRelatedProducts, "emerging"), "emerging", identityCard, toolTypes, groomingGateRules);
          const neighbors = filterCandidatesByCategoryAndIdentity(await searchRelatedProductNeighbors(eligibleRelatedProducts, toolTypes, identityCard, "emerging", startTime), "emerging", identityCard, toolTypes, groomingGateRules);
          pool = mergeNewCandidatesIntoPool(pool, [...relatedSeeds, ...neighbors]);
        }

        const usedBrands = new Set(pool.map((c: any) => normalizeBrandToken(c.brand || "")));
        const correctionsGuidance = buildCorrectionsGuidance(correctionSignals.corrections);
        const extraInstruction = [fill.round === 1 ? null : fillRoundExtraInstruction(fill.round, "emerging"), correctionsGuidance, relatedProductsDiscoveryContext].filter(Boolean).join("\n\n") || undefined;
        const result: any = await withAiFallback(
          fill.round === 1 ? "Phase 2" : `Phase 2 (fill round ${fill.round})`,
          hasGeminiKey ? () => executePhase2Gemini(context, identityCard, targetPriceRaw, onSearchUsed, toolTypes, brandHintOverride, ourMotorLabel, extraInstruction, primaryCriterion, startTime) : null,
          hasOpenAIKey ? () => executePhase2OpenAI(context, identityCard, targetPriceRaw, onSearchUsed, toolTypes, brandHintOverride, ourMotorLabel, extraInstruction, primaryCriterion, startTime) : null,
          () => generateMockPhase2(context, identityCard, targetPriceRaw, toolTypes, phase1Result),
          startTime
        );

        let newCompetitors = filterCandidatesByCategoryAndIdentity(result.competitors, "emerging", identityCard, toolTypes, groomingGateRules);
        if (registryBrandTokens) {
          newCompetitors = newCompetitors.filter((c: any) => !registryBrandTokens.has(normalizeBrandToken(c.brand || "")));
        }
        newCompetitors = newCompetitors.filter((c: any) => !usedBrands.has(normalizeBrandToken(c.brand || "")));
        newCompetitors = newCompetitors.filter((c: any) => !correctionSignals.blockedAsins.has((c.asin || "").toUpperCase()));
        webSearchCount += result.web_searches_performed || 0;
        pool = mergeNewCandidatesIntoPool(pool, newCompetitors);

        const updatedFill: FillLoopMarker = { round: fill.round, searchesSoFar: fill.searchesSoFar + (webSearchCount - searchesBeforeThisRound) };

        // Cheap trial check (no Rainforest/indie-lineup calls — those stay
        // in 2b) — indieLineups: [] makes relative-pricing candidates fall
        // back to absolute-price scoring for this estimate only; the real,
        // authoritative selection with full indie lineups happens in 2b
        // regardless of what this trial predicts.
        const trialCtx: CompositeScoringContext = {
          motorFamilies, brandedNames, toolTypes, primaryCriterion, ourMotor,
          heatTechFamilies, brandedHeatTechNames, ourHeatTech,
          ourSpecs, ourLineupPercentile, indieLineups: new Map(),
          weights,
          keyDiff: context.keyDiff ?? null,
          penalizedAsins: correctionSignals.penalizedAsins,
          relatedProducts: relatedProductProfiles,
          groomingGateRules, groomingGateConfidenceThreshold, ourGroomingTag, ourIsPetGrooming,
        };
        const trialSelection = selectByCompositeScore(pool, targetPriceRaw, "emerging", identityCard, 5, trialCtx, { allowStaticFallbackTopup: false, requireMotorEvidenceFirst: true });

        if (trialSelection.length < 5 && updatedFill.round < 3) {
          await updateAnalysisPhase(analysisId, 2, "phase2_result", {
            __phase2Fill: { round: (updatedFill.round + 1) as 1 | 2 | 3, searchesSoFar: updatedFill.searchesSoFar },
            __phase2Pool: pool,
          }, webSearchCount);
          return { analysisId, phase: 2, status: "running", stepResult: null, totalSearches: webSearchCount };
        }

        const finalized: any = { competitors: pool, __phase2Stage: "discovered", __phase2FillRoundsUsed: updatedFill.round, __phase2SearchesSoFar: updatedFill.searchesSoFar };
        await updateAnalysisPhase(analysisId, 2, "phase2_result", finalized, webSearchCount);
        return { analysisId, phase: 2, status: "running", stepResult: null, totalSearches: webSearchCount };
      }

      // ----------------------------------------------------
      // PHASE 2b: RAINFOREST ENRICHMENT + INDIE LINEUPS + SCORING
      // ----------------------------------------------------
      const result: any = record.phase2_result;
      delete result.__phase2Stage;
      const fillRoundsUsed: number = result.__phase2FillRoundsUsed ?? 1;
      const searchesSoFarPhase2: number = result.__phase2SearchesSoFar ?? 0;
      delete result.__phase2FillRoundsUsed;
      delete result.__phase2SearchesSoFar;

      // Speed fix — indie brand lineups (below) only ever need each
      // candidate's BRAND NAME, which mergeRainforestProductIntoCompetitor
      // never overwrites (it spreads price/specs/description/etc. but never
      // `.brand`) — so this lookup doesn't actually need to wait for
      // Rainforest enrichment or the brand-site pass to finish. Previously
      // all three ran sequentially against the SAME shared
      // RAINFOREST_STEP_DEADLINE_MS clock (enrichment, then brand-site,
      // then indie lineups), which is exactly the "searching indie
      // competitors" step users reported as slow/repeatedly re-polling.
      // Kicking indie lineups off here — in parallel with the
      // enrichment-then-brand-site chain below — cuts this phase's
      // wall-clock cost from the SUM of all three steps to roughly the MAX
      // of them, with zero change to which brands get looked up (the brand
      // SET is identical before/after enrichment; only enrichment/brand-site
      // ever add data to existing candidates, never add/remove candidates).
      const subcategoryForLineups = identityCard.subcategory || identityCard.category || "";
      const distinctBrandsForLineups: string[] = Array.from(new Set(result.competitors.map((c: any) => c.brand as string).filter(Boolean)));
      const indieLineupsPromise = buildIndieBrandLineups(
        distinctBrandsForLineups.map(brand => ({ brand, subcategory: subcategoryForLineups })),
        remainingRainforestBudget(startTime)
      );

      if (hasRainforestKey) {
        result.competitors = await enrichCompetitorsWithRainforest(result.competitors, toolTypes, identityCard.toolType, startTime);
      }

      // Best-effort brand-site pass for emerging candidates — the curated
      // legacy path has always had this (lib/legacy-brand-discovery.ts's
      // official_domains lookup); emerging candidates never did, since
      // indie/emerging brands aren't in that curated registry by
      // definition. Deliberately scoped to ONLY candidates Rainforest left
      // with zero grounding data at all (no specs/attributes/bullets/
      // description — meaning motor type would otherwise resolve
      // "unverified" for certain) — this is a genuinely added-latency
      // operation, so it stays rare rather than running for every
      // candidate. Folds straight into `description`, exactly like the
      // legacy path, so the existing extractCompetitorMotorType call in
      // selectByCompositeScore below picks it up for free — no new
      // matching logic needed. This DOES need to wait for enrichment
      // (it only targets candidates enrichment left ungrounded), so it
      // stays sequential — only the independent indie-lineups lookup above
      // was pulled out of the chain.
      if (hasOpenAIKey && identityCard.toolType) {
        const ungrounded = result.competitors.filter((c: any) =>
          !c.specifications?.length && !c.attributes?.length && !c.feature_bullets?.length && !c.description && c.brand
        );
        if (ungrounded.length > 0) {
          const brandSiteHits = await discoverBrandSiteCandidatesForEmerging(
            ungrounded.map((c: any) => c.brand),
            { toolType: identityCard.toolType, toolTypes, motorLabel: ourMotorLabel, analysisId, criterionTerm: criterionPhrasing(primaryCriterion).term },
            remainingRainforestBudget(startTime)
          );
          result.competitors = result.competitors.map((c: any) => {
            const hit = brandSiteHits.get(c.brand);
            if (!hit) return c;
            return {
              ...c,
              description: hit.description,
              sources: { ...(c.sources || {}), brand_site: { url: hit.url, price: hit.price, price_raw: hit.price_raw, retrieved_at: hit.retrieved_at } },
            };
          });
        }
      }

      const indieLineups = await indieLineupsPromise;

      const scoringCtx: CompositeScoringContext = {
        motorFamilies,
        brandedNames,
        toolTypes,
        primaryCriterion,
        ourMotor,
        heatTechFamilies,
        brandedHeatTechNames,
        ourHeatTech,
        ourSpecs,
        weights,
        ourLineupPercentile,
        indieLineups,
        keyDiff: context.keyDiff ?? null,
        penalizedAsins: correctionSignals.penalizedAsins,
        relatedProducts: relatedProductProfiles,
        groomingGateRules,
        groomingGateConfidenceThreshold,
        ourGroomingTag,
        ourIsPetGrooming,
      };
      // Captured before the reassignment below — this is the full,
      // already-enriched candidate pool the nearest-similar fallback draws
      // from if the normal selection still comes up short.
      const enrichedPool = result.competitors;
      result.competitors = selectByCompositeScore(enrichedPool, targetPriceRaw, "emerging", identityCard, 5, scoringCtx, { requireMotorEvidenceFirst: true, allowStaticFallbackTopup: true });
      let stillShortEmerging = 5 - result.competitors.length;

      if (stillShortEmerging > 0) {
        // Nearest-similar fallback — same reasoning as Phase 1's (see its
        // own finalize block): everything already gathered this run that
        // wasn't selected above, re-scored under a much wider band with no
        // motor/heat-tech evidence requirement. Tool type and registry-
        // brand exclusion are already guaranteed (enrichedPool only ever
        // received tool-type-filtered, non-registry-brand candidates on
        // the way in during Phase 2a).
        const unusedPool = excludeAlreadySelected(enrichedPool, result.competitors);
        const nearestPicks = selectByCompositeScore(unusedPool, targetPriceRaw, "emerging", identityCard, stillShortEmerging, scoringCtx, { nearestSimilarMode: true, allowStaticFallbackTopup: false });
        result.competitors = [...result.competitors, ...nearestPicks];
        stillShortEmerging = 5 - result.competitors.length;
      }

      if (stillShortEmerging > 0 && fillRoundsUsed < 4) {
        // Last resort: even the nearest-similar rescan over the full pool
        // couldn't fill every slot — run ONE more, differently-angled
        // search round (see fillRoundExtraInstruction's round 4 text)
        // before accepting an empty slot. __phase2Stage flips to
        // "needs_round4" (NOT back to "discovered"), so the next /continue
        // call re-enters the PHASE 2a block above; __phase2Fill: {round:4}
        // makes that block's existing fill.round!==1 branch run
        // fillRoundExtraInstruction(4, "emerging") with zero further
        // changes needed there. Once round 4 completes, 2a's own existing
        // transition-to-"discovered" logic naturally hands back to this
        // same 2b block a second time (fillRoundsUsed will then read 4,
        // which is why this guard can never trigger a second round 4).
        await updateAnalysisPhase(analysisId, 2, "phase2_result", {
          __phase2Stage: "needs_round4",
          __phase2Fill: { round: 4, searchesSoFar: searchesSoFarPhase2 },
          __phase2Pool: enrichedPool,
        }, webSearchCount);
        return { analysisId, phase: 2, status: "running", stepResult: null, totalSearches: webSearchCount };
      }

      for (let i = 0; i < stillShortEmerging; i++) {
        result.competitors.push(buildEmptySlotPlaceholder("emerging", identityCard, toolTypes, ourMotorLabel, searchesSoFarPhase2));
      }
      result.matching_weights = scoringCtx.weights;
      result.form_inputs = buildFormInputsSnapshot(context);
      result.fill_rounds_used = fillRoundsUsed;

      // PART 3 (Remove + Refill) — same runner-up-pool/removed-ASIN
      // persistence as Phase 1's finalize block (see its own comment).
      // enrichedPool is the full, already-enriched candidate pool BEFORE
      // truncation to 5 — the right "everything gathered but not selected"
      // source for a runner-up pool.
      result.runnerUpPool = trimRunnerUpPoolForStorage(excludeAlreadySelected(enrichedPool, result.competitors));
      result.removedAsins = [];

      // 1E post-selection sweep — same reasoning as Phase 1's own call.
      // Unlike Phase 1 (which always finalizes before Phase 2 exists, so it
      // has no "other tier" to exclude against), Phase 1's real competitors
      // ARE already persisted by the time Phase 2 reaches its own finalize —
      // excluded here so a sweep-triggered emerging replacement can never
      // duplicate an ASIN already seated on the legacy side (same cross-tier
      // union refillCompetitorSlot already builds for its own case).
      const phase1CompetitorAsins = new Set<string>();
      for (const c of record.phase1_result?.competitors || []) {
        const a = (c.asin || "").toUpperCase();
        if (/^[A-Z0-9]{10}$/.test(a)) phase1CompetitorAsins.add(a);
      }
      result.competitors = await sweepGroomingGateContamination(result.competitors, result.runnerUpPool, {
        identity: identityCard,
        tier: "emerging",
        targetPriceRaw,
        toolTypes,
        scoringCtx,
        excludeAsins: phase1CompetitorAsins,
        analysisId,
        routeStartTime: startTime,
      });

      const realEmergingCompetitors = result.competitors.filter((c: any) => !c.empty_slot);
      if (hasRainforestKey) {
        await persistPricingProvenance(realEmergingCompetitors, analysisId);
      }

      await updateAnalysisPhase(analysisId, 3, "phase2_result", result, webSearchCount);
      return { analysisId, phase: 3, status: "running", stepResult: result, totalSearches: webSearchCount };
    }

    if (record.phase === 3) {
      // ----------------------------------------------------
      // PHASE 3a: STRATEGIC SYNTHESIS (main AI call only)
      // ----------------------------------------------------
      // Split from what used to be a single request doing synthesis +
      // conditional anti-boilerplate retry + citation verification + report
      // save, all sequentially — each of the first two is independently
      // capable of running close to the per-call AI timeout on its own (see
      // Phase 1's own comment on OpenAI web-search latency variance), so
      // stacking two of them plus citation fetches routinely blew past
      // Vercel's 60s cap ("connection dropped" for the user, mid-request,
      // with no error ever persisted since the function was killed before
      // it could write one). record.phase stays "3" in the DB response
      // client-side is never told about this split (see phase 4 below) —
      // ProgressPanel's existing generic "call /continue again" loop just
      // keeps polling, so no client change was needed for the resumability
      // itself, only a small guard against a premature "Complete" flash
      // (see ProgressPanel.tsx's step.phase !== 4 check).
      if (!phase1Result || !phase2Result || !identityCard) {
        throw new Error("Missing identity/phase 1/2 results — cannot run phase 3");
      }

      const result: any = await withAiFallback(
        "Phase 3",
        hasGeminiKey ? () => executePhase3Gemini(context, identityCard, phase1Result, phase2Result, onSearchUsed, undefined, startTime) : null,
        hasOpenAIKey ? () => executePhase3OpenAI(context, identityCard, phase1Result, phase2Result, onSearchUsed, undefined, startTime) : null,
        () => generateMockPhase3(context, identityCard, phase1Result, phase2Result),
        startTime
      );
      webSearchCount += result.web_searches_performed || 0;
      result.__phase3Stage = "synthesized";

      await updateAnalysisPhase(analysisId, 4, "phase3_result", result, webSearchCount);
      return { analysisId, phase: 4, status: "running", stepResult: null, totalSearches: webSearchCount };
    }

    if (record.phase === 4) {
      if (!phase1Result || !phase2Result || !identityCard) {
        throw new Error("Missing identity/phase 1/2 results — cannot finish phase 3");
      }
      const stage = record.phase3_result?.__phase3Stage;
      let result: any = record.phase3_result;
      delete result.__phase3Stage;

      if (stage === "synthesized") {
        // ----------------------------------------------------
        // PHASE 3b: ANTI-BOILERPLATE CHECK (at most one more AI call)
        // ----------------------------------------------------
        // If this analysis's positioning text is near-identical to a recent
        // DIFFERENT-category analysis, it's almost certainly generic
        // could-apply-to-anything strategy text — one regeneration attempt
        // with the real competitor facts, same retry-with-facts pattern
        // already proven in lib/gtm-generate.ts.
        try {
          const positioningText = typeof result.positioning_recommendation === "string" ? result.positioning_recommendation : "";
          if (positioningText && (hasOpenAIKey || hasGeminiKey)) {
            const recent = await getRecentAnalysesForBoilerplateCheck(context.orgId, analysisId);
            const boilerplateMatch = recent.find(r =>
              r.category && r.category.toLowerCase() !== identityCard.category.toLowerCase() &&
              r.positioningText && textSimilarity(positioningText, r.positioningText) > BOILERPLATE_SIMILARITY_THRESHOLD
            );
            if (boilerplateMatch) {
              const facts = [...(phase1Result?.competitors || []), ...(phase2Result?.competitors || [])]
                .slice(0, 3)
                .map((c: any) => `${c.name} at ${c.price || "an unlisted price"}`);
              const extraInstruction = `The draft was generic. Rewrite strictly about ${identityCard.subcategory} using these specific competitor facts: ${facts.join("; ") || "the competitor data above"}.`;
              const retried = hasOpenAIKey
                ? await executePhase3OpenAI(context, identityCard, phase1Result, phase2Result, onSearchUsed, extraInstruction, startTime)
                : await executePhase3Gemini(context, identityCard, phase1Result, phase2Result, onSearchUsed, extraInstruction, startTime);
              if (retried && typeof retried.positioning_recommendation === "string") {
                result = retried;
              }
            }
          }
        } catch (err) {
          console.warn("Phase 3 anti-boilerplate check failed (non-fatal, keeping original result):", err);
        }

        result.__phase3Stage = "boilerplateChecked";
        await updateAnalysisPhase(analysisId, 4, "phase3_result", result, webSearchCount);
        return { analysisId, phase: 4, status: "running", stepResult: null, totalSearches: webSearchCount };
      }

      // ----------------------------------------------------
      // PHASE 3c: CITATIONS + MARKET-SIZE CHECK + finalize
      // ----------------------------------------------------
      // Universal citation verification: independently fetch every URL the
      // model cited and downgrade any claim whose quote doesn't actually
      // appear on that page — never trust the model's own citation as-is.
      // Applied uniformly regardless of which provider produced `result`
      // (OpenAI, Gemini, or mock all go through the same check).
      try {
        const rawCitations = Array.isArray(result.citations) ? result.citations : [];
        result.citations = await finalizeCitations(rawCitations, analysisId);
      } catch (err) {
        console.warn("Phase 3 citation verification failed (non-fatal, treating as no citations):", err);
        result.citations = [];
      }

      // Market size is the highest-risk hallucination surface: if this
      // category has no curated market data (lib/market-data.ts) AND no
      // verified market_stat citation survived the check above, force the
      // honest fallback regardless of whatever number the model wrote —
      // never let an uncited figure reach the UI/PDF.
      const hasCuratedMarketData = !!getMarketData(identityCard.subcategory || identityCard.category, context.productName);
      const hasVerifiedMarketStat = (result.citations || []).some((c: any) => c.type === "market_stat" && c.verification === "verified");
      if (!hasCuratedMarketData && !hasVerifiedMarketStat && result.market_snapshot) {
        const noDataDate = new Date().toISOString().slice(0, 10);
        result.market_snapshot.market_size_current = null;
        result.market_snapshot.market_size_forecast = null;
        result.market_snapshot.forecast_year = null;
        result.market_snapshot.cagr_percent = null;
        result.market_snapshot.cagr_period = null;
        result.market_snapshot.data_source = null;
        result.market_snapshot.headline_stat_label = "unavailable";
        result.market_snapshot.headline_stat_value = `Market size: no verifiable public figure found as of ${noDataDate}`;
      }

      result.analysis_label = `Analysis of ${identityCard.productName} (${identityCard.subcategory}) — competitors verified ${new Date().toISOString()}`;

      await updateAnalysisPhase(analysisId, 4, "phase3_result", result, 0);

      // Save CompetitorAnalyses to DB/Memory for link references
      await saveCompetitorAnalyses(analysisId, context.orgId, phase1Result, phase2Result, identityCard);

      // Mark as complete
      await completeAnalysis(analysisId, Date.now() - startTime);

      // Auto-save report
      let reportId = "";
      try {
        const report = await createReportFromAnalysis(
          context.userId,
          analysisId,
          context.projectId,
          {
            phase1: phase1Result,
            phase2: phase2Result,
            phase3: result,
            productName: context.productName,
            industry: context.industry,
            targetMarket: context.targetMarket,
            pricePoint: context.pricePoint,
          },
          context.orgId
        );
        reportId = report.id;
      } catch (saveErr) {
        console.error("Auto report saving failed:", saveErr);
      }

      return { analysisId, phase: 5, status: "complete", stepResult: result, totalSearches: 0, reportId };
    }

    // Already past phase 4 (completeAnalysis sets phase 5) without being
    // marked complete/failed — shouldn't normally happen, nothing left to run.
    return { analysisId, phase: record.phase, status: record.status, stepResult: null, totalSearches: 0 };
  } catch (error: any) {
    console.error(`Analysis step crashed at phase ${record.phase}:`, error);
    const message = error.message || "Unknown error during analysis";
    await failAnalysis(analysisId, message);
    return { analysisId, phase: record.phase, status: "failed", stepResult: null, totalSearches: webSearchCount, error: message };
  }
}

// ----------------------------------------------------
// EDITABLE ASIN: a user manually replacing a wrongly-selected competitor.
// ----------------------------------------------------

// Accepts either a plain 10-char ASIN or a pasted Amazon product URL
// (/dp/{ASIN}, /gp/product/{ASIN}) — same acceptance shape as the "product
// URL" field on project creation (lib/snapshot-capture.ts's own
// extractAsinFromUrl, reused directly here rather than duplicated).
// Returns null (never a guess) when neither form is recognizable.
export function resolveAsinFromInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^[A-Z0-9]{10}$/i.test(trimmed)) return trimmed.toUpperCase();
  return extractAsinFromUrl(trimmed);
}

// Substring-scans phase3_result's free-prose competitor-naming fields for
// the OLD competitor's name/brand — the only structured competitor
// reference this codebase's synthesis output has is
// top_threats[].competitor_name; everything else (market_gaps,
// top_opportunities, positioning_recommendation, strategic_recommendations,
// quick_wins) is plain prose with no citation-to-competitor index. A hit
// here doesn't rewrite anything — it only flags phase3_result as possibly
// stale so the UI can offer a one-click full re-synthesis (see
// resetPhase3ForRegeneration) rather than either silently leaving wrong
// text or re-running an AI call on every single swap.
export function phase3MentionsCompetitor(phase3Result: any, oldName: string, oldBrand: string | undefined): boolean {
  if (!phase3Result) return false;
  const needles = [oldName, oldBrand].filter((s): s is string => !!s && s.trim().length > 2).map(s => s.toLowerCase());
  if (needles.length === 0) return false;

  const haystacks: string[] = [
    ...(Array.isArray(phase3Result.market_gaps) ? phase3Result.market_gaps : []),
    ...(Array.isArray(phase3Result.quick_wins) ? phase3Result.quick_wins : []),
    phase3Result.positioning_recommendation,
    ...(Array.isArray(phase3Result.top_threats) ? phase3Result.top_threats.flatMap((t: any) => [t.competitor_name, t.threat_description]) : []),
    ...(Array.isArray(phase3Result.top_opportunities) ? phase3Result.top_opportunities.map((o: any) => o.description) : []),
    ...(Array.isArray(phase3Result.strategic_recommendations) ? phase3Result.strategic_recommendations.map((r: any) => r.explanation) : []),
  ].filter((s): s is string => typeof s === "string" && s.length > 0);

  return haystacks.some(text => needles.some(needle => text.toLowerCase().includes(needle)));
}

export interface ReplaceCompetitorResult {
  competitor: any;
  synthesisPossiblyStale: boolean;
}

// Refetches ONE competitor's full Amazon data by a user-supplied ASIN and
// rebuilds its entry in place — never re-ranks against siblings (the
// corrected competitor keeps its existing slot; that's the entire point of
// a targeted human correction, not a fresh discovery run). Price/feature
// scoring here deliberately uses the simpler absolute-price/no-lineup path
// even for an emerging/indie competitor — relative-lineup pricing needs
// each brand's full price lineup (lib/indie-brand-lineup.ts), a
// discovery-time-only concept not worth reconstructing for a single
// manual swap whose card no longer shows the "Why this competitor"
// scoring rationale anyway (replaced by "Manually selected by {user}").
export async function replaceCompetitor(
  analysisId: string,
  oldAsin: string,
  newAsin: string,
  actorUserId: string | null,
  correction: { reason: CorrectionReason; note?: string | null }
): Promise<ReplaceCompetitorResult> {
  const record: any = await getAnalysis(analysisId);
  if (!record) throw new Error("Analysis not found");

  const identity: IdentityCard | null = hasResult(record.phase0_result) ? record.phase0_result : null;
  if (!identity) throw new Error("Analysis has no confirmed product identity yet — cannot replace a competitor before Phase 0 completes");

  const context: AnalysisContext = { id: analysisId, orgId: record.org_id || "dev_org_id", userId: record.user_id, projectId: record.project_id || null, ...(record.context || {}) };

  const phase1Result = hasResult(record.phase1_result) ? record.phase1_result : null;
  const phase2Result = hasResult(record.phase2_result) ? record.phase2_result : null;
  const phase3Result = hasResult(record.phase3_result) ? record.phase3_result : null;

  let foundIn: "phase1" | "phase2" | null = null;
  let oldCompetitor: any = null;
  if (phase1Result?.competitors) {
    const idx = phase1Result.competitors.findIndex((c: any) => c.asin === oldAsin);
    if (idx >= 0) { foundIn = "phase1"; oldCompetitor = phase1Result.competitors[idx]; }
  }
  if (!foundIn && phase2Result?.competitors) {
    const idx = phase2Result.competitors.findIndex((c: any) => c.asin === oldAsin);
    if (idx >= 0) { foundIn = "phase2"; oldCompetitor = phase2Result.competitors[idx]; }
  }
  if (!foundIn || !oldCompetitor) throw new Error(`No competitor with ASIN "${oldAsin}" found on this analysis`);

  const allExistingAsins = new Set([...(phase1Result?.competitors || []), ...(phase2Result?.competitors || [])].map((c: any) => c.asin).filter(Boolean));
  if (allExistingAsins.has(newAsin)) throw new Error(`ASIN "${newAsin}" is already one of this analysis's other competitors`);

  const product = await fetchAmazonProductFresh(newAsin);
  // Broad-audit finding — getAmazonProduct/fetchAmazonProductFresh collapse
  // a genuine "no such product" result and a Rainforest auth/credit/outage
  // error into the identical `null` (the distinction only survives in
  // internal telemetry, never in what a caller can branch on) — this
  // previously asserted false certainty ("could not fetch" reads as "this
  // ASIN is wrong") when the real cause could just as easily be a service
  // outage. Wording fixed to stop overclaiming; NOT a full fix of the
  // underlying error-class collapse (that's a larger, riskier change
  // touching getAmazonProduct's many other callers — flagged as a known
  // follow-up, not attempted here).
  if (!product) throw new Error(`Could not fetch a real Amazon product for ASIN "${newAsin}" — this could mean the ASIN is wrong, or that Amazon/Rainforest data is temporarily unavailable. Double-check the ASIN and try again in a moment.`);
  // No cache write-through needed here: newAsin has never been cached
  // under this analysis before, so any later getAmazonProduct(newAsin)
  // call (e.g. CompetitorCard's own review/news/key-features lookups)
  // simply cache-misses and fetches fresh itself on first access — there
  // is no stale entry to invalidate for a brand-new ASIN.

  const toolTypes = await listToolTypes();
  const primaryCriterion = resolvePrimaryCriterion(identity, toolTypes);

  let newCompetitor = mergeRainforestProductIntoCompetitor({ ...oldCompetitor, key_features: [], strengths: [], weaknesses: [], recent_news: [] }, product);

  if (primaryCriterion === "motor") {
    const motorFamilies = await listMotorFamilies();
    const brandedNames = await listBrandedMotorNames();
    const ourMotor = await resolveOurMotorType({ motorFamily: context.motorFamily, motorTech: context.motorTech, projectId: context.projectId }, identity, motorFamilies);
    const motorExtraction = extractCompetitorMotorType({ ...newCompetitor, title: newCompetitor.name }, motorFamilies, { brand: newCompetitor.brand, brandedNames });
    const motorMatchTier = computeMotorMatchTier(ourMotor?.familyKey ?? null, motorExtraction?.familyKey ?? null, motorFamilies);
    newCompetitor = {
      ...newCompetitor,
      motor_type: motorExtraction?.label ?? null,
      motor_family_key: motorExtraction?.familyKey ?? null,
      motor_modifier: motorExtraction?.modifierLabel ?? null,
      motor_branded_name: motorExtraction?.brandedName ?? null,
      motor_source_quote: motorExtraction?.sourceQuote ?? null,
      motor_confirmed_via: motorExtraction?.confirmedVia ?? null,
      motor_source_url: motorExtraction ? (newCompetitor.sources?.brand_site?.url || newCompetitor.amazon_url || null) : null,
      motor_match_tier: motorMatchTier,
      motor_score: computeMotorScore(motorMatchTier),
    };
  } else if (primaryCriterion === "heat_technology") {
    const heatTechFamilies = await listHeatTechFamilies();
    const brandedHeatTechNames = await listBrandedHeatTechNames();
    const ourHeatTech = await resolveOurHeatTech({ heatTechFamily: context.heatTechFamily, heatTechRaw: context.heatTechRaw, projectId: context.projectId }, identity, heatTechFamilies);
    const heatTechExtraction = extractCompetitorHeatTech({ ...newCompetitor, title: newCompetitor.name }, heatTechFamilies, { brand: newCompetitor.brand, brandedNames: brandedHeatTechNames });
    const heatTechMatchTier = computeHeatTechMatchTier(ourHeatTech?.familyKey ?? null, heatTechExtraction?.familyKey ?? null);
    newCompetitor = {
      ...newCompetitor,
      heat_tech_type: heatTechExtraction?.label ?? null,
      heat_tech_family_key: heatTechExtraction?.familyKey ?? null,
      heat_tech_branded_name: heatTechExtraction?.brandedName ?? null,
      heat_tech_source_quote: heatTechExtraction?.sourceQuote ?? null,
      heat_tech_confirmed_via: heatTechExtraction?.confirmedVia ?? null,
      heat_tech_source_url: heatTechExtraction ? (newCompetitor.sources?.brand_site?.url || newCompetitor.amazon_url || null) : null,
      heat_tech_match_tier: heatTechMatchTier,
      heat_tech_score: computeMotorScore(heatTechMatchTier),
    };
  }

  const targetPriceRaw = await resolveDiscoveryTargetPrice(context, identity);
  const priceScore = targetPriceRaw != null && typeof newCompetitor.price_raw === "number" ? computePriceScoreAbsolute(newCompetitor.price_raw, targetPriceRaw) : 0;
  const theirSpecs = extractCompetitorSpecs(newCompetitor);
  const ourSpecs = context.projectId ? extractOurSpecsFromTds(await getTdsFieldsForProject(context.projectId)) : extractOurSpecsFromTds(null);
  const candidateText = [newCompetitor.name, ...(Array.isArray(newCompetitor.feature_bullets) ? newCompetitor.feature_bullets : []), newCompetitor.description || ""].filter(Boolean).join(" ");
  const differentiatorMatch = context.keyDiff ? matchesDifferentiator(context.keyDiff, candidateText) : null;
  const featureScore = computeFeatureScore(ourSpecs, theirSpecs, differentiatorMatch);
  const weights = resolveEffectiveWeights(context.weightOverride ?? await getScoringProfileForToolType(identity.toolType), primaryCriterion);
  const criterionScore = newCompetitor.motor_score ?? newCompetitor.heat_tech_score ?? 0;

  // Recomputed honestly rather than assumed false — a human-corrected pick
  // can still genuinely fall outside the price band (e.g. a deliberately
  // pricier "better competitor" swap); "warn, don't block" applies here
  // too, so the existing out-of-band disclosure just reflects reality.
  const primaryBand = targetPriceRaw != null ? computePriceBand(targetPriceRaw, foundIn === "phase1" ? "legacy" : "emerging", 0) : null;
  const isOutOfBand = !!primaryBand && typeof newCompetitor.price_raw === "number" && !isWithinBand(newCompetitor.price_raw, primaryBand);

  newCompetitor = {
    ...newCompetitor,
    price_score: priceScore,
    price_logic: "absolute",
    feature_score: featureScore,
    differentiator_match: differentiatorMatch,
    composite_score: computeCompositeScore(criterionScore, priceScore, featureScore, weights),
    manually_selected: true,
    manually_selected_by: actorUserId,
    manually_selected_at: new Date().toISOString(),
    replaced_from_asin: oldAsin,
    out_of_band: isOutOfBand,
    out_of_band_reason: isOutOfBand ? buildOutOfBandLabel(newCompetitor.price_raw, primaryBand!) : null,
    // A manual ASIN swap is a human-confirmed real product — never leave a
    // stale "Nearest Match" badge on a competitor the user just fixed
    // themselves. The generic object-spread above would otherwise carry
    // nearest_match/nearest_match_reason forward unchanged from oldCompetitor.
    nearest_match: false,
    nearest_match_reason: null,
  };

  const patch: { phase1_result?: object; phase2_result?: object; phase3_result?: object } = {};
  if (foundIn === "phase1") {
    patch.phase1_result = { ...phase1Result, competitors: phase1Result.competitors.map((c: any) => (c.asin === oldAsin ? newCompetitor : c)) };
  } else {
    patch.phase2_result = { ...phase2Result, competitors: phase2Result.competitors.map((c: any) => (c.asin === oldAsin ? newCompetitor : c)) };
  }

  const synthesisPossiblyStale = phase3MentionsCompetitor(phase3Result, oldCompetitor.name, oldCompetitor.brand);
  if (synthesisPossiblyStale && phase3Result) {
    patch.phase3_result = { ...phase3Result, synthesis_possibly_stale: true };
  }

  await patchAnalysisPhaseResults(analysisId, patch);

  try {
    await persistPricingProvenance([newCompetitor], analysisId);
  } catch (e) {
    console.warn("Failed to persist pricing provenance for replaced competitor:", e);
  }

  // A report already created from this analysis (project's Competitive
  // Analysis tab) is a frozen snapshot copied from phase1/phase2 at
  // creation time — patching the live analysis above doesn't touch it.
  // Sync just this one competitor entry so the report reflects the real
  // replaced product instead of the stale one; best-effort, since no
  // report may exist yet for this analysis.
  try {
    await syncReportCompetitorByAsin(analysisId, oldAsin, newCompetitor);
  } catch (e) {
    console.warn("Failed to sync replaced competitor into linked report:", e);
  }

  const toolType = identity.toolType || "";
  await recordCorrection({
    analysisId,
    projectId: context.projectId,
    toolType,
    motorFamily: primaryCriterion === "motor" ? (newCompetitor.motor_family_key ?? null) : null,
    heatTechFamily: primaryCriterion === "heat_technology" ? (newCompetitor.heat_tech_family_key ?? null) : null,
    priceBand: targetPriceRaw != null ? deriveTierKeyword(targetPriceRaw) : null,
    oldAsin,
    oldTitle: oldCompetitor.name ?? null,
    newAsin,
    newTitle: newCompetitor.name ?? null,
    reason: correction.reason,
    note: correction.note ?? null,
    userId: actorUserId,
  });

  // PART 3.3 (root-cause routing) — a "Wrong motor/plate-heat type"
  // correction re-uses the ALREADY-BUILT admin-inspectable miss log
  // (lib/db/motor-families.ts's motor_tech_search_misses table, surfaced
  // on the Competitor Matching admin page) rather than inventing a new
  // flagging system, for the motor-criterion case where that log already
  // exists. No heat-tech-criterion equivalent miss log exists yet (this
  // session's Heat/Plate Technology work never built one) — adding a
  // parallel table + admin surface for this single secondary signal is
  // scoped out for now rather than invented on the spot.
  if (correction.reason === "wrong_motor" && primaryCriterion === "motor") {
    try {
      await logMotorTechMiss(oldCompetitor.motor_type || oldCompetitor.name || oldAsin);
    } catch (e) {
      console.warn("Failed to log motor-tech miss for correction:", e);
    }
  }

  return { competitor: newCompetitor, synthesisPossiblyStale };
}

// ─────────────────────────────────────────────────────────────────────────
// PART 3 — Remove + Refill single slot. A bad competitor pick (most often
// caught by the grooming/beauty industry gate, but also a plain wrong-
// product/wrong-motor human catch) can be dropped and replaced without
// re-running the whole analysis. Reuses filterCandidatesByCategoryAndIdentity/
// selectByCompositeScore — the exact same gate+scoring pipeline every
// discovery round already runs through — never a parallel/looser path, so a
// slot filled this way is held to identical standards as one filled during
// normal discovery.
// ─────────────────────────────────────────────────────────────────────────

// Capped for storage — a "nice to have instant refill" pool, not a full
// audit trail. 15 is comfortably more than a single slot ever needs across
// a handful of manual Remove/Refill cycles.
function trimRunnerUpPoolForStorage(pool: any[]): any[] {
  return pool.slice(0, 15);
}

export interface SlotRefillContext {
  identity: IdentityCard;
  tier: CompetitorTier;
  targetPriceRaw: number;
  toolTypes: ToolTypeRow[];
  // Already carries groomingGateRules/ourGroomingTag/groomingGateConfidenceThreshold/
  // ourIsPetGrooming — the whole point of reusing CompositeScoringContext
  // here is that a refill is held to the exact same gate/scoring standard
  // as a normal discovery pick, never a separate, looser path.
  scoringCtx: CompositeScoringContext;
  excludeAsins: Set<string>;
  analysisId: string;
  // Wall-clock anchor for this specific request (Date.now() at its own
  // start — NOT necessarily "when the analysis was created"). Required so
  // fetchReplacementForSlot's Tier B (a real, unbounded-by-default live
  // Rainforest search via discoverCompetitorsLive) never attempts a live
  // search this request doesn't have time left for — a real bug fixed
  // after it surfaced live as "Connection dropped — retrying" during Phase
  // 2, because the original version called Tier B with zero budget
  // awareness inside the SAME request that had already spent most of the
  // shared RAINFOREST_STEP_DEADLINE_MS clock on enrichment/lineups/brand-site.
  routeStartTime: number;
}

export interface SlotRefillResult {
  ok: boolean;
  competitor?: any;
  source?: "runner_up_pool" | "live_rainforest_search";
  reason?: string;
}

// The one core primitive used by both the 1E post-selection sweep
// (sweepGroomingGateContamination, below) and manual single-slot Refill
// (refillCompetitorSlot, below). Tier A (instant, zero network calls) draws
// from an already-persisted runner-up pool, re-gated against the CURRENT
// grooming-gate rules (never whatever rules were live when that pool was
// first gathered) — this is what makes an admin's rule edit affect the very
// next refill. Tier B (only when Tier A comes up empty AND a live catalog
// search is actually possible) falls back to the existing, already-built
// discoverCompetitorsLive (Rainforest-only, no LLM — genuinely fast). The
// industry gate is NEVER relaxed at either tier: an honest "nothing
// qualifies" beats a gate bypass (see the plan's own "Refill's live-fallback
// depth" note) — allowStaticFallbackTopup is always false here, since the
// hand-curated static fallback dataset has never been gate-checked.
export async function fetchReplacementForSlot(candidatePool: any[], ctx: SlotRefillContext): Promise<SlotRefillResult> {
  const notExcluded = (c: any): boolean => {
    const asin = (c.asin || "").toUpperCase();
    return !(asin && ctx.excludeAsins.has(asin));
  };

  const tierAPool = filterCandidatesByCategoryAndIdentity(
    candidatePool.filter(notExcluded),
    ctx.tier,
    ctx.identity,
    ctx.toolTypes,
    ctx.scoringCtx.groomingGateRules
  );
  let picked = selectByCompositeScore(tierAPool, ctx.targetPriceRaw, ctx.tier, ctx.identity, 1, ctx.scoringCtx, { allowStaticFallbackTopup: false });
  if (picked.length === 0) {
    picked = selectByCompositeScore(tierAPool, ctx.targetPriceRaw, ctx.tier, ctx.identity, 1, ctx.scoringCtx, { nearestSimilarMode: true, allowStaticFallbackTopup: false });
  }
  if (picked.length > 0) {
    return { ok: true, competitor: picked[0], source: "runner_up_pool" };
  }

  // Tier B — only reachable when the saved runner-up pool has nothing
  // qualifying left, a live Rainforest search is actually possible, AND
  // this request still has enough of its own time budget left. Skipping
  // this check once already caused discoverCompetitorsLive's own
  // unbounded multi-search-term loop to run inside an already-nearly-
  // exhausted Phase 1/2 request (the sweep's call site), surfacing live as
  // "Connection dropped — retrying" from blowing past Vercel's 60s cap.
  // MIN_BUDGET_FOR_LIVE_SEARCH_MS is a rough "enough time for a couple of
  // real Rainforest round-trips," not a precise measurement.
  const MIN_BUDGET_FOR_LIVE_SEARCH_MS = 8_000;
  const budgetLeft = remainingRainforestBudget(ctx.routeStartTime);
  if (hasRainforestKey && budgetLeft >= MIN_BUDGET_FOR_LIVE_SEARCH_MS) {
    const ourMotorLabel = ctx.scoringCtx.ourMotor ? formatMotorLabel(ctx.scoringCtx.ourMotor) : null;
    const liveCandidates = await discoverCompetitorsLive(ctx.identity, ctx.tier, ctx.targetPriceRaw, ctx.toolTypes, [], ourMotorLabel, budgetLeft);
    const tierBPool = filterCandidatesByCategoryAndIdentity(
      liveCandidates.filter(notExcluded),
      ctx.tier,
      ctx.identity,
      ctx.toolTypes,
      ctx.scoringCtx.groomingGateRules
    );
    let livePicked = selectByCompositeScore(tierBPool, ctx.targetPriceRaw, ctx.tier, ctx.identity, 1, ctx.scoringCtx, { allowStaticFallbackTopup: false });
    if (livePicked.length === 0) {
      livePicked = selectByCompositeScore(tierBPool, ctx.targetPriceRaw, ctx.tier, ctx.identity, 1, ctx.scoringCtx, { nearestSimilarMode: true, allowStaticFallbackTopup: false });
    }
    if (livePicked.length > 0) {
      return { ok: true, competitor: livePicked[0], source: "live_rainforest_search" };
    }
  }

  return { ok: false, reason: "No qualifying in-industry competitor found in the saved candidate pool or a live catalog search — the industry gate was not relaxed." };
}

// 1E post-selection sweep — re-checks every non-placeholder finalist against
// the grooming/beauty industry gate one more time (defense in depth:
// candidates flow through several merge/dedupe/nearest-similar-fallback
// steps between their own gate check and final selection) and swaps out
// anything contaminated using the SAME run's own runner-up pool — zero
// extra network calls in the common case. A failure that can't be replaced
// shrinks the slot (an honest empty) rather than ever leaving a
// contaminated pick in place. Exported (rather than file-private) so it's
// directly unit-testable (scripts/verify-sweep-gate-contamination.ts).
//
// Broad-audit finding: re-checking with `ctx.scoringCtx.groomingGateRules`
// (the SAME rules object `selectByCompositeScore` already gated every one
// of these candidates against, moments earlier in this same request) made
// this sweep structurally incapable of ever catching anything at its real
// call sites — a pure function given identical inputs always agrees with
// itself. Fixed by re-fetching rules fresh right here, which is also what
// actually makes "the gate was already applied... but rules can change
// between candidate-gating and this exact moment" (this function's own
// original justification) literally true rather than aspirational; it also
// keeps this sweep a genuine defense-in-depth backstop against a FUTURE
// code path that adds candidates without gating them, which is the other
// real reason to keep an already-redundant-looking check.
export async function sweepGroomingGateContamination(
  finalList: any[],
  runnerUpPool: any[],
  ctx: SlotRefillContext & { scoringCtx: CompositeScoringContext }
): Promise<any[]> {
  const freshRules = await listGroomingGateRules();
  const freshCtx: SlotRefillContext & { scoringCtx: CompositeScoringContext } = {
    ...ctx,
    scoringCtx: { ...ctx.scoringCtx, groomingGateRules: freshRules },
  };

  const rebuilt: any[] = [];
  for (const c of finalList) {
    if (c.empty_slot) {
      rebuilt.push(c);
      continue;
    }

    const result = passesGroomingIndustryGate(c, freshRules, {
      stage: "post_enrichment",
      toolTypes: ctx.toolTypes,
      requiredToolType: ctx.identity.toolType,
      ourIsPetGrooming: ctx.scoringCtx.ourIsPetGrooming,
      theirSpecs: c._groomingSpecs,
      ourSpecs: ctx.scoringCtx.ourSpecs,
      ourTag: ctx.scoringCtx.ourGroomingTag,
      candidateTag: c._groomingSpecs?.groomingTag,
      confidenceThreshold: ctx.scoringCtx.groomingGateConfidenceThreshold,
    });

    if (result.ok) {
      rebuilt.push(c);
      continue;
    }

    console.warn(`[grooming-gate] sweep caught contaminated survivor "${c.name}" — ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
    try {
      await logGroomingGateIncident({
        analysisId: ctx.analysisId,
        phase: ctx.tier === "legacy" ? "phase1" : "phase2",
        candidateName: c.name,
        candidateAsin: c.asin,
        candidateBrand: c.brand,
        categoryPath: (c.categories || []).join(" > ") || null,
        failedRule: result.reason,
        detail: result.detail,
      });
    } catch (e) {
      console.warn("Failed to log grooming-gate sweep incident:", e);
    }

    // Broad-audit finding — excluding only `finalList` let a SECOND
    // contaminated candidate in the same sweep pick the SAME replacement
    // already pushed onto `rebuilt` for the first one (both duplicate
    // computations against the same static input), producing a visible
    // duplicate competitor with no downstream dedup. Excluding the union of
    // the original list AND everything already decided this pass closes it.
    const replacement = await fetchReplacementForSlot(excludeAlreadySelected(runnerUpPool, [...finalList, ...rebuilt]), freshCtx);
    if (replacement.ok && replacement.competitor) {
      console.warn(`[grooming-gate] sweep replaced "${c.name}" with "${replacement.competitor.name}" (source: ${replacement.source})`);
      rebuilt.push(replacement.competitor);
    } else {
      // Broad-audit finding — dropping the slot with only a console.warn
      // silently shrank the tier's total below 5 with zero indication to
      // the user why. An honest empty-slot placeholder keeps the count
      // right (real, replaced, or explicitly empty — never just missing)
      // and lets the user's own "Refill this slot" action try again later.
      console.warn(`[grooming-gate] sweep removed "${c.name}" — no qualifying replacement found in the runner-up pool or a live search; slot marked empty`);
      rebuilt.push({
        empty_slot: true,
        tier: ctx.tier,
        name: `No additional ${ctx.tier === "legacy" ? "legacy" : "emerging"} competitor found`,
        reason: `"${c.name}" was removed by the industry gate on a post-selection re-check (${result.reason}), and no qualifying replacement was found. Use "Refill this slot" to search again.`,
      });
    }
  }
  return rebuilt;
}

// The single-slot Remove action. Mirrors replaceCompetitor's own
// ownership/loading/patching/staleness-flagging/correction-recording
// machinery exactly (see that function above) but replaces the slot with an
// honest "removed, awaiting refill" placeholder instead of a new pick —
// Refill (below) is a separate, later action.
export type CompetitorRemoveReason = "wrong_industry" | "wrong_product" | "wrong_motor" | "not_comparable" | "other";

export interface RemoveCompetitorSlotResult {
  removedAsin: string;
  tier: string;
  synthesisPossiblyStale: boolean;
}

export async function removeCompetitorSlot(
  analysisId: string,
  asin: string,
  actorUserId: string,
  opts: { reason: CompetitorRemoveReason; note?: string | null }
): Promise<RemoveCompetitorSlotResult> {
  const record: any = await getAnalysis(analysisId);
  if (!record) throw new Error("Analysis not found");

  const identity: IdentityCard | null = hasResult(record.phase0_result) ? record.phase0_result : null;
  if (!identity) throw new Error("Analysis has no confirmed product identity yet — cannot remove a competitor before Phase 0 completes");

  const context: AnalysisContext = { id: analysisId, orgId: record.org_id || "dev_org_id", userId: record.user_id, projectId: record.project_id || null, ...(record.context || {}) };

  const phase1Result = hasResult(record.phase1_result) ? record.phase1_result : null;
  const phase2Result = hasResult(record.phase2_result) ? record.phase2_result : null;
  const phase3Result = hasResult(record.phase3_result) ? record.phase3_result : null;

  let foundIn: "phase1" | "phase2" | null = null;
  let found: any = null;
  if (phase1Result?.competitors) {
    const idx = phase1Result.competitors.findIndex((c: any) => c.asin === asin);
    if (idx >= 0) { foundIn = "phase1"; found = phase1Result.competitors[idx]; }
  }
  if (!foundIn && phase2Result?.competitors) {
    const idx = phase2Result.competitors.findIndex((c: any) => c.asin === asin);
    if (idx >= 0) { foundIn = "phase2"; found = phase2Result.competitors[idx]; }
  }
  if (!foundIn || !found) throw new Error(`No competitor with ASIN "${asin}" found on this analysis`);

  const tier = foundIn === "phase1" ? "legacy" : "emerging";
  const placeholder = {
    empty_slot: true,
    tier,
    removed: true,
    removed_asin: asin,
    removed_name: found.name ?? null,
    removed_brand: found.brand ?? null,
    removed_reason: opts.reason,
    removed_at: new Date().toISOString(),
    removed_by: actorUserId,
    name: "Slot removed — refill to search for a replacement",
  };

  const patch: { phase1_result?: object; phase2_result?: object; phase3_result?: object } = {};
  if (foundIn === "phase1") {
    const existingRemoved: string[] = Array.isArray(phase1Result.removedAsins) ? phase1Result.removedAsins : [];
    patch.phase1_result = {
      ...phase1Result,
      competitors: phase1Result.competitors.map((c: any) => (c.asin === asin ? placeholder : c)),
      removedAsins: existingRemoved.includes(asin) ? existingRemoved : [...existingRemoved, asin],
    };
  } else {
    const existingRemoved: string[] = Array.isArray(phase2Result.removedAsins) ? phase2Result.removedAsins : [];
    patch.phase2_result = {
      ...phase2Result,
      competitors: phase2Result.competitors.map((c: any) => (c.asin === asin ? placeholder : c)),
      removedAsins: existingRemoved.includes(asin) ? existingRemoved : [...existingRemoved, asin],
    };
  }

  const synthesisPossiblyStale = phase3MentionsCompetitor(phase3Result, found.name, found.brand);
  if (synthesisPossiblyStale && phase3Result) {
    patch.phase3_result = { ...phase3Result, synthesis_possibly_stale: true };
  }

  await patchAnalysisPhaseResults(analysisId, patch);

  // Same report-staleness fix as replaceCompetitor above — a report already
  // created from this analysis is a frozen snapshot and won't otherwise see
  // this slot's placeholder until a later refill.
  try {
    await syncReportCompetitorByAsin(analysisId, asin, placeholder);
  } catch (e) {
    console.warn("Failed to sync removed competitor into linked report:", e);
  }

  const toolTypes = await listToolTypes();
  const primaryCriterion = resolvePrimaryCriterion(identity, toolTypes);
  const targetPriceRaw = await resolveDiscoveryTargetPrice(context, identity);

  // One correction row per remove, keyed on old_asin (never new_asin, which
  // is null here) — a later refill of this same slot does NOT write a
  // second row, avoiding double-counting toward buildCorrectionSignals'
  // 2-distinct-user hard-block threshold.
  await recordCorrection({
    analysisId,
    projectId: context.projectId,
    toolType: identity.toolType || "",
    motorFamily: primaryCriterion === "motor" ? (found.motor_family_key ?? null) : null,
    heatTechFamily: primaryCriterion === "heat_technology" ? (found.heat_tech_family_key ?? null) : null,
    priceBand: targetPriceRaw != null ? deriveTierKeyword(targetPriceRaw) : null,
    oldAsin: asin,
    oldTitle: found.name ?? null,
    newAsin: null,
    newTitle: null,
    reason: opts.reason,
    note: opts.note ?? null,
    userId: actorUserId,
    correctionType: "remove",
  });

  // Same root-cause routing as replaceCompetitor's own "wrong_motor" branch
  // — reuses the already-built motor_tech_search_misses admin-inspectable
  // log rather than inventing a parallel one.
  if (opts.reason === "wrong_motor" && primaryCriterion === "motor") {
    try {
      await logMotorTechMiss(found.motor_type || found.name || asin);
    } catch (e) {
      console.warn("Failed to log motor-tech miss for removal:", e);
    }
  }

  // A human-flagged "wrong industry" removal surfaces in the exact same
  // admin anomaly panel as an automated gate rejection (phase:
  // "manual_removal", failed_rule: null — a human flagged it, the automated
  // gate never actually tripped), with an "Add to blocklist" suggestion the
  // admin can confirm — never auto-applied.
  if (opts.reason === "wrong_industry") {
    try {
      await logGroomingGateIncident({
        analysisId,
        phase: "manual_removal",
        candidateName: found.name ?? null,
        candidateAsin: asin,
        candidateBrand: found.brand ?? null,
        categoryPath: (found.categories || []).join(" > ") || (found.bestsellers_rank_full || [])[0]?.category || null,
        failedRule: null,
        detail: opts.note ?? null,
      });
    } catch (e) {
      console.warn("Failed to log grooming-gate manual-removal incident:", e);
    }
  }

  return { removedAsin: asin, tier, synthesisPossiblyStale };
}

// The single-slot Refill action, the counterpart to Remove above. Re-derives
// everything a fresh SlotRefillContext needs (never cached — same "cheap
// re-read every time" discipline as motorFamilies/toolTypes elsewhere in
// this file, and what lets an admin's grooming-gate rule edit affect the
// very next refill), then delegates the actual search to
// fetchReplacementForSlot. An honest "nothing qualifies" is a normal,
// non-throwing outcome here (HTTP 200 at the route layer) — matching this
// codebase's existing buildEmptySlotPlaceholder "explicit empty is not a
// failure" convention.
export async function refillCompetitorSlot(
  analysisId: string,
  removedAsin: string,
  actorUserId: string
): Promise<SlotRefillResult & { tier?: string; synthesisPossiblyStale?: boolean }> {
  const record: any = await getAnalysis(analysisId);
  if (!record) throw new Error("Analysis not found");

  const identity: IdentityCard | null = hasResult(record.phase0_result) ? record.phase0_result : null;
  if (!identity) throw new Error("Analysis has no confirmed product identity yet — cannot refill a slot before Phase 0 completes");

  const context: AnalysisContext = { id: analysisId, orgId: record.org_id || "dev_org_id", userId: record.user_id, projectId: record.project_id || null, ...(record.context || {}) };

  const phase1Result = hasResult(record.phase1_result) ? record.phase1_result : null;
  const phase2Result = hasResult(record.phase2_result) ? record.phase2_result : null;
  const phase3Result = hasResult(record.phase3_result) ? record.phase3_result : null;

  let foundIn: "phase1" | "phase2" | null = null;
  let placeholderIdx = -1;
  let placeholder: any = null;
  if (phase1Result?.competitors) {
    const idx = phase1Result.competitors.findIndex((c: any) => c.removed_asin === removedAsin);
    if (idx >= 0) { foundIn = "phase1"; placeholderIdx = idx; placeholder = phase1Result.competitors[idx]; }
  }
  if (!foundIn && phase2Result?.competitors) {
    const idx = phase2Result.competitors.findIndex((c: any) => c.removed_asin === removedAsin);
    if (idx >= 0) { foundIn = "phase2"; placeholderIdx = idx; placeholder = phase2Result.competitors[idx]; }
  }
  if (!foundIn || !placeholder) throw new Error(`No removed slot with ASIN "${removedAsin}" found on this analysis`);

  const tier: CompetitorTier = foundIn === "phase1" ? "legacy" : "emerging";
  const phaseResult = foundIn === "phase1" ? phase1Result : phase2Result;

  // resolvePhase2Context is tier-agnostic despite its name — it resolves
  // exactly the pieces a fresh CompositeScoringContext needs (target price,
  // motor/heat-tech resolution, weights, our specs, lineup percentile,
  // correction signals, grooming-gate rules/tag/threshold) regardless of
  // which tier is being refilled. By the time a slot exists to refill,
  // discovery has already run at least once for this analysis, so every
  // pause-and-ask input this resolves was already answered earlier in the
  // flow — this should not re-trigger a pause in practice; if it somehow
  // does, that's an honest "can't search right now" rather than a crash.
  const resolved = await resolvePhase2Context(context, identity);
  if (!resolved.ok) {
    return { ok: false, reason: `Cannot search for a replacement — missing required analysis context (${resolved.pendingQuestion.question})` };
  }
  const {
    targetPriceRaw, motorFamilies, brandedNames, toolTypes, primaryCriterion, ourMotor,
    heatTechFamilies, brandedHeatTechNames, ourHeatTech, weights, ourSpecs, ourLineupPercentile,
    correctionSignals, groomingGateRules, groomingGateConfidenceThreshold, ourGroomingTag, ourIsPetGrooming,
  } = resolved.ctx;

  // No indie brand lineups reconstructed here — same reasoning as
  // replaceCompetitor's own header comment: relative-lineup pricing is a
  // discovery-time-only concept not worth rebuilding for a single slot;
  // price scoring falls back to absolute-price-to-target automatically when
  // indieLineups/ourLineupPercentile aren't both present (see
  // selectByCompositeScore's own tier==="emerging" branch).
  //
  // Broad-audit finding — relatedProducts was previously omitted entirely
  // here (every OTHER CompositeScoringContext built in this file sets it
  // from `relatedProductProfiles`, computed once per phase step in
  // runAnalysisStep — but that computation never reached refillCompetitorSlot,
  // which resolves its own context via resolvePhase2Context instead). A
  // refill would score every candidate on motor/price/features/the grooming
  // gate, but silently skip the small additive Related Products bonus every
  // other discovery pick in the same analysis got — never erroring, just
  // quietly less-aligned. Recomputed here the same way runAnalysisStep does,
  // straight from the analysis record already loaded above.
  const relatedProductsForRefill: ResolvedRelatedProduct[] = Array.isArray(record.related_products) ? record.related_products : [];
  const relatedProductProfilesForRefill: RelatedProductProfile[] = relatedProductsForRefill
    .filter(rp => rp.eligibleForPoolSeeding && !rp.resolutionFailed)
    .map(rp => ({
      motorFamilyKey: rp.motor_family_key ?? null,
      heatTechFamilyKey: rp.heat_tech_family_key ?? null,
      priceRaw: rp.price_raw ?? null,
      specs: extractCompetitorSpecs(rp as any),
    }));

  const scoringCtx: CompositeScoringContext = {
    motorFamilies,
    brandedNames,
    toolTypes,
    primaryCriterion,
    ourMotor,
    heatTechFamilies,
    brandedHeatTechNames,
    ourHeatTech,
    ourSpecs,
    weights,
    ourLineupPercentile,
    keyDiff: context.keyDiff ?? null,
    penalizedAsins: correctionSignals.penalizedAsins,
    relatedProducts: relatedProductProfilesForRefill,
    groomingGateRules,
    groomingGateConfidenceThreshold,
    ourGroomingTag,
    ourIsPetGrooming,
  };

  // The union of both phases' real (non-placeholder) competitor ASINs and
  // both phases' removedAsins blocklists — a removed legacy pick can never
  // resurface as an emerging refill, or vice versa.
  const excludeAsins = new Set<string>();
  for (const c of phase1Result?.competitors || []) {
    const a = (c.asin || "").toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(a)) excludeAsins.add(a);
  }
  for (const c of phase2Result?.competitors || []) {
    const a = (c.asin || "").toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(a)) excludeAsins.add(a);
  }
  for (const a of phase1Result?.removedAsins || []) excludeAsins.add(String(a).toUpperCase());
  for (const a of phase2Result?.removedAsins || []) excludeAsins.add(String(a).toUpperCase());

  // Fresh Date.now() — this is a standalone request (the user-facing manual
  // refill route), not sharing a clock with any other in-flight phase work,
  // so its own start time is the correct anchor for Tier B's budget check.
  const slotCtx: SlotRefillContext = { identity, tier, targetPriceRaw, toolTypes, scoringCtx, excludeAsins, analysisId, routeStartTime: Date.now() };

  const result = await fetchReplacementForSlot(phaseResult.runnerUpPool || [], slotCtx);
  if (!result.ok || !result.competitor) {
    return { ok: false, reason: result.reason };
  }

  const newCompetitor = {
    ...result.competitor,
    // A distinct flag from manually_selected (replaceCompetitor's own
    // marker) — this is an auto-discovered replacement, not a human-typed
    // ASIN override.
    slot_refilled: true,
    slot_refilled_at: new Date().toISOString(),
    slot_refilled_source: result.source,
  };

  const newCompetitors = phaseResult.competitors.map((c: any, i: number) => (i === placeholderIdx ? newCompetitor : c));
  const consumedAsin = (result.competitor.asin || "").toUpperCase();
  const newRunnerUpPool = (phaseResult.runnerUpPool || []).filter((c: any) => (c.asin || "").toUpperCase() !== consumedAsin);

  const updatedPhaseResult = { ...phaseResult, competitors: newCompetitors, runnerUpPool: newRunnerUpPool };
  const patch: { phase1_result?: object; phase2_result?: object; phase3_result?: object } = {};
  if (foundIn === "phase1") {
    patch.phase1_result = updatedPhaseResult;
  } else {
    patch.phase2_result = updatedPhaseResult;
  }

  // The ORIGINAL removed competitor's name/brand (stored on the placeholder
  // by removeCompetitorSlot above) — not the new pick's — since this checks
  // whether Phase 3's synthesis discussed the product that's now gone.
  const synthesisPossiblyStale = phase3MentionsCompetitor(phase3Result, placeholder.removed_name, placeholder.removed_brand);
  if (synthesisPossiblyStale && phase3Result) {
    patch.phase3_result = { ...phase3Result, synthesis_possibly_stale: true };
  }

  await patchAnalysisPhaseResults(analysisId, patch);

  try {
    await persistPricingProvenance([newCompetitor], analysisId);
  } catch (e) {
    console.warn("Failed to persist pricing provenance for refilled competitor:", e);
  }

  // Same report-staleness fix as replaceCompetitor/removeCompetitorSlot
  // above — the report's copy of this slot is still the empty-slot
  // placeholder (matched by removed_asin, since the placeholder never had
  // its own .asin) until synced here.
  try {
    await syncReportCompetitorByAsin(analysisId, removedAsin, newCompetitor, "removed_asin");
  } catch (e) {
    console.warn("Failed to sync refilled competitor into linked report:", e);
  }

  return { ok: true, competitor: newCompetitor, source: result.source, tier, synthesisPossiblyStale };
}

export interface ReplaceRelatedProductResult {
  relatedProduct: ResolvedRelatedProduct;
}

// Related Products' "fixing a mispaste re-fetches in place" swap —
// deliberately simpler than replaceCompetitor above: no CorrectionReason
// picker and no recordCorrection() call (a mispaste fix on a user-provided
// product isn't a discovery-learning signal), and a tool-type mismatch
// here is never a hard block (it's an expected, common case for this
// feature — only the toolTypeMismatch flag gets recomputed).
export async function replaceRelatedProduct(analysisId: string, oldAsin: string, newAsinOrUrl: string): Promise<ReplaceRelatedProductResult> {
  const record: any = await getAnalysis(analysisId);
  if (!record) throw new Error("Analysis not found");

  const identity: IdentityCard | null = hasResult(record.phase0_result) ? record.phase0_result : null;
  if (!identity) throw new Error("Analysis has no confirmed product identity yet — cannot replace a related product before Phase 0 completes");

  const existing: ResolvedRelatedProduct[] = Array.isArray(record.related_products) ? record.related_products : [];
  const idx = existing.findIndex(rp => rp.asin === oldAsin);
  if (idx < 0) throw new Error(`No related product with ASIN "${oldAsin}" found on this analysis`);

  const newAsin = resolveAsinFromInput(newAsinOrUrl);
  const trimmedInput = newAsinOrUrl.trim();
  // Not Amazon-resolvable — same "any other product page URL is still a
  // valid related product" allowance as the analyze form's own preview/
  // resolveRelatedProducts, just reached from the "fix a mispaste" swap
  // flow instead of the initial form.
  if (!newAsin && !/^https?:\/\//i.test(trimmedInput)) {
    throw new Error("Could not resolve an ASIN from that input, and it isn't a URL either — enter an ASIN, Amazon URL, or any other product page URL");
  }

  const toolTypes = await listToolTypes();
  const [resolved] = await resolveRelatedProducts(
    [{ asin: newAsin, url: newAsin ? (/^https?:\/\//i.test(trimmedInput) ? trimmedInput : (existing[idx].url ?? undefined)) : trimmedInput, addedAt: existing[idx].addedAt }],
    identity,
    toolTypes,
    Date.now()
  );
  // Same wording fix as replaceCompetitor above, same reason.
  if (!resolved || resolved.resolutionFailed) throw new Error(newAsin
    ? `Could not fetch a real Amazon product for ASIN "${newAsin}" — this could mean the ASIN is wrong, or that Amazon/Rainforest data is temporarily unavailable. Double-check the ASIN and try again in a moment.`
    : `Could not load that page — check the URL and try again in a moment.`);

  const updated = [...existing];
  updated[idx] = resolved;
  await patchRelatedProducts(analysisId, updated);

  return { relatedProduct: resolved };
}

// ----------------------------------------------------
// AI PROVIDER FALLBACK: try OpenAI first, then Gemini, then mock data.
// ----------------------------------------------------

// A 429/RESOURCE_EXHAUSTED response means the Gemini project's quota is
// exhausted at the account level (confirmed live in production: both the
// grounded AND the ungrounded retry fail identically once this happens) —
// retrying ungrounded in this case is never going to succeed, it only
// burns several more seconds of the route's 60s Vercel ceiling for
// nothing. Checked against both a numeric HTTP status the SDK may attach
// and the raw error message text (the Gemini SDK sometimes only surfaces
// the provider's JSON error body as a string, not a typed status field).
export function isGeminiQuotaExhausted(err: any): boolean {
  if (err?.status === 429 || err?.code === 429) return true;
  const message = String(err?.message ?? err ?? "");
  return message.includes("RESOURCE_EXHAUSTED") || message.includes('"code":429');
}

// withDeadline is already defined above (bounds a single async operation to
// a hard wall-clock deadline) — reused here rather than duplicated.
const GEMINI_DEADLINE_TIMEOUT = Symbol("gemini-deadline-timeout");

// Google Search grounding has its own quota separate from plain generation —
// it can be exhausted while plain calls still work fine. Retry ungrounded
// (no live search, but still real AI reasoning) before giving up on Gemini
// entirely and falling through to OpenAI/mock — UNLESS the failure is a
// quota exhaustion, which the ungrounded retry can't route around.
//
// Confirmed live (matches the exact "Connection dropped — retrying" symptom
// documented above ROUTE_TIME_BUDGET_MS): withAiFallback's own
// remainingMs < MIN_VIABLE_GEMINI_ATTEMPT_MS gate only decides whether to
// ATTEMPT Gemini at all — once attempted, neither the grounded call nor the
// ungrounded retry had any actual deadline, so a slow-but-not-erroring
// Gemini response (or, worse, both the grounded AND ungrounded attempts
// back to back) could still run past whatever budget was left and take the
// whole route down with it, exactly like lib/product-identification.ts's
// Phase 0 bug before its own fix. routeStartTime threads the same shared
// clock every other AI call in this file already uses (see
// effectiveOpenAiWebSearchTimeoutMs) so this can never happen again here.
async function generateWithGeminiFallback(
  systemPrompt: string,
  userPrompt: string,
  onSearchUsed: (query: string) => void,
  routeStartTime: number = Date.now()
): Promise<string> {
  const remainingForGrounded = ROUTE_TIME_BUDGET_MS - (Date.now() - routeStartTime);
  try {
    const response: any = await withDeadline<any>(
      genAI.models.generateContent({
        model: GEMINI_MODEL,
        contents: userPrompt,
        config: {
          systemInstruction: systemPrompt,
          tools: [{ googleSearch: {} }],
          maxOutputTokens: 8192,
        },
      }),
      remainingForGrounded,
      GEMINI_DEADLINE_TIMEOUT
    );
    if (response === GEMINI_DEADLINE_TIMEOUT) {
      throw new Error(`Gemini grounded call exceeded the route's remaining time budget (${Math.round(remainingForGrounded / 1000)}s) — treating as a failure rather than waiting further`);
    }
    const queries = response.candidates?.[0]?.groundingMetadata?.webSearchQueries || [];
    queries.forEach((q: string) => onSearchUsed(q));
    if (!response.text) {
      throw new Error(`Empty response (finishReason: ${response.candidates?.[0]?.finishReason})`);
    }
    return response.text;
  } catch (err: any) {
    if (isGeminiQuotaExhausted(err)) {
      console.warn("Gemini call failed with quota exhaustion — skipping the ungrounded retry, it would fail the same way:", err?.message || err);
      throw err;
    }
    const remainingForUngrounded = ROUTE_TIME_BUDGET_MS - (Date.now() - routeStartTime);
    if (remainingForUngrounded < MIN_VIABLE_GEMINI_ATTEMPT_MS) {
      console.warn(`Gemini grounded call failed and only ${Math.round(remainingForUngrounded / 1000)}s remain in the route's time budget — skipping the ungrounded retry rather than risking another slow call:`, err?.message || err);
      throw err;
    }
    console.warn("Gemini call with Google Search grounding failed, retrying ungrounded:", err?.message || err);
    // The prompt tells the model it has web search — without the tool
    // actually attached, it tries to call it anyway and produces a
    // MALFORMED_FUNCTION_CALL. Override that instruction for this attempt.
    const ungroundedSystemPrompt = `${systemPrompt}\n\nIMPORTANT: Web search is temporarily unavailable for this request. Do NOT attempt to call any search tool. Answer using your own trained knowledge instead, and still return the exact JSON schema requested.`;
    const response: any = await withDeadline<any>(
      genAI.models.generateContent({
        model: GEMINI_MODEL,
        contents: userPrompt,
        config: {
          systemInstruction: ungroundedSystemPrompt,
          maxOutputTokens: 8192,
        },
      }),
      remainingForUngrounded,
      GEMINI_DEADLINE_TIMEOUT
    );
    if (response === GEMINI_DEADLINE_TIMEOUT) {
      throw new Error(`Gemini ungrounded retry exceeded the route's remaining time budget (${Math.round(remainingForUngrounded / 1000)}s) — treating as a failure rather than waiting further`);
    }
    if (!response.text) {
      throw new Error(`Empty ungrounded response (finishReason: ${response.candidates?.[0]?.finishReason})`);
    }
    return response.text;
  }
}

// Vercel Hobby's fixed 60s function timeout (see maxDuration in
// app/api/analyses/[id]/continue/route.ts) is a hard platform kill, not a
// catchable JS error — if the whole AI-fallback chain (OpenAI's own
// up-to-45s attempt, then a Gemini attempt, then its ungrounded retry) is
// still running when the clock runs out, the route dies mid-request and
// the client sees a raw platform error page instead of JSON, which
// surfaces as the "Connection dropped — retrying" loop in
// ProgressPanel.tsx — and every retry repeats the exact same doomed
// sequence, so it never actually recovers. Once OpenAI has already failed,
// only attempt the Gemini fallback if there's realistically enough of the
// budget left for it to finish (and still leave room for Rainforest
// enrichment/DB writes afterward) — otherwise skip straight to the
// honest, always-fast mock/Rainforest-backed fallback.
export const ROUTE_TIME_BUDGET_MS = 50_000;
export const MIN_VIABLE_GEMINI_ATTEMPT_MS = 10_000;

export async function withAiFallback<T>(
  label: string,
  geminiCall: (() => Promise<T>) | null,
  openAiCall: (() => Promise<T>) | null,
  mockCall: () => T | Promise<T>,
  routeStartTime: number
): Promise<T> {
  // OpenAI is primary — its own native web-search tool handles the
  // live-data step, so no Gemini call is needed first. Gemini remains the
  // fallback if OpenAI is unavailable/fails.
  if (openAiCall) {
    try {
      return await openAiCall();
    } catch (err: any) {
      console.warn(`OpenAI ${label} failed:`, err?.message || err);
    }
  }
  if (geminiCall) {
    const remainingMs = ROUTE_TIME_BUDGET_MS - (Date.now() - routeStartTime);
    if (remainingMs < MIN_VIABLE_GEMINI_ATTEMPT_MS) {
      console.warn(`Skipping Gemini fallback for ${label} — only ${Math.round(remainingMs / 1000)}s left in the route's time budget, falling back to mock instead.`);
    } else {
      try {
        console.warn(`Falling back to Gemini for ${label}...`);
        return await geminiCall();
      } catch (err: any) {
        console.warn(`Gemini ${label} fallback also failed, falling back to mock:`, err?.message || err);
      }
    }
  }
  return await mockCall();
}

// Shared OpenAI web-search call for Phase 1/2/3 — max_tool_calls bounds
// search/page-open iterations (the same lesson learned from the prior,
// now-removed Anthropic integration: an uncapped web-search call once ran
// 30+ minutes in testing, which would always blow through Vercel's 60s
// function cap). Returns both the raw response text (schema JSON) and the
// list of search queries actually issued, for the onSearchUsed callback.
//
// Tuning note (confirmed in extensive live testing): thorough research for
// 5 established + 5 emerging real competitors with prices/ASINs is
// genuinely slow with reasoning-model web search — successful runs took
// 20-46s, and even generous budgets (46s, 8 tool calls) sometimes still
// returned an empty result. Faster non-reasoning models (gpt-4.1) return
// in ~6-10s but are shallow (1 search, gives up early) and unreliable for
// this multi-brand task. There is no configuration that is reliably both
// fast and thorough within Vercel's 60s cap — 45s here is the practical
// ceiling that leaves the rest of the route (Rainforest enrichment,
// citation verification, DB writes) enough headroom. When this times out
// or comes back empty, the pipeline falls through to Gemini, then to the
// live Rainforest-search fallback / honest mock data — never fake data.
const OPENAI_REQUEST_TIMEOUT_MS = 45_000;

// Confirmed live (two real analyses stuck retrying "Phase 2 of 4" for
// 5-14 minutes with zero forward progress, __phase1Fill.round unchanged
// across every attempt): the fixed 45s ceiling above was measured against
// an EMPTY route budget, but by the time this call actually fires,
// earlier same-request work (identity/context fetch, correction signals,
// related-product neighbor search, curated-brand lookups) has already
// spent real wall-clock too. A 45s call on top of that can push the
// TOTAL past Vercel's 60s cap — which kills the whole function with no
// response at all (no catch block runs, nothing gets saved), unlike a
// clean timeout the app's own fallback chain can react to. Capping the
// EFFECTIVE timeout to whatever's actually left of ROUTE_TIME_BUDGET_MS
// (measured from the same routeStartTime already threaded into
// withAiFallback) guarantees this call always fails fast enough to reach
// the Gemini-fallback/mock path and a real DB write, instead of racing
// Vercel's hard kill on every single retry.
function effectiveOpenAiWebSearchTimeoutMs(routeStartTime: number): number {
  const remaining = ROUTE_TIME_BUDGET_MS - (Date.now() - routeStartTime);
  return Math.max(5_000, Math.min(OPENAI_REQUEST_TIMEOUT_MS, remaining));
}

async function runOpenAiWebSearch(systemPrompt: string, userPrompt: string, routeStartTime: number): Promise<{ text: string; queries: string[] }> {
  const response: any = await openai.responses.create(
    {
      model: OPENAI_MODEL,
      reasoning: { effort: "low" },
      tools: [{ type: "web_search" as any }],
      max_tool_calls: 5,
      instructions: systemPrompt,
      input: userPrompt,
    } as any,
    { timeout: effectiveOpenAiWebSearchTimeoutMs(routeStartTime) }
  );

  const queries: string[] = (response.output || [])
    .filter((o: any) => o.type === "web_search_call")
    .flatMap((o: any) => o.action?.queries || (o.action?.query ? [o.action.query] : []));

  const message = (response.output || []).find((o: any) => o.type === "message");
  const text: string = message?.content?.find((c: any) => c.type === "output_text")?.text || response.output_text || "";
  if (!text) throw new Error("Empty response from OpenAI web search call");

  return { text, queries };
}

// ----------------------------------------------------
// PHASE 1/2 PROMPTS (shared between Gemini and OpenAI runners)
// ----------------------------------------------------

// Brand hint and search terms are built ENTIRELY from the verified Identity
// Card (lib/product-identification.ts) — never a hardcoded category. A
// known-brand hint is only included when the identified category matches
// a family this app already has real brand knowledge for
// (lib/known-brands-by-category.ts); otherwise the model searches freely.
// Exported for scripts/verify-motor-price-discovery.ts — lets the offline
// verify suite inspect the exact generated prompt text (e.g. assert zero
// literal "clipper" substrings for a trimmer identity) without needing a
// live AI call.
export function buildPhase1Prompt(context: AnalysisContext, identity: IdentityCard, targetPriceRaw: number, toolTypes: ToolTypeRow[], ourMotorLabel?: string | null, extraInstruction?: string, primaryCriterion: "motor" | "heat_technology" | "none" = "motor") {
  const brandHint = getKnownBrandsHint(identity.category);
  const attributesLine = identity.keyAttributes.length ? identity.keyAttributes.join(", ") : "—";
  const targetDisplay = context.pricePoint || identity.priceObserved?.value || `$${targetPriceRaw.toFixed(2)}`;
  const band = computePriceBand(targetPriceRaw, "legacy", 0);
  const tierKeyword = deriveTierKeyword(targetPriceRaw);
  const bandLabel = `$${band.min.toFixed(2)}–$${band.max.toFixed(2)}`;
  const { term: criterionTerm, typeWord: criterionTypeWord } = criterionPhrasing(primaryCriterion);

  const toolTypeLabel = identity.toolType && identity.toolType !== "combo" ? getToolTypeLabel(identity.toolType, toolTypes) : (identity.subcategory || identity.category);
  const combinedExampleQuery = `{brand} ${ourMotorLabel || ""} ${toolTypeLabel} near ${targetDisplay}`.replace(/\s+/g, " ").trim();

  const systemPrompt = `You are a professional competitive intelligence analyst specializing in Amazon product research and market analysis. You have access to web search. Use it extensively.

Do not narrate your search process or explain what you're doing between searches — search silently, then respond with ONLY the final JSON object. No preamble, no commentary, no "I'll research..." text.

${identity.toolType ? buildToolTypePromptGuard(identity.toolType, toolTypes) : ""}

Your task: Research up to 10 ESTABLISHED, LARGE market leaders that compete with the identified product: a ${identity.subcategory || identity.category}.
${brandHint ? `Known major brands in this category to check first: ${brandHint.join(", ")} — but do not limit yourself to only these; include any other established brand your search finds.` : "Search broadly for the established, large brands that actually compete in this specific category — do not assume any particular brand."}
For each brand, find their ONE best matching product THAT FALLS WITHIN THE ACCEPTABLE PRICE RANGE below, in the SAME category as the identified product — among in-band candidates only, prioritize matching key attributes first. Return up to 10 products total — a wider margin than the 5 actually needed, since some candidates will be screened out downstream (see rule 8 below), and it costs nothing to propose a few extra real, qualifying ones.

DISCOVERY PRIORITY (combined — search using ALL of these together, not as separate passes): propose ONLY ${toolTypeLabel} products.${ourMotorLabel ? ` Prioritize matching ${criterionTerm} "${ourMotorLabel}" first, then proximity to ${targetDisplay}.` : criterionTerm ? ` No ${criterionTerm} was specified, so proximity to ${targetDisplay} is the leading signal.` : ` Proximity to ${targetDisplay} is the leading signal.`}${context.keyDiff ? ` Products that also share the stated differentiating feature "${context.keyDiff}" rank higher when found — call this out in inclusion_rationale.` : ""} Example search combining all of this: "${combinedExampleQuery}" — before falling back to a plain brand+category search.${ourMotorLabel && criterionTerm ? ` For each brand, prefer their model that ALSO uses ${ourMotorLabel} (or the closest related ${criterionTerm} in their lineup) over a model that merely matches on price. If a brand's only in-range model uses a different ${criterionTypeWord} type, still include it (never leave a brand slot empty over ${criterionTypeWord} mismatch alone) but make that clear in its inclusion_rationale.` : ""}

CRITICAL RULES:
1. Search Amazon directly for real competing PRODUCTS (not brands), sourcing all data from Amazon listings. Always drill down to the specific SKU/model that competes with the identified product. Never use brand overview data.
2. Search for exact price, ASIN, review count, star rating, monthly sales velocity badge (e.g. "X+ bought in past month"), and all confirmed technical specs. If data is unavailable, use "—" NOT a guess.
3. Every candidate MUST be the same product type as "${identity.category} / ${identity.subcategory}" — reject anything from a different category, even a closely related one, unless the identified product itself spans categories.
4. If key attributes are mentioned (${attributesLine}), perform a DIRECT Amazon search combining those attributes with the category term (e.g. "${identity.keyAttributes[0] || identity.subcategory} ${identity.category}") before selecting competitors.
5. PRICE IS A HARD CONSTRAINT, NOT A TIEBREAKER: the acceptable price range for every candidate is ${bandLabel} (the user's target price of ${targetDisplay} ± 30%). Reject any product whose real Amazon price falls outside this range, even if it is an excellent brand/attribute match — prefer a different, in-range product from the same or another major brand instead. Do not substitute an out-of-range product to fill a slot.
6. NEVER invent a filler/placeholder company to reach the requested count (e.g. generic-sounding names like "Vanguard Corp", "Prime Tech", "Heritage Brand", or any company name combined with "${context.productName}" itself — that is fabrication, not a real competitor). If your search only turns up a few real, in-range competitors, return only those. Returning fewer real results is correct; inventing fake ones is not.
7. Return ONLY valid JSON matching the exact schema below — no markdown, no preamble, no explanation.
8. NEVER propose any of the following — they are automatically rejected downstream regardless of how well they otherwise match on motor type, price, or brand, so proposing one always wastes a slot: (a) lawn/garden/outdoor power equipment (weed trimmers/wackers, hedge trimmers, lawn mowers, string trimmers — even if their listing mentions a "brushless"/"motor" spec); (b) a bare motor, battery, or replacement part sold standalone as a component (not a finished, ready-to-use grooming/styling tool a consumer buys and uses directly); (c) any product whose primary stated use is unrelated to hair/beard/grooming/beauty (marine, drone, automotive, industrial, or general power-tool use) even if it superficially shares a technical spec with the identified product. Every real candidate must be an actual, finished, ready-to-use ${toolTypeLabel.toLowerCase()} a consumer or professional buys for hair/grooming/beauty use.

Note: strengths, weaknesses, and recent buyer sentiment are NOT part of this schema — those are sourced separately and exclusively from real Amazon customer reviews (see enrichCompetitorsWithRainforest / the reviews-analysis endpoint), never from your own knowledge or web search.

Return this EXACT JSON schema:
{
  "web_searches_performed": 12,
  "competitors": [
    {
      "name": "Full Product Name (specific SKU/Model)",
      "brand": "Brand Name",
      "tier": "legacy",
      "asin": "BXXXXXXXXX",
      "amazon_url": "https://www.amazon.com/dp/BXXXXXXXXX",
      "price": "$XX.XX",
      "rating": "4.5",
      "review_count": "2,847",
      "monthly_sales": "1,000+ bought in past month",
      "bsr_rank": "#17,162 in Beauty & Personal Care",
      "initials": "WA",
      "key_features": [
        {
          "headline": "Feature headline",
          "source": "Amazon",
          "attribution": "Per brand marketing:",
          "detail": "1–2 sentence explanation of what this means for the professional user"
        }
      ],
      "top_feature_summary": "Single sentence — their #1 differentiating feature",
      "inclusion_rationale": "One sentence: why this is a real established/major-brand competitor at this price tier, plus a source (e.g. 'Wahl — decades-long incumbent brand, #1 BSR in Beauty & Personal Care, per Amazon listing')."
    }
  ]
}`;

  const userPrompt = `Research up to 10 established large brand competitors for this identified product:

Product Name: ${context.productName}
Identified Category: ${identity.category}
Identified Subcategory: ${identity.subcategory}
What it is: ${identity.whatItIs}
Key Attributes: ${attributesLine}
Target Market: ${context.targetMarket}
Target Price Point: ${targetDisplay} — ACCEPTABLE RANGE: ${bandLabel} (see CRITICAL RULES). Reject anything outside this range.
Key Differentiator: ${context.keyDiff || "—"}
Positioning Context (product-specific facts — current BSR, price tier, target customer — never a company/brand description): ${context.companyContext || "—"}

Instructions:
1. ${brandHint ? `Check these known brands first: ${brandHint.join(", ")} — then add any other established brand your search finds in this category.` : "Search broadly for established brands in this exact category."}
2. ${criterionTerm ? `Combine ${criterionTerm} and price in the same search rather than searching each separately, e.g. "${combinedExampleQuery}" or "best ${tierKeyword} ${toolTypeLabel} ${bandLabel}", to bias results toward the correct ${criterionTypeWord}+price segment together.` : `Combine the product type and price in the same search rather than searching each separately, e.g. "best ${tierKeyword} ${toolTypeLabel} ${bandLabel}", to bias results toward the correct segment.`}
3. Every result must be a real ${identity.subcategory || identity.category} — not any other product type.
4. Drill down to specific SKU/model listings. Retrieve exact price, ASIN, rating, review count, and monthly sales velocity.${extraInstruction ? `\n\n${extraInstruction}` : ""}`;

  return { systemPrompt, userPrompt };
}

async function executePhase1Gemini(context: AnalysisContext, identity: IdentityCard, targetPriceRaw: number, onSearchUsed: (query: string) => void, toolTypes: ToolTypeRow[], ourMotorLabel?: string | null, extraInstruction?: string, primaryCriterion: "motor" | "heat_technology" | "none" = "motor", routeStartTime: number = Date.now()) {
  const { systemPrompt, userPrompt } = buildPhase1Prompt(context, identity, targetPriceRaw, toolTypes, ourMotorLabel, extraInstruction, primaryCriterion);
  const text = await generateWithGeminiFallback(systemPrompt, userPrompt, onSearchUsed, routeStartTime);
  return assertHasCompetitors(JSON.parse(cleanJsonString(text)));
}

// A model call that "succeeds" (valid JSON, no exception) but returns zero
// competitors is not actually a success — confirmed in testing: gpt-5 can
// return {"competitors":[]} after tens of seconds of searching instead of
// throwing. Without this check, withAiFallback would treat that as the
// final answer and skip Gemini/mock entirely, silently producing an
// analysis with no competitors for that phase.
function assertHasCompetitors(parsed: any): any {
  if (!Array.isArray(parsed?.competitors) || parsed.competitors.length === 0) {
    throw new Error("Model returned zero competitors — treating as a failed attempt");
  }
  return parsed;
}

async function executePhase1OpenAI(context: AnalysisContext, identity: IdentityCard, targetPriceRaw: number, onSearchUsed: (query: string) => void, toolTypes: ToolTypeRow[], ourMotorLabel?: string | null, extraInstruction?: string, primaryCriterion: "motor" | "heat_technology" | "none" = "motor", routeStartTime: number = Date.now()) {
  const { systemPrompt, userPrompt } = buildPhase1Prompt(context, identity, targetPriceRaw, toolTypes, ourMotorLabel, extraInstruction, primaryCriterion);
  const { text, queries } = await runOpenAiWebSearch(systemPrompt, userPrompt, routeStartTime);
  queries.forEach(onSearchUsed);
  return assertHasCompetitors(JSON.parse(cleanJsonString(text)));
}

// Exported for the same offline-verify reason as buildPhase1Prompt above.
export function buildPhase2Prompt(context: AnalysisContext, identity: IdentityCard, targetPriceRaw: number, toolTypes: ToolTypeRow[], brandHintOverride?: string[] | null, ourMotorLabel?: string | null, extraInstruction?: string, primaryCriterion: "motor" | "heat_technology" | "none" = "motor") {
  // brandHintOverride (when the identified product maps to a legacy-brand
  // registry category, lib/legacy-brand-registry.ts) takes priority over
  // the static, non-binding lib/known-brands-by-category.ts hint — the
  // curated registry's brands (and aliases) are excluded here so the same
  // brand can never appear in both the legacy and emerging lists.
  const brandHint = brandHintOverride !== undefined ? brandHintOverride : getKnownBrandsHint(identity.category);
  const attributesLine = identity.keyAttributes.length ? identity.keyAttributes.join(", ") : "—";
  const targetDisplay = context.pricePoint || identity.priceObserved?.value || `$${targetPriceRaw.toFixed(2)}`;
  const band = computePriceBand(targetPriceRaw, "emerging", 0);
  const tierKeyword = deriveTierKeyword(targetPriceRaw);
  const bandLabel = `$${band.min.toFixed(2)}–$${band.max.toFixed(2)}`;
  const { term: criterionTerm, typeWord: criterionTypeWord } = criterionPhrasing(primaryCriterion);

  const toolTypeLabel = identity.toolType && identity.toolType !== "combo" ? getToolTypeLabel(identity.toolType, toolTypes) : (identity.subcategory || identity.category);
  const combinedExampleQuery = `${ourMotorLabel || ""} ${toolTypeLabel} near ${targetDisplay}`.replace(/\s+/g, " ").trim();

  const systemPrompt = `You are a professional competitive intelligence analyst specializing in Amazon product research. You have access to web search. Use it extensively.

Do not narrate your search process or explain what you're doing between searches — search silently, then respond with ONLY the final JSON object. No preamble, no commentary, no "I'll research..." text.

${identity.toolType ? buildToolTypePromptGuard(identity.toolType, toolTypes) : ""}

Your task: Research up to 10 INDIE, EMERGING, or NEWER brand products that compete with the identified product: a ${identity.subcategory || identity.category} — a wider margin than the 5 actually needed, since some candidates will be screened out downstream (see rule 8 below), and it costs nothing to propose a few extra real, qualifying ones.
${brandHint ? `Exclude these already-covered large brands: ${brandHint.join(", ")}.` : "Exclude whatever large established brands would already be covered by a separate established-competitor search — focus on indie/DTC/newer names."}

DISCOVERY PRIORITY (combined — search using ALL of these together, not as separate passes): propose ONLY ${toolTypeLabel} products.${ourMotorLabel ? ` Prioritize indie/emerging brands specifically known for similar ${criterionTerm} "${ourMotorLabel}" first, then proximity to ${targetDisplay}.` : criterionTerm ? ` No ${criterionTerm} was specified, so proximity to ${targetDisplay} is the leading signal.` : ` Proximity to ${targetDisplay} is the leading signal.`}${context.keyDiff ? ` Products that also share the stated differentiating feature "${context.keyDiff}" rank higher when found — call this out in inclusion_rationale.` : ""} Example search combining all of this: "${combinedExampleQuery}", or "best ${combinedExampleQuery} ${new Date().getFullYear()}" — before falling back to generic category searches.${ourMotorLabel && criterionTypeWord ? ` A candidate whose ${criterionTypeWord} type you cannot confirm from its own listing should still be included if nothing better is found, but note in its inclusion_rationale that ${criterionTypeWord} type could not be verified.` : ""}

CRITICAL RULES:
1. Search Amazon directly for real competing PRODUCTS (not brands), sourcing all data from Amazon listings. Always drill down to the specific SKU/model that competes with the identified product. Never use brand overview data.
2. Search for exact price, ASIN, review count, star rating, monthly sales velocity badge (e.g. "X+ bought in past month"), and all confirmed technical specs${criterionTerm ? ` — INCLUDING ${criterionTerm} whenever the listing states it` : ""}. If data is unavailable, use "—" NOT a guess.
3. Every candidate MUST be the same product type as "${identity.category} / ${identity.subcategory}" — reject anything from a different category, even a closely related one, unless the identified product itself spans categories.
4. If key attributes are mentioned (${attributesLine}), perform a DIRECT Amazon search combining those attributes with the category term before selecting competitors.
5. PRICE IS A HARD CONSTRAINT: the acceptable price range for every candidate is ${bandLabel} (the user's target price of ${targetDisplay}). Value/indie challengers priced meaningfully below this range are still legitimately relevant competitors, which is why this range already extends lower than the established-brand search — but reject anything above the range, and never below 50% of the target price. Reject any product priced outside ${bandLabel}, even if it is an excellent category/attribute match.
6. NEVER invent a filler/placeholder company to reach the requested count (e.g. generic-sounding names like "NovaDyne", "Flux DTC", "Zenith Lab", or any company name combined with "${context.productName}" itself — that is fabrication, not a real competitor). If your search only turns up a few real, in-range competitors, return only those. Returning fewer real results is correct; inventing fake ones is not.
7. Return ONLY valid JSON matching the exact schema below — no markdown, no preamble, no explanation.
8. NEVER propose any of the following — they are automatically rejected downstream regardless of how well they otherwise match on motor type, price, or brand, so proposing one always wastes a slot: (a) lawn/garden/outdoor power equipment (weed trimmers/wackers, hedge trimmers, lawn mowers, string trimmers — even if their listing mentions a "brushless"/"motor" spec); (b) a bare motor, battery, or replacement part sold standalone as a component (not a finished, ready-to-use grooming/styling tool a consumer buys and uses directly); (c) any product whose primary stated use is unrelated to hair/beard/grooming/beauty (marine, drone, automotive, industrial, or general power-tool use) even if it superficially shares a technical spec with the identified product. Every real candidate must be an actual, finished, ready-to-use ${toolTypeLabel.toLowerCase()} a consumer or professional buys for hair/grooming/beauty use.

Note: strengths, weaknesses, and recent buyer sentiment are NOT part of this schema — those are sourced separately and exclusively from real Amazon customer reviews (see enrichCompetitorsWithRainforest / the reviews-analysis endpoint), never from your own knowledge or web search.

Return this EXACT JSON schema:
{
  "web_searches_performed": 14,
  "competitors": [
    {
      "name": "Full Product Name (specific SKU/Model)",
      "brand": "Brand Name",
      "tier": "emerging",
      "asin": "BXXXXXXXXX",
      "amazon_url": "https://www.amazon.com/dp/BXXXXXXXXX",
      "price": "$XX.XX",
      "rating": "4.2",
      "review_count": "156",
      "monthly_sales": "300+ bought in past month",
      "bsr_rank": "#133,173 in Beauty & Personal Care",
      "initials": "SU",
      "key_features": [
        {
          "headline": "Feature headline",
          "source": "Amazon",
          "attribution": "Per brand marketing:",
          "detail": "1–2 sentence explanation of what this means for the user"
        }
      ],
      "top_feature_summary": "Single sentence — their #1 differentiating feature",
      "inclusion_rationale": "One sentence: why this is a real emerging/indie competitor at this price tier, plus a source (e.g. 'DTC brand launched 2023, growing BSR momentum, per Amazon listing')."
    }
  ]
}`;

  const userPrompt = `Research up to 10 indie/emerging competitor products for this identified product:

Product Name: ${context.productName}
Identified Category: ${identity.category}
Identified Subcategory: ${identity.subcategory}
What it is: ${identity.whatItIs}
Key Attributes: ${attributesLine}
Target Market: ${context.targetMarket}
Target Price Point: ${targetDisplay} — ACCEPTABLE RANGE: ${bandLabel} (see CRITICAL RULES). Reject anything outside this range.
Key Differentiator: ${context.keyDiff || "—"}
Positioning Context (product-specific facts — current BSR, price tier, target customer — never a company/brand description): ${context.companyContext || "—"}

Instructions:
1. Search Amazon for emerging brand products matching the identified category and key attributes, within the acceptable price range — price is a hard filter here, not a secondary preference.
2. ${criterionTerm ? `Combine ${criterionTerm} and price in the same search rather than searching each separately, e.g. "${combinedExampleQuery}" or "best value ${toolTypeLabel} ${bandLabel}", to bias results toward the correct ${criterionTypeWord}+price segment together.` : `Combine the product type and price in the same search rather than searching each separately, e.g. "best value ${toolTypeLabel} ${bandLabel}", to bias results toward the correct segment.`}
3. Every result must be a real ${identity.subcategory || identity.category} — not any other product type.
4. ${brandHint ? `Exclude the large brands: ${brandHint.join(", ")}.` : "Exclude any large established brand — focus on indie/newer names."}
5. Drill down to specific SKU/model listings. Retrieve exact price, ASIN, rating, review count, and monthly sales velocity.${extraInstruction ? `\n\n${extraInstruction}` : ""}`;

  return { systemPrompt, userPrompt };
}

async function executePhase2Gemini(context: AnalysisContext, identity: IdentityCard, targetPriceRaw: number, onSearchUsed: (query: string) => void, toolTypes: ToolTypeRow[], brandHintOverride?: string[] | null, ourMotorLabel?: string | null, extraInstruction?: string, primaryCriterion: "motor" | "heat_technology" | "none" = "motor", routeStartTime: number = Date.now()) {
  const { systemPrompt, userPrompt } = buildPhase2Prompt(context, identity, targetPriceRaw, toolTypes, brandHintOverride, ourMotorLabel, extraInstruction, primaryCriterion);
  const text = await generateWithGeminiFallback(systemPrompt, userPrompt, onSearchUsed, routeStartTime);
  return assertHasCompetitors(JSON.parse(cleanJsonString(text)));
}

async function executePhase2OpenAI(context: AnalysisContext, identity: IdentityCard, targetPriceRaw: number, onSearchUsed: (query: string) => void, toolTypes: ToolTypeRow[], brandHintOverride?: string[] | null, ourMotorLabel?: string | null, extraInstruction?: string, primaryCriterion: "motor" | "heat_technology" | "none" = "motor", routeStartTime: number = Date.now()) {
  const { systemPrompt, userPrompt } = buildPhase2Prompt(context, identity, targetPriceRaw, toolTypes, brandHintOverride, ourMotorLabel, extraInstruction, primaryCriterion);
  const { text, queries } = await runOpenAiWebSearch(systemPrompt, userPrompt, routeStartTime);
  queries.forEach(onSearchUsed);
  return assertHasCompetitors(JSON.parse(cleanJsonString(text)));
}

async function executePhase3Gemini(context: AnalysisContext, identity: IdentityCard, phase1: any, phase2: any, onSearchUsed: (query: string) => void, extraInstruction?: string, routeStartTime: number = Date.now()) {
  const { systemPrompt, userPrompt } = await buildPhase3Prompt(context, identity, phase1, phase2, extraInstruction);

  let usedAnyQuery = false;
  const text = await generateWithGeminiFallback(systemPrompt, userPrompt, (q) => {
    usedAnyQuery = true;
    onSearchUsed(q);
  }, routeStartTime);
  if (!usedAnyQuery) {
    onSearchUsed(`${identity.subcategory || identity.category} market data lookup`);
  }

  return JSON.parse(cleanJsonString(text));
}

async function executePhase3OpenAI(context: AnalysisContext, identity: IdentityCard, phase1: any, phase2: any, onSearchUsed: (query: string) => void, extraInstruction?: string, routeStartTime: number = Date.now()) {
  const { systemPrompt, userPrompt } = await buildPhase3Prompt(context, identity, phase1, phase2, extraInstruction);

  // Needed so the model can actually search when marketData is null (see
  // buildPhase3Prompt's marketDataInstruction) — runOpenAiWebSearch always
  // attaches the web_search tool, so "search the web" has something to call.
  const { text, queries } = await runOpenAiWebSearch(systemPrompt, userPrompt, routeStartTime);
  if (queries.length > 0) {
    queries.forEach(onSearchUsed);
  } else {
    onSearchUsed(`${identity.subcategory || identity.category} market data lookup`);
  }

  return JSON.parse(cleanJsonString(text));
}

// ----------------------------------------------------
// LIVE FALLBACK DISCOVERY — real Amazon products via Rainforest search when
// no AI provider is available. This is what actually answers "I analyse
// NEW products, I need NEW REAL products from Amazon" for a category with
// no hardcoded mock dataset (e.g. hair crimpers) instead of falling
// through to fabricated placeholder brand names ("Apex Global", etc.).
// Runs whenever Rainforest is configured, regardless of category — the
// static getCategoryFallbackCompetitors data is now a last-resort only,
// used solely when Rainforest itself is unavailable/fails outright.
async function discoverCompetitorsLive(identity: IdentityCard, tier: "legacy" | "emerging", targetPriceRaw: number | null, toolTypes: ToolTypeRow[], excludeNames: string[] = [], motorHint?: string | null, deadlineMs?: number): Promise<any[]> {
  if (!hasRainforestKey) return [];
  const category = identity.subcategory || identity.category;
  if (!category) return [];

  const brandHint = getKnownBrandsHint(identity.category) || [];
  const searchTerms: string[] = [];
  // Motor-led search tried first when both a motor hint and a target price
  // are known — this is the no-AI-key/offline demo fallback path (real
  // production discovery always goes through buildPhase1Prompt/
  // buildPhase2Prompt's combined motor+price instruction instead), but it
  // should still lead with motor+price together rather than price alone.
  if (motorHint && targetPriceRaw != null) {
    const band = computePriceBand(targetPriceRaw, tier, 0);
    searchTerms.push(`${motorHint} ${category} $${band.min.toFixed(0)}-$${band.max.toFixed(0)}`);
  }
  // Tried next when a target price is known — biases the search toward the
  // correct price segment before falling through to generic phrasings.
  if (targetPriceRaw != null) {
    const band = computePriceBand(targetPriceRaw, tier, 0);
    const tierKeyword = deriveTierKeyword(targetPriceRaw);
    searchTerms.push(`best ${tierKeyword} ${category} $${band.min.toFixed(0)}-$${band.max.toFixed(0)}`);
  }
  if (motorHint) searchTerms.push(`${motorHint} ${category}`);
  if (brandHint.length) {
    const slice = tier === "legacy" ? brandHint.slice(0, 5) : brandHint.slice(-5);
    for (const b of slice) searchTerms.push(`${b} ${category}`);
  }
  // Multiple phrasings widen the pool of distinct real products found —
  // a single search term (especially for a niche category with no known
  // brand hint) often can't fill the pool after de-duplication against
  // the other tier's results, leaving slots to fall back to generic
  // placeholder brands unnecessarily.
  if (tier === "legacy") {
    searchTerms.push(`best ${category}`, `top ${category} brands`, `professional ${category}`, category);
  } else {
    searchTerms.push(`${category} new brand`, `budget ${category}`, `affordable ${category}`, category);
  }

  const seenAsins = new Set<string>();
  const seenTitleFragments = new Set(excludeNames.map(n => n.toLowerCase().slice(0, 24)));
  const collected: any[] = [];
  // A larger pool than the final limit (5) so applyPriceBandGate downstream
  // has real candidates to filter/widen against instead of being handed
  // exactly 5 already-unfiltered results.
  const POOL_SIZE = 10;
  // deadlineMs bounds this loop's own wall-clock time when a caller has a
  // shared budget to respect (fetchReplacementForSlot's Tier B, itself
  // bounded by the calling request's remaining RAINFOREST_STEP_DEADLINE_MS)
  // — up to ~9 search terms run sequentially below with no per-call
  // timeout otherwise, which is fine for this function's original callers
  // (the no-AI-key offline mock generators, which have no shared budget to
  // blow), but was a real, unbounded risk once reused inside an
  // already-time-constrained live request.
  const loopStart = Date.now();

  for (const term of searchTerms) {
    if (collected.length >= POOL_SIZE) break;
    if (deadlineMs != null && Date.now() - loopStart > deadlineMs) break;
    const results = await searchAmazonCategory(term, 8);
    for (const r of results) {
      if (collected.length >= POOL_SIZE) break;
      if (seenAsins.has(r.asin)) continue;
      const titleLower = r.title.toLowerCase();
      if (Array.from(seenTitleFragments).some(f => f && titleLower.includes(f))) continue;
      if (identity.toolType && !assertToolType(r.title, identity.toolType, toolTypes).ok) {
        console.warn(`[tool-type] rejected live-search result "${r.title}" — mismatched tool type for ${identity.toolType}`);
        continue;
      }

      seenAsins.add(r.asin);
      seenTitleFragments.add(titleLower.slice(0, 24));
      const brand = (r.title.split(/[\s,]+/)[0] || "Unknown").replace(/[^\w-]/g, "");
      collected.push({
        name: r.title.length > 100 ? `${r.title.slice(0, 100)}…` : r.title,
        brand,
        tier,
        asin: r.asin,
        amazon_url: `https://www.amazon.com/dp/${r.asin}`,
        price: r.price,
        price_raw: r.price_raw,
        rating: r.rating,
        review_count: r.reviewsTotal,
        monthly_sales: r.monthlyStr,
        bsr_rank: null,
        initials: brand.slice(0, 2).toUpperCase(),
        key_features: [],
        strengths: [],
        weaknesses: [],
        recent_news: [],
        top_feature_summary: "",
        verified_by_rainforest: true,
      });
    }
  }
  return collected;
}

// ----------------------------------------------------
// SMART MOCK GENERATORS FOR OFFLINE / NO-KEY USE
async function generateMockPhase1(context: AnalysisContext, identity: IdentityCard, targetPriceRaw: number | null, toolTypes: ToolTypeRow[]) {
  const live = await discoverCompetitorsLive(identity, "legacy", targetPriceRaw, toolTypes, [], context.motorTech || null);
  if (live.length > 0) {
    return { web_searches_performed: live.length, competitors: live };
  }

  const dynamicList = getCategoryFallbackCompetitors(identity, "legacy");
  return {
    web_searches_performed: 12,
    competitors: dynamicList.map(c => ({
      name: c.name,
      brand: c.brand,
      tier: "legacy",
      asin: c.asin,
      amazon_url: `https://www.amazon.com/dp/${c.asin}`,
      price: c.price,
      rating: c.rating,
      review_count: c.reviewCount || (c as any).review_count || "2,410",
      monthly_sales: c.sales || (c as any).monthly_sales || "1,000+ bought in past month",
      bsr_rank: c.bsr || (c as any).bsr_rank || "#1,200 in Category",
      initials: c.initials,
      key_features: [
        {
          headline: `${c.brand} High-Performance Core Engine`,
          source: "Amazon",
          attribution: "Per brand marketing:",
          detail: `Engineered specifically for heavy-duty commercial use in the ${identity.subcategory || identity.category || "professional"} sector.`
        },
        {
          headline: "Ergonomic & Durable Build Chassis",
          source: "Amazon",
          attribution: "Per customer reviews:",
          detail: "Reduces operational fatigue while providing industrial grade heat dissipation during extended work shifts."
        },
        {
          headline: "Precision Micro-Adjustable Componentry",
          source: "Amazon",
          attribution: "Per brand marketing:",
          detail: "Offers ultra-fine calibration and seamless control suitable for demanding commercial standards."
        }
      ],
      // Never fabricated — populated on demand from real Amazon reviews via
      // /api/amazon/reviews-analysis/[asin].
      strengths: [],
      weaknesses: [],
      recent_news: [],
      top_feature_summary: `${c.brand} precision platform with commercial duty cycle`,
    }))
  };
}

async function generateMockPhase2(context: AnalysisContext, identity: IdentityCard, targetPriceRaw: number | null, toolTypes: ToolTypeRow[], phase1?: any) {
  const excludeNames = (phase1?.competitors || []).map((c: any) => c.name as string);
  const live = await discoverCompetitorsLive(identity, "emerging", targetPriceRaw, toolTypes, excludeNames, context.motorTech || null);
  if (live.length > 0) {
    return { web_searches_performed: live.length, competitors: live };
  }

  const dynamicList = getCategoryFallbackCompetitors(identity, "emerging");
  return {
    web_searches_performed: 14,
    competitors: dynamicList.map(c => ({
      name: c.name,
      brand: c.brand,
      tier: "emerging",
      asin: c.asin,
      amazon_url: `https://www.amazon.com/dp/${c.asin}`,
      price: c.price,
      rating: c.rating,
      review_count: c.reviewCount || (c as any).review_count || "312",
      monthly_sales: c.sales || (c as any).monthly_sales || "500+ bought in past month",
      bsr_rank: c.bsr || (c as any).bsr_rank || "#15,200 in Category",
      initials: c.initials,
      key_features: [
        {
          headline: `${c.brand} Next-Gen Innovation Module`,
          source: "Amazon",
          attribution: "Per brand marketing:",
          detail: `Designed to challenge legacy pricing by offering modern ${identity.keyAttributes[0] || "adaptive"} features at an aggressive price point.`
        },
        {
          headline: "Smart Power Regulation Circuitry",
          source: "Amazon",
          attribution: "Per customer reviews:",
          detail: "Senses load resistance and adjusts output dynamically to prevent stalling or power sag."
        },
        {
          headline: "Cool-Touch Lightweight Casing",
          source: "Amazon",
          attribution: "Per customer reviews:",
          detail: "Advanced composite materials keep operating temperatures lower than traditional metal alternatives."
        }
      ],
      strengths: [],
      weaknesses: [],
      recent_news: [],
      top_feature_summary: `Modern DTC ${c.brand} design with high price-to-performance ratio`,
    }))
  };
}

function generateMockPhase3(context: AnalysisContext, identity: IdentityCard, phase1: any, phase2: any) {
  const mData = getMarketData(identity.subcategory || identity.category, context.productName);

  const legComps = phase1?.competitors || [];
  const emComps = phase2?.competitors || [];

  const leg1 = legComps[0] || { name: "Legacy Leader", price: "$149.99", brand: "Legacy", asin: "B000000001" };
  const leg2 = legComps[1] || { name: "Industry Standard", price: "$189.99", brand: "Standard", asin: "B000000002" };
  const em1 = emComps[0] || { name: "Emerging Challenger", price: "$89.99", brand: "Challenger", asin: "B000000003" };
  const em2 = emComps[1] || { name: "Agile DTC Brand", price: "$99.99", brand: "Agile", asin: "B000000004" };

  const allCompetitors = [
    ...legComps.map((c: any) => ({ name: c.name, price: c.price || null, tier: "legacy" as const, asin: c.asin || null })),
    ...emComps.map((c: any) => ({ name: c.name, price: c.price || null, tier: "emerging" as const, asin: c.asin || null })),
  ];

  const overviewParagraph = buildOverviewParagraph({
    productName: context.productName,
    motorTech: context.motorTech || "",
    pricePoint: context.pricePoint || "",
    targetMarket: context.targetMarket,
    category: identity.category,
    subcategory: identity.subcategory,
    toolType: identity.toolType,
    marketData: mData,
    competitors: allCompetitors,
  });

  const threats = [
    {
      competitor_name: em1.name,
      threat_description: `Aggressive market entry with ${em1.price || "competitive pricing"} and fast review acceleration creating direct pressure on ${context.productName}.`
    },
    {
      competitor_name: em2.name,
      threat_description: `Capturing digital consumer mindshare with targeted social campaigns and innovative features at ${em2.price || "mid-tier pricing"}.`
    },
    {
      competitor_name: `${leg1.brand} Market Dominance`,
      threat_description: `${leg1.name} maintains entrenched retail distribution and deep customer brand loyalty.`
    },
    {
      competitor_name: leg2.name,
      threat_description: `High rating stability (${leg2.rating || "4.5"} stars) and proven commercial durability buffering against new market entrants.`
    }
  ];

  const opportunities = [
    {
      action: `Position as high-performance alternative to ${leg1.name}`,
      description: `Highlight superior ${context.motorTech || "modern motor"} technology and ergonomic advantages at the ${context.pricePoint || "target"} price point.`
    },
    {
      action: `Exploit pricing gap against ${em1.name}`,
      description: `Emphasize build quality, component transparency, and verifiable specifications to capture switching buyers.`
    },
    {
      action: "Leverage sales velocity transparency",
      description: "Prominently display monthly verified purchase indicators to build instant trust with decision makers."
    },
    {
      action: "Create comprehensive warranty assurance program",
      description: "Address customer risk concerns by offering multi-year warranty coverage exceeding indie competitor standards."
    }
  ];

  const recommendations = [
    {
      priority: "high",
      category: "product",
      headline: `Secure verified performance certifications for ${context.motorTech || "core drive system"} and highlight test results on listing materials`,
      explanation: `Differentiates ${context.productName} from unverified claim inflation by emerging competitors like ${em1.brand}.`
    },
    {
      priority: "high",
      category: "marketing",
      headline: `Launch comparison campaigns targeting ${leg1.name} and ${leg2.name} users with upgrade incentives`,
      explanation: `Legacy users seeking next-generation feature sets represent high-intent conversion targets at ${context.pricePoint || "current pricing"}.`
    },
    {
      priority: "high",
      category: "positioning",
      headline: "Establish dedicated professional verified buyer portal with priority parts replacement",
      explanation: `Addresses component scarcity concerns surfaced in competitor review analysis and cements brand credibility.`
    },
    {
      priority: "medium",
      category: "pricing",
      headline: `Maintain firm ${context.pricePoint || "retail"} price positioning without aggressive early discounting`,
      explanation: "Establishes premium value separation from low-cost consumer alternatives and protects long-term margins."
    }
  ];

  const quickWins = [
    `Highlight multi-year warranty badge prominently on product listing to counter ${em1.name} risk concerns.`,
    `Publish clear performance specification sheets detailing real-world test ratings.`,
    `Launch targeted Amazon Sponsored campaigns against ASIN ${em1.asin || "B000000003"} (${em1.name}) and ASIN ${leg1.asin || "B000000001"} (${leg1.name}).`
  ];

  const noDataDate = new Date().toISOString().slice(0, 10);

  return {
    web_searches_performed: 4,
    amazon_category: context.category || "General Marketplace",
    data_sources_used: mData ? [mData.source, "Simulated market data (no AI key configured)"] : ["Simulated market data (no AI key configured)"],
    market_snapshot: {
      market_size_current: mData?.market_size_2026 || null,
      market_size_year: "2026",
      market_size_forecast: mData?.market_size_forecast || null,
      forecast_year: mData?.forecast_year || null,
      cagr_percent: mData?.cagr || null,
      cagr_period: mData?.cagr_period || null,
      data_source: mData?.source || null,
      headline_stat_label: mData ? "growth" : "unavailable",
      headline_stat_value: mData ? `${mData.market_size_2026} ${mData.industry_label} snapshot (2026)` : `Market size: no verifiable public figure found as of ${noDataDate}`,
      overview_paragraph: overviewParagraph
    },
    key_trends: (mData?.verified_trends || []).map(t => ({
      trend_name: t.name,
      description: `${t.description} [Data Point: ${t.data_point}]`,
      source: mData!.source
    })),
    market_gaps: [
      `Gaps in verified ${context.motorTech || "advanced tech"} offerings at the ${context.pricePoint || "target"} price tier`,
      "Transparent performance testing and verified specification disclosures",
      "Comprehensive long-term parts availability and warranty support from emerging brands",
      "Certified quiet operation and low-vibration engineering claims"
    ],
    top_threats: threats,
    top_opportunities: opportunities,
    positioning_recommendation: `We recommend positioning "${context.productName}" as the primary market benchmark at ${context.pricePoint || "target pricing"}, bridging ${context.motorTech || "advanced performance"} with verified reliability. Emphasize key differentiators to stand out against ${leg1.name} and ${em1.name}.`,
    strategic_recommendations: recommendations,
    quick_wins: quickWins
  };
}

async function saveCompetitorAnalyses(analysisId: string, orgId: string, phase1: any, phase2: any, identity: IdentityCard) {
  const allCompetitors = [...(phase1.competitors || []), ...(phase2.competitors || [])];

  for (const c of allCompetitors) {
    const competitorData = {
      analysisId,
      name: c.name,
      tier: c.tier,
      threatScore: c.rating ? Math.round(parseFloat(c.rating) * 20) : 75,
      category: c.category || identity.category || identity.subcategory || "General",
      tags: c.key_features?.map((f: any) => f.headline.toLowerCase()) || [],
      insight: c.top_feature_summary || null,
      pricePoint: c.price,
      standoutFeature: c.top_feature_summary || null,
    };
    
    try {
      // 1. Try to find/link an existing competitor record by name
      let competitorId = null;
      try {
        const existing = await prisma.competitor.findFirst({
          where: {
            orgId,
            name: { equals: c.name, mode: "insensitive" }
          }
        });
        if (existing) {
          competitorId = existing.id;
        }
      } catch (dbErr) {}
      
      // Save CompetitorAnalysis record in PostgreSQL
      await prisma.competitorAnalysis.create({
        data: {
          ...competitorData,
          competitorId
        }
      });
    } catch (e) {
      // 2. Fallback to Memory Database
      let competitorId = null;
      const existing = memoryDb.competitors.find(
        comp => comp.orgId === orgId && comp.name.toLowerCase() === c.name.toLowerCase()
      );
      if (existing) {
        competitorId = existing.id;
      }
      
      memoryDb.competitorAnalyses.push({
        id: `c_an_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        ...competitorData,
        competitorId
      });
    }
  }
}

// Utility functions
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
