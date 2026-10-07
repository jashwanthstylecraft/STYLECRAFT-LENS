// lib/spec-extraction.ts
// Extracts the comparable spec/feature signals lib/competitor-scoring.ts's
// computeFeatureScore needs — blade tech, RPM, run time, cordless/corded,
// build material — for BOTH our own product (from its real TDS fields,
// same "grounded, never invented" discipline as everything else in this
// pipeline) and a competitor (from the Rainforest product data already
// fetched by enrichCompetitorsWithRainforest, zero new network calls,
// mirroring lib/motor-extraction.ts's exact reuse strategy).
import type { RainforestSpec } from "./rainforest";
import type { FeatureComparable } from "./competitor-scoring";
import { isRealAnswer } from "./field-answer-state";

const RPM_LABELS = ["rpm", "speed"];
const RUNTIME_LABELS = ["run time", "runtime", "battery life"];
const CORDLESS_KEYWORDS = ["cordless", "wireless", "battery-powered", "battery powered"];
const CORDED_KEYWORDS = ["corded", "plug-in", "plug in", "wired"];
const BLADE_KEYWORDS = ["stainless steel", "ceramic", "titanium", "carbon steel", "self-sharpening"];
// Heat/Plate Technology tool types (flat iron/curling iron/hot brush) —
// heater type and max temp class are ordinary comparable features, never
// the primary criterion itself (that's plate material, see
// lib/heat-tech-taxonomy.ts/lib/heat-tech-extraction.ts).
const HEATER_TYPE_LABELS = ["heater type", "heating element", "heater"];
const MAX_TEMP_LABELS = ["max temp", "maximum temperature", "temperature range", "heat setting"];
// Grooming industry gate ticket, Part 2 — grooming-specific structural spec
// keywords, same hardcoded-not-DB-editable convention as BLADE_KEYWORDS/
// CORDLESS_KEYWORDS above.
const BLADE_TYPE_KEYWORDS = ["dlc", "ceramic", "stainless", "titanium", "fixed blade", "moving blade", "foil"];
const ZERO_GAP_KEYWORDS = ["zero gap", "zero-gap"];
const TAPER_LEVER_KEYWORDS = ["taper lever", "adjustable lever"];
const WATERPROOF_KEYWORDS = ["waterproof", "ipx7", "wet/dry", "wet dry"];

function findSpecValue(specAndAttr: RainforestSpec[], labels: string[]): string | null {
  for (const spec of specAndAttr) {
    const nameLower = (spec.name || "").toLowerCase();
    if (labels.some(l => nameLower.includes(l))) return spec.value;
  }
  return null;
}

