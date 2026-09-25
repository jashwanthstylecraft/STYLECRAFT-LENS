"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle, Loader2, AlertCircle, HelpCircle, XCircle } from "lucide-react";
import { useBackgroundStageStore } from "@/stores/backgroundStageStore";

interface PhaseState {
  status: "waiting" | "running" | "complete" | "error";
  label: string;
  message: string;
}

// Phase 0 (Product Identification) runs before any competitor search —
// added so every downstream phase keys off a VERIFIED category instead
// of a hardcoded default (see lib/analysisEngine.ts / lib/product-identification.ts).
// Exported so scripts/verify-phase-sequence-contract.ts can assert this
// stays byte-identical — the motor+price-led discovery rework changes
// research logic INSIDE Phase 1/2, never the phase sequence/labels
// themselves.
export const PHASE_LABELS = [
  "Identifying the product",
  "Researching large brand competitors",
  "Researching indie & emerging competitors",
  "Synthesizing market analysis & strategic recommendations",
];

// Which phase row shows the "waiting for input" icon for a given pause
// field — "category" (Phase 0 product identification) is the default for
// old paused questions that predate this field. "toolType" also pauses
// during Phase 0 (lib/product-identification.ts's strict tool-type
// resolution — see lib/tool-type-taxonomy.ts). "motorType" pauses during
// Phase 1 (lib/analysisEngine.ts's resolveOurMotorType gate), "lineupTier"
// during Phase 2 (resolveOurLineupTier, indie relative pricing). Exported
// for the same regression-contract reason as PHASE_LABELS above.
export const PENDING_QUESTION_PHASE_INDEX: Record<string, number> = {
  category: 0,
  toolType: 0,
  pricePoint: 1,
  motorType: 1,
  lineupTier: 2,
};

interface BrandProgressEntry {
  brand: string;
  status: "searching" | "found" | "not_found";
  price?: string | null;
  reason?: string | null;
  // Best-effort live hint (lib/legacy-brand-discovery.ts) — whether the
  // motor-first search query is what actually found this brand's match.
  // The authoritative motor match tier is computed later and shown on the
  // completed competitor card/table.
  motorMatched?: boolean;
  // Which source actually produced this brand's final candidate — set
  // once lib/legacy-brand-discovery.ts merges its concurrent brand-site +
  // Amazon passes. Absent while still "searching".
  source?: "brand_site" | "amazon" | "both" | null;
}

const SOURCE_LABELS: Record<string, string> = { brand_site: "brand site", amazon: "Amazon", both: "brand site + Amazon" };

interface BrandProgress {
  category_slug?: string;
  category_name?: string;
  brands?: BrandProgressEntry[];
  // Threaded from lib/analysisEngine.ts's writeBrandProgress — what's
  // actually driving this search, for the upfront "Searching: X" summary
  // line below (not just the reactive per-brand chips).
  motor_label?: string | null;
  tool_type_label?: string | null;
  target_market_label?: "pro" | "consumer" | "both" | string | null;
  price_band_low?: number | null;
  price_band_high?: number | null;
}

const TARGET_MARKET_SUMMARY_LABELS: Record<string, string> = { pro: "Pro/Salon", consumer: "Retail", both: "Both (merged)" };

interface PendingQuestion {
  question: string;
  foundSoFar?: string;
  // Which context field the answer patches — "category" (Phase 0 product
  // identification), "pricePoint"/"motorType" (Phase 1's price/motor gates),
  // or "lineupTier" (Phase 2's relative-pricing gate). Absent on old paused
  // questions that predate this field — treated as "category".
  field?: string;
  placeholder?: string;
}

interface Props {
  analysisId: string;
  productName: string;
  onComplete: (results: any) => void;
  onError: (msg: string) => void;
  // User clicked "Cancel" — distinct from onError so the parent can show a
  // neutral "cancelled" message instead of a red error, then let them
  // start a fresh analysis immediately.
  onCancelled: () => void;
}

// A hard Vercel function kill (the route ran past its own maxDuration)
// returns a plain-text/HTML platform error page, not this route's own
// JSON — a raw res.json() call crashes on that with a confusing
// "Unexpected token 'A', "An error o"... is not valid JSON" surfaced
// straight to the user. Read the body as text first and parse it
// ourselves so a non-JSON response degrades to an honest, retryable
// message instead (same pattern as CompetitorCard.tsx's safeJson()).
async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(res.ok ? "Unexpected response from server" : "Server took too long to respond");
  }
  if (!res.ok) throw new Error(data.message || data.error || `Request to ${url} failed`);
  return data;
}

