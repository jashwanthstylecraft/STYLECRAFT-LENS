// scripts/verify-target-buyer-persona-prompt.ts
// Offline check that lib/prompts/phase3.ts's buildPhase3Prompt emits the
// target_buyer_persona schema key and its no-fabricated-individual rule —
// this is a reasoned synthesis for OUR OWN product, not per-competitor
// (see git revert 157b2ad for the feature this replaced). No live API
// calls — buildPhase3Prompt itself never calls out to AI providers, it
// just builds prompt text.
//
// Run with: npx tsx scripts/verify-target-buyer-persona-prompt.ts

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

async function main() {
  const { buildPhase3Prompt } = await import("../lib/prompts/phase3");

  const ctx: any = {
    productName: "Arbitrage Clipper",
    motorTech: "P.U.R.E. Outrunner Motor",
    pricePoint: "$149.99",
    targetMarket: "Professional barbers",
  };
  const identity: any = {
    category: "Clippers & Trimmers",
    subcategory: "Professional Hair Clippers",
    whatItIs: "A professional cordless hair clipper",
    keyAttributes: ["High-torque motor", "60-minute runtime"],
    priceObserved: { value: "$149.99" },
  };
  const phase1 = { competitors: [{ name: "BaBylissPRO FXONE", price: "$149.99", tier: "legacy", asin: "B0ABC12345" }] };
  const phase2 = { competitors: [{ name: "StyleCraft Shorty Clipper", price: "$99.99", tier: "emerging", asin: "B0DEF67890" }] };

  const { systemPrompt, userPrompt } = await buildPhase3Prompt(ctx, identity, phase1, phase2);

  console.log("\n[1] target_buyer_persona is present in the JSON schema sent to the model");
  assert(userPrompt.includes('"target_buyer_persona"'), "userPrompt includes the target_buyer_persona key");
  assert(userPrompt.includes("archetype_name"), "schema includes archetype_name");
  assert(userPrompt.includes("age_range"), "schema includes age_range");
  assert(userPrompt.includes("household_income"), "schema includes household_income");
  assert(userPrompt.includes("life_stage"), "schema includes life_stage");
  assert(userPrompt.includes("shopping_style"), "schema includes shopping_style");
  assert(userPrompt.includes("lifestyle_and_personality"), "schema includes lifestyle_and_personality");
  assert(userPrompt.includes("pain_points"), "schema includes pain_points");
  assert(userPrompt.includes("objections"), "schema includes objections");
  assert(userPrompt.includes("purchase_triggers"), "schema includes purchase_triggers");
  assert(userPrompt.includes("messaging_that_resonates"), "schema includes messaging_that_resonates");
  assert(userPrompt.includes("preferred_channels"), "schema includes preferred_channels");

  console.log("\n[2] it's grounded in THIS product, not phrased as per-competitor");
  assert(userPrompt.includes("Arbitrage Clipper"), "schema references our own product name for grounding");

  console.log("\n[3] system prompt carries the no-fabricated-individual rule");
  assert(systemPrompt.includes("NEVER invent a specific fake individual"), "system prompt forbids inventing a specific person");
  assert(systemPrompt.includes("age RANGE"), "system prompt requires an age range, not a single age");
  assert(!systemPrompt.toLowerCase().includes("per-competitor") && !systemPrompt.toLowerCase().includes("per competitor"), "not framed as per-competitor (that version was reverted)");
  assert(systemPrompt.includes("never a fabricated statistic or invented percentage"), "system prompt forbids fabricated stats in the deeper fields (e.g. no fake '73% likely to buy')");

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