export function parseNumber(s: string | null): number | null {
  if (!s) return null;
  const match = s.replace(/,/g, "").match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

function parseRuntimeMinutes(raw: string | null): number | null {
  if (!raw) return null;
  const hourMatch = raw.match(/([\d.]+)\s*h(?:our|r)?/i);
  if (hourMatch) return parseFloat(hourMatch[1]) * 60;
  const minMatch = raw.match(/([\d.]+)\s*min/i);
  if (minMatch) return parseFloat(minMatch[1]);
  return parseNumber(raw);
}

function detectCordless(texts: string[]): boolean | null {
  const joined = texts.join(" ").toLowerCase();
  if (CORDLESS_KEYWORDS.some(k => joined.includes(k))) return true;
  if (CORDED_KEYWORDS.some(k => joined.includes(k))) return false;
  return null;
}

function findBladeMention(texts: string[]): string | null {
  const joined = texts.join(" ").toLowerCase();
  return BLADE_KEYWORDS.find(k => joined.includes(k)) || null;
}

function findKeywordMention(texts: string[], keywords: string[]): string | null {
  const joined = texts.join(" ").toLowerCase();
  return keywords.find(k => joined.includes(k)) || null;
}

function detectKeywordPresence(texts: string[], keywords: string[]): boolean | null {
  const joined = texts.join(" ").toLowerCase();
  return keywords.some(k => joined.includes(k)) ? true : null;
}

// "0.5mm-25mm", "0.5 to 25 mm" style ranges — grooming clippers/trimmers
// commonly advertise their adjustable cutting-length range this way.
function parseLengthSettingsRange(texts: string[]): { min: number; max: number } | null {
  const joined = texts.join(" ");
  const match = joined.match(/([\d.]+)\s*(?:mm)?\s*(?:-|to)\s*([\d.]+)\s*mm/i);
  if (!match) return null;
  const min = parseFloat(match[1]);
  const max = parseFloat(match[2]);
  if (!isFinite(min) || !isFinite(max)) return null;
  return { min, max };
}

// "10 length settings", "adjustable to 10 lengths"
function parseLengthSettingsCount(texts: string[]): number | null {
  const joined = texts.join(" ");
  const match = joined.match(/(\d+)\s*(?:length settings|adjustable lengths|lengths)/i);
  return match ? parseInt(match[1], 10) : null;
}

function parseGuardCombCount(texts: string[]): number | null {
  const joined = texts.join(" ");
  const match = joined.match(/(\d+)\s*(?:guard combs?|guards?|combs?)/i);
  return match ? parseInt(match[1], 10) : null;
}

function parseBladeWidthMm(texts: string[]): number | null {
  const joined = texts.join(" ");
  const match = joined.match(/([\d.]+)\s*mm\s*(?:blade|width)/i);
  return match ? parseFloat(match[1]) : null;
}

export function extractCompetitorSpecs(product: {
  specifications?: RainforestSpec[];
  attributes?: RainforestSpec[];
  feature_bullets?: string[];
  description?: string | null;
}): FeatureComparable {
  const specAndAttr = [...(product.specifications || []), ...(product.attributes || [])];
  const texts = [...(product.feature_bullets || []), product.description || ""];
  const allTexts = [...texts, ...specAndAttr.map(s => `${s.name} ${s.value}`)];

  return {
    rpm: parseNumber(findSpecValue(specAndAttr, RPM_LABELS)),
    runTimeMinutes: parseRuntimeMinutes(findSpecValue(specAndAttr, RUNTIME_LABELS)),
    cordless: detectCordless(allTexts),
    buildMaterial: findSpecValue(specAndAttr, ["material"]),
    bladeTech: findBladeMention(texts),
    heaterType: findSpecValue(specAndAttr, HEATER_TYPE_LABELS),
    maxTempClass: findSpecValue(specAndAttr, MAX_TEMP_LABELS),
    bladeType: findKeywordMention(allTexts, BLADE_TYPE_KEYWORDS),
    cutterName: null, // no reliable generic extraction signal — left unknown rather than guessed
    zeroGap: detectKeywordPresence(allTexts, ZERO_GAP_KEYWORDS),
    bladeWidthMm: parseBladeWidthMm(allTexts),
    guardCombCount: parseGuardCombCount(allTexts),
    taperLever: detectKeywordPresence(allTexts, TAPER_LEVER_KEYWORDS),
    lengthSettingsMm: parseLengthSettingsRange(allTexts),
    lengthSettingsCount: parseLengthSettingsCount(allTexts),
    waterproof: detectKeywordPresence(allTexts, WATERPROOF_KEYWORDS),
  };
}

// `tdsFields` is the flat {field_id: answer} map from
// lib/db/documents.ts's getTdsFieldsForProject — real TDS spec fields
// (motor_rpm, motor_run_time, material, blade_name) reused as-is, never a
// new data source. Returns an all-null comparable when there's no linked
// project (ad-hoc analyses simply skip feature scoring gracefully, since
// computeFeatureScore already treats "nothing comparable" as 0, not an error).
export function extractOurSpecsFromTds(tdsFields: Record<string, string> | null): FeatureComparable {
  if (!tdsFields) {
    return {
      rpm: null, runTimeMinutes: null, cordless: null, buildMaterial: null, bladeTech: null, heaterType: null, maxTempClass: null,
      bladeType: null, cutterName: null, zeroGap: null, bladeWidthMm: null, guardCombCount: null, taperLever: null,
      lengthSettingsMm: null, lengthSettingsCount: null, waterproof: null,
    };
  }

  const rpmAnswer = tdsFields["motor_rpm"];
  const runTimeAnswer = tdsFields["motor_run_time"];
  const materialAnswer = tdsFields["material"];
  const bladeAnswer = tdsFields["blade_name"];
  const heaterTypeAnswer = tdsFields["heater_type"];
  const maxTempAnswer = tdsFields["max_temp_class"];
  const fixedBladeAnswer = tdsFields["fixed_blade"];
  const cuttingBladeAnswer = tdsFields["cutting_blade"];
  const guardsQtyAnswer = tdsFields["guards_qty"];

  return {
    rpm: isRealAnswer(rpmAnswer) ? parseNumber(rpmAnswer) : null,
    runTimeMinutes: isRealAnswer(runTimeAnswer) ? parseRuntimeMinutes(runTimeAnswer) : null,
    cordless: null, // no dedicated TDS field for this today — left unknown rather than guessed
    buildMaterial: isRealAnswer(materialAnswer) ? materialAnswer : null,
    bladeTech: isRealAnswer(bladeAnswer) ? (findBladeMention([bladeAnswer]) || bladeAnswer) : null,
    heaterType: isRealAnswer(heaterTypeAnswer) ? heaterTypeAnswer : null,
    maxTempClass: isRealAnswer(maxTempAnswer) ? maxTempAnswer : null,
    // Partial TDS backing: guard count comes straight from guards_qty; blade
    // type is approximated from whichever blade field has a real answer.
    // zeroGap/bladeWidthMm/taperLever/lengthSettingsMm/Count/waterproof have
    // no TDS field today and resolve to null — an honest, stated limitation,
    // same as cordless above (they still populate fully on the competitor
    // side from real Rainforest listing text).
    bladeType: isRealAnswer(fixedBladeAnswer) ? (findBladeMention([fixedBladeAnswer]) || fixedBladeAnswer) : isRealAnswer(cuttingBladeAnswer) ? (findBladeMention([cuttingBladeAnswer]) || cuttingBladeAnswer) : null,
    cutterName: null,
    zeroGap: null,
    bladeWidthMm: null,
    guardCombCount: isRealAnswer(guardsQtyAnswer) ? parseNumber(guardsQtyAnswer) : null,
    taperLever: null,
    lengthSettingsMm: null,
    lengthSettingsCount: null,
    waterproof: null,
  };
}
