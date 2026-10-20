"use client";

import { useEffect, useState } from "react";
import { useAmazonProduct } from "@/hooks/useAmazonProduct";
import { ChevronDown, ChevronUp, ExternalLink, Star, RefreshCw, Newspaper, TrendingUp, TrendingDown, Minus, AlertTriangle, Pencil, X, Check, Trash2 } from "lucide-react";
import type { ReviewAnalysis, TierResult, ListingStats } from "@/lib/amazon-review-analysis";
import type { ProductNewsResult } from "@/lib/product-news";
import type { KeyFeaturesResult } from "@/lib/key-features-resolver";
import { CitationMarker, SourcesFootnoteList, useCitationNumbering } from "./CitationMarker";
import { enqueue } from "@/lib/fetch-queue";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { SectionSourceLine, SourceUnavailableCaption } from "./SectionSourceLine";
import { assertProvenance, domainOf, formatReviewDate } from "@/lib/provenance-format";
import type { ReviewEvidence } from "@/lib/amazon-review-analysis";
import { CorrectionReasonValues, CompetitorRemoveReasonValues } from "@/lib/validations";

const CORRECTION_REASON_LABELS: Record<string, string> = {
  wrong_product: "Wrong product entirely (not the right tool type)",
  wrong_model: "Wrong model — right brand, wrong tier/price",
  wrong_motor: "Wrong motor/plate-heat type",
  better_competitor: "Better/more relevant competitor exists (this one)",
  discontinued: "Discontinued / unavailable product",
  other: "Other",
};

// Remove + Refill single slot (distinct from the correction reasons above,
// which are for an ASIN swap/replace) — labels map 1:1 to
// lib/validations.ts's CompetitorRemoveReasonValues, the authoritative list.
const REMOVE_REASON_LABELS: Record<string, string> = {
  wrong_industry: "Wrong industry (not a grooming/beauty product at all)",
  wrong_product: "Wrong product",
  wrong_motor: "Wrong motor",
  not_comparable: "Not really comparable",
  other: "Other",
};

interface Competitor {
  name:               string;
  brand:              string;
  tier:               "legacy" | "emerging" | "related";
  // Related Products only (lib/analysisEngine.ts's resolveRelatedProducts) —
  // a cross-tool-type paste (e.g. a clipper pasted into a trimmer analysis),
  // still shown here with a mismatch note, per the feature's own Part 2.3/
  // Part 4.4 ("shown in the section with the mismatch note").
  toolTypeMismatch?:      boolean;
  toolTypeMismatchLabel?: string | null;
  // Set by lib/analysisEngine.ts's fill loop when a slot genuinely
  // couldn't be filled after exhausting the full search/relaxation ladder
  // — render EmptySlotCard instead of CompetitorCard for these, never treat
  // as a real competitor (counts, PDF, exports).
  empty_slot?:        boolean;
  reason?:            string;
  // null for a non-Amazon related product (Related Products field accepts
  // any product page URL now, not just Amazon) — see external/url below.
  asin:               string | null;
  // Set alongside a null asin — the actual URL the user pasted, since
  // there's no /dp/{asin} link to construct for a non-Amazon page.
  url?:               string | null;
  external?:          boolean;
  price:              string;
  rating:             string;
  review_count:       string;
  monthly_sales?:     string;
  bsr_rank?:          string;
  initials:           string;
  key_features:       { headline: string; source: string; attribution: string; detail: string }[];
  strengths:          string[];
  weaknesses:         string[];
  recent_news:        string[];
  top_feature_summary?: string;
  verified_by_rainforest?: boolean;
  manufacturer?:      string | null;
  model_number?:      string | null;
  description?:       string | null;
  images?:            string[];
  // Set by lib/analysisEngine.ts's applyPriceBandGate when this competitor
  // only made it in after the price band was widened (fewer than 5 in-band
  // candidates were found) — never set for a normal in-band match.
  out_of_band?:        boolean;
  out_of_band_reason?: string | null;
  // Set by lib/legacy-brand-discovery.ts when this legacy competitor came
  // from the curated brand registry (lib/db/legacy-brands.ts) — absent/false
  // means it was AI-sourced because curated brands couldn't fill all 5
  // in-band slots (lib/analysisEngine.ts's Phase 1 top-up fallback).
  curated_brand?:      boolean;
  brand_list_status?:  "not_curated" | null;
  // Set only for a "both" target-market analysis (lib/legacy-brand-
  // registry.ts's resolveLegacyBrandsForIdentity merges the pro+retail
  // curated lists) — which list(s) this curated pick came from.
  registry_source_lists?: ("pro" | "retail")[] | null;
  // One sentence justifying why this is a real legacy/emerging competitor
  // at this price tier, per lib/analysisEngine.ts's Phase 1/2 prompts.
  inclusion_rationale?: string;
  // Set by lib/analysisEngine.ts's selectByCompositeScore — motor type is
  // the #1 selection priority (lib/motor-taxonomy.ts/lib/motor-extraction.ts),
  // then price, then comparable specs. motor_type is always one of the 7
  // canonical family labels (e.g. "Brushless Motor"), never a brand's own
  // marketing name — always populated with SOMETHING for a selected
  // competitor (never blank) — "unverified" tier means neither side's motor
  // type could be determined, not that they differ.
  motor_type?:            string | null;
  motor_modifier?:         string | null;
  // The brand's own proprietary term (e.g. "IN3") when resolved via the
  // branded map (lib/db/branded-motor-names.ts) — display this alongside
  // motor_type ("Vector Motor (IN3)"), never in place of it; matching always
  // happens on motor_type/motor_family_key only.
  motor_branded_name?:     string | null;
  motor_source_quote?:     string | null;
  motor_match_tier?:       "exact" | "adjacent" | "different" | "unverified";
  motor_score?:            number;
  // Full parallel to the motor_* fields above, for tool types whose
  // primary_criterion is 'heat_technology' (flat iron/curling iron/hot
  // brush) instead of 'motor' — see lib/heat-tech-taxonomy.ts. A scored
  // competitor NEVER has both sets populated; 'none'-criterion types have
  // neither.
  heat_tech_type?:         string | null;
  heat_tech_branded_name?: string | null;
  heat_tech_source_quote?: string | null;
  heat_tech_match_tier?:   "exact" | "different" | "unverified";
  heat_tech_score?:        number;
  price_score?:            number;
  price_logic?:            "absolute" | "relative";
  their_lineup_percentile?: number | null;
  their_lineup_sample?:    { asin: string; title: string; price_raw: number }[] | null;
  our_lineup_percentile?:  number | null;
  feature_score?:          number;
  composite_score?:        number;
  // Set by lib/analysisEngine.ts's selectByCompositeScore when the analysis
  // form's Key Differentiator field was given AND this candidate's real
  // listing text (lib/differentiator-match.ts) appears to share it — null
  // when no Key Differentiator was given at all.
  differentiator_match?:  boolean | null;
  // Set by selectByCompositeScore's requireMotorEvidenceFirst pass — this
  // candidate had ZERO motor evidence (no verified competitor could fill
  // the slot) and was pulled in only as a last-resort, explicitly labeled.
  motor_unverified_fallback?: boolean;
  // Set by selectByCompositeScore's nearestSimilarMode — the full ladder
  // (rounds 1-3, the normal price-band widen loop, even a dedicated round-4
  // search) still couldn't find an exact-fit competitor for this slot, so
  // the nearest real, verified product available was seated instead — a
  // real competitor, never an empty_slot placeholder. nearest_match_reason
  // is a one-line human-readable deviation (e.g. "Different motor (Rotary
  // vs your Brushless), $89.00 vs your $299.00 target"). Reset to
  // false/null by lib/analysisEngine.ts's replaceCompetitor on a manual
  // ASIN swap — a human-confirmed pick is never still "nearest match."
  nearest_match?: boolean;
  nearest_match_reason?: string | null;
  // Which source(s) actually produced this competitor — brand-site specs
  // are authoritative for motor/technical data; Amazon supplies live
  // price/rating/reviews/BSR when a listing exists. `amazon: null` means a
  // real product genuinely not sold on Amazon at all (distinct from
  // verified_by_rainforest:false, which means a lookup was attempted and
  // failed/unconfirmed).
  sources?: {
    brand_site: { url: string; price: string | null; price_raw: number | null; retrieved_at: string } | null;
    amazon: { asin: string; url: string; price: string | null; price_raw: number | null; rating: string | null; review_count: string | null; bsr_rank: string | null; monthly_sales: string | null; retrieved_at: string } | null;
  };
  // Set by lib/analysisEngine.ts's replaceCompetitor after a user manually
  // swapped this competitor's ASIN — replaces the composite-score-based
  // "Why this competitor" rationale with a plain provenance note, since a
  // human override has no scoring rationale to explain.
  manually_selected?: boolean;
  manually_selected_by?: string | null;
  manually_selected_at?: string | null;
  replaced_from_asin?: string | null;
}

