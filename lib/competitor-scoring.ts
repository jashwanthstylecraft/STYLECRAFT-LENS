// lib/competitor-scoring.ts
// Pure composite-scoring math for competitor selection: motor (dominant),
// then price (absolute for legacy, relative-lineup for indie), then
// comparable feature/spec overlap as a tie-breaker. Plain TS, no
// server-only imports — fully offline-testable.
import type { MotorMatchTier } from "./motor-taxonomy";
import { normalizeBrandToken } from "./legacy-brand-discovery";

export interface MatchingWeights {
  motor: number;
  price: number;
  feature: number;
}

export const DEFAULT_WEIGHTS: MatchingWeights = { motor: 0.45, price: 0.35, feature: 0.2 };

const MOTOR_SCORE_BY_TIER: Record<MotorMatchTier, number> = {
  exact: 1.0,
  adjacent: 0.6,
  different: 0.15,
  unverified: 0.3,
};

export function computeMotorScore(tier: MotorMatchTier): number {
  return MOTOR_SCORE_BY_TIER[tier];
}

// Absolute proximity to target price (legacy default) — the same falloff
// shape already implied by lib/price-band.ts's existing ±50%-of-target
// floor: a candidate priced at the floor scores 0, right at target scores 1.
export function computePriceScoreAbsolute(price: number, targetPrice: number): number {
  if (!targetPrice) return 0;
  const diff = Math.abs(price - targetPrice);
  return Math.max(0, 1 - Math.min(1, diff / (0.5 * targetPrice)));
}

// Relative-tier proximity for indie brands (Part 4) — 1.0 when our
// percentile within OUR OWN lineup matches their model's percentile within
// THEIR lineup (both are each brand's flagship, say), regardless of how
// different the absolute dollars are.
export function computePriceScoreRelative(ourPercentile: number, theirPercentile: number): number {
  return Math.max(0, 1 - Math.abs(ourPercentile - theirPercentile));
}

export interface FeatureComparable {
  bladeTech?: string | null;
  rpm?: number | null;
  runTimeMinutes?: number | null;
  cordless?: boolean | null;
  buildMaterial?: string | null;
  // Heat/Plate Technology tool types (flat iron/curling iron/hot brush) —
  // plate material itself is the PRIMARY criterion (see
  // lib/heat-tech-taxonomy.ts), scored separately from this feature
  // overlap. Heater type and max temp class are ordinary comparable
  // features, same tier as bladeTech/buildMaterial, so they never
  // double-count the primary-criterion match.
  heaterType?: string | null;
  maxTempClass?: string | null;
  // Grooming-specific structural specs (industry-gate ticket, Part 2) — used
  // both as extra computeFeatureScore checks below AND, separately, by
  // lib/grooming-tag-taxonomy.ts's computeGroomingTagConfidence() as a hard
  // same-tool-kind gate (not blended into this function's score).
  bladeType?: string | null; // fixed/moving/DLC/ceramic/stainless/titanium/foil
  cutterName?: string | null;
  zeroGap?: boolean | null;
  bladeWidthMm?: number | null;
  guardCombCount?: number | null;
  taperLever?: boolean | null;
  lengthSettingsMm?: { min: number; max: number } | null;
  lengthSettingsCount?: number | null;
  waterproof?: boolean | null;
  groomingTag?: string | null; // the derived GroomingTag, carried for downstream display/debugging
}

function normalizeStr(s: string): string {
  return s.trim().toLowerCase();
}

