// lib/tds-doc-facts.ts
// Uploaded TDS Ingestion, Part 1 — format-agnostic structured fact
// extraction. Runs on whatever `fullText`/`locations` lib/tds-doc-extract.ts
// produced, regardless of source format (PDF/XLSX/DOCX). Targets
// lib/tds-field-schema.ts's own field vocabulary directly — TDS's spec
// field ids are already identical to GTM_FIELD_SCHEMA's, so extracted
// facts slot straight into the existing fill ladder with no translation.
import { callAiForJson } from "./ai-json-call";
import { TDS_FIELD_SCHEMA } from "./tds-field-schema";
import { ExtractedDocContent, ExtractedLocation } from "./tds-doc-extract";

export interface ExtractedFactCandidate {
  field_id: string;
  value: string;
  raw_text: string;
  source_location?: string;
}

// A document's real text can run long — capped to keep the extraction call
// well within a single request's time/token budget. TDS documents are
// typically a handful of pages; a doc past this cap may miss facts beyond
// it, an accepted MVP scope limit rather than building full chunking here.
const MAX_EXTRACTION_TEXT_CHARS = 40_000;

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// Same case/whitespace-insensitive substring discipline as
// lib/gtm-grounding.ts's verifyGrounding — a candidate whose quote doesn't
// actually appear in the source text (AI hallucination) is dropped here,
// before it's ever persisted, rather than trusting the model's own claim.
function quoteAppearsInText(rawText: string, fullText: string): boolean {
  const needle = normalize(rawText);
  if (needle.length < 2) return false;
  return normalize(fullText).includes(needle);
}

function findLocationForRawText(locations: ExtractedLocation[], rawText: string): string | undefined {
  const needle = normalize(rawText);
  const hit = locations.find(l => normalize(l.text).includes(needle));
  return hit?.label;
}

export interface StructuredFactsResult {
  candidates: ExtractedFactCandidate[];
  // true only when the AI call itself failed/timed out/returned unparseable
  // JSON (callAiForJson returned null) — distinct from a successful call
  // that legitimately found zero facts. Callers use this to tell "extraction
  // errored, retry" apart from "this document really has no specs," which
  // were previously indistinguishable (both produced an empty array).
  aiCallFailed: boolean;
}

export async function extractStructuredFacts(
  content: ExtractedDocContent,
  productName: string,
  // Field ids the deterministic synonym-map pass (lib/source-fact-extract-
  // deterministic.ts) already resolved for this SAME document — skipped
  // here to avoid a slower, lower-confidence re-derivation of a fact
  // already found with a literal label match.
  skipFieldIds: Set<string> = new Set()
): Promise<StructuredFactsResult> {
  if (!content.fullText.trim()) return { candidates: [], aiCallFailed: false };

  // Internal-kind fields are genuine human decisions (approved pricing,
  // packaging sign-off) — never AI/document-extractable, so they're never
  // asked for here, same exclusion the rest of GTM generation already applies.
  const targetFields = TDS_FIELD_SCHEMA.filter(f => f.kind !== "internal" && !skipFieldIds.has(f.id));
  const fieldList = targetFields.map(f => `- ${f.id}: ${f.question}`).join("\n");
  const validFieldIds = new Set(targetFields.map(f => f.id));

  const systemInstruction = `You extract technical spec facts from a product's Technical Data Sheet (TDS) document for "${productName}". Given the document text below, extract ONLY values for the fields listed that are LITERALLY present in the text — never infer, guess, or use general knowledge about similar products. For the motor_type field specifically, format the value as "{Canonical Family} ({Branded Name})" when both are determinable (e.g. "Brushless Motor (EON Digital Brushless Motor)"), or just whichever of the two is present.

FIELDS TO EXTRACT (id: label):
${fieldList}

For each fact found, include a "raw_text" value — a short VERBATIM quote (a few words to one sentence) copied EXACTLY from the document text below that proves this value. A fact whose raw_text isn't an exact quote from the document will be discarded, so never paraphrase it.

DOCUMENT TEXT:
"""
${content.fullText.slice(0, MAX_EXTRACTION_TEXT_CHARS)}
"""

Return ONLY valid JSON: { "facts": [{ "field_id": "...", "value": "...", "raw_text": "..." }] } — omit any field not literally found, never guess a value.`;

  // This used to cap at 12_000ms specifically to leave time for a Gemini
  // fallback after Claude/OpenAI — stale reasoning: lib/gemini.ts's
  // hasGeminiKey is now permanently forced false (expired key), so Gemini
  // is never actually attempted by callAiForJson regardless of how much
  // budget this leaves it. A 12s cap bought that reserve at the cost of
  // cutting off Claude/OpenAI before a real, non-trivial document (up to
  // MAX_EXTRACTION_TEXT_CHARS) reliably finishes — confirmed live as the
  // actual cause of recurring "fact extraction had an error" reports on
  // real uploads. Raised to 20s per provider (worst case ~40s for
  // Claude+OpenAI together, well inside deriveFactsForDoc's own 50s
  // FACTS_DERIVATION_DEADLINE_MS, still leaving real time for the
  // narrative-signals sweep that runs after this). OpenAI's own SDK retry-
  // on-timeout (createResponseWithRetry) can still inflate a single OpenAI
  // attempt somewhat past the requested timeoutMs — accepted, since the
  // outer withDeadline in deriveFactsForDoc is the real backstop either way.
  const raw = await callAiForJson<{ facts?: ExtractedFactCandidate[] }>(
    systemInstruction,
    `Product: ${productName}`,
    "TDS-Doc-Fact-Extraction",
    { timeoutMs: 20_000 }
  );

  // callAiForJson (lib/ai-json-call.ts) returns null only when EVERY
  // provider it tried (OpenAI, then Gemini) failed/timed out/returned
  // unparseable JSON — a real call failure, not "the document has no
  // specs." A successful call that just found nothing returns `{facts: []}`
  // or `{}`, both non-null — those correctly fall through to aiCallFailed:
  // false below.
  if (raw === null) {
    return { candidates: [], aiCallFailed: true };
  }

  const candidates = (raw.facts || []).filter(
    f => f && typeof f.field_id === "string" && typeof f.value === "string" && typeof f.raw_text === "string" && f.value.trim() && f.raw_text.trim()
  );

  return {
    candidates: candidates
      .filter(f => validFieldIds.has(f.field_id) && quoteAppearsInText(f.raw_text, content.fullText))
      .map(f => ({
        field_id: f.field_id,
        value: f.value.trim(),
        raw_text: f.raw_text.trim(),
        source_location: findLocationForRawText(content.locations, f.raw_text),
      })),
    aiCallFailed: false,
  };
}

