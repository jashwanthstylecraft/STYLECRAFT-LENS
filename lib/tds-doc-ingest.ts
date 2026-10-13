// lib/tds-doc-ingest.ts
// Uploaded TDS Ingestion — shared processing pipeline used by both upload
// paths (the signed-URL finalize route, and the direct-multipart route
// used only in local dev without Supabase configured): validate magic
// bytes, extract content, persist the versioned doc, carry forward any
// previously user-confirmed corrections so a replacement upload never
// silently drops a human's override. Structured fact extraction
// (extractStructuredFacts) is DELIBERATELY a separate function
// (deriveFactsForDoc, below) called from its OWN route/request — see that
// function's own header comment for why.
import { detectDocType, looksLikeText } from "./file-magic-bytes";
import { extractSourceDocContent, SourceDocFormat, ExtractedDocContent } from "./tds-doc-extract";
import { extractStructuredFacts, extractNarrativeSignals } from "./tds-doc-facts";
import { extractDeterministicFacts, deterministicallyResolvedFieldIds } from "./source-fact-extract-deterministic";
import {
  createNewVersion,
  updateExtractionResult,
  updateFactsExtractionStatus,
  setLocalFileBytes,
  listVersionsForProjectDocType,
  getSourceDocById,
  SourceDocType,
  UploadedSourceDocRow,
} from "./db/uploaded-source-docs";
import { upsertFacts, carryForwardConfirmedFacts, listFactsForDoc } from "./db/extracted-facts";
import { isSupabaseConfigured } from "./supabase";
import { logCall } from "./obs";

// Matches the feature spec's own 15MB ceiling exactly (previously 20MB —
// tightened, not loosened, so a file the spec calls "too large" at 15.1MB
// is genuinely rejected server-side too, not just by a client-side check
// that a forged/direct request could bypass).
export const MAX_SOURCE_DOC_SIZE_BYTES = 15 * 1024 * 1024;
export const ALLOWED_SOURCE_DOC_TYPES: SourceDocType[] = ["tds", "spec_sheet", "sales_kit", "other"];

// Both the finalize route and the facts-derivation route this feeds have
// `export const maxDuration = 60` (Vercel Hobby's hard cap). A scanned/
// image-based PDF's OCR vision fallback alone can take up to ~57s
// worst-case (a 45s first attempt + a 10s retry, see lib/openai.ts's
// createResponseWithRetry) — CONFIRMED LIVE, this happened repeatedly in
// production even after two earlier attempts to share one budget between
// content-extraction AND fact-extraction in a single request: OCR alone can
// already consume nearly the entire 60s window, so ANY further AI work
// (extractStructuredFacts's own up-to-30s call) stacked in the SAME request
// still risked the platform's hard kill — which returns a plain HTML error
// page instead of JSON, and the browser's `res.json()` then crashes with
// "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON" / "Server
// took too long to respond" instead of a legible error.
//
// The real fix is architectural, not a tighter shared clock: content
// extraction (ingestSourceDocUpload, this file) and fact extraction
// (deriveFactsForDoc, below) are now two SEPARATE requests, each with its
// own full deadline, so they never compound within one 60s window — the
// same "one phase per request" discipline this codebase already uses for
// the analysis and GTM generation pipelines (lib/analysisEngine.ts,
// lib/project-generation-engine.ts), applied here for the same reason.
//
// Reduced from 50s to 40s after a live report of the SAME "server took too
// long" timeout recurring for a large (10-15MB) text-layer PDF (not a
// scanned one — the OCR fallback never even triggers for these). withDeadline
// only reliably races away an async/network-bound call (like the OCR vision
// request) — it CANNOT interrupt genuinely synchronous CPU work, and
// pdf-parse's own page-by-page text extraction for a large, complex,
// many-page PDF can be CPU-heavy enough on Vercel's constrained runtime that
// there wasn't enough headroom left, after this budget, for the remaining
// DB writes (createNewVersion/updateExtractionResult/carry-forward) to
// finish before the platform's own 60s hard kill. 40s leaves a full 20s of
// headroom for the Storage download (already accounted for via
// routeStartTime) plus those final writes, instead of the previous ~10s.
export const CONTENT_EXTRACTION_DEADLINE_MS = 40_000;
// Confirmed live via production logs: lib/openai.ts's own
// createResponseWithRetry has a built-in retry-on-timeout (a full
// `timeoutMs` first attempt, then a 2s wait, then one more up-to-10s short
// retry) — worst case ~42s for a SINGLE extractStructuredFacts call whose
// first attempt genuinely times out. A 40s budget here meant withDeadline
// almost always won that race and returned the failure fallback BEFORE the
// retry ever got a chance to succeed — guaranteeing a false "extraction had
// an error" for any document whose first attempt ran long, not an
// occasional edge case. The facts route's own maxDuration is 60s (it does
// no Storage download, unlike the finalize route sharing
// CONTENT_EXTRACTION_DEADLINE_MS above) — 50s leaves 10s of real headroom
// for cold start + the DB read/write around this call, and comfortably
// covers the ~42s worst case with room to spare.
export const FACTS_DERIVATION_DEADLINE_MS = 50_000;