// Equal-weighted overlap of grounded, comparable specs. A value missing on
// either side never counts as a mismatch — it simply doesn't contribute
// (no invented "0 vs unknown" penalty). Returns 0 (not null) when nothing
// is comparable at all, so it composes cleanly with computeCompositeScore.
//
// `differentiatorMatch` (Part 2 of the motor+price-led discovery plan) is
// optional and backward-compatible: omit it (or pass null/undefined — the
// "no Key Differentiator was given" case) and this returns exactly the
// structural score as before, unchanged. When the analysis form's Key
// Differentiator field IS set, the caller resolves whether this specific
// candidate's real listing text matches it (lib/differentiator-match.ts)
// and passes that boolean here — blended in at a fixed 30% weight so a
// differentiator match can meaningfully move the score without ever fully
// overriding grounded structural spec overlap.
// `relatedProductSimilarity` (Related Products feature, Part 2.2) is a
// separate, purely ADDITIVE bonus, not another blend term like
// differentiatorMatch above — deliberately not folded into the 0.7/0.3
// interpolation, since the spec calls for "+10% of the feature component,
// never overrides motor/price gates" rather than a reweighting. Omit (or
// pass null/undefined/0 — "no related products were given, or none of them
// resemble this candidate") and this returns exactly what it returned
// before this parameter existed.
export function computeFeatureScore(
  ours: FeatureComparable,
  theirs: FeatureComparable,
  differentiatorMatch?: boolean | null,
  relatedProductSimilarity?: number | null
): number {
  const checks: boolean[] = [];

  if (ours.bladeTech && theirs.bladeTech) checks.push(normalizeStr(ours.bladeTech) === normalizeStr(theirs.bladeTech));
  if (ours.rpm != null && theirs.rpm != null && ours.rpm > 0) checks.push(Math.abs(ours.rpm - theirs.rpm) / ours.rpm <= 0.2);
  if (ours.runTimeMinutes != null && theirs.runTimeMinutes != null && ours.runTimeMinutes > 0) {
    checks.push(Math.abs(ours.runTimeMinutes - theirs.runTimeMinutes) / ours.runTimeMinutes <= 0.25);
  }
  if (ours.cordless != null && theirs.cordless != null) checks.push(ours.cordless === theirs.cordless);
  if (ours.buildMaterial && theirs.buildMaterial) checks.push(normalizeStr(ours.buildMaterial) === normalizeStr(theirs.buildMaterial));
  if (ours.heaterType && theirs.heaterType) checks.push(normalizeStr(ours.heaterType) === normalizeStr(theirs.heaterType));
  if (ours.maxTempClass && theirs.maxTempClass) checks.push(normalizeStr(ours.maxTempClass) === normalizeStr(theirs.maxTempClass));
  if (ours.bladeType && theirs.bladeType) checks.push(normalizeStr(ours.bladeType) === normalizeStr(theirs.bladeType));
  if (ours.zeroGap != null && theirs.zeroGap != null) checks.push(ours.zeroGap === theirs.zeroGap);
  if (ours.guardCombCount != null && theirs.guardCombCount != null) checks.push(ours.guardCombCount === theirs.guardCombCount);
  if (ours.taperLever != null && theirs.taperLever != null) checks.push(ours.taperLever === theirs.taperLever);
  if (ours.waterproof != null && theirs.waterproof != null) checks.push(ours.waterproof === theirs.waterproof);

  const structuralScore = checks.length === 0 ? 0 : checks.filter(Boolean).length / checks.length;
  const score = (differentiatorMatch === undefined || differentiatorMatch === null)
    ? structuralScore
    : structuralScore * 0.7 + (differentiatorMatch ? 1 : 0) * 0.3;

  if (!relatedProductSimilarity) return score;
  return Math.min(1, score + score * 0.10 * relatedProductSimilarity);
}

export interface RelatedProductProfile {
  motorFamilyKey?: string | null;
  heatTechFamilyKey?: string | null;
  priceRaw?: number | null;
  specs?: FeatureComparable | null;
}

export interface ScoredCandidateProfile {
  motorFamilyKey?: string | null;
  heatTechFamilyKey?: string | null;
  priceRaw?: number | null;
}

// "Same motor family + within their price cluster + overlapping features"
// (Related Products spec, Part 2.2) — one true/false check per related
// product; similarity for that product = fraction of checks true. A
// candidate only needs to resemble ONE related product to earn the bonus,
// not all of them, so the result is the MAX across every related product
// supplied. Returns 0 (never null) so callers can pass it straight into
// computeFeatureScore's falsy-skips-the-bonus check above.
export function computeRelatedProductSimilarity(
  candidate: ScoredCandidateProfile,
  candidateSpecs: FeatureComparable,
  relatedProducts: RelatedProductProfile[]
): number {
  if (!relatedProducts.length) return 0;

  let best = 0;
  for (const rp of relatedProducts) {
    const checks: boolean[] = [];

    const candidateFamily = candidate.motorFamilyKey || candidate.heatTechFamilyKey;
    const relatedFamily = rp.motorFamilyKey || rp.heatTechFamilyKey;
    if (candidateFamily && relatedFamily) checks.push(normalizeStr(candidateFamily) === normalizeStr(relatedFamily));

    if (candidate.priceRaw != null && rp.priceRaw != null && rp.priceRaw > 0) {
      checks.push(Math.abs(candidate.priceRaw - rp.priceRaw) / rp.priceRaw <= 0.2);
    }

    if (rp.specs) checks.push(computeFeatureScore(candidateSpecs, rp.specs) >= 0.5);

    if (checks.length === 0) continue;
    const similarity = checks.filter(Boolean).length / checks.length;
    if (similarity > best) best = similarity;
  }
  return best;
}