export interface NarrativeSignalCandidate {
  key: string; // free-form slug, synthesized by the AI — no fixed schema field id
  label: string; // short human-readable description of what this signal is
  value: string;
  raw_text: string;
  source_location?: string;
}

export interface NarrativeSignalsResult {
  candidates: NarrativeSignalCandidate[];
  aiCallFailed: boolean;
}

// The "AI sweep over the remaining text" from the feature spec — free-form
// marketing facts that don't map to any fixed TDS_FIELD_SCHEMA field id:
// positioning language, feature claims, USPs, audience statements, taglines,
// care instructions, collection references, marketing claims, channel
// notes. A SEPARATE call from extractStructuredFacts above (different
// target — narrative signals, not spec fields) so each stays a simple,
// single-purpose prompt rather than one call trying to do both jobs. Same
// quote-verification anti-hallucination gate as the spec sweep.
export async function extractNarrativeSignals(
  content: ExtractedDocContent,
  productName: string
): Promise<NarrativeSignalsResult> {
  if (!content.fullText.trim()) return { candidates: [], aiCallFailed: false };

  const systemInstruction = `Extract every product-marketing fact from this document about "${productName}" as key/value pairs — positioning language, feature claims, unique selling points (USPs), audience/who-it's-for statements, taglines, care/usage instructions, collection or product-family references, marketing claims, and sales-channel notes. Only extract what the text LITERALLY states — never infer, guess, or add outside knowledge.

For each fact found, provide:
- "key": a short snake_case slug describing what this is (e.g. "tagline", "usp_1", "audience_statement", "collection_reference")
- "label": a short human-readable description (e.g. "Tagline", "USP #1", "Target Audience")
- "value": the extracted fact text
- "raw_text": a short VERBATIM quote (a few words to one sentence) copied EXACTLY from the document text below that proves this value — a fact whose raw_text isn't an exact quote will be discarded.

DOCUMENT TEXT:
"""
${content.fullText.slice(0, MAX_EXTRACTION_TEXT_CHARS)}
"""

Return ONLY valid JSON: { "signals": [{ "key": "...", "label": "...", "value": "...", "raw_text": "..." }] } — omit anything not literally stated, never guess.`;

  const raw = await callAiForJson<{ signals?: NarrativeSignalCandidate[] }>(
    systemInstruction,
    `Product: ${productName}`,
    "TDS-Doc-Narrative-Signal-Extraction",
    { timeoutMs: 30_000 }
  );

  if (raw === null) {
    return { candidates: [], aiCallFailed: true };
  }

  const candidates = (raw.signals || []).filter(
    s => s && typeof s.key === "string" && s.key.trim() && typeof s.value === "string" && typeof s.raw_text === "string" && s.value.trim() && s.raw_text.trim()
  );

  return {
    candidates: candidates
      .filter(s => quoteAppearsInText(s.raw_text, content.fullText))
      .map(s => ({
        key: s.key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
        label: (s.label || s.key).trim(),
        value: s.value.trim(),
        raw_text: s.raw_text.trim(),
        source_location: findLocationForRawText(content.locations, s.raw_text),
      })),
    aiCallFailed: false,
  };
}