interface CompetitorCardProps {
  competitor: Competitor;
  tier?: "legacy" | "emerging" | "related";
  // "related" = a user-pasted Related Product (analyze form), not a
  // discovered/scored competitor: no auto-fired review analysis (on-demand
  // button instead), no News, no composite-score "Why this competitor"
  // panel (never set for these anyway), "User-provided" badge instead of
  // the Legacy/Emerging pill, and its editable-ASIN swap posts to
  // /related-products/replace (no correction reason) instead of
  // /competitors/replace.
  mode?: "competitor" | "related";
  // Lets the comparison table (a sibling, not a parent, of this card) reuse
  // the same resolved Key Features instead of re-running the resolver —
  // fired once per successful/refreshed fetch.
  onFeaturesResolved?: (result: KeyFeaturesResult) => void;
  // Best-effort — threaded into each section fetch so its persisted
  // provenance row (lib/db/section-provenance.ts) carries a real
  // analysis_id when one exists. Never required for a provenance write.
  analysisId?: string | null;
  // The analysis form's Key Differentiator text (if any) — displayed
  // alongside competitor.differentiator_match so a "matches" line names
  // the actual feature, not just an unlabeled checkmark.
  keyDiff?: string | null;
  // Feature flags (lib/feature-flags.ts), fetched once by the parent page
  // via GET /api/features and threaded down — default true (fail-open,
  // matching this codebase's flag convention) so an omitted prop never
  // hides either section.
  buyerSentimentEnabled?: boolean;
  newsUpdatesEnabled?: boolean;
  // Fired after a successful ASIN swap (lib/analysisEngine.ts's
  // replaceCompetitor via POST .../competitors/replace) — the parent
  // (ResultsPanel, then analyze/page.tsx) owns the actual analysis state
  // and patches its phase1/phase2 competitors array in place; this card
  // never mutates its own `competitor` prop directly.
  onReplaced?: (oldAsin: string, updatedCompetitor: any, synthesisPossiblyStale: boolean) => void;
  // Fired after a successful Remove (lib/analysisEngine.ts's
  // removeCompetitorSlot via POST .../competitors/remove) — same division
  // of responsibility as onReplaced above: the route only returns
  // {removedAsin, tier, synthesisPossiblyStale}, so this card builds the
  // displayed placeholder object itself (mirroring the server's own
  // placeholder shape) and hands it up for the parent to patch in. Never
  // shown/wired for Related Products cards (mode="related") — Remove +
  // Refill only applies to phase1/phase2 discovered competitor slots.
  onRemoved?: (asin: string, tier: string, placeholder: any, synthesisPossiblyStale: boolean) => void;
}

type FeaturesState =
  | { status: "loading" }
  | { status: "loaded"; data: KeyFeaturesResult & { retrievedAt: string } }
  | { status: "error"; message: string };

type ReviewAnalysisState =
  // "idle" — Related Products cards only (mode="related"): review analysis
  // never auto-fires on mount, the user triggers it via the on-demand
  // "Analyze reviews" button, which calls loadReviewAnalysis() the same way
  // a normal competitor card's mount effect does.
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: ReviewAnalysis & { retrievedAt: string } }
  | { status: "error"; message: string };

type NewsState =
  | { status: "loading" }
  | { status: "loaded"; data: ProductNewsResult & { retrievedAt: string } }
  | { status: "error"; message: string };

function RefreshButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      title="Refresh — re-pulls live data, bypassing cache"
      className="p-1 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors disabled:opacity-40"
    >
      <RefreshCw className={`w-3 h-3 ${disabled ? "animate-spin" : ""}`} />
    </button>
  );
}

function TimeoutChip({ onRetry, label }: { onRetry: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold bg-warning/10 border border-warning/25 text-warning hover:bg-warning/20 transition-colors"
    >
      <AlertTriangle className="w-2.5 h-2.5" /> {label || "Some sources timed out — Retry"}
    </button>
  );
}

// Turns one tier's outcome into a short, honest phrase — "returned 0" and
// "request failed" must read differently, since they mean very different
// things (the product genuinely has no reviews vs. the source was
// unreachable this time).
// Canonical family label, plus the brand's own proprietary term in parens
// when known (e.g. "Vector Motor (IN3)") — never the branded name alone,
// since matching/comparison always happens on the canonical family.
function motorLabelWithBranded(c: Pick<Competitor, "motor_type" | "motor_branded_name">): string {
  if (!c.motor_type) return "";
  return c.motor_branded_name ? `${c.motor_type} (${c.motor_branded_name})` : c.motor_type;
}

// Same derivation, mirrored for the Heat/Plate Technology criterion.
function heatTechLabelWithBranded(c: Pick<Competitor, "heat_tech_type" | "heat_tech_branded_name">): string {
  if (!c.heat_tech_type) return "";
  return c.heat_tech_branded_name ? `${c.heat_tech_type} (${c.heat_tech_branded_name})` : c.heat_tech_type;
}

type CriterionKind = "motor" | "heat_technology" | "none";

// Which criterion actually scored this competitor — 'motor'/'heat_technology'
// fields are mutually exclusive (see lib/analysisEngine.ts's
// selectByCompositeScore), 'none' means this tool type's primary_criterion
// is 'none' and neither was ever populated.
function resolveCriterionKind(c: Pick<Competitor, "motor_match_tier" | "heat_tech_match_tier">): CriterionKind {
  if (c.motor_match_tier) return "motor";
  if (c.heat_tech_match_tier) return "heat_technology";
  return "none";
}

const CRITERION_DISPLAY: Record<"motor" | "heat_technology", { label: string; noun: string }> = {
  motor: { label: "Motor", noun: "motor type" },
  heat_technology: { label: "Heat/Plate Technology", noun: "plate/heat technology" },
};

function describeTier(t: TierResult): string {
  if (!t.attempted) return "not attempted (no ASIN)";
  if (t.outcome === "success") return t.itemCount != null ? `found ${t.itemCount}` : "found supporting content";
  if (t.outcome === "empty") return "returned 0";
  return `request failed${t.errorMessage ? ` (${t.errorMessage})` : ""}`;
}

// Renders whichever notice applies for the Strengths/Weaknesses sections —
// shared so the two sections can't drift out of sync. Order matters: an AI
// outage is reported before a sources outage, which is reported before a
// genuine "nothing found anywhere" — these are three different situations
// and must never collapse into the same generic message.
function ReviewSourcesNotice({ data, onRetry }: { data: ReviewAnalysis; onRetry: () => void }) {
  if (data.aiUnavailable) {
    return (
      <div className="flex items-center justify-between gap-2 py-2">
        <span className="text-warning">Fetched real reviews, but no AI provider is available right now to analyze them.</span>
        <TimeoutChip onRetry={onRetry} />
      </div>
    );
  }
  if (data.sourcesUnavailable) {
    const errored = (data.sourcesSummary.tiers ?? []).filter(t => t.attempted && t.outcome === "error");
    return (
      <div className="flex items-center justify-between gap-2 py-2">
        <span className="text-warning">
          Live review sources unavailable right now{errored.length ? ` (${errored.map(t => t.tier).join(", ")})` : ""} — this is a temporary source outage, not a lack of reviews.
        </span>
        <TimeoutChip onRetry={onRetry} label="Retry" />
      </div>
    );
  }
  if (data.insufficientData) {
    const tiers = data.sourcesSummary.tiers;
    if (tiers && tiers.length) {
      return (
        <div className="italic text-text-muted space-y-0.5">
          <p>No review data found across any source:</p>
          <ul className="pl-3 list-disc space-y-0.5 not-italic">
            {tiers.map((t, i) => <li key={i}>{t.tier}: {describeTier(t)}</li>)}
          </ul>
        </div>
      );
    }
    // Backward-compat fallback for older cached payloads without `tiers`.
    return (
      <p className="italic text-text-muted">
        No review data found on Amazon, retailers, or the web (searched {data.sourcesSummary.tiersTried.join(", ")}).
      </p>
    );
  }
  return null;
}

function reviewSourceLabel(sourceType: string): string | null {
  if (sourceType === "customer_reviews") return "Amazon customer reviews";
  if (sourceType === "amazon_listing") return "Amazon product listing";
  return null;
}

