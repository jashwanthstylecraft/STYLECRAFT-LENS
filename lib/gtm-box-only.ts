// lib/gtm-box-only.ts
// GTM workbook export work, Part 4 — Box Only section: Main Statement
// (<=15 words, distilled from the already-resolved Positioning Statement)
// and 6 box-length feature condensations (<=12 words each, condensed from
// the already-resolved Top Features in Priority Order). Both grounded-only
// (no new claims), run as a Tier-6.5-style step gated on unresolved — same
// pattern as lib/gtm-features-and-tip.ts's applyFeaturesAndExpertTip.
import { callAiForJson } from "./ai-json-call";
import { GtmField, GtmFieldAnswer } from "./gtm-field-schema";
import { isRealAnswer } from "./field-answer-state";
import { getToneDirective } from "./brand-voice";
import { runVoiceGuardedText, checkVoiceCompliance, buildVoiceCorrectionInstruction } from "./ai-generation-guard";

function isUnresolved(fields: Record<string, GtmFieldAnswer>, id: string): boolean {
  const current = fields[id];
  return !current || current.source === "none" || current.answer.toUpperCase() === "N/A";
}

async function generateMainStatement(
  productName: string,
  positioningStatement: string,
  voiceBlock: string,
  tdsGroundingBlock: string = "",
  retryInstruction?: string
): Promise<string | null> {
  const systemInstruction = `Distill this positioning statement for "${productName}" into ONE punchy box-front statement, at most 15 words, grounded only in the statement below — no new claims.

POSITIONING STATEMENT:
${positioningStatement}
${retryInstruction ? `\n${retryInstruction}` : ""}

Return ONLY valid JSON: { "statement": "..." }${voiceBlock}\n${getToneDirective("launch")}${tdsGroundingBlock}`;

  const raw = await callAiForJson<{ statement?: string }>(systemInstruction, `Product: ${productName}`, "GTM-BoxMainStatement", { timeoutMs: 15_000 });
  const statement = raw?.statement?.trim();
  return statement && statement.toUpperCase() !== "N/A" ? statement : null;
}

async function generateBoxFeatures(
  productName: string,
  topFeatures: string[],
  voiceBlock: string,
  tdsGroundingBlock: string = "",
  retryInstruction?: string
): Promise<string[]> {
  const systemInstruction = `Condense each of these Top Features for "${productName}" into a box-length bullet, at most 12 words each, grounded only in the feature text below — no new claims, keep the real spec value if the feature has one.

TOP FEATURES:
${topFeatures.map((f, i) => `${i + 1}. ${f}`).join("\n")}
${retryInstruction ? `\n${retryInstruction}` : ""}

Return ONLY valid JSON: { "features": ["..."] } — same order, same count as the input list.${voiceBlock}\n${getToneDirective("launch")}${tdsGroundingBlock}`;

  const raw = await callAiForJson<{ features?: string[] }>(systemInstruction, `Product: ${productName}`, "GTM-BoxFeatures", { timeoutMs: 20_000 });
  return (raw?.features || []).filter(f => typeof f === "string" && f.trim()).map(f => f.trim());
}

async function deriveBoxMainStatement(
  fields: Record<string, GtmFieldAnswer>,
  schema: GtmField[],
  productName: string,
  voiceBlock: string,
  tdsGroundingBlock: string
): Promise<void> {
  const wantsMainStatement = schema.some(f => f.id === "box_main_statement") && isUnresolved(fields, "box_main_statement");
  if (!wantsMainStatement) return;

  const positioning = fields["positioning_statement"]?.answer;
  if (!isRealAnswer(positioning)) return;

  const statement = await generateMainStatement(productName, positioning!, voiceBlock, tdsGroundingBlock);
  if (!statement) return;

  const guarded = await runVoiceGuardedText(
    statement,
    "launch",
    correction => generateMainStatement(productName, positioning!, voiceBlock, tdsGroundingBlock, correction)
  );
  fields["box_main_statement"] = { answer: guarded.text, source: "derived", flagged: guarded.flagged, sourceDetail: Object.keys(guarded.sourceDetail).length ? guarded.sourceDetail : undefined };
}

async function deriveBoxFeatures(
  fields: Record<string, GtmFieldAnswer>,
  schema: GtmField[],
  productName: string,
  voiceBlock: string,
  tdsGroundingBlock: string
): Promise<void> {
  const wantsBoxFeatures = schema.some(f => f.id === "box_feature_1") && isUnresolved(fields, "box_feature_1");
  if (!wantsBoxFeatures) return;

  const topFeatures: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const answer = fields[`top_6_features_${i}`]?.answer;
    if (isRealAnswer(answer)) topFeatures.push(answer!);
  }
  if (topFeatures.length === 0) return;

  const condensed = await generateBoxFeatures(productName, topFeatures, voiceBlock, tdsGroundingBlock);
  const voiceChecks = condensed.map(text => checkVoiceCompliance(text, "launch"));
  const violatingIndices = voiceChecks.map((c, i) => ({ i, violations: c.violations })).filter(v => v.violations.length > 0);

  let final = condensed.map((text, i) => voiceChecks[i].text);
  if (violatingIndices.length > 0) {
    const correction = buildVoiceCorrectionInstruction(violatingIndices.flatMap(v => v.violations));
    const retryFeatures = await generateBoxFeatures(productName, topFeatures, voiceBlock, tdsGroundingBlock, correction);
    violatingIndices.forEach(v => {
      const replacement = retryFeatures[v.i];
      if (!replacement) return;
      const replacementCheck = checkVoiceCompliance(replacement, "launch");
      if (replacementCheck.violations.length === 0) {
        final[v.i] = replacementCheck.text;
        voiceChecks[v.i] = replacementCheck;
      }
    });
  }

  final.slice(0, 6).forEach((text, i) => {
    const check = voiceChecks[i];
    fields[`box_feature_${i + 1}`] = {
      answer: text,
      source: "derived",
      flagged: check.violations.length > 0,
      sourceDetail: check.violations.length > 0
        ? { reason: "voice_violation", voiceReview: true, voiceViolations: check.violations.map(v => v.rule) }
        : (check.autoFixed ? { voiceAutoFixed: true } : undefined),
    };
  });
}

// Main Statement (from positioning_statement) and Box Features (from
// top_6_features_*) are independent — different input fields, different
// output fields, each with its own possible voice-guard retry — so they
// run concurrently instead of one full flow completing before the other
// starts (each flow can itself take 15-40s worst case with a retry).
export async function applyBoxOnlyDerivation(
  fields: Record<string, GtmFieldAnswer>,
  schema: GtmField[],
  productName: string,
  voiceBlock: string = "",
  tdsGroundingBlock: string = ""
): Promise<void> {
  await Promise.all([
    deriveBoxMainStatement(fields, schema, productName, voiceBlock, tdsGroundingBlock),
    deriveBoxFeatures(fields, schema, productName, voiceBlock, tdsGroundingBlock),
  ]);
}
