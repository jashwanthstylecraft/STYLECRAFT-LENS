// scripts/verify-competitor-scoring.ts
// Offline regression check for lib/competitor-scoring.ts's pure scoring
// math — motor/price/feature scores, the composite weighting, and the
// legacy one-per-brand dedupe. No live API calls — pure functions only.
//
// Run with: npx tsx scripts/verify-competitor-scoring.ts

export {};

let failures = 0;
let passes = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passes++;
    console.log(`  PASS: ${message}`);
  } else {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

function approx(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) < eps;
}

async function main() {
  const {
    computeMotorScore, computePriceScoreAbsolute, computePriceScoreRelative,
    computeFeatureScore, computeCompositeScore, dedupeToOnePerBrand, DEFAULT_WEIGHTS,
  } = await import("../lib/competitor-scoring");

  console.log("\n[1] computeMotorScore — tier -> score mapping");
  assert(computeMotorScore("exact") === 1.0, "exact -> 1.0");
  assert(computeMotorScore("adjacent") === 0.6, "adjacent -> 0.6");
  assert(computeMotorScore("different") === 0.15, "different -> 0.15");
  assert(computeMotorScore("unverified") === 0.3, "unverified -> 0.3");
  assert(computeMotorScore("exact") > computeMotorScore("adjacent"), "exact outranks adjacent");
  assert(computeMotorScore("adjacent") > computeMotorScore("unverified"), "adjacent outranks unverified");
  assert(computeMotorScore("unverified") > computeMotorScore("different"), "unverified outranks different — never penalize missing data as hard as a real mismatch");

  console.log("\n[2] computePriceScoreAbsolute — proximity to target price");
  assert(computePriceScoreAbsolute(259.95, 259.95) === 1, "exact price match -> score 1");
  assert(approx(computePriceScoreAbsolute(259.95 * 1.5, 259.95), 0), "price at the 50%-above floor -> score ~0");
  assert(computePriceScoreAbsolute(259.95 * 3, 259.95) === 0, "price far outside any band -> score floors at 0, never negative");
  assert(computePriceScoreAbsolute(249.95, 259.95) > computePriceScoreAbsolute(199.95, 259.95), "closer-to-target price scores higher");

  console.log("\n[3] computePriceScoreRelative — brand-lineup-relative tier match (Part 4's own worked example)");
  const ourFlagshipPercentile = 0.95;
  const theirFlagshipPercentile = 0.90;
  const theirBudgetPercentile = 0.05;
  const relativeFlagshipScore = computePriceScoreRelative(ourFlagshipPercentile, theirFlagshipPercentile);
  const relativeBudgetScore = computePriceScoreRelative(ourFlagshipPercentile, theirBudgetPercentile);
  assert(relativeFlagshipScore > relativeBudgetScore, "our flagship matched against their flagship scores higher than against their budget model");
  assert(relativeFlagshipScore > 0.9, `near-identical percentiles score close to 1 (got ${relativeFlagshipScore})`);

  console.log("\n[4] computeFeatureScore — grounded overlap, missing data never penalized");
  assert(computeFeatureScore({}, {}) === 0, "nothing comparable on either side -> 0, not an error");
  assert(computeFeatureScore({ rpm: 7500 }, {}) === 0, "one-sided data alone contributes nothing (no fabricated mismatch)");
  assert(computeFeatureScore({ rpm: 7500, cordless: true }, { rpm: 7400, cordless: true }) === 1, "RPM within 20% AND matching cordless -> full score");
  assert(computeFeatureScore({ rpm: 7500 }, { rpm: 3000 }) === 0, "RPM wildly different (>20%) -> no match on that dimension");
  const partial = computeFeatureScore({ rpm: 7500, cordless: true }, { rpm: 7400, cordless: false });
  assert(approx(partial, 0.5), `1 of 2 comparable dimensions matching -> 0.5 (got ${partial})`);

  console.log("\n[5] computeCompositeScore — weighted blend, default weights sum to 1");
  assert(approx(DEFAULT_WEIGHTS.motor + DEFAULT_WEIGHTS.price + DEFAULT_WEIGHTS.feature, 1), "default weights sum to 1.0");
  const compositeAllOnes = computeCompositeScore(1, 1, 1);
  assert(approx(compositeAllOnes, 1), "perfect scores on all 3 dimensions -> composite ~1");
  const motorDominant = computeCompositeScore(1, 0, 0) > computeCompositeScore(0, 1, 0);
  assert(motorDominant, "with default weights, a perfect motor-only match outranks a perfect price-only match — motor dominates, per the spec");

  console.log("\n[6] dedupeToOnePerBrand — max 1 per brand, preserves score order, priority-order-safe");
  const candidates = [
    { brand: "Wahl", score: 0.9 },
    { brand: "Andis", score: 0.85 },
    { brand: "Wahl", score: 0.8 }, // a second Wahl candidate, lower score
    { brand: "Oster", score: 0.7 },
  ];
  // limit === the number of distinct brands (3), so there's no need to
  // reach into a second candidate from an already-used brand — the one-
  // per-brand rule should hold exactly.
  const deduped = dedupeToOnePerBrand(candidates, 3);
  const wahlCount = deduped.filter(c => c.brand === "Wahl").length;
  assert(wahlCount === 1, `at most 1 candidate per brand when enough distinct brands exist to fill the limit (got ${wahlCount} Wahl entries)`);
  assert(deduped.some(c => c.brand === "Wahl" && c.score === 0.9), "the HIGHER-scoring Wahl candidate is the one kept, not the first-seen");
  assert(deduped.length === 3, `exactly 3 distinct brands returned (got ${deduped.length})`);

  // With a HIGHER limit than there are distinct brands, the function
  // correctly reaches into leftover (already-used-brand) candidates to
  // fill the remaining slots, rather than under-filling.
  const dedupedWithSpareSlots = dedupeToOnePerBrand(candidates, 5);
  assert(dedupedWithSpareSlots.length === 4, `limit (5) > distinct brands (3) -> all 4 real candidates returned, including a 2nd Wahl to use the spare slot (got ${dedupedWithSpareSlots.length})`);

  const onlyTwoBrands = [
    { brand: "Wahl", score: 0.9 },
    { brand: "Wahl", score: 0.8 },
  ];
  const dedupedShort = dedupeToOnePerBrand(onlyTwoBrands, 5);
  assert(dedupedShort.length === 2, `when fewer distinct brands than the limit exist, a second candidate from an already-used brand IS allowed in (got ${dedupedShort.length})`);

  // Regression check — brandKey used to be a plain .trim().toLowerCase(),
  // which treated "Bio Ionic" and "Bio-Ionic" (or "T3"/"T3 Micro") as
  // different brands, letting a spelling variant silently consume a 2nd
  // slot that should have gone to a genuinely different competitor. Now
  // keyed on normalizeBrandToken, same as every other brand-identity
  // comparison in the pipeline.
  const punctuationVariants = [
    { brand: "Bio Ionic", score: 0.9 },
    { brand: "Bio-Ionic", score: 0.8 }, // same brand, hyphen variant — must dedupe away
    { brand: "T3", score: 0.7 },
  ];
  // limit === the true distinct-brand count (2: "bio ionic" + "t3") — same
  // "no spare slots to top up from" setup as the very first dedupe case
  // above, so this only passes if the hyphen variant is correctly folded
  // into the SAME brand rather than topping up a 3rd slot.
  const dedupedVariants = dedupeToOnePerBrand(punctuationVariants, 2);
  const bioIonicCount = dedupedVariants.filter(c => /bio/i.test(c.brand)).length;
  assert(bioIonicCount === 1, `"Bio Ionic" and "Bio-Ionic" normalize to the same brand and dedupe to 1 (got ${bioIonicCount})`);
  assert(dedupedVariants.length === 2, `punctuation variant of an already-seen brand does not count as a distinct brand (got ${dedupedVariants.length} distinct)`);
  assert(dedupedVariants.some(c => c.brand === "Bio Ionic"), "the higher-scoring spelling variant (\"Bio Ionic\", 0.9) is the one kept");

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