// Exported for direct verification (scripts/verify-tds-doc-ingestion.ts) —
// the real AI providers aren't reachable offline, so there's no way to make
// extractSourceDocContent itself actually run long in a test environment;
// testing this mechanism directly is the only way to cover the fix.
export async function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  const timeout = new Promise<T>(resolve => setTimeout(() => resolve(fallback), Math.max(0, ms)));
  return Promise.race([promise, timeout]);
}

export function inferFormatFromFileName(fileName: string): SourceDocFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return "xlsx";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".doc")) return "doc";
  if (lower.endsWith(".xls")) return "xls";
  if (lower.endsWith(".csv")) return "csv";
  return null;
}

// User-facing label for the accepted-types error message — kept in one
// place so the client (pre-upload check) and server (this file's own
// rejection message) always describe the same set the same way.
export const ACCEPTED_SOURCE_DOC_TYPES_LABEL = "PDF, DOC/DOCX, XLS/XLSX, or CSV";

export interface IngestSourceDocInput {
  projectId: string;
  docType: SourceDocType;
  filePath: string; // real Storage path (signed flow) — a placeholder is fine for the memoryDb-only direct flow
  fileName: string;
  buffer: Buffer;
  mimeType: string;
  productName: string;
  uploadedBy?: string | null;
  // Captured at the very top of the calling route handler, BEFORE the
  // Storage download — lets the shared deadline below account for time
  // already spent on the download/auth/DB lookups that happen before this
  // function is even called, not just this function's own internal work.
  // Defaults to "now" (effectively un-budgeted) only for callers that
  // genuinely have no earlier reference point.
  routeStartTime?: number;
}

export interface IngestSourceDocResult {
  document: UploadedSourceDocRow;
  factsFound: number;
  sampleFacts: { field_id: string; value: string; source_location: string | null }[];
  carriedForwardCount: number;
}

