"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CompetitorCard, EmptySlotCard } from "./CompetitorCard";
import { Sparkles, FileText, CheckCircle2, TrendingUp, AlertTriangle, Lightbulb, UserCheck, Shield, Award, Download, Minus, Plus, Flag, Trash2 } from "lucide-react";
import { downloadReportPDF } from "@/lib/export-pdf";
import { CitationsSection, UnverifiedBadge, type Claim } from "./CitedClaim";
import type { KeyFeaturesResult } from "@/lib/key-features-resolver";
import { Spinner } from "@/components/ui/Spinner";
import { buildPricingAnalysis } from "@/lib/pricing-analysis";
import type { ToolTypeRow } from "@/lib/db/tool-types";
import { getToolTypeLabel } from "@/lib/tool-type-taxonomy";
import { CompetitorRemoveReasonValues } from "@/lib/validations";

// Bulk "Remove & refill" reason picker — same 5 values as CompetitorCard.tsx's
// own single-slot Remove panel (lib/validations.ts's
// CompetitorRemoveReasonValues is the authoritative list); duplicated here
// (rather than imported) since it's just display text for this file's own
// select, not shared logic.
const BULK_REMOVE_REASON_LABELS: Record<string, string> = {
  wrong_industry: "Wrong industry",
  wrong_product: "Wrong product",
  wrong_motor: "Wrong motor",
  not_comparable: "Not really comparable",
  other: "Other",
};

// Removed-slot placeholder's EmptySlotCard reason text — names what was
// removed and why (lib/analysisEngine.ts's removeCompetitorSlot placeholder
// shape: removed_brand/removed_name/removed_reason), so "Refill this slot"
// isn't the only context shown for a Remove + Refill vacated slot, as
// opposed to a genuinely-never-found empty slot from normal discovery.
function describeRemovedSlot(comp: any): string {
  const who = [comp.removed_brand, comp.removed_name].filter(Boolean).join(" ");
  const reasonText = comp.removed_reason ? (BULK_REMOVE_REASON_LABELS[comp.removed_reason] || comp.removed_reason).toLowerCase() : null;
  return `Removed${who ? ` ${who}` : ""}${reasonText ? ` (${reasonText})` : ""} — refill to search for a replacement.`;
}