// Visible, inline (not hover-only) label naming a review theme's source
// type — distinct from reviewSourceLabel above, which only feeds the
// citation marker's tooltip title.
function reviewThemeSourceLabel(theme: { sourceType: string; sourceUrl?: string | null }): string {
  if (theme.sourceType === "customer_reviews") return "customer reviews (Amazon)";
  if (theme.sourceType === "amazon_listing") return "Amazon listing";
  if (theme.sourceType === "expert_review") return `expert review${theme.sourceUrl ? ` (${domainOf(theme.sourceUrl)})` : ""}`;
  if (theme.sourceType === "forum") return `forum${theme.sourceUrl ? ` (${domainOf(theme.sourceUrl)})` : ""}`;
  return theme.sourceType;
}

const QUOTE_DISPLAY_MAX_CHARS = 120;

// Display-only truncation at a word boundary — never touches the stored
// verbatim quote used for citation/verification, only what's rendered.
function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// One shared renderer for a single evidence quote — used by Strengths,
// Weaknesses, and Recent Buyer Sentiment so all three stay in sync: clean
// "Mon D, YYYY" dates (never an ISO timestamp or a raw source phrase, see
// lib/rainforest.ts's parseRainforestReviewDate), no date at all when none
// is known, a bracketed translation for a non-English quote, and a
// word-boundary-truncated display string that never alters the real quote.
function EvidenceQuote({ evidence }: { evidence: ReviewEvidence }) {
  const displayDate = formatReviewDate(evidence.date);
  return (
    <p className="pl-2 text-[10px] text-text-muted italic">
      &ldquo;{truncateAtWord(evidence.quote, QUOTE_DISPLAY_MAX_CHARS)}&rdquo;
      {evidence.translated && evidence.translation && <> [&ldquo;{truncateAtWord(evidence.translation, QUOTE_DISPLAY_MAX_CHARS)}&rdquo;]</>}
      {displayDate && ` — ${displayDate}`}
    </p>
  );
}

function ListingStatsCaption({ stats }: { stats: ListingStats }) {
  if (stats.rating == null && stats.reviewsTotal == null) return null;
  return (
    <p className="text-[10px] text-text-muted inline-flex items-center flex-wrap gap-x-1">
      <span>Based on the Amazon listing{stats.rating != null ? ":" : ""}</span>
      {stats.rating != null && (
        <span className="inline-flex items-center gap-0.5">
          {stats.rating.toFixed(1)}
          <Star className="w-2.5 h-2.5 fill-warning text-warning" />
        </span>
      )}
      {stats.reviewsTotal != null && <span>across {stats.reviewsTotal.toLocaleString()} ratings.</span>}
      {stats.reviewsTotal == null && stats.rating != null && <span>.</span>}
    </p>
  );
}

// Must safely exceed every section route's own maxDuration (all three are
// 60s, Vercel Hobby's actual ceiling — see those routes' exports) or this
// client-side abort fires before the server-side work even has a chance
// to finish. Confirmed live: with the old 20s value, real successful
// responses (verified real data, not errors) were arriving at 33-45s and
// getting thrown away as "timed out" by this timer alone.
const SECTION_TIMEOUT_MS = 63_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SECTION_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// A hard Vercel function kill (the route ran past its own maxDuration)
// returns a plain-text/HTML platform error page, not this route's own
// JSON — confirmed live: that crashed res.json() with a raw parse error
// ("Unexpected token 'A', "An error o"... is not valid JSON") shown
// directly to the user instead of a clean message. Read the body as text
// first and parse it ourselves so a non-JSON response degrades to a
// normal, honest "unavailable — retry" instead of a stack-trace-looking
// string.
async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: res.ok ? "Unexpected response — retry" : `Live data unavailable (server error) — retry` };
  }
}

interface EmptySlotCardProps {
  reason: string;
  // Set only for a slot vacated by Remove + Refill (lib/analysisEngine.ts's
  // removeCompetitorSlot placeholder, identified by its removed_asin field)
  // — a genuinely-never-found empty slot from normal discovery never has
  // this, and must render IDENTICALLY to before (no button, no layout
  // change) since that's a completely different, unrelated situation.
  removedAsin?: string;
  onRefillRequested?: (removedAsin: string) => void;
  refilling?: boolean;
}

// Rendered instead of a real CompetitorCard for a slot the fill loop
// genuinely could not fill after exhausting the full round/relaxation
// ladder (lib/analysisEngine.ts's buildEmptySlotPlaceholder) — an honest,
// visibly-different empty state rather than silently showing fewer
// competitors, with the exact reason (how much was actually searched)
// always visible, not just in a log. ALSO doubles as the post-Remove
// placeholder's display (removedAsin present) — same visual shell, plus a
// "Refill this slot" action.
export function EmptySlotCard({ reason, removedAsin, onRefillRequested, refilling }: EmptySlotCardProps) {
  return (
    <div className={`competitor-card border border-dashed border-border rounded-xl p-5 flex items-center justify-center text-center min-h-[140px]${removedAsin ? " flex-col gap-3" : ""}`}>
      <p className="text-[11px] text-text-muted italic max-w-xs">{reason}</p>
      {removedAsin && (
        <button
          type="button"
          onClick={() => onRefillRequested?.(removedAsin)}
          disabled={refilling}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50"
        >
          {refilling ? <Spinner size="xs" className="text-white" /> : <RefreshCw className="w-3 h-3" />}
          <span>{refilling ? "Searching…" : "Refill this slot"}</span>
        </button>
      )}
    </div>
  );
}