// Weights are entered as free-form relative-importance numbers (any
// non-negative scale, no sum-to-1 constraint) — normalization happens HERE,
// at use-time, so every caller (and the stored/snapshotted `matching_weights`
// audit trail) keeps the raw values the user actually typed. Guards against
// a zero/invalid sum (should never happen given scoring-profiles.ts's own
// "at least one > 0" validation, but a composite score must never divide by
// zero) by falling back to DEFAULT_WEIGHTS, which already sums to 1.
function normalizeWeights(weights: MatchingWeights): MatchingWeights {
  const sum = weights.motor + weights.price + weights.feature;
  if (!sum || !isFinite(sum)) return DEFAULT_WEIGHTS;
  return { motor: weights.motor / sum, price: weights.price / sum, feature: weights.feature / sum };
}

export function computeCompositeScore(motorScore: number, priceScore: number, featureScore: number, weights: MatchingWeights = DEFAULT_WEIGHTS): number {
  const w = normalizeWeights(weights);
  return w.motor * motorScore + w.price * priceScore + w.feature * featureScore;
}

// A "none"-primary-criterion tool type (lib/tool-type-taxonomy.ts's
// resolvePrimaryCriterion — a category with no motor or heat/plate
// technology to speak of) structurally never produces a real motor/
// heat-tech score: motor_score/heat_tech_score are never computed for its
// candidates, so criterionScore is always 0 no matter how good a match one
// actually is. Applying ANY nonzero motor weight to such a tool type isn't
// just an unlucky config choice — it silently caps every candidate's
// maximum possible composite score at whatever share price+feature hold,
// which can crush a genuinely well-matched real candidate below whatever
// minimum-score gate exists elsewhere in the selection pipeline. Confirmed
// live: an 83-query search that found real candidates for a brand-new
// "none"-criterion tool type still selected ZERO of them, because the
// tool-type-less global default scoring profile happened to be heavily
// motor-weighted (90%) — a profile that's perfectly reasonable for a
// motor-based type, but silently fatal for a 'none'-criterion one.
// Call this right after resolving weights (admin-configured or a
// per-analysis override) at every scoring call site, so a misconfigured
// profile — past, present, or future — can never structurally break a
// 'none'-criterion tool type's discovery. normalizeWeights (inside
// computeCompositeScore) already re-normalizes proportionally once motor
// is zeroed here, so price/feature don't need manual redistribution.
export function resolveEffectiveWeights(weights: MatchingWeights, primaryCriterion: "motor" | "heat_technology" | "none"): MatchingWeights {
  if (primaryCriterion !== "none" || weights.motor === 0) return weights;
  return { ...weights, motor: 0 };
}

// "Fill in priority order, max 1 product per brand until every listed
// brand has had a chance" (legacy only) — assumes `candidates` is already
// sorted by descending composite score. Keeps the highest-scoring
// candidate per distinct brand on a first pass; only reaches into a
// second candidate from an already-used brand if fewer distinct brands
// than `limit` exist at all.
export function dedupeToOnePerBrand<T extends { brand?: string }>(candidates: T[], limit: number): T[] {
  const seenBrands = new Set<string>();
  const firstPass: T[] = [];
  const leftover: T[] = [];

  for (const c of candidates) {
    const brandKey = normalizeBrandToken(c.brand || "");
    if (brandKey && !seenBrands.has(brandKey)) {
      seenBrands.add(brandKey);
      firstPass.push(c);
    } else {
      leftover.push(c);
    }
  }

  return [...firstPass, ...leftover].slice(0, limit);
}
