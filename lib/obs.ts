// lib/obs.ts
// Structured, single-line observability for external-call tiers (Rainforest
// + web-search review tiers). No logging library — just console.warn with a
// stable JSON shape, matching this codebase's existing plain-console
// convention, so lines stay greppable via `vercel logs` and carry elapsed-ms
// timing + a clear ok/empty/error outcome, which nothing in this codebase
// tracked before. Callers pass discrete fields (asin, page, query) rather
// than a full URL, so the Rainforest api_key query param can never leak.
export type CallOutcome = "ok" | "empty" | "error";

export interface LogCallFields {
  op: string;
  asin?: string;
  page?: number;
  reviewStars?: string;
  httpStatus?: number | null;
  requestSuccess?: boolean | null;
  outcome: CallOutcome;
  itemCount?: number;
  query?: string;
  pagesFetched?: number;
  extractedTextLength?: number;
  elapsedMs: number;
  errorMessage?: string;
  // generation-pipeline / openai scopes (project TDS/GTM generation hardening)
  projectId?: string;
  phase?: string;
  label?: string;
  errorClass?: string;
  tokensIn?: number;
  tokensOut?: number;
  totalTokens?: number;
  // source-doc-upload scope (Sources tab upload hardening)
  docType?: string;
  fileSizeBytes?: number;
  referenceId?: string;
  // document-field-resolve scope (per-field fill-ladder tier trace)
  documentId?: string;
  fieldId?: string;
  source?: string;
}

export function logCall(scope: "rainforest" | "review-tier" | "generation-pipeline" | "openai" | "anthropic" | "source-doc-upload" | "document-field-resolve", fields: LogCallFields): void {
  console.warn(`[${scope}] ${JSON.stringify(fields)}`);
}
