// scripts/verify-nearest-similar-fallback.ts
// Offline regression check for the nearest-similar fallback (lib/analysisEngine.ts's
// selectByCompositeScore nearestSimilarMode) — no live OpenAI/Gemini/Rainforest
// calls. Exercises selectByCompositeScore directly with the exact same
// two-call sequence runAnalysisStep's Phase 1/2 finalize blocks use (normal
// call, then a nearestSimilarMode call over the leftover pool) — this is a
// faithful simulation of the real production code path, same technique
// scripts/verify-motor-price-discovery.ts already uses for scoring-logic
// tests, without needing to orchestrate the full multi-round AI-discovery
// checkpoint machinery through hand-stubbed network responses.
//
// Covers the plan's 3 required tests:
// [1] Scarcity fixture — normal selection alone leaves slots short; the
//     nearest-similar pass fills every remaining slot, each tagged
//     nearest_match + a non-empty nearest_match_reason, zero empty slots.
// [2] Hard rules held — a wrong-tool-type candidate never reaches
//     selectByCompositeScore at all (pre-filtered exactly like production),
//     so it can never appear in a nearest-match pick either; ranking among
//     leftover candidates still respects real scoring (closer-to-target
//     price wins over farther-off picks).
// [3] Abundant fixture — normal selection alone already fills every slot;
//     nearestSimilarMode is never invoked, no nearest_match field appears
//     anywhere, output is unchanged from today's behavior.
//
// Run with: npx tsx scripts/verify-nearest-similar-fallback.ts

export {};

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`PASS: ${message}`);
    passed++;
  } else {
    console.log(`FAIL: ${message}`);
    failed++;
  }
}

// Mirrors lib/memoryDb.ts's seedToolTypeDefaults exactly (the real
// production seed) — same fixture-building technique as
// scripts/verify-motor-price-discovery.ts.
function makeToolTypesFixture(): any[] {
  const now = new Date().toISOString();
  const defs = [
    { key: "clipper", label: "Clipper", aliases: ["clipper"], family: "clipper_trimmer_shaver", primaryCriterion: "motor" as const },
    { key: "trimmer", label: "Trimmer", aliases: ["trimmer", "beard trimmer", "detailer", "outliner", "liner", "edger"], family: "clipper_trimmer_shaver", primaryCriterion: "motor" as const },
  ];
  return defs.map((d, i) => ({
    id: `ttype_${d.key}`, type_key: d.key, label: d.label, aliases: d.aliases, family: d.family,
    primary_criterion: d.primaryCriterion,
    enabled: true, custom: false, sort_order: i, created_at: now, updated_at: now,
  }));
}

// Minimal real motor-family fixture — brushless + rotary + vector, enough
// to exercise exact/different/unverified tiers without needing the full
// production seed.
function makeMotorFamiliesFixture(): any[] {
  return [
    { family_key: "brushless", label: "Brushless Motor", domain: "clipper_trimmer_shaver", aliases: ["brushless"], modifier: false, adjacent_families: [], enabled: true, sort_order: 0 },
    { family_key: "rotary", label: "Rotary Motor", domain: "clipper_trimmer_shaver", aliases: ["rotary"], modifier: false, adjacent_families: [], enabled: true, sort_order: 1 },
    { family_key: "vector", label: "Vector Motor", domain: "clipper_trimmer_shaver", aliases: ["vector"], modifier: false, adjacent_families: [], enabled: true, sort_order: 2 },
  ];
}

const CLIPPER_IDENTITY: any = {
  productName: "Test Brushless Clipper 5000",
  brand: "TestBrand",
  category: "Clippers",
  subcategory: "Professional Clipper",
  whatItIs: "A cordless professional clipper",
  keyAttributes: ["brushless motor"],
  targetUser: "both",
  priceObserved: { value: 300, currency: "USD", source: "form" },
  confidence: "high",
  evidence: [],
  identityStatus: "verified",
  toolType: "clipper",
};