// Validates + processes an already-uploaded/received file buffer: magic
// bytes, content extraction (including OCR for a scanned PDF), saves the
// new document version, carries forward prior user-confirmed facts.
// Deliberately does NOT call extractStructuredFacts — see deriveFactsForDoc
// below and this file's header comment for why that's a separate request.
// Throws an Error with a `.status` (400) for a validation failure — callers
// surface `err.message`/`err.status` directly, same convention as every
// other upload route in this codebase.
export async function ingestSourceDocUpload(input: IngestSourceDocInput): Promise<IngestSourceDocResult> {
  if (input.buffer.length > MAX_SOURCE_DOC_SIZE_BYTES) {
    const actualMb = (input.buffer.length / 1024 / 1024).toFixed(1);
    const maxMb = MAX_SOURCE_DOC_SIZE_BYTES / 1024 / 1024;
    throw Object.assign(new Error(`File is ${actualMb} MB — max is ${maxMb} MB`), { status: 400 });
  }

  const expectedFormat = inferFormatFromFileName(input.fileName);
  if (!expectedFormat) {
    throw Object.assign(new Error(`File type not accepted — upload ${ACCEPTED_SOURCE_DOC_TYPES_LABEL}`), { status: 400 });
  }

  // CSV has no binary signature to match against (it's plain text) —
  // validated by content-sniffing instead of detectDocType, which only
  // ever returns pdf/xlsx/docx/doc/xls. A binary file renamed .csv is
  // still rejected, just via looksLikeText's own control-byte check.
  if (expectedFormat === "csv") {
    if (!looksLikeText(input.buffer)) {
      console.warn(`[tds-doc-ingest] rejected "${input.fileName}" — declared .csv but content contains binary bytes. First 32 bytes (hex): ${input.buffer.subarray(0, 32).toString("hex")}`);
      throw Object.assign(new Error("This file doesn't look like plain-text CSV content — a real CSV export is required"), { status: 400 });
    }
  } else {
    const detected = detectDocType(input.buffer);
    if (detected === null || detected !== expectedFormat) {
      // Diagnostic only (never blocks/changes the rejection) — this exact
      // check has already needed widening once in production (the PDF sniff
      // window was too small for a real, unmodified file); logging the
      // leading bytes means a future edge case is debuggable from server
      // logs instead of requiring the file itself to be reproduced.
      console.warn(
        `[tds-doc-ingest] rejected "${input.fileName}" — expected ${expectedFormat}, detected ${detected ?? "null"}. First 32 bytes (hex): ${input.buffer.subarray(0, 32).toString("hex")}`
      );
      throw Object.assign(new Error(`File content doesn't match its extension — a real ${ACCEPTED_SOURCE_DOC_TYPES_LABEL} file is required`), { status: 400 });
    }
  }

  // The doc CURRENTLY active for this project+docType (before this upload
  // creates its own new version) — its confirmed facts carry forward.
  const priorVersions = await listVersionsForProjectDocType(input.projectId, input.docType);
  const priorActive = priorVersions.find(d => d.is_active) || null;

  const document = await createNewVersion({
    projectId: input.projectId,
    docType: input.docType,
    filePath: input.filePath,
    fileName: input.fileName,
    fileSizeBytes: input.buffer.length,
    mimeType: input.mimeType,
    uploadedBy: input.uploadedBy,
  });
  if (!isSupabaseConfigured) {
    await setLocalFileBytes(document.id, input.buffer);
  }

  const routeStartTime = input.routeStartTime ?? Date.now();
  const extractionBudget = Math.max(0, CONTENT_EXTRACTION_DEADLINE_MS - (Date.now() - routeStartTime));
  const extractionStart = Date.now();
  const content = await withDeadline(
    extractSourceDocContent(input.buffer, expectedFormat),
    extractionBudget,
    { fullText: "", locations: [], extractionStatus: "failed" as const, extractionMethod: "failed" as const }
  );
  // Real elapsed time for JUST this step, separate from the overall route's
  // own finalize-outcome log — lets a future timeout be diagnosed from
  // server logs (was it extraction itself running the full budget out, i.e.
  // withDeadline's fallback kicked in — logged here as method:"failed" with
  // elapsedMs ~= extractionBudget — vs. something AFTER this step being the
  // slow part) instead of guessing blind, which is what happened this time.
  logCall("source-doc-upload", {
    op: "extract",
    projectId: input.projectId,
    docType: input.docType,
    fileSizeBytes: input.buffer.length,
    outcome: content.extractionStatus === "complete" ? "ok" : "empty",
    label: content.extractionMethod,
    elapsedMs: Date.now() - extractionStart,
  });
  await updateExtractionResult(document.id, content.fullText, content.extractionStatus, content.locations);

  let carriedForwardCount = 0;
  if (priorActive) {
    const priorFacts = await listFactsForDoc(priorActive.id);
    carriedForwardCount = priorFacts.filter(f => f.confirmed_by_user).length;
    if (carriedForwardCount > 0) {
      await carryForwardConfirmedFacts(priorActive.id, document.id, input.projectId);
    }
  }

  // factsFound/sampleFacts are always 0/[] from THIS call now — the actual
  // facts arrive from the caller's own follow-up call to deriveFactsForDoc
  // (see lib/upload-source-doc-client.ts, which calls both in sequence and
  // merges the result so nothing downstream of the client needed to change).
  return { document, factsFound: 0, sampleFacts: [], carriedForwardCount };
}

export interface DeriveFactsResult {
  factsFound: number;
  sampleFacts: { field_id: string; value: string; source_location: string | null }[];
  // True when the AI call itself failed/timed out (or ran out of time
  // budget before even starting) — distinct from a successful call that
  // legitimately found zero facts. See lib/tds-doc-facts.ts's
  // StructuredFactsResult for the underlying distinction.
  extractionError: boolean;
}