// Fallback for a raw family/tech key (e.g. "brushless_dc") when no
// human-authored branded name was captured for this run — title-cases it
// rather than showing the raw snake_case key in the chip.
function prettifyKey(key: string): string {
  return key
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface ResultsPanelProps {
  analysis: {
    productName: string;
    totalSearches: number;
    pricePoint?: string;
    identity?: {
      category?: string;
      subcategory?: string;
      whatItIs?: string;
      confidence?: "high" | "medium" | "low";
      evidence?: { claim: string; url: string; quote: string }[];
    };
    phase1: {
      competitors: any[];
      matching_weights?: { motor: number; price: number; feature: number } | null;
      legacy_registry_snapshot?: { category_slug: string; category_name: string; brands: any[] } | null;
      form_inputs?: Record<string, any> | null;
      web_searches_performed?: number;
    };
    phase2: {
      competitors: any[];
      matching_weights?: { motor: number; price: number; feature: number } | null;
      form_inputs?: Record<string, any> | null;
      web_searches_performed?: number;
    };
    phase3: {
      amazon_category: string;
      market_snapshot: {
        headline_stat_value: string;
        overview_paragraph: string;
        data_source?: string;
        market_size_current?: string;
        market_size_year?: string;
        market_size_forecast?: string;
        forecast_year?: string;
        cagr_percent?: string;
        cagr_period?: string;
      };
      key_trends: Array<{
        trend_name: string;
        description: string;
        source?: string;
      }>;
      market_gaps: string[];
      top_threats: Array<{
        competitor_name: string;
        threat_description: string;
      }>;
      top_opportunities: Array<{
        action: string;
        description: string;
      }>;
      positioning_recommendation: string;
      // Absent on analyses run before this field existed — render guarded.
      target_buyer_persona?: {
        archetype_name: string;
        quote: string;
        age_range: string;
        household_income: string;
        life_stage: string;
        shopping_style: string;
        lifestyle_and_personality: string;
        // Absent on analyses run before this deeper set existed — render guarded.
        pain_points?: string;
        objections?: string;
        purchase_triggers?: string;
        messaging_that_resonates?: string;
        preferred_channels?: string;
      } | null;
      strategic_recommendations: Array<{
        priority: "high" | "medium" | "low";
        category: "product" | "marketing" | "positioning" | "pricing" | "partnerships";
        headline: string;
        explanation: string;
      }>;
      quick_wins: string[];
      // Server-verified claims (lib/citations.ts) — every factual claim
      // this analysis makes that isn't already directly backed by the
      // Phase 1/2 Amazon data above. Absent/empty when nothing was cited.
      citations?: Claim[];
      // Set by lib/analysisEngine.ts's replaceCompetitor when a swap left
      // this synthesis possibly naming a since-replaced competitor (a
      // substring scan, not a guarantee) — surfaces the regenerate banner
      // below rather than silently leaving stale text or auto-regenerating.
      synthesis_possibly_stale?: boolean;
    };
    // Related Products (up to 3, user-pasted on the analyze form) — a
    // genuinely separate array from phase1/phase2, never spread into
    // buildPricingAnalysis's input below, so medians/tiers never see them
    // unless one also independently earned a real phase1/phase2 slot (see
    // lib/analysisEngine.ts's buildRelatedProductSeeds). Empty/absent hides
    // the whole section.
    relatedProducts?: any[];
  };
  // Best-effort — lets each competitor's live per-section provenance writes
  // (lib/db/section-provenance.ts) carry a real analysis_id when one exists.
  // Never required: a missing id never blocks a provenance write.
  analysisId?: string | null;
  onSaveAsReport: () => void;
  savingReport: boolean;
  onNewAnalysis: () => void;
  // Bubbled up from CompetitorCard's editable-ASIN flow — the parent
  // (analyze/page.tsx) owns the actual analysisResult state and patches
  // phase1/phase2's competitors array in place.
  onCompetitorReplaced?: (oldAsin: string, updatedCompetitor: any, synthesisPossiblyStale: boolean) => void;
  // Related Products' "fixing a mispaste re-fetches in place" swap —
  // separate from onCompetitorReplaced since it patches a different array
  // (analysisResult.relatedProducts, not phase1/phase2.competitors) and
  // never touches synthesis-staleness (related products aren't named in
  // Phase 3 synthesis the way a selected competitor could be).
  onRelatedProductReplaced?: (oldAsin: string, updatedRelatedProduct: any) => void;
  // Triggers POST .../regenerate-synthesis then hands control back to the
  // parent's ProgressPanel view (same phase-3-only re-run, no new
  // state-machine code) — see the banner below.
  onRegenerateSynthesis?: () => void;
  regeneratingSynthesis?: boolean;
  // Remove + Refill single slot (Part 3) — these four are pure pass-through
  // down to CompetitorCard/EmptySlotCard at both the legacy and emerging
  // card-rendering sites below; this component owns no analysis state of
  // its own (analyze/page.tsx does), only the per-card "flag" checkbox
  // state and the bulk POST used by the "Remove & refill N flagged" button.
  // Bubbled straight from CompetitorCard's own onRemoved (a Trash2-triggered
  // single-slot Remove already POSTed by that card) up to the page's
  // handleCompetitorRemoved.
  onRemoved?: (asin: string, tier: string, placeholder: any, synthesisPossiblyStale: boolean) => void;
  // Bubbled straight from EmptySlotCard's own onRefillRequested (just the
  // removedAsin — EmptySlotCard never fetches itself) up to the page, which
  // performs the actual POST .../competitors/refill-slot call and tracks
  // its own loading state.
  onRefillRequested?: (removedAsin: string) => void;
  // Which removed slot's refill is currently in flight (page-owned state) —
  // threaded back down so only that one EmptySlotCard shows a spinner.
  refillingAsin?: string | null;
  // Fired after THIS component's own POST .../competitors/bulk-refill call
  // (the "Remove & refill N flagged" button below) resolves — unlike
  // onRemoved/onRefillRequested above, the bulk fetch itself lives here,
  // not in the page, since it's a whole-batch action this component
  // originates (the per-card flag checkboxes are local-only state).
  onBulkRefillComplete?: (results: any[]) => void;
}

// Which criterion actually scored a batch of competitors (motor_*/
// heat_tech_* fields are mutually exclusive per competitor, see
// lib/analysisEngine.ts's selectByCompositeScore) — null for a 'none'-
// criterion tool type, where the "prioritized by X" sentence below is
// skipped entirely rather than naming a criterion that never applied.
function describeCriterionForCompetitors(competitors: any[]): string | null {
  if (competitors.some(c => c.motor_match_tier)) return "motor type";
  if (competitors.some(c => c.heat_tech_match_tier)) return "plate/heat technology";
  return null;
}

export function ResultsPanel({ analysis, analysisId, onSaveAsReport, savingReport, onNewAnalysis, onCompetitorReplaced, onRelatedProductReplaced, onRegenerateSynthesis, regeneratingSynthesis, onRemoved, onRefillRequested, refillingAsin, onBulkRefillComplete }: ResultsPanelProps) {
  const { phase1, phase2, phase3, identity } = analysis;
  // A slot the fill loop couldn't fill (lib/analysisEngine.ts's
  // buildEmptySlotPlaceholder) renders as EmptySlotCard, not a real
  // competitor — counts/comparison-table columns must never include it.
  const phase1RealCompetitors = (phase1.competitors || []).filter((c: any) => !c.empty_slot);
  const phase2RealCompetitors = (phase2.competitors || []).filter((c: any) => !c.empty_slot);
  const relatedProducts = analysis.relatedProducts || [];
  const phase1CriterionLabel = describeCriterionForCompetitors(phase1RealCompetitors);
  const phase2CriterionLabel = describeCriterionForCompetitors(phase2RealCompetitors);
  // lib/analysisEngine.ts's nearest-similar fallback (selectByCompositeScore's
  // nearestSimilarMode) — a real, verified competitor seated only because no
  // exact-fit candidate was found after the full discovery ladder ran. Used
  // below for the compact per-tier header note.
  const phase1NearestMatchCount = phase1RealCompetitors.filter((c: any) => c.nearest_match).length;
  const phase2NearestMatchCount = phase2RealCompetitors.filter((c: any) => c.nearest_match).length;
  // Threaded into each CompetitorCard so its "Why this competitor" section
  // can name the actual differentiator a match was scored against, not
  // just show an unlabeled checkmark.
  const keyDiff: string | null = phase1.form_inputs?.keyDiff ?? phase2.form_inputs?.keyDiff ?? null;
  const [exporting, setExporting] = useState(false);
  // Populated as each CompetitorCard's own Key Features fetch resolves, so
  // the comparison table's Top Feature row can reuse real cited data
  // instead of re-running the resolver a second time.
  const [phase1Features, setPhase1Features] = useState<Record<number, KeyFeaturesResult>>({});
  const [phase2Features, setPhase2Features] = useState<Record<number, KeyFeaturesResult>>({});

  // Remove + Refill single slot (Part 3) — per-card "flag" checkbox, local
  // to this component only (never persisted, reset on unmount/re-analysis)
  // and the one shared reason for the whole "Remove & refill N flagged"
  // batch action. Real competitors only (never an already-empty slot) —
  // toggleFlag is only ever wired to CompetitorCard below, not EmptySlotCard.
  const [flaggedAsins, setFlaggedAsins] = useState<Set<string>>(new Set());
  const [bulkReason, setBulkReason] = useState<string>("other");
  const [bulkNote, setBulkNote] = useState("");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);

  function toggleFlag(asin: string) {
    setFlaggedAsins(prev => {
      const next = new Set(prev);
      if (next.has(asin)) next.delete(asin);
      else next.add(asin);
      return next;
    });
  }

  // The bulk fetch itself lives here (unlike the single-slot
  // remove/refill flows above, which the page performs) — this is a
  // whole-batch action this component originates from its own flag
  // checkboxes, not something CompetitorCard/EmptySlotCard triggers
  // individually.
  async function handleBulkRemoveRefill() {
    if (!analysisId || flaggedAsins.size === 0) return;
    setBulkSubmitting(true);
    try {
      const items = Array.from(flaggedAsins).map(asin => ({ asin, reason: bulkReason, note: bulkNote.trim() || undefined }));
      const res = await fetch(`/api/analyses/${analysisId}/competitors/bulk-refill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to remove/refill flagged competitors");
      onBulkRefillComplete?.(data.results || []);
      setFlaggedAsins(new Set());
      setBulkNote("");
    } catch (err: any) {
      toast.error(err.message || "Failed to remove/refill flagged competitors");
    } finally {
      setBulkSubmitting(false);
    }
  }

  // Fetched once here (not once per card) and threaded into every
  // CompetitorCard — lib/feature-flags.ts's isBuyerSentimentEnabled()/
  // isNewsUpdatesEnabled(). Default true (fail-open) until the fetch
  // resolves, matching this codebase's flag convention.
  const [buyerSentimentEnabled, setBuyerSentimentEnabled] = useState(true);
  const [newsUpdatesEnabled, setNewsUpdatesEnabled] = useState(true);
  useEffect(() => {
    fetch("/api/features")
      .then(res => res.json())
      .then(data => {
        if (typeof data.buyer_sentiment_enabled === "boolean") setBuyerSentimentEnabled(data.buyer_sentiment_enabled);
        if (typeof data.news_updates_enabled === "boolean") setNewsUpdatesEnabled(data.news_updates_enabled);
      })
      .catch(() => {});
  }, []);

  // Fetched once here and threaded into downloadReportPDF (lib/export-pdf.ts) —
  // that module renders client-side, with no other existing tool-types fetch
  // to reuse.
  const [toolTypes, setToolTypes] = useState<ToolTypeRow[]>([]);
  useEffect(() => {
    fetch("/api/tool-types")
      .then(res => res.json())
      .then(data => { if (Array.isArray(data.toolTypes)) setToolTypes(data.toolTypes); })
      .catch(() => {});
  }, []);

  // Same source phase1/phase2 already fall back to for the PDF export's
  // "Data Sources & Methodology" appendix (see handleExportPDF below) — the
  // pinned identity scene's chips reuse it rather than requiring new props
  // threaded down from analyze/page.tsx's own form state.
  const formInputs = phase1.form_inputs ?? phase2.form_inputs ?? null;
  const identityToolTypeLabel = formInputs?.toolType ? getToolTypeLabel(formInputs.toolType, toolTypes) : null;
  const identityMotorLabel = formInputs?.motorBrandedName
    ? formInputs.motorBrandedName
    : formInputs?.motorFamily
    ? prettifyKey(formInputs.motorFamily)
    : formInputs?.heatTechBrandedName
    ? formInputs.heatTechBrandedName
    : formInputs?.heatTechFamily
    ? prettifyKey(formInputs.heatTechFamily)
    : null;
  const identityPriceLabel = analysis.pricePoint || formInputs?.pricePoint || null;

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const reportData = {
        title: `Competitive Intelligence Report — ${analysis.productName}`,
        created_at: new Date().toISOString(),
        competitive_analysis: {
          product_name: analysis.productName,
          large_brand_competitors: phase1RealCompetitors,
          indie_emerging_competitors: phase2RealCompetitors,
          related_products: relatedProducts,
          market_snapshot: phase3.market_snapshot,
          key_trends: phase3.key_trends,
          market_gaps: phase3.market_gaps,
          top_threats: phase3.top_threats,
          top_opportunities: phase3.top_opportunities,
          positioning_recommendation: phase3.positioning_recommendation,
          strategic_recommendations: phase3.strategic_recommendations,
          quick_wins: phase3.quick_wins,
          citations: phase3.citations || [],
          matching_weights: phase1.matching_weights ?? phase2.matching_weights ?? null,
          form_inputs: phase1.form_inputs ?? phase2.form_inputs ?? null,
        },
        pricing_analysis: buildPricingAnalysis({
          competitors: [...phase1RealCompetitors, ...phase2RealCompetitors],
          targetPriceCandidates: [[analysis.pricePoint, "project_record"]],
          identity: analysis.identity,
        }),
        go_to_market: {
          recommendations: phase3.strategic_recommendations,
          quick_wins: phase3.quick_wins,
          positioning: phase3.positioning_recommendation,
          notes: "",
        },
        content_form: {
          product_name: analysis.productName,
          key_messages: (phase3.top_opportunities || []).map((o: any) => o.action || o.detail || o.description || ""),
          target_audience: "",
          notes: "",
        }
      };
      await downloadReportPDF(reportData, toolTypes);
    } catch (err) {
      console.error("PDF generation failed:", err);
    } finally {
      setExporting(false);
    }
  };

  // Sorting strategic recommendations: High -> Medium -> Low
  const sortedRecommendations = [...(phase3.strategic_recommendations || [])].sort((a, b) => {
    const priorities = { high: 1, medium: 2, low: 3 };
    return priorities[a.priority] - priorities[b.priority];
  });

  return (
    <div className="results-panel space-y-8">
      {/* SUCCESS BANNER & TOP BAR */}
      <div className="results-topbar flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-surface-2 border border-border rounded-xl">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-success shrink-0" />
            <h1 className="text-sm font-bold text-text-primary">Analysis — {analysis.productName}</h1>
          </div>
          <div className="results-meta text-[11px] text-text-muted font-mono leading-none">
            <span>{phase3.amazon_category || "Market Analysis"}</span>
            <span className="mx-2">·</span>
            <span>{phase1RealCompetitors.length + phase2RealCompetitors.length} products mapped</span>
            <span className="mx-2">·</span>
            <span>{analysis.totalSearches ?? 0} web searches performed</span>
          </div>
        </div>

        <div className="results-actions flex items-center gap-2 self-end md:self-auto">
          <button
            onClick={onNewAnalysis}
            className="px-4 py-2 border border-border bg-surface-3/40 hover:bg-surface-3 text-text-primary text-xs font-bold rounded-lg transition-colors"
          >
            New analysis
          </button>
          <button
            onClick={handleExportPDF}
            disabled={exporting}
            className="flex items-center gap-1.5 px-4 py-2 border border-border bg-surface-3/45 hover:bg-surface-3 text-text-primary text-xs font-bold rounded-lg transition-colors shadow-sm disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export to PDF</span>
          </button>
          <button
            onClick={onSaveAsReport}
            disabled={savingReport}
            className="flex items-center gap-1.5 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-xs font-bold rounded-lg transition-colors shadow shadow-accent/20 disabled:opacity-50"
          >
            {savingReport ? (
              <Spinner size="sm" className="text-white" />
            ) : (
              <FileText className="w-3.5 h-3.5" />
            )}
            <span>View saved report</span>
          </button>
        </div>
      </div>

      {/* IDENTIFIED PRODUCT — shown so a wrong identification is caught
          immediately, not buried inside the market analysis text. */}
      {identity && (identity.category || identity.whatItIs) && (
        <div className="p-4 bg-surface-2 border border-border rounded-xl space-y-1.5">
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
          <div className="text-xs text-text-primary font-semibold">
            {identity.category}{identity.subcategory && identity.subcategory !== identity.category ? ` / ${identity.subcategory}` : ""}
          </div>
          {(identityToolTypeLabel || identityMotorLabel || identityPriceLabel) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {identityToolTypeLabel && (
                <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-surface-3 border border-border text-text-secondary uppercase">
                  {identityToolTypeLabel}
                </span>
              )}
              {identityMotorLabel && (
                <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-surface-3 border border-border text-text-secondary uppercase">
                  {identityMotorLabel}
                </span>
              )}
              {identityPriceLabel && (
                <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-accent-bg border border-accent-border text-accent-text uppercase">
                  {identityPriceLabel}
                </span>
              )}
            </div>
          )}
          {identity.whatItIs && <p className="text-[11px] text-text-secondary leading-relaxed">{identity.whatItIs}</p>}
          {Array.isArray(identity.evidence) && identity.evidence.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-0.5">
              {identity.evidence.slice(0, 4).map((e, i) => (
                e.url ? (
                  <a key={i} href={e.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-accent hover:underline" title={e.claim}>
                    evidence {i + 1}
                  </a>
                ) : null
              ))}
            </div>
          )}
        </div>
      )}

      {/* Synthesis-stale banner — a competitor swap (CompetitorCard's
          editable-ASIN flow) may have left this section naming a since-
          replaced competitor (lib/analysisEngine.ts's
          phase3MentionsCompetitor, a substring scan, not a guarantee).
          Manual regenerate only — never automatic, since a full Phase 3
          re-run is a real AI call. */}
      {phase3.synthesis_possibly_stale && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/10 px-5 py-3">
          <p className="text-xs text-warning">
            Strategy recommendations below may reference a competitor that&apos;s since been replaced.
          </p>
          <button
            type="button"
            onClick={onRegenerateSynthesis}
            disabled={regeneratingSynthesis || !onRegenerateSynthesis}
            className="px-3 py-1.5 text-[11px] font-semibold bg-warning/20 hover:bg-warning/30 text-warning rounded-lg transition-colors disabled:opacity-50 shrink-0"
          >
            {regeneratingSynthesis ? "Regenerating…" : "Regenerate"}
          </button>
        </div>
      )}

      {/* Remove + Refill single slot (Part 3) — bulk action bar, shown only
          once at least one real competitor (either tier) has been flagged
          via its own card's checkbox below. One shared reason for the
          whole batch keeps this simple rather than asking per-item. */}
      {flaggedAsins.size > 0 && (
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/5 px-5 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <Flag className="w-3.5 h-3.5 text-danger shrink-0" />
            <span>{flaggedAsins.size} competitor{flaggedAsins.size === 1 ? "" : "s"} flagged.</span>
            <label className="flex items-center gap-1.5 text-[10px] text-text-muted">
              Reason:
              <select
                value={bulkReason}
                onChange={(e) => setBulkReason(e.target.value)}
                disabled={bulkSubmitting}
                className="px-2 py-1 text-[10px] border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
              >
                {CompetitorRemoveReasonValues.map((reasonValue) => (
                  <option key={reasonValue} value={reasonValue}>{BULK_REMOVE_REASON_LABELS[reasonValue]}</option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            onClick={handleBulkRemoveRefill}
            disabled={bulkSubmitting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold bg-danger hover:bg-danger/90 text-white rounded-lg transition-colors disabled:opacity-50 shrink-0 self-end md:self-auto"
          >
            {bulkSubmitting ? <Spinner size="xs" className="text-white" /> : <Trash2 className="w-3.5 h-3.5" />}
            <span>{bulkSubmitting ? "Removing & refilling…" : `Remove & refill ${flaggedAsins.size} flagged`}</span>
          </button>
        </div>
      )}

      {/* 1. MARKET ANALYSIS SECTION */}
      <section className="results-section bg-surface-2 border border-border rounded-xl p-6 md:p-8 space-y-6">
        <div className="flex items-center gap-2 pb-3 border-b border-border/60">
          <TrendingUp className="w-5 h-5 text-accent" />
          <h2 className="text-base font-bold text-text-primary tracking-tight">Market Analysis</h2>
        </div>

        {/* Market Snapshot */}
        <div className="subsection space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="subsection-heading text-xs font-bold text-text-muted uppercase tracking-wider">Market Snapshot</h3>
            
            {/* Verified Data Badges */}
            <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
              <span className="px-2 py-0.5 rounded-full bg-surface-1 border border-border text-text-primary font-medium">
                ✓ {phase3.market_snapshot?.data_source || "Verified Industry Analytics"}
              </span>
              <span className="px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-400 font-medium">
                🔍 Google Custom Search
              </span>
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-medium">
                ● Live Amazon (Rainforest API)
              </span>
            </div>
          </div>

          {/* Market Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="p-3 bg-surface-1 border border-border rounded-lg">
              <span className="text-[9px] uppercase tracking-wider font-mono text-text-muted block mb-1">Market Size ({phase3.market_snapshot?.market_size_year || "Current"})</span>
              <span className="text-lg font-black text-text-primary">{phase3.market_snapshot?.market_size_current || "N/A"}</span>
            </div>
            <div className="p-3 bg-surface-1 border border-border rounded-lg">
              <span className="text-[9px] uppercase tracking-wider font-mono text-text-muted block mb-1">Forecast ({phase3.market_snapshot?.forecast_year || "Forecast"})</span>
              <span className="text-lg font-black text-text-primary">{phase3.market_snapshot?.market_size_forecast || "N/A"}</span>
            </div>
            <div className="p-3 bg-surface-1 border border-border rounded-lg">
              <span className="text-[9px] uppercase tracking-wider font-mono text-text-muted block mb-1">CAGR ({phase3.market_snapshot?.cagr_period || "Growth Period"})</span>
              <span className="text-lg font-black text-accent">{phase3.market_snapshot?.cagr_percent || "N/A"}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-start pt-2">
            {/* Growth Stat Card */}
            <div className="growth-stat-card p-4 border border-border bg-surface-3/20 rounded-xl space-y-1.5 md:col-span-1">
              {(phase3.market_snapshot as any)?.headline_stat_label === "unavailable" ? (
                <UnverifiedBadge title="No verifiable public market-size figure was found for this category — showing this honestly instead of an invented number." />
              ) : (
                <span className="growth-label inline-flex px-1.5 py-0.5 rounded text-[8px] font-bold bg-success-bg border border-success/20 text-success uppercase tracking-wider">
                  growth
                </span>
              )}
              <p className="growth-value text-sm font-black text-text-primary leading-tight">
                {phase3.market_snapshot?.headline_stat_value || "Market Growth Analysis"}
              </p>
              {phase3.market_snapshot?.data_source && (
                <p className="text-[9px] text-text-muted italic">Source: {phase3.market_snapshot.data_source}</p>
              )}
            </div>

            {/* Overview Paragraph */}
            <p className="market-overview text-xs text-text-secondary leading-relaxed md:col-span-3">
              {phase3.market_snapshot?.overview_paragraph}
            </p>
          </div>

          {/* Key Trends */}
          <div className="trends-block space-y-3 pt-3 border-t border-border/40">
            <h4 className="block-label text-[10px] font-bold text-text-muted uppercase tracking-wider">Key Trends</h4>
            <ul className="trends-list grid grid-cols-1 gap-2.5 text-xs">
              {phase3.key_trends?.map((trend, i) => (
                <li key={i} className="trend-item flex items-start gap-2.5 leading-normal">
                  <span className="trend-bullet text-accent font-bold mt-0.5">•</span>
                  <div className="text-text-secondary space-y-0.5">
                    <p>
                      <strong className="text-text-primary font-semibold">{trend.trend_name}:</strong>{" "}
                      {trend.description}
                    </p>
                    {trend.source && (
                      <span className="text-[10px] text-text-muted font-mono inline-block">[Source: {trend.source}]</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Market Gaps */}
        <div className="subsection space-y-3 pt-4 border-t border-border/40">
          <h3 className="subsection-heading text-xs font-bold text-text-muted uppercase tracking-wider">Market Gaps</h3>
          <ul className="gaps-list grid grid-cols-1 gap-2 text-xs">
            {phase3.market_gaps?.map((gap, i) => (
              <li key={i} className="gap-item flex items-start gap-2.5 leading-normal">
                <span className="gap-bullet text-text-muted font-bold mt-0.5">·</span>
                <span className="text-text-secondary">{gap}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Top Threats */}
        <div className="subsection space-y-3 pt-4 border-t border-border/40">
          <h3 className="subsection-heading text-xs font-bold text-text-muted uppercase tracking-wider flex items-center gap-1">
            <AlertTriangle className="w-4 h-4 text-danger" />
            <span>Top Threats</span>
          </h3>
          <ul className="threats-list grid grid-cols-1 gap-2 text-xs">
            {phase3.top_threats?.map((threat, i) => (
              <li key={i} className="threat-item flex items-start gap-2.5 leading-normal">
                <span className="threat-bullet text-danger font-bold mt-0.5"><Minus className="w-3 h-3" /></span>
                <p className="text-text-secondary">
                  <strong className="text-text-primary font-semibold">{threat.competitor_name}:</strong>{" "}
                  {threat.threat_description}
                </p>
              </li>
            ))}
          </ul>
        </div>

        {/* Top Opportunities */}
        <div className="subsection space-y-3 pt-4 border-t border-border/40">
          <h3 className="subsection-heading text-xs font-bold text-text-muted uppercase tracking-wider flex items-center gap-1">
            <Lightbulb className="w-4 h-4 text-success" />
            <span>Top Opportunities</span>
          </h3>
          <ul className="opps-list grid grid-cols-1 gap-2 text-xs">
            {phase3.top_opportunities?.map((opp, i) => (
              <li key={i} className="opp-item flex items-start gap-2.5 leading-normal">
                <span className="opp-bullet text-success font-bold mt-0.5"><Plus className="w-3 h-3" /></span>
                <p className="text-text-secondary">
                  <strong className="text-text-primary font-semibold">{opp.action}:</strong>{" "}
                  {opp.description}
                </p>
              </li>
            ))}
          </ul>
        </div>

        {/* Positioning Recommendation */}
        <div className="subsection positioning-card p-5 border border-accent/30 bg-accent-bg/5 rounded-xl space-y-2">
          <h3 className="subsection-heading text-xs font-bold text-accent-text uppercase tracking-wider flex items-center gap-1">
            <UserCheck className="w-4 h-4 text-accent" />
            <span>Positioning Recommendation</span>
          </h3>
          <p className="text-xs text-text-secondary leading-relaxed">{phase3.positioning_recommendation}</p>
        </div>

        {/* Target Buyer Persona */}
        {phase3.target_buyer_persona && (
          <div className="subsection persona-card p-5 border border-accent/30 bg-accent-bg/5 rounded-xl space-y-3">
            <h3 className="subsection-heading text-xs font-bold text-accent-text uppercase tracking-wider flex items-center gap-1">
              <UserCheck className="w-4 h-4 text-accent" />
              <span>Target Buyer Persona</span>
            </h3>
            <div>
              <p className="text-sm font-semibold text-text-primary">{phase3.target_buyer_persona.archetype_name}</p>
              <p className="text-xs text-text-secondary italic mt-1">&ldquo;{phase3.target_buyer_persona.quote}&rdquo;</p>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div>
                <span className="text-text-muted uppercase tracking-wide text-[10px]">Age Range</span>
                <p className="text-text-secondary">{phase3.target_buyer_persona.age_range}</p>
              </div>
              <div>
                <span className="text-text-muted uppercase tracking-wide text-[10px]">Household Income</span>
                <p className="text-text-secondary">{phase3.target_buyer_persona.household_income}</p>
              </div>
              <div>
                <span className="text-text-muted uppercase tracking-wide text-[10px]">Life Stage</span>
                <p className="text-text-secondary">{phase3.target_buyer_persona.life_stage}</p>
              </div>
              <div>
                <span className="text-text-muted uppercase tracking-wide text-[10px]">Shopping Style</span>
                <p className="text-text-secondary">{phase3.target_buyer_persona.shopping_style}</p>
              </div>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">{phase3.target_buyer_persona.lifestyle_and_personality}</p>
            {(phase3.target_buyer_persona.pain_points || phase3.target_buyer_persona.objections || phase3.target_buyer_persona.purchase_triggers || phase3.target_buyer_persona.messaging_that_resonates || phase3.target_buyer_persona.preferred_channels) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-border/40 text-xs">
                {phase3.target_buyer_persona.pain_points && (
                  <div>
                    <span className="text-text-muted uppercase tracking-wide text-[10px]">Pain Points</span>
                    <p className="text-text-secondary">{phase3.target_buyer_persona.pain_points}</p>
                  </div>
                )}
                {phase3.target_buyer_persona.objections && (
                  <div>
                    <span className="text-text-muted uppercase tracking-wide text-[10px]">Objections</span>
                    <p className="text-text-secondary">{phase3.target_buyer_persona.objections}</p>
                  </div>
                )}
                {phase3.target_buyer_persona.purchase_triggers && (
                  <div>
                    <span className="text-text-muted uppercase tracking-wide text-[10px]">Purchase Triggers</span>
                    <p className="text-text-secondary">{phase3.target_buyer_persona.purchase_triggers}</p>
                  </div>
                )}
                {phase3.target_buyer_persona.messaging_that_resonates && (
                  <div>
                    <span className="text-text-muted uppercase tracking-wide text-[10px]">Messaging That Resonates</span>
                    <p className="text-text-secondary">{phase3.target_buyer_persona.messaging_that_resonates}</p>
                  </div>
                )}
                {phase3.target_buyer_persona.preferred_channels && (
                  <div className="sm:col-span-2">
                    <span className="text-text-muted uppercase tracking-wide text-[10px]">Preferred Channels</span>
                    <p className="text-text-secondary">{phase3.target_buyer_persona.preferred_channels}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <CitationsSection claims={phase3.citations || []} />
      </section>

      {/* 2. STRATEGIC RECOMMENDATIONS SECTION */}
      <section className="results-section bg-surface-2 border border-border rounded-xl p-6 md:p-8 space-y-6">
        <div className="flex items-center gap-2 pb-3 border-b border-border/60">
          <Shield className="w-5 h-5 text-accent" />
          <h2 className="text-base font-bold text-text-primary tracking-tight">Strategic Recommendations</h2>
        </div>

        {/* Priority Sorted Cards */}
        <div className="recommendations-list grid grid-cols-1 md:grid-cols-2 gap-4">
          {sortedRecommendations.map((rec, i) => (
            <div
              key={i}
              className={`rec-card p-4 border rounded-xl space-y-2.5 text-xs relative overflow-hidden transition-all hover:translate-y-[-2px] ${
                rec.priority === "high"
                  ? "border-danger/35 bg-danger-bg/5"
                  : rec.priority === "medium"
                  ? "border-warning/35 bg-warning-bg/5"
                  : "border-border bg-surface-3/20"
              }`}
            >
              <div className="rec-badges flex items-center gap-1.5">
                <span
                  className={`priority-badge px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider ${
                    rec.priority === "high"
                      ? "bg-danger/10 text-danger border border-danger/30"
                      : rec.priority === "medium"
                      ? "bg-warning/10 text-warning border border-warning/30"
                      : "bg-surface-3 text-text-muted border border-border-strong"
                  }`}
                >
                  {rec.priority}
                </span>
                <span className="category-badge px-1.5 py-0.5 rounded bg-surface-3 text-[8px] text-text-muted font-bold uppercase border border-border-strong">
                  {rec.category}
                </span>
              </div>
              <p className="rec-headline font-bold text-text-primary text-xs leading-normal">{rec.headline}</p>
              <p className="rec-explanation text-[11px] text-text-secondary leading-relaxed">{rec.explanation}</p>
            </div>
          ))}
        </div>

        {/* Quick Wins */}
        <div className="quick-wins-block p-5 border border-border bg-surface-3/10 rounded-xl space-y-3">
          <h3 className="subsection-heading text-xs font-bold text-text-muted uppercase tracking-wider">Quick Wins</h3>
          <ul className="quick-wins-list grid grid-cols-1 gap-2.5 text-xs text-text-secondary leading-normal">
            {phase3.quick_wins?.map((win, i) => (
              <li key={i} className="quick-win-item flex items-start gap-2.5">
                <span className="bullet text-accent font-bold mt-0.5">⚡</span>
                <p>{win}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 3. LARGE BRAND COMPETITORS SECTION */}
      <section className="results-section bg-surface-2 border border-border rounded-xl p-6 md:p-8 space-y-6">
        <div className="flex items-center justify-between pb-3 border-b border-border/60">
          <div className="flex items-center gap-2">
            <Award className="w-5 h-5 text-indigo-400" />
            <h2 className="text-base font-bold text-text-primary tracking-tight">Large Brand Competitors</h2>
          </div>
          <span className="count-badge bg-indigo-950/60 border border-indigo-900/60 text-indigo-400 text-[10px] font-bold px-2 py-0.5 rounded-full">
            {phase1RealCompetitors.length} Brands
          </span>
        </div>

        {phase1.matching_weights && (
          <p className="text-[10px] text-text-muted italic -mt-3">
            Competitors prioritized {phase1CriterionLabel ? `by ${phase1CriterionLabel}, then ` : "by "}price (legacy: nearest to your target price), then comparable specs.
            {phase1.legacy_registry_snapshot && (
              <> Legacy competitors selected from the {phase1.legacy_registry_snapshot.category_name} brand list ({phase1RealCompetitors.filter((c: any) => c.curated_brand === true).length} of {phase1RealCompetitors.length} from curated brands).</>
            )}
          </p>
        )}
        {phase1NearestMatchCount > 0 && (
          <p className="text-[10px] text-warning italic -mt-3">
            {phase1NearestMatchCount} of {phase1RealCompetitors.length} legacy slots filled with nearest-similar products (no exact fits after {phase1.web_searches_performed ?? 0} queries) — see the &quot;Nearest Match&quot; badge on each.
          </p>
        )}

        <div className="competitors-list grid grid-cols-1 md:grid-cols-2 gap-4">
          {phase1.competitors && phase1.competitors.length > 0 ? (
            phase1.competitors.map((comp, i) => (
              comp.empty_slot ? (
                <EmptySlotCard
                  key={i}
                  reason={comp.removed ? describeRemovedSlot(comp) : (comp.reason || "No additional legacy competitor found.")}
                  removedAsin={comp.removed_asin}
                  onRefillRequested={onRefillRequested}
                  refilling={!!comp.removed_asin && refillingAsin === comp.removed_asin}
                />
              ) : (
                <div key={i} className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-[10px] text-text-muted cursor-pointer select-none">
                    <input type="checkbox" checked={flaggedAsins.has(comp.asin)} onChange={() => toggleFlag(comp.asin)} className="accent-danger" />
                    <Flag className="w-3 h-3" />
                    <span>Flag for bulk remove &amp; refill</span>
                  </label>
                  <CompetitorCard
                    competitor={comp}
                    tier="legacy"
                    analysisId={analysisId}
                    keyDiff={keyDiff}
                    buyerSentimentEnabled={buyerSentimentEnabled}
                    newsUpdatesEnabled={newsUpdatesEnabled}
                    onFeaturesResolved={(r) => setPhase1Features(prev => ({ ...prev, [i]: r }))}
                    onReplaced={onCompetitorReplaced}
                    onRemoved={onRemoved}
                  />
                </div>
              )
            ))
          ) : (
            <p className="col-span-full italic text-text-muted text-xs py-4 text-center">No large-brand competitors were identified for this product.</p>
          )}
        </div>

        <div className="pt-4 border-t border-border/40">
          <h3 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-3">Legacy Brand Specification Comparison</h3>
          <CompetitorTable competitors={phase1RealCompetitors} tier="legacy" resolvedFeatures={phase1Features} />
        </div>
      </section>

      {/* 4. INDIE & EMERGING COMPETITORS SECTION */}
      <section className="results-section bg-surface-2 border border-border rounded-xl p-6 md:p-8 space-y-6">
        <div className="flex items-center justify-between pb-3 border-b border-border/60">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-amber-400" />
            <h2 className="text-base font-bold text-text-primary tracking-tight">Indie & Emerging Competitors</h2>
          </div>
          <span className="count-badge bg-amber-950/60 border border-amber-900/60 text-amber-400 text-[10px] font-bold px-2 py-0.5 rounded-full">
            {phase2RealCompetitors.length} Brands
          </span>
        </div>

        {phase2.matching_weights && (
          <p className="text-[10px] text-text-muted italic -mt-3">
            Competitors prioritized {phase2CriterionLabel ? `by ${phase2CriterionLabel}, then ` : "by "}price (indie: relative to each brand&apos;s own lineup tier), then comparable specs.
          </p>
        )}
        {phase2NearestMatchCount > 0 && (
          <p className="text-[10px] text-warning italic -mt-3">
            {phase2NearestMatchCount} of {phase2RealCompetitors.length} emerging slots filled with nearest-similar products (no exact fits after {phase2.web_searches_performed ?? 0} queries) — see the &quot;Nearest Match&quot; badge on each.
          </p>
        )}

        <div className="competitors-list grid grid-cols-1 md:grid-cols-2 gap-4">
          {phase2.competitors && phase2.competitors.length > 0 ? (
            phase2.competitors.map((comp, i) => (
              comp.empty_slot ? (
                <EmptySlotCard
                  key={i}
                  reason={comp.removed ? describeRemovedSlot(comp) : (comp.reason || "No additional emerging competitor found.")}
                  removedAsin={comp.removed_asin}
                  onRefillRequested={onRefillRequested}
                  refilling={!!comp.removed_asin && refillingAsin === comp.removed_asin}
                />
              ) : (
                <div key={i} className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-[10px] text-text-muted cursor-pointer select-none">
                    <input type="checkbox" checked={flaggedAsins.has(comp.asin)} onChange={() => toggleFlag(comp.asin)} className="accent-danger" />
                    <Flag className="w-3 h-3" />
                    <span>Flag for bulk remove &amp; refill</span>
                  </label>
                  <CompetitorCard
                    competitor={comp}
                    tier="emerging"
                    analysisId={analysisId}
                    keyDiff={keyDiff}
                    buyerSentimentEnabled={buyerSentimentEnabled}
                    newsUpdatesEnabled={newsUpdatesEnabled}
                    onFeaturesResolved={(r) => setPhase2Features(prev => ({ ...prev, [i]: r }))}
                    onReplaced={onCompetitorReplaced}
                    onRemoved={onRemoved}
                  />
                </div>
              )
            ))
          ) : (
            <p className="col-span-full italic text-text-muted text-xs py-4 text-center">No indie & emerging competitors were identified for this product.</p>
          )}
        </div>

        <div className="pt-4 border-t border-border/40">
          <h3 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-3">Emerging Brand Specification Comparison</h3>
          <CompetitorTable competitors={phase2RealCompetitors} tier="emerging" resolvedFeatures={phase2Features} />
        </div>
      </section>

      {/* 5. RELATED PRODUCTS (USER-PROVIDED) SECTION — hidden entirely when
          none were pasted on the analyze form. Genuinely separate from
          phase1/phase2: no matching-weights/nearest-match language (these
          were never scored/ranked), no empty-slot placeholders (there's no
          fixed slot count to fill). */}
      {relatedProducts.length > 0 && (
        <section className="results-section bg-surface-2 border border-border rounded-xl p-6 md:p-8 space-y-6">
          <div className="flex items-center justify-between pb-3 border-b border-border/60">
            <div className="flex items-center gap-2">
              <UserCheck className="w-5 h-5 text-emerald-400" />
              <h2 className="text-base font-bold text-text-primary tracking-tight">Related Products (user-provided)</h2>
            </div>
            <span className="count-badge bg-emerald-950/60 border border-emerald-900/60 text-emerald-400 text-[10px] font-bold px-2 py-0.5 rounded-full">
              {relatedProducts.length} Product{relatedProducts.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="text-[10px] text-text-muted italic -mt-3">
            Pasted directly by you as examples of nearby similar products — shown here for reference and used to guide discovery above, not independently scored.
          </p>

          <div className="competitors-list grid grid-cols-1 md:grid-cols-2 gap-4">
            {relatedProducts.map((comp, i) => (
              <CompetitorCard
                key={comp.asin || i}
                competitor={comp}
                tier="related"
                mode="related"
                analysisId={analysisId}
                buyerSentimentEnabled={buyerSentimentEnabled}
                newsUpdatesEnabled={false}
                onReplaced={(oldAsin, updated) => onRelatedProductReplaced?.(oldAsin, updated)}
              />
            ))}
          </div>

          <div className="pt-4 border-t border-border/40">
            <h3 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-3">Related Products Specification Comparison</h3>
            <CompetitorTable competitors={relatedProducts} tier="related" />
          </div>
        </section>
      )}
    </div>
  );
}

/* HELPER COMPARISON TABLE COMPONENT — data-driven rows: a row that no
   competitor has data for is skipped entirely; a row where only some
   competitors have data renders real values plus a muted "Not available
   for {name}" — never a bare dash/N/A (delivered documents must never
   show empty cells). */
interface CompetitorTableProps {
  competitors: any[];
  tier: "legacy" | "emerging" | "related";
  resolvedFeatures?: Record<number, KeyFeaturesResult>;
}

interface TableRowDef {
  label: string;
  getValue: (comp: any, idx: number) => string | null;
  getSourceUrl?: (comp: any, idx: number) => string | null;
  // Overrides the generic "Not available for {name}" fallback text for a
  // null cell — used by the Amazon-only rows below to say WHY it's empty
  // (sold via brand/pro channels, not simply "unknown") when a competitor
  // is real and verified but genuinely has no Amazon listing at all.
  getEmptyLabel?: (comp: any) => string | null;
}

// Shared by every Amazon-only row (rating/reviews/BSR/monthly sales) — a
// competitor discovered via lib/legacy-brand-discovery.ts's brand-site
// pass with no matching Amazon listing (sources.amazon === null) is real
// and verified, just not sold on Amazon; that's a different, more
// specific empty-state than "we don't know."
function amazonOnlyEmptyLabel(c: any): string | null {
  return c.sources?.brand_site && !c.sources?.amazon ? "Sold via brand/pro channels — not on Amazon" : null;
}

function CompetitorTable({ competitors, tier, resolvedFeatures }: CompetitorTableProps) {
  if (!competitors || competitors.length === 0) return null;

  // Whichever criterion actually scored this batch of competitors
  // (lib/analysisEngine.ts's selectByCompositeScore — motor_*/heat_tech_*
  // fields are mutually exclusive per competitor, and every competitor in
  // one analysis shares the same tool type's primary_criterion) — 'none'
  // means neither applies and the row is omitted entirely, never rendered
  // as an empty/"Unverified" Motor Type row for a motorless product.
  const criterionKind: "motor" | "heat_technology" | "none" = competitors.some((c: any) => c.motor_match_tier)
    ? "motor"
    : competitors.some((c: any) => c.heat_tech_match_tier)
    ? "heat_technology"
    : "none";

  const criterionRow: TableRowDef | null =
    criterionKind === "motor"
      ? {
          label: "Motor Type",
          getValue: (c) =>
            c.motor_match_tier === "unverified"
              ? "Unverified"
              : c.motor_type
              ? (c.motor_branded_name ? `${c.motor_type} (${c.motor_branded_name})` : c.motor_type)
              : null,
        }
      : criterionKind === "heat_technology"
      ? {
          label: "Heat/Plate Technology",
          getValue: (c) =>
            c.heat_tech_match_tier === "unverified"
              ? "Unverified"
              : c.heat_tech_type
              ? (c.heat_tech_branded_name ? `${c.heat_tech_type} (${c.heat_tech_branded_name})` : c.heat_tech_type)
              : null,
        }
      : null;

  const rows: TableRowDef[] = [
    // The primary-criterion row (Motor Type/Heat-Plate Technology) and
    // Price lead the table — they're the #1 and #2 competitor-selection
    // criteria (lib/analysisEngine.ts's selectByCompositeScore), not just
    // incidental spec data, so they're always populated for a selected
    // competitor rather than something that can fall through to "Not
    // available." Omitted entirely for a 'none'-criterion tool type.
    ...(criterionRow ? [criterionRow] : []),
    { label: "Amazon Price", getValue: (c) => c.price || null },
    { label: "Star Rating", getValue: (c) => (c.rating ? `${c.rating} / 5` : null), getEmptyLabel: amazonOnlyEmptyLabel },
    { label: "Review Count", getValue: (c) => c.review_count || null, getEmptyLabel: amazonOnlyEmptyLabel },
    { label: "Monthly Sales", getValue: (c) => c.monthly_sales || null, getEmptyLabel: amazonOnlyEmptyLabel },
    { label: "Best Seller Rank", getValue: (c) => c.bsr_rank || null, getEmptyLabel: amazonOnlyEmptyLabel },
    { label: "Brand", getValue: (c) => c.brand || null },
    { label: "Manufacturer", getValue: (c) => c.manufacturer || null },
    { label: "Model Number", getValue: (c) => c.model_number || null },
    { label: "ASIN", getValue: (c) => c.asin || null },
    {
      label: "Top Feature",
      getValue: (c, idx) => {
        const resolved = resolvedFeatures?.[idx]?.features?.[0];
        return c.top_feature_summary || c.key_features?.[0]?.headline || resolved?.headline || null;
      },
      getSourceUrl: (c, idx) => resolvedFeatures?.[idx]?.features?.[0]?.sourceUrl ?? null,
    },
  ];

  // Rows where every competitor is null get skipped entirely — a bare
  // header with only "Not available" cells is just as empty as a dash.
  const visibleRows = rows.filter(row => competitors.some((c, idx) => row.getValue(c, idx)));

  if (visibleRows.length === 0) return null;

  return (
    <div className="overflow-x-auto border border-border rounded-lg bg-surface-1">
      <table className="w-full text-left border-collapse text-[10px] font-mono whitespace-nowrap">
        <thead>
          <tr className="border-b border-border/60 bg-surface-3/30 text-text-muted uppercase font-bold text-[9px]">
            <th className="p-2 border-r border-border/40">Spec</th>
            {competitors.map((comp, idx) => (
              <th key={idx} className="p-2 border-r border-border/40 min-w-[120px]">
                <div className="text-text-primary font-bold text-xs truncate max-w-[150px]">{comp.brand || comp.name}</div>
                <div className="text-[8px] text-text-muted mt-0.5">{tier === "legacy" ? "Legacy" : tier === "emerging" ? "Emerging" : "Related"}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40 text-text-secondary">
          {visibleRows.map((row, rowIdx) => (
            <tr key={row.label} className={rowIdx % 2 === 1 ? "bg-surface-3/5" : undefined}>
              <td className="p-2 border-r border-border/40 bg-surface-3/10 font-bold text-text-muted">{row.label}</td>
              {competitors.map((comp, idx) => {
                const value = row.getValue(comp, idx);
                const sourceUrl = row.getSourceUrl?.(comp, idx);
                const emptyLabel = !value ? (row.getEmptyLabel?.(comp) || `Not available for ${comp.brand || comp.name}`) : null;
                return (
                  <td key={idx} className="p-2 border-r border-border/40 max-w-[180px] truncate" title={value ?? emptyLabel ?? undefined}>
                    {value ? (
                      <span className="inline-flex items-center gap-1">
                        {value}
                        {sourceUrl && (
                          <a href={sourceUrl} target="_blank" rel="noopener noreferrer" title="View source" className="text-accent hover:underline">
                            <ExternalLinkIcon />
                          </a>
                        )}
                      </span>
                    ) : (
                      <span className="italic text-text-muted normal-case font-sans">{emptyLabel}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExternalLinkIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