// A single phase step occasionally runs long enough (slow AI/Rainforest
// calls, a cold serverless start) to get killed by the platform's function
// timeout before it returns a response — the fetch() just fails with a
// network error, even though the step may have partially succeeded. Retrying
// is safe: /continue always re-reads the current persisted phase and only
// ever advances it by one, so a retry either resumes cleanly or repeats a
// no-op. Without this, a single transient timeout permanently stranded the
// analysis (confirmed happening in production — analyses stuck mid-phase
// with no error recorded, since the failure never reached the server).
async function fetchJsonWithRetry(url: string, init: RequestInit | undefined, onRetry: (attempt: number) => void, retries = 2): Promise<any> {
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJson(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        onRetry(attempt + 1);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

export function ProgressPanel({ analysisId, productName, onComplete, onError, onCancelled }: Props) {
  const [phases, setPhases] = useState<PhaseState[]>(
    PHASE_LABELS.map((label) => ({
      status: "waiting",
      label,
      message: "Waiting to start…",
    }))
  );
  const [totalSearches, setTotalSearches] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [identity, setIdentity] = useState<any>(null);
  const [brandProgress, setBrandProgress] = useState<BrandProgress | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [submittingAnswer, setSubmittingAnswer] = useState(false);
  const [failedMessage, setFailedMessage] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);

  // While this results-are-generating screen is showing, the persistent
  // BackgroundStage (mounted in Shell.tsx) swaps to the "waiting/generating"
  // GIF-2 video instead of /dashboard/analyze's own default background —
  // cleared on unmount so the route's normal background resumes.
  useEffect(() => {
    useBackgroundStageStore.getState().setOverride("gif-2");
    return () => useBackgroundStageStore.getState().clearOverride();
  }, []);
  const [runToken, setRunToken] = useState(0);
  const startTime = useRef(Date.now());
  const timerRef = useRef<NodeJS.Timeout>();
  // Separate from timerRef — polls GET /api/analyses/[id] WHILE the Phase 1
  // POST /continue call is still in flight, so the legacy-brand panel
  // updates live as each brand actually resolves server-side (see
  // lib/legacy-brand-discovery.ts's onBrandProgress). Must be cleared
  // everywhere timerRef already is (retry, unmount, AND right after the
  // phase-1 POST resolves) or a retry leaks an orphaned poller.
  const brandProgressIntervalRef = useRef<NodeJS.Timeout>();
  const resumeRef = useRef<(() => void) | null>(null);

  function stopBrandProgressPolling() {
    if (brandProgressIntervalRef.current) {
      clearInterval(brandProgressIntervalRef.current);
      brandProgressIntervalRef.current = undefined;
    }
  }

  function startBrandProgressPolling() {
    if (brandProgressIntervalRef.current) return;
    brandProgressIntervalRef.current = setInterval(async () => {
      try {
        const { analysis: latest } = await fetchJson(`/api/analyses/${analysisId}`);
        if (latest?.phase1_brand_progress) setBrandProgress(latest.phase1_brand_progress);
      } catch {
        // Best-effort — a single failed poll just tries again next tick,
        // never surfaces as a user-facing error (the main phase POST below
        // is the real source of truth/error reporting).
      }
    }, 1500);
  }

  useEffect(() => {
    let cancelled = false;
    startTime.current = Date.now();
    timerRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime.current) / 1000));
    }, 1000);

    // The pipeline runs one phase per POST .../continue call — this loop
    // drives it phase by phase. Since every phase is persisted server-side
    // before this call returns, a page refresh mid-analysis just resumes
    // from whatever phase is saved, instead of losing progress.
    async function run() {
      const results: any = {};
      let searchesSoFar = 0;

      try {
        let { analysis } = await fetchJsonWithRetry(`/api/analyses/${analysisId}`, undefined, () => {});
        if (analysis.phase0_result && Object.keys(analysis.phase0_result).length) {
          results.identity = analysis.phase0_result;
          setIdentity(analysis.phase0_result);
          setPhases((prev) => prev.map((p, i) => (i === 0 ? { ...p, status: "complete", message: "Complete" } : p)));
        }
        if (analysis.related_products?.length) {
          results.relatedProducts = analysis.related_products;
        }
        if (analysis.phase1_result && Object.keys(analysis.phase1_result).length) {
          results.phase1 = analysis.phase1_result;
          setPhases((prev) => prev.map((p, i) => (i === 1 ? { ...p, status: "complete", message: "Complete" } : p)));
        }
        if (analysis.phase2_result && Object.keys(analysis.phase2_result).length) {
          results.phase2 = analysis.phase2_result;
          setPhases((prev) => prev.map((p, i) => (i === 2 ? { ...p, status: "complete", message: "Complete" } : p)));
        }

        while (!cancelled) {
          if (analysis.status === "complete") {
            setPhases((prev) => prev.map((p) => ({ ...p, status: "complete", message: "Complete" })));
            onComplete({
              identity: results.identity || identity,
              phase1: results.phase1 || {},
              phase2: results.phase2 || {},
              phase3: analysis.phase3_result || results.phase3 || {},
              relatedProducts: analysis.related_products || results.relatedProducts || [],
              productName,
              totalSearches: searchesSoFar,
              reportId: results.reportId,
            });
            return;
          }
          if (analysis.status === "failed") {
            throw new Error(analysis.error_message || "Analysis failed");
          }

          // The pipeline paused for a clarifying answer — either Phase 0
          // (product identity unclear) or Phase 1 (no target price
          // resolvable, see lib/analysisEngine.ts's resolveDiscoveryTargetPrice).
          // analysis.phase is whichever phase is actually paused (it's never
          // advanced past while a question is pending), so the "waiting"
          // highlight lands on the right step instead of always phase 0.
          if (analysis.pending_question) {
            setPhases((prev) => prev.map((p, i) => (i === analysis.phase ? { ...p, status: "running", message: "Waiting for your answer…" } : p)));
            await new Promise<void>((resolve) => { resumeRef.current = resolve; setPendingQuestion(analysis.pending_question); });
            if (cancelled) return;
            setPendingQuestion(null);
            const refreshed = await fetchJsonWithRetry(`/api/analyses/${analysisId}`, undefined, () => {});
            analysis = refreshed.analysis;
            continue;
          }

          // 0, 1, 2, or 3 — the phase about to run. DB phase 4 is Phase 3's
          // own internal checkpoint (see lib/analysisEngine.ts) — still
          // conceptually "phase 3 running" from the UI's point of view, so a
          // page reload mid-checkpoint still highlights the right row instead
          // of highlighting nothing.
          const runningIdx = analysis.phase === 4 ? 3 : analysis.phase;
          setPhases((prev) =>
            prev.map((p, i) => (i === runningIdx ? { ...p, status: "running", message: "Running…" } : p))
          );

          // Phase 1 (legacy/established competitors) may run a curated
          // brand-by-brand search server-side (lib/legacy-brand-discovery.ts)
          // before this POST resolves — poll for its live progress in
          // parallel so the brand panel below updates in real time, not just
          // once the whole phase completes.
          if (runningIdx === 1) startBrandProgressPolling();

          const { analysis: updated, step } = await fetchJsonWithRetry(
            `/api/analyses/${analysisId}/continue`,
            { method: "POST" },
            (attempt) =>
              setPhases((prev) =>
                prev.map((p, i) => (i === runningIdx ? { ...p, message: `Connection dropped — retrying (${attempt})…` } : p))
              )
          );
          stopBrandProgressPolling();
          if (cancelled) return;

          searchesSoFar += step.totalSearches || 0;
          setTotalSearches(searchesSoFar);

          if (step.status === "failed") {
            throw new Error(step.error || "Analysis failed");
          }

          if (step.pendingQuestion) {
            analysis = updated;
            continue;
          }

          // step.stepResult is null on an intermediate checkpoint response
          // (e.g. Phase 2a's own completion still reports phase: 2, per
          // lib/analysisEngine.ts's __phase2Stage pattern) — guarding on it
          // here stops that null from clobbering a real result an earlier
          // call at the SAME phase number already populated. Confirmed live:
          // without this guard, Phase 2a's completion wiped out Phase 1's
          // already-correct results.phase1 (and the same shape of bug would
          // hit results.identity too), and onComplete's payload has no DB
          // fallback on this live (non-resume) path.
          if (step.phase === 1 && step.stepResult) {
            results.identity = step.stepResult;
            setIdentity(step.stepResult);
          }
          if (step.phase === 2) {
            // Phase 1 is fully done — the completed competitor list (with
            // tier badges/out-of-band labels) takes over from here; the
            // live search-in-progress chip panel has served its purpose.
            setBrandProgress(null);
            if (step.stepResult) results.phase1 = step.stepResult;
          }
          if (step.phase === 3 && step.stepResult) results.phase2 = step.stepResult;
          if (step.phase === 5) {
            results.phase3 = step.stepResult;
            results.reportId = step.reportId;
          }

          // phase 4 is Phase 3's own internal checkpoint (lib/analysisEngine.ts
          // splits the synthesis/anti-boilerplate-check/citation-verification
          // work that used to be one request into up to three, to stay under
          // Vercel's 60s cap) — status is still "running" at that point, so
          // the Synthesizing row should keep spinning, not flip to Complete
          // a beat early.
          if (step.phase !== 4) {
            const completedIdx = step.phase === 5 ? 3 : step.phase - 1;
            setPhases((prev) =>
              prev.map((p, i) => (i === completedIdx ? { ...p, status: "complete", message: "Complete" } : p))
            );
          }

          analysis = updated;
        }
      } catch (err: any) {
        if (cancelled) return;
        clearInterval(timerRef.current);
        stopBrandProgressPolling();
        setPhases((prev) =>
          prev.map((p) => (p.status === "running" ? { ...p, status: "error", message: err.message } : p))
        );
        // Stay mounted with a Retry affordance instead of immediately bouncing
        // back to the empty form — /continue always re-reads the persisted
        // phase and only advances it by one, so resuming from here is safe
        // (see fetchJsonWithRetry's comment above). onError is now only
        // invoked if the user explicitly chooses to give up (see the
        // "Start new analysis instead" button below).
        setFailedMessage(err.message || "Analysis failed");
      }
    }

    run();

    return () => {
      cancelled = true;
      clearInterval(timerRef.current);
      stopBrandProgressPolling();
    };
  }, [analysisId, runToken]);

  function handleRetry() {
    setFailedMessage(null);
    setPhases(PHASE_LABELS.map((label) => ({ status: "waiting", label, message: "Waiting to start…" })));
    setBrandProgress(null);
    setRunToken((t) => t + 1);
  }

  // Unmounting this component (the parent flips viewState away from
  // "running" inside onCancelled) already stops the polling loop via the
  // effect's own cleanup (`cancelled = true`) — no AbortController needed.
  // resumeRef.current?.() unblocks a pending-question await first, so a
  // cancel click during a pause-and-ask doesn't leave that promise dangling.
  // The server-side cancel call is best-effort: even if it fails, the client
  // stops immediately, and any stray in-flight /continue still gets caught by
  // the "cancelled" terminal-status guard in lib/analysisEngine.ts.
  async function handleCancel() {
    if (canceling) return;
    setCanceling(true);
    resumeRef.current?.();
    try {
      await fetchJson(`/api/analyses/${analysisId}/cancel`, { method: "POST" });
    } catch {
      // Best-effort — see comment above.
    }
    onCancelled();
  }

  async function submitAnswer() {
    if (!answerText.trim() || submittingAnswer) return;
    setSubmittingAnswer(true);
    try {
      const res = await fetch(`/api/analyses/${analysisId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: answerText.trim() }),
      });
      if (!res.ok) throw new Error("Failed to submit answer");
      setAnswerText("");
      resumeRef.current?.();
    } catch (err) {
      // Leave the question visible — the user can retry submitting.
    } finally {
      setSubmittingAnswer(false);
    }
  }

  const formatTime = (s: number) =>
    `${Math.floor(s / 60)}m ${s % 60}s`;

  const completedCount = phases.filter((p) => p.status === "complete").length;

  return (
    <div className="analysis-progress-panel bg-surface-2 border border-border rounded-xl overflow-hidden mb-6 shadow-xl text-xs">
      {/* Top bar */}
      <div className="progress-topbar flex items-center justify-between px-5 py-3 border-b border-border bg-surface-3/30">
        <div className="progress-meta text-[11px] text-text-muted font-mono">
          <span className="product-label font-bold text-text-primary">{productName}</span>
          <span className="mx-1.5">·</span>
          <span className="search-count">{totalSearches} web searches</span>
          <span className="mx-1.5">·</span>
          <span className="elapsed">{formatTime(elapsedSeconds)}</span>
        </div>
        <div className="flex items-center gap-3">
          {pendingQuestion ? (
            <div className="status-running flex items-center gap-1.5 text-[11px] text-warning font-semibold">
              <HelpCircle className="w-3.5 h-3.5" />
              <span>Waiting for your input…</span>
            </div>
          ) : (
            <div className="status-running flex items-center gap-1.5 text-[11px] text-accent font-semibold">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Analyzing…</span>
            </div>
          )}
          {!failedMessage && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={canceling}
              className="flex items-center gap-1 px-2 py-1 border border-border hover:bg-danger-bg hover:border-danger/30 hover:text-danger text-text-muted text-[10px] font-semibold rounded-md transition-colors disabled:opacity-50"
            >
              <XCircle className="w-3 h-3" />
              {canceling ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </div>
      </div>

      {/* Overall progress bar — derived from completed phase count. */}
      <div className="h-1 bg-surface-3">
        <div
          className="h-full bg-accent transition-[width] duration-[250ms] ease-[var(--ease-out)]"
          style={{ width: `${(completedCount / PHASE_LABELS.length) * 100}%` }}
        />
      </div>

      {/* Product Identity Card — shown as soon as Stage 1 completes, so a
          wrong identification is visible immediately. */}
      {identity && (identity.category || identity.whatItIs) && (
        <div className="mx-5 mt-4">
            <div className="p-3 bg-surface-3/30 border border-border rounded-lg">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Identified Product</span>
                {identity.confidence && (
                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                    identity.confidence === "high" ? "bg-success/10 border-success/30 text-success" :
                    identity.confidence === "medium" ? "bg-warning/10 border-warning/25 text-warning" :
                    "bg-danger/10 border-danger/30 text-danger"
                  }`}>{identity.confidence} confidence</span>
                )}
              </div>
              <div className="mt-1 text-[11px] text-text-primary font-semibold">
                {identity.category}{identity.subcategory && identity.subcategory !== identity.category ? ` / ${identity.subcategory}` : ""}
              </div>
              {identity.whatItIs && <p className="mt-1 text-[10px] text-text-secondary leading-relaxed">{identity.whatItIs}</p>}
              {Array.isArray(identity.evidence) && identity.evidence.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {identity.evidence.slice(0, 3).map((e: any, i: number) => (
                    e.url ? (
                      <a key={i} href={e.url} target="_blank" rel="noopener noreferrer" className="text-[9px] text-accent hover:underline">
                        source {i + 1}
                      </a>
                    ) : null
                  ))}
                </div>
              )}
            </div>
        </div>
      )}

      {/* Legacy brand registry — live per-brand search status while Phase 1
          runs its curated-brand discovery pass (lib/legacy-brand-discovery.ts),
          polled via startBrandProgressPolling() above. Disappears once
          Phase 1 completes (setBrandProgress(null)) — the completed
          competitor list takes over from there. */}
      {brandProgress && Array.isArray(brandProgress.brands) && brandProgress.brands.length > 0 && (
        <div className="mx-5 mt-4">
            <div className="p-3 bg-surface-3/30 border border-border rounded-lg">
              <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">
                Legacy brands being searched{brandProgress.category_name ? ` — ${brandProgress.category_name}` : ""}
              </span>
              {(brandProgress.motor_label || brandProgress.tool_type_label || (brandProgress.price_band_low != null && brandProgress.price_band_high != null)) && (
                <p className="mt-1 text-[10px] text-text-secondary italic">
                  Searching: {[
                    [brandProgress.motor_label, brandProgress.tool_type_label ? `${brandProgress.tool_type_label}s` : null].filter(Boolean).join(" "),
                    brandProgress.target_market_label ? `${TARGET_MARKET_SUMMARY_LABELS[brandProgress.target_market_label] || brandProgress.target_market_label} brand list` : null,
                    brandProgress.price_band_low != null && brandProgress.price_band_high != null ? `$${brandProgress.price_band_low.toFixed(0)}–$${brandProgress.price_band_high.toFixed(0)}` : null,
                  ].filter(Boolean).join(" · ")}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {brandProgress.brands.map((b, i) => (
                  <span
                    key={i}
                    title={b.reason || undefined}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border ${
                      b.status === "found"
                        ? "bg-success/10 border-success/30 text-success"
                        : b.status === "not_found"
                        ? "bg-danger/10 border-danger/25 text-danger"
                        : "bg-surface-3 border-border text-text-muted"
                    }`}
                  >
                    {b.brand}
                    {b.status === "found" && (
                      <span className="inline-flex items-center gap-0.5">
                        <CheckCircle className="w-2.5 h-2.5 shrink-0" />
                        {b.price ? ` ${b.price}` : ""}{b.motorMatched ? " · motor match" : ""}{b.source ? ` (${SOURCE_LABELS[b.source] || b.source})` : ""}
                      </span>
                    )}
                    {b.status === "not_found" && (
                      <span className="inline-flex items-center gap-0.5">
                        <XCircle className="w-2.5 h-2.5 shrink-0" />
                        {b.reason ? ` ${b.reason}` : ""}
                      </span>
                    )}
                    {b.status === "searching" && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                  </span>
                ))}
              </div>
            </div>
        </div>
      )}

      {/* Pause-and-ask: identification couldn't confidently determine the
          category — never guess, ask the one question needed instead. */}
      {pendingQuestion && (
        <div className="mx-5 mt-4">
            <div className="p-3.5 bg-warning/5 border border-warning/25 rounded-lg space-y-2">
              <div className="flex items-center gap-1.5 text-warning font-bold text-[11px]">
                <HelpCircle className="w-3.5 h-3.5" />
                <span>{pendingQuestion.question}</span>
              </div>
              {pendingQuestion.foundSoFar && (
                <p className="text-[10px] text-text-muted italic">What we found so far: {pendingQuestion.foundSoFar}</p>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={answerText}
                  onChange={(e) => setAnswerText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitAnswer()}
                  placeholder={pendingQuestion.placeholder || "e.g. beard trimmer"}
                  className="flex-1 px-2.5 py-1.5 border border-border rounded-lg bg-surface-1 text-text-primary text-[11px] outline-none focus:border-accent"
                  autoFocus
                />
                <button
                  onClick={submitAnswer}
                  disabled={!answerText.trim() || submittingAnswer}
                  className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-[11px] font-bold rounded-lg disabled:opacity-50 transition-colors"
                >
                  {submittingAnswer ? "Saving…" : "Continue"}
                </button>
              </div>
            </div>
        </div>
      )}

      {/* Phase list */}
      <div className="phase-list flex flex-col p-5 gap-4">
        {phases.map((phase, i) => (
          <div
            key={i}
            className={`phase-row flex items-start gap-3 transition-opacity ${
              phase.status === "waiting" ? "opacity-40" : "opacity-100"
            }`}
          >
            {/* Phase icon */}
            <div className="phase-icon w-6 h-6 flex items-center justify-center shrink-0 mt-0.5">
              {phase.status === "complete" ? (
                <CheckCircle className="w-5 h-5 text-success" />
              ) : phase.status === "error" ? (
                <AlertCircle className="w-5 h-5 text-danger" />
              ) : pendingQuestion && i === PENDING_QUESTION_PHASE_INDEX[pendingQuestion.field || "category"] ? (
                <HelpCircle className="w-5 h-5 text-warning" />
              ) : phase.status === "running" ? (
                <Loader2 className="w-5 h-5 text-accent animate-spin" />
              ) : (
                <span className="phase-number w-5 h-5 rounded-full border border-border-strong text-[10px] font-bold text-text-muted flex items-center justify-center">
                  {i + 1}
                </span>
              )}
            </div>

            {/* Phase text */}
            <div className="phase-text text-xs leading-normal">
              <div className="phase-label">
                <span className="phase-counter font-semibold text-text-muted text-[10px] uppercase tracking-wider">
                  Phase {i + 1} of {PHASE_LABELS.length}
                </span>
                <span className="mx-1.5 text-text-muted">—</span>
                <span
                  className={`phase-name font-bold ${
                    phase.status === "running"
                      ? "text-accent"
                      : phase.status === "complete"
                      ? "text-success"
                      : "text-text-primary"
                  }`}
                >
                  {phase.label}
                </span>
              </div>
              {phase.status === "running" && (
                <div className="phase-message text-[10px] text-text-muted mt-1 italic">
                  {phase.message}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Terminal failure — resumable in place instead of discarding progress
          back to the empty form; /continue is safe to call again (see the
          comment on fetchJsonWithRetry above). */}
      {failedMessage && (
        <div className="mx-5 mb-5 p-3.5 bg-danger-bg border border-danger/20 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2 text-danger">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{failedMessage}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleRetry}
              className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-[11px] font-bold rounded-lg transition-colors"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => onError(failedMessage)}
              className="px-3 py-1.5 border border-border hover:bg-surface-3 text-text-primary text-[11px] font-semibold rounded-lg transition-colors"
            >
              Start new analysis instead
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