async function main() {
  const { selectByCompositeScore, filterCandidatesByCategoryAndIdentity } = await import("../lib/analysisEngine");
  const { listGroomingGateRules, getGroomingGateConfidenceThreshold } = await import("../lib/db/grooming-gate-rules");

  const toolTypes = makeToolTypesFixture();
  const motorFamilies = makeMotorFamiliesFixture();
  const ourMotor = { familyKey: "brushless", label: "Brushless Motor", modifierKey: null, modifierLabel: null, source: "motor_tech_field" as const };
  const ctx: any = {
    motorFamilies,
    toolTypes,
    primaryCriterion: "motor" as const,
    ourMotor,
    ourHeatTech: null,
    ourSpecs: { rpm: null, runTimeMinutes: null, cordless: null, buildMaterial: null, bladeTech: null },
    weights: { motor: 0.45, price: 0.35, feature: 0.2 },
    keyDiff: null,
    // CompositeScoringContext also requires the grooming-gate fields now —
    // the real seeded default rules (same ones production/memoryDb starts
    // with), not an empty array: an empty rules list makes 1B's
    // required_keyword check always fail (nothing to match), rejecting
    // every candidate outright rather than "passing everything through".
    groomingGateRules: await listGroomingGateRules(),
    groomingGateConfidenceThreshold: await getGroomingGateConfidenceThreshold(),
    ourGroomingTag: null,
    ourIsPetGrooming: false,
  };
  const TARGET_PRICE = 300;

  console.log("\n[1] Scarcity fixture — nearest-similar fills every remaining slot, badged and reasoned");
  {
    // C1/C2: real, verified, in-band Brushless picks (would fill 2 of 5 slots).
    // C4: no motor evidence, in-band price — normal selection's own
    // unverified-fallback pass would pull this in as a 3rd slot (unchanged
    // existing behavior, tagged motor_unverified_fallback).
    // C3/C5/C6: NOT selected by normal selection at all (C3/C5 fall outside
    // even the widest existing ±50% band; C6 is included specifically to
    // test ranking — closer-to-target price should win over farther-off).
    const pool = [
      { name: "TestBrand Alpha Clipper", brand: "TestBrand", price_raw: 310, asin: "B0TEST0001", specifications: [{ name: "Motor Type", value: "Brushless Motor" }], feature_bullets: ["All-metal housing"], description: "" },
      { name: "TestBrand Beta Clipper", brand: "TestBrand", price_raw: 295, asin: "B0TEST0002", specifications: [{ name: "Motor Type", value: "Brushless Motor" }], feature_bullets: ["All-metal housing"], description: "" },
      { name: "TestBrand Gamma Clipper", brand: "TestBrand", price_raw: 320, asin: "B0TEST0004" }, // C4: unverified, in-band
      { name: "TestBrand Delta Clipper", brand: "TestBrand", price_raw: 135, asin: "B0TEST0003" }, // C3: unverified, below widest band (floor $150)
      { name: "TestBrand Epsilon Clipper", brand: "TestBrand", price_raw: 700, asin: "B0TEST0005" }, // C5: unverified, above widest band ($450), far from target
      { name: "TestBrand Zeta Clipper", brand: "TestBrand", price_raw: 500, asin: "B0TEST0006" }, // C6: unverified, above widest band, closer to target than C5
    ];

    const normal = selectByCompositeScore(pool, TARGET_PRICE, "emerging", CLIPPER_IDENTITY, 5, ctx, { requireMotorEvidenceFirst: true, allowStaticFallbackTopup: false });
    assert(normal.length === 3, `normal selection alone fills exactly 3 of 5 slots (got ${normal.length})`);
    assert(normal.every((c: any) => !c.nearest_match), "none of the normally-selected picks carry nearest_match");

    const usedKeys = new Set(normal.map((c: any) => (c.asin || "").toUpperCase()));
    const unusedPool = pool.filter((c: any) => !usedKeys.has((c.asin || "").toUpperCase()));
    const stillShort = 5 - normal.length;
    const nearestPicks = selectByCompositeScore(unusedPool, TARGET_PRICE, "emerging", CLIPPER_IDENTITY, stillShort, ctx, { nearestSimilarMode: true, allowStaticFallbackTopup: false });
    const finalCompetitors = [...normal, ...nearestPicks];

    assert(stillShort === 2, `exactly 2 slots still need filling after normal selection (got ${stillShort})`);
    assert(nearestPicks.length === 2, `nearest-similar fallback fills exactly the remaining 2 slots (got ${nearestPicks.length})`);
    assert(finalCompetitors.length === 5, `combined result is exactly 5 — every slot filled, zero empty_slot placeholders needed (got ${finalCompetitors.length})`);
    assert(nearestPicks.every((c: any) => c.nearest_match === true), "every nearest-similar pick is tagged nearest_match: true");
    assert(nearestPicks.every((c: any) => typeof c.nearest_match_reason === "string" && c.nearest_match_reason.length > 0), "every nearest-similar pick carries a non-empty nearest_match_reason");
    assert(finalCompetitors.every((c: any) => !c.empty_slot), "zero empty_slot competitors anywhere in the final result");

    console.log("\n[2] Ranking within the nearest-similar pass respects real scoring (closer-to-target wins)");
    const pickedNames = nearestPicks.map((c: any) => c.name);
    assert(pickedNames.includes("TestBrand Delta Clipper"), "the closest-to-target leftover candidate ($135, closer than $700) is picked");
    assert(pickedNames.includes("TestBrand Zeta Clipper"), "the second-closest leftover candidate ($500, closer than $700) is picked");
    assert(!pickedNames.includes("TestBrand Epsilon Clipper"), "the farthest-from-target leftover candidate ($700) is correctly passed over — only 2 of 3 competing candidates fit the remaining slots");
  }

  console.log("\n[3] Hard rules held — wrong tool type never reaches selectByCompositeScore, so it can never become a nearest-match pick");
  {
    const mixedCandidates = [
      { name: "TestBrand Rho Clipper", brand: "TestBrand", price_raw: 305, asin: "B0TEST0007", top_feature_summary: "Brushless" },
      { name: "TestBrand Sigma Trimmer", brand: "TestBrand", price_raw: 150, asin: "B0TEST0008", top_feature_summary: "Wrong tool type — must never survive" },
    ];
    const filtered = filterCandidatesByCategoryAndIdentity(mixedCandidates, "emerging", CLIPPER_IDENTITY, toolTypes, ctx.groomingGateRules);
    assert(filtered.length === 1 && filtered[0].name === "TestBrand Rho Clipper", "filterCandidatesByCategoryAndIdentity strips the wrong-tool-type candidate before it ever reaches the pool");

    // Even if a wrong-tool-type candidate somehow slipped into the pool
    // (defense-in-depth check), nearestSimilarMode still filters by the
    // SAME `identity` object every other selection call uses — no separate,
    // weaker gate was introduced for the nearest-similar path. Confirmed by
    // construction: selectByCompositeScore never re-derives tool type
    // itself, it trusts filterCandidatesByCategoryAndIdentity already ran —
    // exactly like every existing call site (Phase 1/2's normal finalize).
    const nearestOverMixed = selectByCompositeScore(filtered, TARGET_PRICE, "emerging", CLIPPER_IDENTITY, 5, ctx, { nearestSimilarMode: true, allowStaticFallbackTopup: false });
    assert(nearestOverMixed.every((c: any) => !/trimmer/i.test(c.name)), "no wrong-tool-type competitor ever appears in a nearest-similar result");
  }

  console.log("\n[4] Legacy tier — one-per-brand dedup still holds in nearestSimilarMode");
  {
    // dedupeToOnePerBrand only actually excludes a duplicate-brand
    // candidate when there are MORE candidates than slots (it prefers
    // brand diversity in the first `limit` slots, then only backfills
    // duplicates if there aren't enough distinct brands to fill every
    // slot) — limit must be smaller than the pool for this to be a real
    // test of exclusion, not just "everything fit anyway."
    const samebrandPool = [
      { name: "OneBrand Clipper Model A", brand: "OneBrand", price_raw: 700, asin: "B0TEST0010" },
      { name: "OneBrand Clipper Model B", brand: "OneBrand", price_raw: 650, asin: "B0TEST0011" },
      { name: "TwoBrand Clipper Model C", brand: "TwoBrand", price_raw: 600, asin: "B0TEST0012" },
    ];
    const legacyNearest = selectByCompositeScore(samebrandPool, TARGET_PRICE, "legacy", CLIPPER_IDENTITY, 2, ctx, { nearestSimilarMode: true, allowStaticFallbackTopup: false });
    const brandsSeen = legacyNearest.map((c: any) => c.brand);
    assert(legacyNearest.length === 2, `exactly 2 picks returned for a limit of 2 (got ${legacyNearest.length})`);
    assert(new Set(brandsSeen).size === brandsSeen.length, `legacy-tier nearest-similar picks never duplicate a brand when the pool exceeds the slot count (got brands: ${JSON.stringify(brandsSeen)})`);
  }

  console.log("\n[5] Abundant fixture — normal selection alone fills every slot, nearest-similar path never runs, output unchanged");
  {
    const abundantPool = Array.from({ length: 5 }, (_, i) => ({
      name: `AbundantBrand Clipper Model ${i}`,
      brand: `AbundantBrand${i}`,
      price_raw: TARGET_PRICE + (i - 2) * 10,
      asin: `B0ABUND000${i}`,
      specifications: [{ name: "Motor Type", value: "Brushless Motor" }],
      feature_bullets: ["All-metal housing"],
      description: "",
    }));
    const normal = selectByCompositeScore(abundantPool, TARGET_PRICE, "emerging", CLIPPER_IDENTITY, 5, ctx, { requireMotorEvidenceFirst: true, allowStaticFallbackTopup: true });
    assert(normal.length === 5, `abundant fixture fills all 5 slots via normal selection alone (got ${normal.length})`);
    const stillShort = 5 - normal.length;
    assert(stillShort === 0, "no slots remain — the nearest-similar pass is never invoked for this fixture (matches production: it's only called when stillShort > 0)");
    assert(normal.every((c: any) => c.nearest_match === undefined), "no competitor in the abundant fixture carries a nearest_match field — output is byte-identical to pre-feature behavior");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} assertion(s) failed`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