export function CompetitorCard({ competitor: c, onFeaturesResolved, analysisId, keyDiff, buyerSentimentEnabled = true, newsUpdatesEnabled = true, mode = "competitor", onReplaced, onRemoved }: CompetitorCardProps) {
  const isRelated = mode === "related";
  // All 4 sections load automatically on mount — collapsing is purely a
  // visual/reading-convenience toggle, never a fetch trigger. Related
  // Products cards are the one exception: Strengths/Weaknesses (both
  // driven by reviewAnalysis) start "idle" and never auto-fetch — see the
  // mount effect below.
  const [featuresOpen, setFeaturesOpen] = useState(true);
  const [strengthsOpen, setStrengthsOpen] = useState(true);
  const [weaknessesOpen, setWeaknessesOpen] = useState(true);
  const [newsOpen, setNewsOpen] = useState(true);
  const [featuresSourceOpen, setFeaturesSourceOpen] = useState(false);
  const [strengthsSourceOpen, setStrengthsSourceOpen] = useState(false);
  const [weaknessesSourceOpen, setWeaknessesSourceOpen] = useState(false);
  const [newsSourceOpen, setNewsSourceOpen] = useState(false);

  const [featuresState, setFeaturesState] = useState<FeaturesState>({ status: "loading" });
  const [reviewAnalysis, setReviewAnalysis] = useState<ReviewAnalysisState>({ status: isRelated ? "idle" : "loading" });
  const [newsState, setNewsState] = useState<NewsState>({ status: "loading" });

  const { data: live, loading, error } = useAmazonProduct(c.verified_by_rainforest === undefined ? c.asin : null);

  const isValidAsin = /^[A-Z0-9]{10}$/i.test(c.asin ?? "");
  const asinPathSegment = isValidAsin && c.asin ? c.asin.toUpperCase() : "NONE";
  const amazonUrl = isValidAsin && c.asin ? `https://www.amazon.com/dp/${c.asin.toUpperCase()}` : null;

  async function loadFeatures(refresh = false) {
    setFeaturesState({ status: "loading" });
    try {
      const params = new URLSearchParams({ productName: c.name });
      if (refresh) params.set("refresh", "true");
      if (analysisId) params.set("analysisId", analysisId);
      const res = await enqueue(() => fetchWithTimeout(`/api/product-data/key-features/${asinPathSegment}?${params.toString()}`));
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || "Live feature data unavailable — retry");
      setFeaturesState({ status: "loaded", data });
      onFeaturesResolved?.(data);
    } catch (err: any) {
      setFeaturesState({ status: "error", message: err.name === "AbortError" ? "Timed out fetching feature data." : (err.message || "Live feature data unavailable — retry") });
    }
  }

  async function loadReviewAnalysis(refresh = false) {
    setReviewAnalysis({ status: "loading" });
    try {
      const params = new URLSearchParams({ productName: c.name });
      if (refresh) params.set("refresh", "true");
      if (analysisId) params.set("analysisId", analysisId);
      const res = await enqueue(() => fetchWithTimeout(`/api/amazon/reviews-analysis/${asinPathSegment}?${params.toString()}`));
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || "Live Amazon data unavailable — retry");
      setReviewAnalysis({ status: "loaded", data });
    } catch (err: any) {
      setReviewAnalysis({ status: "error", message: err.name === "AbortError" ? "Timed out fetching review data." : (err.message || "Live Amazon data unavailable — retry") });
    }
  }

  async function loadNews(refresh = false) {
    setNewsState({ status: "loading" });
    try {
      const params = new URLSearchParams({ productName: c.name, brand: c.brand || "" });
      if (refresh) params.set("refresh", "true");
      if (analysisId) params.set("analysisId", analysisId);
      const res = await enqueue(() => fetchWithTimeout(`/api/amazon/product-news/${asinPathSegment}?${params.toString()}`));
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || "Live news search unavailable — retry");
      setNewsState({ status: "loaded", data });
    } catch (err: any) {
      setNewsState({ status: "error", message: err.name === "AbortError" ? "Timed out searching for news." : (err.message || "Live news search unavailable — retry") });
    }
  }

  // Fire on mount — no click required, EXCEPT review analysis on a Related
  // Products card (mode="related"), which stays "idle" until the user
  // clicks "Analyze reviews" (keeps the analysis run's time flat per the
  // feature's own Part 3.2 — strengths/weaknesses aren't run for these by
  // default). News is skipped entirely for Related Products cards
  // regardless of newsUpdatesEnabled — not part of what this section shows.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    loadFeatures();
    if (!isRelated) loadReviewAnalysis();
    if (newsUpdatesEnabled && !isRelated) loadNews();
  }, [c.asin, c.name, newsUpdatesEnabled, isRelated]);

  const displayPrice   = live?.price        ?? c.price        ?? "—";
  const displayRating  = live?.rating_str   ?? c.rating       ?? "—";
  const displayReviews = live?.reviews_str  ?? c.review_count ?? "—";
  const displayBSR     = live?.bsr          ?? c.bsr_rank     ?? null;
  const displaySales   = live?.monthly_str  ?? c.monthly_sales ?? null;
  const displayManufacturer = live?.manufacturer ?? c.manufacturer ?? null;
  const displayModelNumber  = live?.model_number ?? c.model_number ?? null;
  const criterionKind = resolveCriterionKind(c);

  // Editable ASIN — edit (pencil) opens an inline input; submitting it
  // fetches a preview (POST .../competitors/preview) and shows a confirm
  // panel before anything actually changes (typo-ASIN disasters guard).
  // Confirming records a required reason and calls .../competitors/replace,
  // which rebuilds this competitor server-side and returns the full
  // updated object — bubbled up via onReplaced so the parent (which owns
  // the actual analysis state) can patch it in.
  const [editingAsin, setEditingAsin] = useState(false);
  const [asinInput, setAsinInput] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{ asin: string; title: string; brand: string; price: string; image: string | null; toolTypeMismatchWarning: string | null; duplicateAsin: boolean } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [correctionReason, setCorrectionReason] = useState<string>("wrong_product");
  const [correctionNote, setCorrectionNote] = useState("");
  const [replacing, setReplacing] = useState(false);

  function resetAsinEdit() {
    setEditingAsin(false);
    setAsinInput("");
    setPreview(null);
    setPreviewError(null);
    setCorrectionReason("wrong_product");
    setCorrectionNote("");
  }

  async function handlePreviewAsin() {
    if (!asinInput.trim() || !analysisId) return;
    setPreviewing(true);
    setPreviewError(null);
    setPreview(null);
    try {
      // Related Products cards use the generic, analysis-agnostic preview
      // endpoint (same one the analyze form's rows use) rather than the
      // analysis-scoped competitor preview — no duplicate-ASIN check here
      // (that's a related-products-array concept, not phase1/phase2), and
      // no confirmed-analysis identity dependency either.
      const res = isRelated
        ? await fetch("/api/products/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ asinOrUrl: asinInput.trim() }),
          })
        : await fetch(`/api/analyses/${analysisId}/competitors/preview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ asinOrUrl: asinInput.trim() }),
          });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Could not preview that product");
      setPreview({ duplicateAsin: false, ...data });
    } catch (err: any) {
      setPreviewError(err.message || "Could not preview that product");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirmReplace() {
    if (!preview || !analysisId || preview.duplicateAsin) return;
    setReplacing(true);
    try {
      // "Fixing a mispaste re-fetches in place" (Related Products) —
      // deliberately simpler than the competitor-swap flow: no correction
      // reason, and the response shape is { relatedProduct } not
      // { competitor, synthesisPossiblyStale }.
      if (isRelated) {
        const res = await fetch(`/api/analyses/${analysisId}/related-products/replace`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oldAsin: c.asin, asinOrUrl: preview.asin }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to replace related product");
        // Non-null: the pencil button that opens this editor is hidden for
        // a related product with no asin (see its render condition above),
        // so this branch is only ever reachable when c.asin is real.
        onReplaced?.(c.asin!, data.relatedProduct, false);
      } else {
        const res = await fetch(`/api/analyses/${analysisId}/competitors/replace`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oldAsin: c.asin, asinOrUrl: preview.asin, reason: correctionReason, note: correctionNote.trim() || undefined }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to replace competitor");
        // Non-null: a discovered (non-related) competitor always has a real
        // asin by construction — only Related Products can ever be null.
        onReplaced?.(c.asin!, data.competitor, data.synthesisPossiblyStale);
      }
      resetAsinEdit();
    } catch (err: any) {
      setPreviewError(err.message || "Failed to replace competitor");
    } finally {
      setReplacing(false);
    }
  }

  // Remove + Refill single slot — Trash2-triggered sibling inline panel
  // (same visual shell as the Replace panel above): pick a reason, an
  // optional note, confirm. Never wired for Related Products (mode=
  // "related") — see onRemoved's own comment on why. On success, this card
  // builds the placeholder object the parent will display in its place
  // (the /competitors/remove route itself only returns
  // {removedAsin, tier, synthesisPossiblyStale}) and bubbles it up via
  // onRemoved, mirroring onReplaced's division of responsibility above.
  const [removePanelOpen, setRemovePanelOpen] = useState(false);
  const [removeReason, setRemoveReason] = useState<string>("wrong_industry");
  const [removeNote, setRemoveNote] = useState("");
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  function resetRemovePanel() {
    setRemovePanelOpen(false);
    setRemoveReason("wrong_industry");
    setRemoveNote("");
    setRemoveError(null);
  }

  async function handleConfirmRemove() {
    if (!analysisId) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const res = await fetch(`/api/analyses/${analysisId}/competitors/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asin: c.asin, reason: removeReason, note: removeNote.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to remove competitor");
      const placeholder = {
        empty_slot: true,
        tier: data.tier,
        removed: true,
        removed_asin: data.removedAsin,
        removed_name: c.name ?? null,
        removed_brand: c.brand ?? null,
        removed_reason: removeReason,
        removed_at: new Date().toISOString(),
        name: "Slot removed — refill to search for a replacement",
      };
      onRemoved?.(data.removedAsin, data.tier, placeholder, data.synthesisPossiblyStale);
      resetRemovePanel();
    } catch (err: any) {
      setRemoveError(err.message || "Failed to remove competitor");
    } finally {
      setRemoving(false);
    }
  }

  // Per-section citation numbering — same URL cited twice in one section
  // keeps one number (components/analyze/CitationMarker.tsx).
  const featuresCitations = useCitationNumbering();
  const strengthsCitations = useCitationNumbering();
  const weaknessesCitations = useCitationNumbering();
  const newsCitations = useCitationNumbering();

  function sourceFor(numbering: ReturnType<typeof useCitationNumbering>, url: string | null | undefined, title: string, quote: string, retrievedAt: string) {
    const safeUrl = url || (amazonUrl ?? "#");
    return { number: numbering.numberFor(safeUrl), url: safeUrl, title, publisher: title, quote, retrievedAt };
  }

  return (
    <div className="competitor-card bg-surface-2 border border-border rounded-xl p-5 space-y-4 shadow-sm hover:border-border-strong transition-all duration-200 text-xs">

      {/* Header */}
      <div className="comp-card-header flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="comp-avatar w-8 h-8 rounded-lg bg-surface-3 border border-border-strong flex items-center justify-center font-bold text-xs text-accent">
            {c.initials || c.name.substring(0, 2).toUpperCase()}
          </div>
          <div>
            <div className="comp-name font-bold text-text-primary text-sm leading-tight">{c.name}</div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`inline-flex px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                isRelated
                  ? "bg-emerald-950/60 border border-emerald-900/60 text-emerald-400"
                  : c.tier === "legacy"
                  ? "bg-indigo-950/60 border border-indigo-900/60 text-indigo-400"
                  : "bg-amber-950/60 border border-amber-900/60 text-amber-400"
              }`}>
                {isRelated ? "User-provided" : c.tier === "legacy" ? "Legacy" : "Emerging"}
              </span>
              <span className="text-[10px] text-text-muted">by {c.brand}</span>
            </div>
            {isRelated && c.toolTypeMismatch && c.toolTypeMismatchLabel && (
              <p className="text-[10px] text-warning italic mt-1 max-w-xs leading-snug">{c.toolTypeMismatchLabel}</p>
            )}
            {c.inclusion_rationale && (
              <p className="text-[10px] text-text-muted italic mt-1 max-w-xs leading-snug">{c.inclusion_rationale}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {amazonUrl ? (
            <a href={amazonUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] font-semibold text-accent hover:underline" title={`View ${c.name} on Amazon`}>
              <span>View on Amazon</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          ) : c.external && c.url ? (
            // Non-Amazon related product (Related Products field now
            // accepts any product page URL, not just Amazon) — no ASIN, so
            // link out to wherever the user actually pasted from instead of
            // the misleading "ASIN unavailable" (this isn't unavailable,
            // it just isn't an Amazon listing).
            <a href={c.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] font-semibold text-accent hover:underline" title={`View ${c.name} on ${c.brand || "the original site"}`}>
              <span>View original page</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          ) : (
            <span className="text-[10px] text-text-muted italic">ASIN unavailable</span>
          )}
          {analysisId && !editingAsin && !removePanelOpen && !(isRelated && !c.asin) && (
            <button
              type="button"
              onClick={() => { setEditingAsin(true); setAsinInput(c.asin || ""); }}
              title="Wrong competitor? Edit its ASIN to replace it"
              className="p-1 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors"
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}
          {analysisId && !isRelated && !editingAsin && !removePanelOpen && (
            <button
              type="button"
              onClick={() => setRemovePanelOpen(true)}
              title="Wrong competitor? Remove this slot"
              className="p-1 rounded hover:bg-surface-3 text-text-muted hover:text-danger transition-colors"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Editable ASIN — pencil-triggered inline swap flow: type/paste an
          ASIN or Amazon URL, preview the real product, pick why, confirm.
          Warns (tool-type mismatch) rather than blocks; duplicate ASIN is
          the one hard block, since that's a genuine error, not a judgment
          call. */}
      {editingAsin && (
        <div className="rounded-lg border border-accent/40 bg-surface-3/30 p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider">Replace this competitor</span>
            <button type="button" onClick={resetAsinEdit} className="p-0.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary">
              <X className="w-3 h-3" />
            </button>
          </div>

          {!preview ? (
            <>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={asinInput}
                  onChange={(e) => { setAsinInput(e.target.value); setPreviewError(null); }}
                  placeholder="New ASIN (e.g. B0ABCDEFGH) or Amazon product URL"
                  className="flex-1 px-2.5 py-1.5 text-[11px] border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent font-mono"
                />
                <button
                  type="button"
                  onClick={handlePreviewAsin}
                  disabled={previewing || !asinInput.trim()}
                  className="px-3 py-1.5 text-[11px] font-semibold bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50 shrink-0"
                >
                  {previewing ? "Looking up…" : "Preview"}
                </button>
              </div>
              {previewError && <p className="text-[10px] text-danger">{previewError}</p>}
            </>
          ) : (
            <div className="space-y-2.5">
              <div className="flex items-start gap-2.5 p-2 rounded-lg bg-surface-1 border border-border/60">
                {preview.image && <img src={preview.image} alt={preview.title} className="w-12 h-12 object-contain rounded shrink-0" />}
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-text-primary leading-snug">
                    Replace <span className="line-through text-text-muted">{c.name}</span> with{" "}
                    <span>{preview.title}</span>?
                  </p>
                  <p className="text-[10px] text-text-muted mt-0.5">{preview.brand} · {preview.price}</p>
                </div>
              </div>

              {preview.duplicateAsin && (
                <p className="text-[10px] text-danger font-semibold">This ASIN is already one of this analysis&apos;s other competitors — pick a different one.</p>
              )}
              {preview.toolTypeMismatchWarning && !preview.duplicateAsin && (
                <p className="text-[10px] text-warning">{preview.toolTypeMismatchWarning}</p>
              )}

              {!preview.duplicateAsin && (
                <>
                  {/* No correction-reason picker for Related Products — a
                      mispaste fix isn't a discovery-learning signal (see
                      lib/analysisEngine.ts's replaceRelatedProduct). */}
                  {!isRelated && (
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Why are you replacing this competitor?</label>
                      <div className="space-y-1">
                        {CorrectionReasonValues.map((reasonValue) => (
                          <label key={reasonValue} className="flex items-center gap-1.5 text-[10px] text-text-secondary cursor-pointer">
                            <input
                              type="radio"
                              name={`correction-reason-${c.asin}`}
                              value={reasonValue}
                              checked={correctionReason === reasonValue}
                              onChange={() => setCorrectionReason(reasonValue)}
                            />
                            {CORRECTION_REASON_LABELS[reasonValue]}
                          </label>
                        ))}
                      </div>
                      {correctionReason === "other" && (
                        <input
                          type="text"
                          value={correctionNote}
                          onChange={(e) => setCorrectionNote(e.target.value)}
                          placeholder="Briefly explain why"
                          className="w-full mt-1 px-2.5 py-1.5 text-[11px] border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                        />
                      )}
                    </div>
                  )}

                  {previewError && <p className="text-[10px] text-danger">{previewError}</p>}

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleConfirmReplace}
                      disabled={replacing}
                      className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-semibold bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50"
                    >
                      <Check className="w-3 h-3" />
                      {replacing ? "Replacing…" : "Confirm Replace"}
                    </button>
                    <button type="button" onClick={() => setPreview(null)} disabled={replacing} className="px-3 py-1.5 text-[11px] font-semibold text-text-muted hover:text-text-primary transition-colors">
                      Back
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Remove + Refill single slot — Trash2-triggered sibling inline
          panel (same shell as the Replace panel above): pick why, an
          optional note, confirm. Destructive-styled per this app's
          ConfirmDialog danger convention (bg-danger / hover:bg-danger/90). */}
      {removePanelOpen && (
        <div className="rounded-lg border border-danger/40 bg-surface-3/30 p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider">Remove this competitor</span>
            <button type="button" onClick={resetRemovePanel} className="p-0.5 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary">
              <X className="w-3 h-3" />
            </button>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Why are you removing this competitor?</label>
            <div className="space-y-1">
              {CompetitorRemoveReasonValues.map((reasonValue) => (
                <label key={reasonValue} className="flex items-center gap-1.5 text-[10px] text-text-secondary cursor-pointer">
                  <input
                    type="radio"
                    name={`remove-reason-${c.asin}`}
                    value={reasonValue}
                    checked={removeReason === reasonValue}
                    onChange={() => setRemoveReason(reasonValue)}
                  />
                  {REMOVE_REASON_LABELS[reasonValue]}
                </label>
              ))}
            </div>
            <input
              type="text"
              value={removeNote}
              onChange={(e) => setRemoveNote(e.target.value)}
              placeholder="Optional note"
              className="w-full mt-1 px-2.5 py-1.5 text-[11px] border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
            />
          </div>

          {removeError && <p className="text-[10px] text-danger">{removeError}</p>}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleConfirmRemove}
              disabled={removing}
              className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-semibold bg-danger hover:bg-danger/90 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {removing && <Spinner size="xs" className="text-white" />}
              <span>{removing ? "Removing…" : "Remove"}</span>
            </button>
            <button type="button" onClick={resetRemovePanel} disabled={removing} className="px-3 py-1.5 text-[11px] font-semibold text-text-muted hover:text-text-primary transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* "Manually selected" provenance — replaces the auto-generated "Why
          this competitor" scoring rationale below for a corrected pick,
          since composite-score reasoning no longer applies to a human
          override. */}
      {c.manually_selected && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-[10px] text-text-secondary">
          <span className="font-semibold text-accent">Manually selected</span>
          {c.replaced_from_asin && <span> — replaced {c.replaced_from_asin}{c.manually_selected_at ? ` on ${new Date(c.manually_selected_at).toLocaleDateString()}` : ""}</span>}
        </div>
      )}

      {/* "Why this competitor" — motor match, price logic, matched features,
          composite score (lib/analysisEngine.ts's selectByCompositeScore).
          Static/synchronous, like inclusion_rationale above — doesn't
          interact with the four useEffect-driven fetch sections below. */}
      {typeof c.composite_score === "number" && (
        <div className="rounded-lg border border-border/60 bg-surface-3/20 p-2.5 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider">Why this competitor</span>
            <span className="text-[9px] font-mono text-text-secondary" title={`Composite match score (${criterionKind === "none" ? "price + features" : `${CRITERION_DISPLAY[criterionKind].label.toLowerCase()} + price + features`})`}>
              score {c.composite_score.toFixed(2)}
            </span>
          </div>
          {criterionKind !== "none" && (
            <p className="text-[10px] text-text-secondary leading-snug">
              <span className="font-semibold">{CRITERION_DISPLAY[criterionKind].label}: </span>
              {criterionKind === "motor" ? (
                c.motor_match_tier === "unverified" ? (
                  "Motor type could not be confirmed for one or both products"
                ) : c.motor_match_tier === "exact" ? (
                  `Same motor type (${motorLabelWithBranded(c)})`
                ) : c.motor_match_tier === "adjacent" ? (
                  `Related motor technology (${motorLabelWithBranded(c)} vs. yours)`
                ) : (
                  `Different motor type (${motorLabelWithBranded(c) || "unknown"} vs. yours)`
                )
              ) : (
                c.heat_tech_match_tier === "unverified" ? (
                  "Plate/heat technology could not be confirmed for one or both products"
                ) : c.heat_tech_match_tier === "exact" ? (
                  `Same plate/heat technology (${heatTechLabelWithBranded(c)})`
                ) : (
                  `Different plate/heat technology (${heatTechLabelWithBranded(c) || "unknown"} vs. yours)`
                )
              )}
              {criterionKind === "motor" && c.motor_source_quote && <span className="italic text-text-muted"> — &quot;{c.motor_source_quote}&quot;</span>}
              {criterionKind === "heat_technology" && c.heat_tech_source_quote && <span className="italic text-text-muted"> — &quot;{c.heat_tech_source_quote}&quot;</span>}
            </p>
          )}
          <p className="text-[10px] text-text-secondary leading-snug">
            <span className="font-semibold">Price: </span>
            {c.price_logic === "relative" ? (
              <>
                Matched by relative brand tier
                {typeof c.their_lineup_percentile === "number" && typeof c.our_lineup_percentile === "number"
                  ? ` — their top ${Math.round((1 - c.their_lineup_percentile) * 100)}% model matched to your top ${Math.round((1 - c.our_lineup_percentile) * 100)}% model`
                  : ""}
                {c.their_lineup_sample && c.their_lineup_sample.length > 1 && (
                  <span className="text-text-muted"> ({c.their_lineup_sample.length} of their products compared)</span>
                )}
              </>
            ) : (
              "Matched by absolute proximity to your target price"
            )}
          </p>
          {c.motor_match_tier === "different" && (
            <p className="text-[10px] text-warning leading-snug">
              Included despite a different motor type — no exact/adjacent-motor candidate was available for this slot.
            </p>
          )}
          {c.heat_tech_match_tier === "different" && (
            <p className="text-[10px] text-warning leading-snug">
              Included despite different plate/heat technology — no exact-match candidate was available for this slot.
            </p>
          )}
          {c.differentiator_match === true && keyDiff && (
            <p className="text-[10px] text-success leading-snug">
              ✓ Matches differentiator: {keyDiff}
            </p>
          )}
        </div>
      )}

      {/* Live price / rating / reviews */}
      <div className="grid grid-cols-3 gap-2 py-2 border-y border-border/40 text-center font-mono">
        <div className="text-left font-sans">
          <p className="text-[9px] text-text-muted uppercase font-bold">Price</p>
          <p className={`font-bold text-text-primary text-xs mt-0.5 ${loading ? "animate-pulse" : ""}`}>{loading ? "$—.——" : displayPrice}</p>
        </div>
        <div className="font-sans">
          <p className="text-[9px] text-text-muted uppercase font-bold">Rating</p>
          {loading ? (
            <p className="font-bold text-text-muted text-xs mt-0.5 animate-pulse">—.—</p>
          ) : (
            <p className="font-bold text-text-primary text-xs mt-0.5 flex items-center justify-center gap-0.5">
              <Star className="w-3 h-3 text-warning fill-warning" />
              <span>{displayRating}</span>
            </p>
          )}
        </div>
        <div className="text-right font-sans">
          <p className="text-[9px] text-text-muted uppercase font-bold">Reviews</p>
          <p className={`font-bold text-text-primary text-xs mt-0.5 ${loading ? "animate-pulse" : ""}`}>{loading ? "—,———" : displayReviews}</p>
        </div>
      </div>

      {!loading && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {displaySales && <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-emerald-950/40 border border-emerald-900/40 text-emerald-400">{displaySales}</span>}
          {displayBSR && <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-blue-950/40 border border-blue-900/40 text-blue-400">{displayBSR}</span>}
          {live && (
            <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-indigo-950/40 border border-indigo-900/40 text-indigo-400 flex items-center gap-1" title={`Last updated: ${new Date(live.last_updated).toLocaleTimeString()}`}>
              <span className="w-1 h-1 rounded-full bg-indigo-400 animate-ping" /> Live
            </span>
          )}
          {error && <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-danger-bg border border-danger/20 text-danger" title={error}>Stale Data</span>}
          {c.verified_by_rainforest === false && (
            <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-warning/10 border border-warning/25 text-warning" title="Could not confirm a live Amazon listing for this competitor — use the search link above to look it up directly.">
              Unverified — see search link
            </span>
          )}
          {c.sources?.brand_site && !c.sources?.amazon && (
            <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-blue-950/40 border border-blue-900/40 text-blue-400" title={`Verified from ${c.sources.brand_site.url} — this product isn't sold on Amazon at all.`}>
              Verified via brand site — not sold on Amazon
            </span>
          )}
          {c.motor_unverified_fallback && criterionKind === "heat_technology" && (
            <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-warning/10 border border-warning/25 text-warning" title="No plate/heat-technology-evidenced candidate was available to fill this slot — included as a last-resort, unconfirmed.">
              Plate/heat technology unconfirmed — last-resort pick
            </span>
          )}
          {c.motor_unverified_fallback && criterionKind !== "heat_technology" && (
            <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-warning/10 border border-warning/25 text-warning" title="No motor-evidenced candidate was available to fill this slot — included as a last-resort, motor type unconfirmed.">
              Motor type unconfirmed — last-resort pick
            </span>
          )}
          {c.out_of_band && (
            <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-warning/10 border border-warning/25 text-warning" title={c.out_of_band_reason || undefined}>
              Outside Price Band
            </span>
          )}
          {c.brand_list_status === "not_curated" && (
            <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-warning/10 border border-warning/25 text-warning" title="Curated brands couldn't fill all 5 legacy slots within the price band — this pick came from AI research instead.">
              Not on curated legacy list
            </span>
          )}
          {c.registry_source_lists && c.registry_source_lists.length > 0 && (
            <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-blue-950/40 border border-blue-900/40 text-blue-400" title="Target Market: Both merges and dedupes the Pro/Salon and Retail curated brand lists.">
              via {c.registry_source_lists.map(l => (l === "pro" ? "Pro/Salon" : "Retail")).join(" + ")} list
            </span>
          )}
          {c.motor_match_tier === "different" && (
            <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-warning/10 border border-warning/25 text-warning" title="No exact or adjacent-motor candidate was available for this slot.">
              Different motor type ({motorLabelWithBranded(c) || "unknown"})
            </span>
          )}
          {c.heat_tech_match_tier === "different" && (
            <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-warning/10 border border-warning/25 text-warning" title="No exact-match candidate was available for this slot.">
              Different plate/heat technology ({heatTechLabelWithBranded(c) || "unknown"})
            </span>
          )}
          {c.nearest_match && (
            <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-warning/10 border border-warning/25 text-warning" title={c.nearest_match_reason || "No exact-fit competitor was found for this slot — showing the nearest similar product instead."}>
              Nearest Match
            </span>
          )}
        </div>
      )}

      {/* Widened-band disclosure — visible, not hover-only, since this is
          competitive-intel messaging the user should always see, not stumble
          into (see lib/analysisEngine.ts's applyPriceBandGate). */}
      {c.out_of_band && c.out_of_band_reason && (
        <p className="text-[10px] text-warning leading-snug">{c.out_of_band_reason}</p>
      )}

      {/* Nearest-match disclosure — same "always visible, not hover-only"
          reasoning as the out-of-band line above (see
          lib/analysisEngine.ts's selectByCompositeScore nearestSimilarMode). */}
      {c.nearest_match && c.nearest_match_reason && (
        <p className="text-[10px] text-warning leading-snug">{c.nearest_match_reason}</p>
      )}

      {isValidAsin && <div className="text-[10px] text-text-muted font-mono leading-none">ASIN: {c.asin}</div>}

      {/* Manufacturer / Model — fill-or-hide, never a placeholder dash */}
      {(displayManufacturer || displayModelNumber) && (
        <div className="flex flex-wrap gap-x-3 text-[10px] text-text-muted">
          {displayManufacturer && <span>Manufacturer: <span className="text-text-secondary">{displayManufacturer}</span></span>}
          {displayModelNumber && <span>Model: <span className="text-text-secondary">{displayModelNumber}</span></span>}
        </div>
      )}

      {/* Rating distribution — from the listing, when present */}
      {live?.rating_breakdown && (
        <div className="space-y-0.5 pt-0.5">
          {([["five_star", 5], ["four_star", 4], ["three_star", 3], ["two_star", 2], ["one_star", 1]] as const).map(([key, stars]) => {
            const pct = live.rating_breakdown?.[key];
            if (pct == null) return null;
            return (
              <div key={key} className="flex items-center gap-1.5 text-[9px] text-text-muted">
                <span className="w-6 shrink-0 inline-flex items-center gap-0.5">{stars}<Star className="w-2.5 h-2.5 fill-warning text-warning" /></span>
                <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                  <div className="h-full bg-warning" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-8 text-right">{pct}%</span>
              </div>
            );
          })}
        </div>
      )}

      {/* ==================== SECTION 1: KEY FEATURES ==================== */}
      <div className="border-t border-border/40 pt-3">
        <div className="w-full flex items-center justify-between text-text-muted">
          <button type="button" onClick={() => setFeaturesOpen(!featuresOpen)} className="flex-1 flex items-center justify-between hover:text-text-primary transition-colors font-semibold text-left">
            <span>Key Features {featuresState.status === "loaded" ? `(${featuresState.data.features.length})` : ""}</span>
            {featuresOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {featuresState.status === "loaded" && <RefreshButton onClick={() => loadFeatures(true)} />}
        </div>

        {featuresState.status === "loaded" && (
          assertProvenance(featuresState.data.provenance, "key_features", c.name) ? (
            <SectionSourceLine
              flavor="key_features"
              provenance={featuresState.data.provenance!}
              resolvedAt={featuresState.data.retrievedAt}
              asin={isValidAsin ? c.asin : null}
              open={featuresSourceOpen}
              onToggle={() => setFeaturesSourceOpen(o => !o)}
            />
          ) : <SourceUnavailableCaption />
        )}

        {featuresOpen && (
          <div className="mt-3 space-y-2.5 animate-slide-down">
            {featuresState.status === "loading" && <SkeletonRows count={4} />}
            {featuresState.status === "error" && (
              <div className="flex items-center justify-between gap-2 p-2 bg-danger-bg border border-danger/20 rounded-lg">
                <span className="text-danger">{featuresState.message}</span>
                <TimeoutChip onRetry={() => loadFeatures()} />
              </div>
            )}
            {featuresState.status === "loaded" && featuresState.data.features.length === 0 && (
              <p className="italic text-text-muted">
                No feature data found across {featuresState.data.tiersTried.join(", ") || "any source"} (searched {new Date(featuresState.data.searchedAt).toLocaleDateString()}).
              </p>
            )}
            {featuresState.status === "loaded" && (
              <div className="grid grid-cols-1 gap-2.5">
                {featuresState.data.features.slice(0, 6).map((f, idx) => (
                  <div key={idx} className="pl-2.5 border-l border-accent/40 space-y-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-bold text-text-primary">{f.headline}</span>
                      <CitationMarker source={sourceFor(featuresCitations, f.sourceUrl, f.sourceTitle, f.quote, f.retrievedAt)} />
                      <a
                        href={f.sourceUrl || amazonUrl || "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-1 py-0.2 rounded bg-surface-3 text-[8px] text-text-muted uppercase font-bold hover:text-accent"
                      >
                        [{f.source === "Amazon" ? "Amazon" : f.source === "Brand site" ? "Brand site" : (domainOf(f.sourceUrl) || f.source)}]
                      </a>
                    </div>
                    <p className="text-[11px] text-text-secondary leading-normal">{f.detail}</p>
                  </div>
                ))}
              </div>
            )}
            {featuresState.status === "loaded" && featuresState.data.features.length > 0 && (
              <SourcesFootnoteList sources={featuresState.data.features.map(f => sourceFor(featuresCitations, f.sourceUrl, f.sourceTitle, f.quote, f.retrievedAt))} />
            )}
          </div>
        )}
      </div>

      {/* ==================== SECTION 2: STRENGTHS ==================== */}
      <div className="border-t border-border/40 pt-3">
        <div className="w-full flex items-center justify-between text-text-muted">
          <button type="button" onClick={() => setStrengthsOpen(!strengthsOpen)} className="flex-1 flex items-center justify-between hover:text-text-primary transition-colors font-semibold text-left">
            <span>Strengths</span>
            {strengthsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {reviewAnalysis.status === "loaded" && <RefreshButton onClick={() => loadReviewAnalysis(true)} />}
        </div>

        {reviewAnalysis.status === "loaded" && (
          assertProvenance(reviewAnalysis.data.provenance, "reviews", c.name) ? (
            <SectionSourceLine
              flavor="reviews"
              provenance={reviewAnalysis.data.provenance!}
              resolvedAt={reviewAnalysis.data.retrievedAt}
              asin={isValidAsin ? c.asin : null}
              open={strengthsSourceOpen}
              onToggle={() => setStrengthsSourceOpen(o => !o)}
            />
          ) : <SourceUnavailableCaption />
        )}

        {strengthsOpen && (
          <div className="mt-3 space-y-2.5 animate-slide-down">
            {reviewAnalysis.status === "idle" && (
              <button
                type="button"
                onClick={() => loadReviewAnalysis()}
                className="px-3 py-1.5 text-[11px] font-semibold bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors"
              >
                Analyze reviews
              </button>
            )}
            {reviewAnalysis.status === "loading" && <SkeletonRows count={2} />}
            {reviewAnalysis.status === "error" && (
              <div className="flex items-center justify-between gap-2 p-2 bg-danger-bg border border-danger/20 rounded-lg">
                <span className="text-danger">{reviewAnalysis.message}</span>
                <TimeoutChip onRetry={() => loadReviewAnalysis()} />
              </div>
            )}
            {reviewAnalysis.status === "loaded" && reviewAnalysis.data.listingStats && (
              <ListingStatsCaption stats={reviewAnalysis.data.listingStats} />
            )}
            {reviewAnalysis.status === "loaded" && (reviewAnalysis.data.aiUnavailable || reviewAnalysis.data.sourcesUnavailable || reviewAnalysis.data.insufficientData) && (
              <ReviewSourcesNotice data={reviewAnalysis.data} onRetry={() => loadReviewAnalysis()} />
            )}
            {reviewAnalysis.status === "loaded" && !reviewAnalysis.data.insufficientData && !reviewAnalysis.data.sourcesUnavailable && !reviewAnalysis.data.aiUnavailable && (
              <>
                {reviewAnalysis.data.strengths.length === 0 && <p className="italic text-text-muted">None with verified support.</p>}
                {reviewAnalysis.data.strengths.map((s, idx) => (
                  <div key={idx} className="space-y-1">
                    <p className="text-success font-semibold flex items-center flex-wrap gap-1">
                      {s.theme}
                      <CitationMarker source={sourceFor(strengthsCitations, s.sourceUrl, reviewSourceLabel(s.sourceType) || s.evidence[0]?.quote?.slice(0, 40) || "Source", s.evidence[0]?.quote || "", reviewAnalysis.data.retrievedAt)} />
                      <span className="text-[9px] font-normal text-text-muted">[{reviewThemeSourceLabel(s)}]</span>
                    </p>
                    {s.evidence.slice(0, 2).map((e, i) => <EvidenceQuote key={i} evidence={e} />)}
                  </div>
                ))}
                <p className="text-[9px] text-text-muted pt-1">
                  Based on {reviewAnalysis.data.sourcesSummary.amazonReviews} Amazon reviews
                  {reviewAnalysis.data.sourcesSummary.expertReviews > 0 && ` + ${reviewAnalysis.data.sourcesSummary.expertReviews} expert reviews`}
                  {reviewAnalysis.data.sourcesSummary.forumDiscussions > 0 && ` + ${reviewAnalysis.data.sourcesSummary.forumDiscussions} forum discussions`}
                </p>
                <SourcesFootnoteList sources={strengthsCitations.allSources().map((url, i) => ({ number: i + 1, url, title: domainLabel(url), publisher: domainLabel(url), quote: "", retrievedAt: reviewAnalysis.data.retrievedAt }))} />
              </>
            )}
          </div>
        )}
      </div>

      {/* ==================== SECTION 3: WEAKNESSES & RECENT BUYER SENTIMENT ==================== */}
      <div className="border-t border-border/40 pt-3">
        <div className="w-full flex items-center justify-between text-text-muted">
          <button type="button" onClick={() => setWeaknessesOpen(!weaknessesOpen)} className="flex-1 flex items-center justify-between hover:text-text-primary transition-colors font-semibold text-left">
            <span>{buyerSentimentEnabled ? "Weaknesses & Recent Buyer Sentiment" : "Weaknesses"}</span>
            {weaknessesOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {reviewAnalysis.status === "loaded" && <RefreshButton onClick={() => loadReviewAnalysis(true)} />}
        </div>

        {reviewAnalysis.status === "loaded" && (
          assertProvenance(reviewAnalysis.data.provenance, "reviews", c.name) ? (
            <SectionSourceLine
              flavor="reviews"
              provenance={reviewAnalysis.data.provenance!}
              resolvedAt={reviewAnalysis.data.retrievedAt}
              asin={isValidAsin ? c.asin : null}
              open={weaknessesSourceOpen}
              onToggle={() => setWeaknessesSourceOpen(o => !o)}
            />
          ) : <SourceUnavailableCaption />
        )}

        {weaknessesOpen && (
          <div className="mt-3 space-y-2.5 animate-slide-down">
            {reviewAnalysis.status === "idle" && (
              <button
                type="button"
                onClick={() => loadReviewAnalysis()}
                className="px-3 py-1.5 text-[11px] font-semibold bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors"
              >
                Analyze reviews
              </button>
            )}
            {reviewAnalysis.status === "loading" && <SkeletonRows count={2} />}
            {reviewAnalysis.status === "error" && (
              <div className="flex items-center justify-between gap-2 p-2 bg-danger-bg border border-danger/20 rounded-lg">
                <span className="text-danger">{reviewAnalysis.message}</span>
                <TimeoutChip onRetry={() => loadReviewAnalysis()} />
              </div>
            )}
            {reviewAnalysis.status === "loaded" && reviewAnalysis.data.listingStats && (
              <ListingStatsCaption stats={reviewAnalysis.data.listingStats} />
            )}
            {reviewAnalysis.status === "loaded" && (reviewAnalysis.data.aiUnavailable || reviewAnalysis.data.sourcesUnavailable || reviewAnalysis.data.insufficientData) && (
              <ReviewSourcesNotice data={reviewAnalysis.data} onRetry={() => loadReviewAnalysis()} />
            )}
            {reviewAnalysis.status === "loaded" && !reviewAnalysis.data.insufficientData && !reviewAnalysis.data.sourcesUnavailable && !reviewAnalysis.data.aiUnavailable && (
              <>
                <div className="space-y-1.5">
                  <p className="font-bold text-danger text-[10px] uppercase tracking-wider">Weaknesses</p>
                  {reviewAnalysis.data.weaknesses.length === 0 && <p className="italic text-text-muted">None with verified support.</p>}
                  {reviewAnalysis.data.weaknesses.map((w, idx) => (
                    <div key={idx} className="space-y-1">
                      <p className="text-text-secondary font-semibold flex items-center flex-wrap gap-1">
                        {w.theme}
                        <CitationMarker source={sourceFor(weaknessesCitations, w.sourceUrl, reviewSourceLabel(w.sourceType) || w.evidence[0]?.quote?.slice(0, 40) || "Source", w.evidence[0]?.quote || "", reviewAnalysis.data.retrievedAt)} />
                        <span className="text-[9px] font-normal text-text-muted">[{reviewThemeSourceLabel(w)}]</span>
                      </p>
                      {w.evidence.slice(0, 2).map((e, i) => <EvidenceQuote key={i} evidence={e} />)}
                    </div>
                  ))}
                </div>

                {buyerSentimentEnabled && (
                  <div className="space-y-1.5 pt-2 border-t border-border/30">
                    <p className="font-bold text-accent text-[10px] uppercase tracking-wider">Recent Buyer Sentiment (last 90 days)</p>
                    {!reviewAnalysis.data.recentSentiment && <p className="italic text-text-muted">No reviews from the last 90 days.</p>}
                    {reviewAnalysis.data.recentSentiment && (
                      <>
                        <div className="flex items-center gap-2 flex-wrap">
                          {reviewAnalysis.data.recentSentiment.trend === "improving" && <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold bg-success/10 border border-success/25 text-success"><TrendingUp className="w-3 h-3" /> Improving</span>}
                          {reviewAnalysis.data.recentSentiment.trend === "declining" && <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold bg-danger/10 border border-danger/25 text-danger"><TrendingDown className="w-3 h-3" /> Declining</span>}
                          {reviewAnalysis.data.recentSentiment.trend === "stable" && <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold bg-surface-3 border border-border text-text-muted"><Minus className="w-3 h-3" /> Stable</span>}
                          {reviewAnalysis.data.recentSentiment.trend === "unknown" && <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold bg-surface-3 border border-border text-text-muted"><Minus className="w-3 h-3" /> Trend unclear</span>}
                          <span className="text-[10px] text-text-muted inline-flex items-center flex-wrap gap-x-1">
                            <span>{reviewAnalysis.data.recentSentiment.reviewCount} reviews</span>
                            {reviewAnalysis.data.recentSentiment.avgRating != null && (
                              <span className="inline-flex items-center gap-0.5">
                                · avg {reviewAnalysis.data.recentSentiment.avgRating.toFixed(1)}<Star className="w-2.5 h-2.5 fill-warning text-warning" />
                              </span>
                            )}
                            {reviewAnalysis.data.recentSentiment.priorAvgRating != null && (
                              <span className="inline-flex items-center gap-0.5">
                                (was {reviewAnalysis.data.recentSentiment.priorAvgRating.toFixed(1)}<Star className="w-2.5 h-2.5 fill-warning text-warning" />)
                              </span>
                            )}
                          </span>
                        </div>
                        {reviewAnalysis.data.recentSentiment.dominantThemes.map((t, idx) => (
                          <div key={idx} className="space-y-1">
                            <p className="text-text-secondary font-semibold flex items-center flex-wrap gap-1">
                              {t.theme}
                              <span className="text-[9px] font-normal text-text-muted">[{reviewThemeSourceLabel(t)}]</span>
                            </p>
                            {t.evidence.slice(0, 2).map((e, i) => <EvidenceQuote key={i} evidence={e} />)}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
                <p className="text-[9px] text-text-muted pt-1 border-t border-border/30">
                  Data retrieved {new Date(reviewAnalysis.data.retrievedAt).toLocaleString()}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* ==================== SECTION 4: NEWS UPDATES ==================== */}
      {newsUpdatesEnabled && (
        <div className="border-t border-border/40 pt-3">
          <div className="w-full flex items-center justify-between text-text-muted">
            <button type="button" onClick={() => setNewsOpen(!newsOpen)} className="flex-1 flex items-center justify-between hover:text-text-primary transition-colors font-semibold text-left">
              <span className="flex items-center gap-1.5"><Newspaper className="w-3.5 h-3.5" /> News Updates</span>
              {newsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            {newsState.status === "loaded" && <RefreshButton onClick={() => loadNews(true)} />}
          </div>

          {newsState.status === "loaded" && (
            assertProvenance(newsState.data.provenance, "news", c.name) ? (
              <SectionSourceLine
                flavor="news"
                provenance={newsState.data.provenance!}
                resolvedAt={newsState.data.retrievedAt}
                open={newsSourceOpen}
                onToggle={() => setNewsSourceOpen(o => !o)}
              />
            ) : <SourceUnavailableCaption />
          )}

          {newsOpen && (
            <div className="mt-3 space-y-2.5 animate-slide-down">
              {newsState.status === "loading" && <SkeletonRows count={2} />}
              {newsState.status === "error" && (
                <div className="flex items-center justify-between gap-2 p-2 bg-danger-bg border border-danger/20 rounded-lg">
                  <span className="text-danger">{newsState.message}</span>
                  <TimeoutChip onRetry={() => loadNews()} />
                </div>
              )}
              {newsState.status === "loaded" && newsState.data.aiUnavailable && (
                <div className="flex items-center justify-between gap-2 py-2">
                  <span className="text-warning">No AI provider is available right now to search for news.</span>
                  <TimeoutChip onRetry={() => loadNews()} />
                </div>
              )}
              {newsState.status === "loaded" && !newsState.data.aiUnavailable && (
                <>
                  {newsState.data.items.length === 0 && (
                    <p className="italic text-text-muted">No product-specific news found (searched {new Date(newsState.data.searchedAt).toLocaleDateString()}).</p>
                  )}
                  {newsState.data.items.map((item, idx) => (
                    <div key={idx} className="p-2 rounded-lg border border-border/60 space-y-0.5">
                      <p className="font-semibold text-text-primary flex items-center flex-wrap">
                        {item.title}
                        <CitationMarker source={sourceFor(newsCitations, item.url, item.publisher || item.title, item.summary, newsState.data.searchedAt)} />
                      </p>
                      <p className="text-[11px] text-text-secondary leading-normal">{item.summary}</p>
                      <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-[9px] text-text-muted hover:text-accent inline-flex items-center gap-1">
                        {item.publisher}{item.date && ` · ${item.date}`} <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    </div>
                  ))}
                  {newsState.data.items.length > 0 && (
                    <SourcesFootnoteList sources={newsState.data.items.map(item => sourceFor(newsCitations, item.url, item.publisher || item.title, item.summary, newsState.data.searchedAt))} />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function domainLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