// Structured fact extraction (extractStructuredFacts's own AI call, up to
// ~30s) — split out of ingestSourceDocUpload into its OWN request/route
// (app/api/projects/[id]/source-docs/[docId]/facts's POST handler) so it
// never has to share a single 60s Vercel window with content extraction's
// own OCR vision call (which alone can take up to ~57s worst-case). Reads
// the already-persisted full_text from the document row — no re-download,
// no re-extraction. Best-effort: a failure here never invalidates the
// upload itself (the document + its extracted text are already saved by
// ingestSourceDocUpload); the caller just gets factsFound: 0.
//
// Trade-off accepted for this fix: `locations` (page/sheet attribution for
// each fact) isn't persisted on uploaded_source_docs, so facts derived here
// carry no source_location — a minor quality nuance (no "found on p.3"
// label in the review UI), not a functional regression. Can be restored
// later with a `locations JSONB` column if wanted.
export async function deriveFactsForDoc(documentId: string, projectId: string, productName: string, routeStartTime?: number): Promise<DeriveFactsResult> {
  const doc = await getSourceDocById(documentId);
  if (!doc || doc.extraction_status !== "complete" || !doc.full_text) {
    // Content extraction itself never completed — nothing to derive facts
    // FROM, which is a different, already-surfaced failure (extraction_status
    // on the doc itself), not a facts-derivation error in its own right.
    return { factsFound: 0, sampleFacts: [], extractionError: false };
  }

  const content: ExtractedDocContent = { fullText: doc.full_text, locations: doc.locations || [], extractionStatus: "complete", extractionMethod: "text-layer" };
  const start = routeStartTime ?? Date.now();
  const budget = Math.max(0, FACTS_DERIVATION_DEADLINE_MS - (Date.now() - start));
  if (budget <= 0) {
    await updateFactsExtractionStatus(documentId, "failed");
    return { factsFound: 0, sampleFacts: [], extractionError: true };
  }

  // Deterministic pass first — no AI call, no time budget consumed, always
  // runs regardless of how much of `budget` is left. Its resolved field ids
  // are skipped by the AI spec-sweep below (skip, don't re-derive).
  const deterministicCandidates = extractDeterministicFacts(content.fullText);
  const resolvedFieldIds = deterministicallyResolvedFieldIds(deterministicCandidates);

  // Deliberately SEQUENTIAL, not Promise.all — confirmed live via real
  // Vercel production logs: running the spec-fact sweep and the narrative-
  // fact sweep concurrently made two large (~40k-char-document) OpenAI
  // calls compete for the same account's throughput at once, and the spec
  // sweep consistently timed out (~42-45s, past its own 30s internal
  // timeout) across every retry while the narrative sweep alone succeeded
  // in 15-26s. This is the exact same failure mode lib/analysisEngine.ts's
  // Phase 1/Phase 2 already hit and reverted from concurrent back to
  // sequential for — two simultaneous large-context calls against the same
  // OpenAI account contend for the same per-minute rate/throughput budget,
  // making both individually slower and more likely to blow their timeout,
  // which is worse than the extra latency of running them one after another.
  const { candidates, aiCallFailed } = await withDeadline(
    extractStructuredFacts(content, productName, resolvedFieldIds),
    budget,
    { candidates: [], aiCallFailed: true }
  );
  const remainingBudget = Math.max(0, FACTS_DERIVATION_DEADLINE_MS - (Date.now() - start));
  const narrativeResult = remainingBudget > 0
    ? await withDeadline(extractNarrativeSignals(content, productName), remainingBudget, { candidates: [], aiCallFailed: false })
    : { candidates: [], aiCallFailed: false };

  const combinedCandidates: { field_id: string; value: string; raw_text: string; source_location?: string; fact_type: "grounded_field" | "narrative_signal"; confidence: "high" | "medium" }[] = [
    ...deterministicCandidates.map(c => ({ field_id: c.field_id, value: c.value, raw_text: c.raw_text, source_location: c.source_location, fact_type: c.fact_type, confidence: "high" as const })),
    ...candidates.map(c => ({ field_id: c.field_id, value: c.value, raw_text: c.raw_text, source_location: c.source_location, fact_type: "grounded_field" as const, confidence: "medium" as const })),
    ...narrativeResult.candidates.map(c => ({ field_id: c.key, value: c.value, raw_text: c.raw_text, source_location: c.source_location, fact_type: "narrative_signal" as const, confidence: "medium" as const })),
  ];

  // Dedup by field_id before upserting — upsertFacts does ONE bulk upsert
  // for this whole batch (onConflict: "source_doc_id,field_id"), and
  // Postgres rejects an upsert batch that targets the same conflict key
  // twice ("ON CONFLICT DO UPDATE command cannot affect row a second
  // time") rather than silently taking the last value. A duplicate field_id
  // can genuinely happen here — the AI spec/narrative sweeps have no
  // dedup guarantee on their own JSON output (e.g. the same field quoted
  // from two different places in the document) — confirmed live as the
  // exact cause of a hard 500 on an otherwise-successful extraction.
  // Keeps the FIRST occurrence per field_id, which already preserves this
  // array's own intentional precedence order (deterministic > AI-grounded
  // > narrative).
  const seenFieldIds = new Set<string>();
  const allCandidates = combinedCandidates.filter(c => {
    if (seenFieldIds.has(c.field_id)) return false;
    seenFieldIds.add(c.field_id);
    return true;
  });

  if (allCandidates.length > 0) {
    await upsertFacts(
      documentId,
      projectId,
      allCandidates.map(c => ({ field_id: c.field_id, value: c.value, raw_text: c.raw_text, source_location: c.source_location, fact_type: c.fact_type, confidence: c.confidence }))
    );
  }
  // A real failure is either provider both failing on the SPEC sweep — the
  // narrative sweep failing too is folded in defensively, but the spec
  // sweep's own aiCallFailed is what actually matters for "extraction
  // errored, retry" today (see facts_extraction_status's own usage).
  await updateFactsExtractionStatus(documentId, aiCallFailed ? "failed" : "complete");
  return {
    factsFound: allCandidates.length,
    sampleFacts: allCandidates.slice(0, 5).map(c => ({ field_id: c.field_id, value: c.value, source_location: c.source_location ?? null })),
    extractionError: aiCallFailed,
  };
}
