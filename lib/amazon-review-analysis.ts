// Strictly review-grounded strengths/weaknesses/recent-sentiment analysis.
// The AI only ever sees the review/article texts fetched for THIS product —
// never web search results trusted blindly, never its own trained
// knowledge. After it responds, every quoted fragment is verified to
// actually appear in the fetched text; any theme whose evidence doesn't
// verify is dropped before it ever reaches the UI. This makes
// hallucination structurally impossible to reach the client.
//
// Resolver order (each tier is recorded — attempted/outcome/itemCount — so
// the UI can report exactly what happened instead of a generic message):
//   Tier A: Rainforest full reviews endpoint (multi-pass: all/positive/
//           negative/recent) — the richest source when it works.
//   Tier B: the product listing's own `top_reviews` + `rating_breakdown`
//           (from the `type=product` payload the caller already fetched —
//           zero additional Rainforest calls) — a floor so a product with
//           a real Amazon listing never renders bare "no data" just
//           because the dedicated reviews endpoint came back thin/erroring.
//   Tier C: expert review articles + forum discussions found via web
//           search, fetched and verified the same way.
// Tier A failing outright (auth/credit error, endpoint down) is recorded
// distinctly from Tier A succeeding with genuinely zero reviews — those
// must never be presented to the user as the same thing.
import { genAI, hasGeminiKey, GEMINI_MODEL, cleanJsonString } from "./gemini";
import { callOpenAiForJson, hasOpenAIKey } from "./openai";
import {
  AmazonReview,
  RainforestProduct,
  ReviewFetchStatus,
  ReviewSetResult,
  combineFetchResults,
  getAmazonReviews,
  getAmazonReviewsByStars,
  getRecentReviews,
} from "./rainforest";
import { searchForUrls, SearchHit } from "./web-search";
import { fetchPageText, quoteAppearsInText } from "./citations";
import { logCall } from "./obs";
import { SectionProvenanceData, ProvenanceTier, ProvenanceQuery, fromTierResult } from "./section-provenance";
import { assertToolType, ToolType } from "./tool-type-taxonomy";
import { listToolTypes } from "./db/tool-types";
import type { ToolTypeRow } from "./db/tool-types";

export type ReviewSourceType = "customer_reviews" | "amazon_listing" | "expert_review" | "forum";

export interface ReviewEvidence {
  quote: string;
  date: string | null;
  // Set only when the quote's original language wasn't the app's display
  // language (lib/amazon-review-analysis.ts's checkQuoteQuality) — quote
  // itself stays the real verbatim original text; translation is shown
  // alongside it, never in place of it.
  translated?: boolean;
  translation?: string | null;
}

export interface ReviewTheme {
  theme: string;
  evidence: ReviewEvidence[];
  sourceType: ReviewSourceType;
  sourceUrl?: string | null;
}

export interface RecentSentiment {
  reviewCount: number;
  avgRating: number | null;
  priorAvgRating: number | null;
  // Computed in code from the actual numbers above — never AI-guessed.
  trend: "improving" | "declining" | "stable" | "unknown";
  dominantThemes: ReviewTheme[];
}

// Honest, per-tier outcome — replaces treating "returned zero" and "the
// request failed" as the same thing. `attempted: false` means the tier was
// never even tried (e.g. no valid ASIN), which is distinct from both.
export type TierOutcome = "success" | "empty" | "error";

export interface TierResult {
  tier: string;
  attempted: boolean;
  outcome: TierOutcome;
  itemCount?: number;
  errorMessage?: string;
}

export interface SourcesSummary {
  amazonReviews: number;
  expertReviews: number;
  forumDiscussions: number;
  // Kept for backward-compatibility with cached (pre-existing) payloads and
  // any reader that only knows this shape — now honestly derived from
  // `tiers` (only tiers that were actually attempted), instead of being
  // unconditionally seeded with every tier name regardless of what ran.
  tiersTried: string[];
  tiers: TierResult[];
}

export interface ListingStats {
  rating: number | null;
  reviewsTotal: number | null;
  ratingBreakdown: RainforestProduct["rating_breakdown"];
  source: "amazon_product_listing";
}

export interface ReviewAnalysis {
  strengths: ReviewTheme[];
  weaknesses: ReviewTheme[];
  recentSentiment: RecentSentiment | null;
  reviewCountAnalyzed: number;
  dateRange: { earliest: string | null; latest: string | null } | null;
  // True only when every tier that ran found genuinely nothing AND no tier
  // errored (a real, verifiably-searched "no data exists" case).
  insufficientData: boolean;
  // True when the reason nothing came back is that a tier's request itself
  // failed (Rainforest auth/credit error, endpoint down, etc.) — distinct
  // from insufficientData; the UI should say "sources unavailable, retry"
  // rather than the misleading "no review data found".
  sourcesUnavailable: boolean;
  // True when reviews were fetched fine but no AI provider could analyze
  // them (both OpenAI and Gemini unavailable) — distinct from both of the
  // above, which are about data availability, not analysis availability.
  aiUnavailable: boolean;
  // Rating + count + distribution straight from the product listing —
  // populated whenever a product payload exists, independent of whether
  // any theme was verified, so a real listing never renders as if it had
  // zero information at all.
  listingStats: ListingStats | null;
  sourcesSummary: SourcesSummary;
  // Persisted, section-level source trail (see lib/section-provenance.ts) —
  // additive/optional so cached pre-existing payloads without it stay valid.
  provenance?: SectionProvenanceData;
}

const MIN_REVIEWS_REQUIRED = 5;
const MIN_EVIDENCE_PER_THEME = 2;
const RATING_TREND_EPSILON = 0.15; // smaller swings are noise, not a real trend

function normalizeWhitespace(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// Amazon-style review pages/snippets often carry a "Reviewed in {country}
// on {date}" boilerplate line right next to the review body, and the AI
// occasionally echoes it (sometimes duplicated) into a quoted fragment —
// the stored quote must contain ONLY the reviewer's own words. Strips that
// phrase plus any raw ISO timestamp, tolerant of either appearing more
// than once in the same string.
const REVIEWED_IN_BOILERPLATE_RE = /reviewed in\s+(?:the\s+)?[a-z .,'-]+?\s+on\s+[a-z]+\.?\s+\d{1,2},?\s*\d{4}/gi;
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/g;

function stripDateArtifacts(text: string): string {
  return text.replace(REVIEWED_IN_BOILERPLATE_RE, "").replace(ISO_TIMESTAMP_RE, "").replace(/\s{2,}/g, " ").trim();
}

// Finds the actual source review a quote came from — used instead of a
// plain boolean check so the evidence's `date` can be taken directly from
// OUR OWN normalized AmazonReview.date, never from whatever the AI echoed
// into its own `date` field (which was the root cause of raw ISO
// timestamps and raw/duplicated "Reviewed in..." strings reaching the UI —
// that field receives no other validation, unlike quote text).
function findMatchingReview(quote: string, reviews: AmazonReview[]): AmazonReview | null {
  const needle = normalizeWhitespace(quote);
  if (needle.length < 8) return null; // too short to be a meaningful citation
  return reviews.find(r => normalizeWhitespace(`${r.title} ${r.body}`).includes(needle)) ?? null;
}

// Shared by the Rainforest-reviews tier (A) and the product-listing
// top_reviews tier (B) — both verify AI-extracted themes against a real
// AmazonReview[] the same way. The web tier (C) verifies against raw page
// text instead (a different shape) and keeps its own inline verifier.
export function verifyThemes(
  themes: any[],
  sourceReviews: AmazonReview[],
  sourceType: ReviewSourceType,
  rejected?: { count: number; reasons: string[] }
): ReviewTheme[] {
  if (!Array.isArray(themes)) return [];
  const out: ReviewTheme[] = [];
  for (const t of themes) {
    if (!t?.theme || !Array.isArray(t.evidence)) continue;
    const verifiedEvidence = (t.evidence as any[])
      .map(e => (e?.quote ? { cleanQuote: stripDateArtifacts(e.quote), match: findMatchingReview(stripDateArtifacts(e.quote), sourceReviews) } : null))
      .filter((e): e is { cleanQuote: string; match: AmazonReview } => !!e?.match);
    if (verifiedEvidence.length >= MIN_EVIDENCE_PER_THEME) {
      out.push({
        theme: t.theme,
        evidence: verifiedEvidence.map(e => ({ quote: e.cleanQuote, date: e.match.date ?? null })),
        sourceType,
      });
    } else if (rejected) {
      rejected.count++;
      rejected.reasons.push(`"${t.theme}" — only ${verifiedEvidence.length}/${MIN_EVIDENCE_PER_THEME} quotes verified`);
    }
  }
  return out;
}

// Maps the product listing's top_reviews (from the type=product payload)
// into the same AmazonReview shape the full reviews endpoint returns, so
// the exact same prompt-building/verification pipeline can be reused.
export function topReviewsToAmazonReviews(product: RainforestProduct): AmazonReview[] {
  return (product.top_reviews ?? [])
    .map(r => ({
      title: r.title || "",
      body: r.body || "",
      rating: r.rating ?? null,
      date: r.date ?? null,
      verifiedPurchase: !!r.verified_purchase,
    }))
    .filter(r => r.body.trim().length > 0);
}

function computeDateRange(reviews: AmazonReview[]): { earliest: string | null; latest: string | null } | null {
  const dates = reviews.map(r => r.date).filter(Boolean) as string[];
  if (dates.length === 0) return null;
  const sorted = [...dates].sort();
  return { earliest: sorted[0], latest: sorted[sorted.length - 1] };
}

function avgRating(reviews: AmazonReview[]): number | null {
  const rated = reviews.map(r => r.rating).filter((r): r is number => typeof r === "number");
  if (rated.length === 0) return null;
  return rated.reduce((a, b) => a + b, 0) / rated.length;
}

function dedupeReviews(reviews: AmazonReview[]): AmazonReview[] {
  const seen = new Set<string>();
  const out: AmazonReview[] = [];
  for (const r of reviews) {
    const key = `${r.date ?? ""}|${normalizeWhitespace(r.title)}|${normalizeWhitespace(r.body).slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function formatReviewBlock(reviews: AmazonReview[]) {
  return reviews
    .map((r, i) => `[Review ${i + 1}] rating: ${r.rating ?? "—"} | date: ${r.date ?? "—"} | verified: ${r.verifiedPurchase}\n${r.title}\n${r.body}`)
    .join("\n\n");
}

function buildPrompt(asin: string, productTitle: string, positive: AmazonReview[], negative: AmazonReview[], recent: AmazonReview[], includeSentiment: boolean) {
  const systemPrompt = `You are analyzing real Amazon customer reviews for ASIN ${asin} (${productTitle}). Using ONLY the review texts provided below in each labeled section — no outside knowledge, no assumptions, no web search:

1. STRENGTHS: recurring positive themes from the POSITIVE REVIEWS section. Each strength must cite at least 2 supporting reviews (a short verbatim quote fragment + that review's date).
2. WEAKNESSES: recurring complaints from the NEGATIVE REVIEWS section. Same citation rule.${includeSentiment ? `
3. RECENT DOMINANT THEMES: recurring themes (positive or negative) specifically from the RECENT REVIEWS (last 90 days) section. Same citation rule — at least 2 supporting reviews per theme.` : ""}

If a section's reviews do not support a claim, do not make it — return an empty array for that section rather than reaching into a different section's reviews. Every quote you cite must be an exact substring of the review text it's attributed to — do not paraphrase inside the quote field.

Return ONLY valid JSON, no markdown:
{
  "strengths": [{ "theme": "...", "evidence": [{ "quote": "...", "date": "..." }, { "quote": "...", "date": "..." }] }],
  "weaknesses": [{ "theme": "...", "evidence": [{ "quote": "...", "date": "..." }, { "quote": "...", "date": "..." }] }]${includeSentiment ? `,
  "recentDominantThemes": [{ "theme": "...", "evidence": [{ "quote": "...", "date": "..." }, { "quote": "...", "date": "..." }] }]` : ""}
}`;

  const userPrompt = `Product: ${productTitle} (ASIN ${asin})

POSITIVE REVIEWS (4-5 star):
${positive.length ? formatReviewBlock(positive) : "(none fetched)"}

NEGATIVE REVIEWS (1-2 star):
${negative.length ? formatReviewBlock(negative) : "(none fetched)"}${includeSentiment ? `

RECENT REVIEWS (last 90 days, any rating):
${recent.length ? formatReviewBlock(recent) : "(none fetched)"}` : ""}`;

  return { systemPrompt, userPrompt };
}

async function callAi(systemPrompt: string, userPrompt: string): Promise<any> {
  if (hasOpenAIKey) {
    const result = await callOpenAiForJson(systemPrompt, userPrompt, "review analysis", { timeoutMs: 30_000 });
    if (result) return result;
  }
  if (hasGeminiKey) {
    try {
      const message = await genAI.models.generateContent({
        model: GEMINI_MODEL,
        config: { systemInstruction: systemPrompt, maxOutputTokens: 4096 },
        contents: userPrompt,
      });
      return JSON.parse(cleanJsonString(message.text || "{}"));
    } catch (err) {
      console.warn("Gemini review analysis failed:", err);
    }
  }
  return null;
}

// Fetches the four targeted Amazon review sets for this ASIN. Each fetch is
// independent and returns a tri-state ReviewSetResult — a failure on one
// (e.g. Rainforest temporarily rejects the star filter, or the reviews
// endpoint is down entirely) doesn't block the others; analyzeReviews works
// with whatever combination came back, and can tell an error apart from a
// genuine empty result.
async function fetchAmazonReviewSets(asin: string, referenceDate: Date, includeSentiment: boolean): Promise<{
  all: ReviewSetResult;
  positive: ReviewSetResult;
  negative: ReviewSetResult;
  recent: ReviewSetResult;
}> {
  // The last-90-days pass exists only to feed Recent Buyer Sentiment — when
  // that's disabled, skip this Rainforest call entirely (real cost/time
  // savings) rather than fetching it and merely hiding the result.
  const [all, positive, negative, recent] = await Promise.all([
    getAmazonReviews(asin),
    getAmazonReviewsByStars(asin, "four_star,five_star"),
    getAmazonReviewsByStars(asin, "one_star,two_star"),
    includeSentiment ? getRecentReviews(asin, referenceDate) : Promise.resolve({ status: "empty", reviews: [] } as ReviewSetResult),
  ]);
  return { all, positive, negative, recent };
}

// Web fallback tier — expert review articles + forum discussions, fetched
// and verified the same way as Amazon reviews (quote must be a real
// substring of the actual fetched page). Runs only when Tiers A and B
// didn't provide any verified themes.
// Confirmed live: extracting strengths+weaknesses from a full ~20k-char
// article at effort:"low" routinely exceeds 20s and hits the OpenAI client
// timeout — bumped alongside the text-window increase above.
const WEB_REVIEW_TIMEOUT_MS = 35_000;

// FIX 3 (quote quality): ONE batched AI call per analyzeReviews invocation
// — never one call per quote — that does two things at once: (1) flags a
// non-English quote and supplies a bracketed translation, sorting
// English-language evidence first within each theme (CompetitorCard.tsx
// only ever displays the first 2, so this is how "prefer the display
// language when enough real evidence exists" actually takes effect); (2)
// catches a quote whose own sentiment directly contradicts the section
// it's filed under (a genuine weight complaint filed as evidence for a
// "Premium build" STRENGTH) and drops it — a theme that falls below
// MIN_EVIDENCE_PER_THEME after dropping is dropped entirely, same rule
// verifyThemes already applies at selection time. Fails open: no OpenAI
// key, an empty input, or any call error leaves strengths/weaknesses
// completely untouched — this is a quality refinement, never a blocker.
async function checkQuoteQuality(strengths: ReviewTheme[], weaknesses: ReviewTheme[]): Promise<{ strengths: ReviewTheme[]; weaknesses: ReviewTheme[] }> {
  type Loc = { section: "strengths" | "weaknesses"; themeIdx: number; evidenceIdx: number };
  const locs: Loc[] = [];
  const quotes: string[] = [];
  strengths.forEach((t, ti) => t.evidence.forEach((e, ei) => { locs.push({ section: "strengths", themeIdx: ti, evidenceIdx: ei }); quotes.push(e.quote); }));
  weaknesses.forEach((t, ti) => t.evidence.forEach((e, ei) => { locs.push({ section: "weaknesses", themeIdx: ti, evidenceIdx: ei }); quotes.push(e.quote); }));

  if (quotes.length === 0 || !hasOpenAIKey) return { strengths, weaknesses };

  const systemPrompt = `For each numbered review quote below, report whether it's already in English, an English translation (only if not English, else null), and the sentiment the REVIEWER is expressing in their own words. Judge sentiment from the quote's own words only — no outside knowledge.

Return ONLY valid JSON, no markdown, one entry per quote in order:
{ "items": [{ "index": 0, "isEnglish": true, "translation": null, "sentiment": "positive" }] }
"sentiment" must be exactly "positive", "negative", or "neutral".`;
  const userPrompt = quotes.map((q, i) => `[${i}] "${q}"`).join("\n");

  let raw: { items?: { index: number; isEnglish?: boolean; translation?: string | null; sentiment?: string }[] } | null = null;
  try {
    raw = await callOpenAiForJson(systemPrompt, userPrompt, "review quote quality check", { timeoutMs: 12_000, effort: "low" });
  } catch {
    raw = null;
  }
  if (!raw || !Array.isArray(raw.items)) return { strengths, weaknesses };

  const byIndex = new Map(raw.items.map(it => [it.index, it]));
  const strengthsCopy = strengths.map(t => ({ ...t, evidence: t.evidence.map(e => ({ ...e })) }));
  const weaknessesCopy = weaknesses.map(t => ({ ...t, evidence: t.evidence.map(e => ({ ...e })) }));
  const dropSlots = new Set<string>();

  locs.forEach((loc, i) => {
    const verdict = byIndex.get(i);
    if (!verdict) return;
    const target = (loc.section === "strengths" ? strengthsCopy : weaknessesCopy)[loc.themeIdx];
    const evidence = target?.evidence[loc.evidenceIdx];
    if (!evidence) return;

    const expectedPositive = loc.section === "strengths";
    const contradicts = (expectedPositive && verdict.sentiment === "negative") || (!expectedPositive && verdict.sentiment === "positive");
    if (contradicts) {
      dropSlots.add(`${loc.section}:${loc.themeIdx}:${loc.evidenceIdx}`);
      return;
    }
    if (verdict.isEnglish === false && verdict.translation) {
      evidence.translated = true;
      evidence.translation = verdict.translation;
    }
  });

  const finalize = (themes: ReviewTheme[], section: "strengths" | "weaknesses"): ReviewTheme[] =>
    themes
      .map((t, ti) => {
        const kept = t.evidence.filter((_, ei) => !dropSlots.has(`${section}:${ti}:${ei}`));
        const sorted = [...kept].sort((a, b) => (a.translated ? 1 : 0) - (b.translated ? 1 : 0));
        return { ...t, evidence: sorted };
      })
      .filter(t => t.evidence.length >= MIN_EVIDENCE_PER_THEME);

  return { strengths: finalize(strengthsCopy, "strengths"), weaknesses: finalize(weaknessesCopy, "weaknesses") };
}

async function resolveWebReviewThemes(productName: string, toolTypes: ToolTypeRow[], requiredToolType?: ToolType | null): Promise<{
  strengths: ReviewTheme[];
  weaknesses: ReviewTheme[];
  expertReviewCount: number;
  forumCount: number;
  queries: ProvenanceQuery[];
}> {
  const expertQuery = `"${productName}" review pros and cons`;
  const forumQuery = `"${productName}" reddit`;
  const t0 = Date.now();
  const [expertHitsRaw, forumHitsRaw] = await Promise.all([
    searchForUrls(expertQuery, 3),
    searchForUrls(forumQuery, 2),
  ]);
  // Reject a hit whose OWN search-result title positively resolves to a
  // DIFFERENT known tool type before ever fetching/paying for its full
  // page text — e.g. an article titled "Best Clippers of 2026" for a
  // trimmer analysis. Unrecognized-but-on-topic titles (no type word at
  // all) are never rejected — assertToolType only catches a known
  // mismatch, never invents one from missing information.
  const rejectWrongType = (h: SearchHit) => {
    if (!requiredToolType) return true;
    const ok = assertToolType(h.title, requiredToolType, toolTypes).ok;
    if (!ok) console.warn(`[tool-type] rejected review-web-search hit "${h.title}" — mismatched tool type for ${requiredToolType}`);
    return ok;
  };
  const expertHits = expertHitsRaw.filter(rejectWrongType);
  const forumHits = forumHitsRaw.filter(rejectWrongType);
  const elapsedMs = Date.now() - t0;
  logCall("review-tier", { op: "web-search", query: expertQuery, outcome: expertHits.length ? "ok" : "empty", itemCount: expertHits.length, elapsedMs });
  logCall("review-tier", { op: "web-search", query: forumQuery, outcome: forumHits.length ? "ok" : "empty", itemCount: forumHits.length, elapsedMs });
  const queries: ProvenanceQuery[] = [
    { tier: "Expert reviews", query: expertQuery, outcome: expertHits.length ? "success" : "empty", itemCount: expertHits.length, elapsedMs, verified: true },
    { tier: "Forum discussions", query: forumQuery, outcome: forumHits.length ? "success" : "empty", itemCount: forumHits.length, elapsedMs, verified: true },
  ];

  const strengths: ReviewTheme[] = [];
  const weaknesses: ReviewTheme[] = [];
  let expertReviewCount = 0;
  let forumCount = 0;

  const processHit = async (url: string, sourceType: ReviewSourceType) => {
    const hitT0 = Date.now();
    const text = await fetchPageText(url);
    if (!text || text.length < 100) {
      logCall("review-tier", { op: `hit:${sourceType}`, outcome: "empty", pagesFetched: 1, extractedTextLength: text?.length ?? 0, elapsedMs: Date.now() - hitT0 });
      return;
    }

    const result = await callOpenAiForJson<{ strengths: any[]; weaknesses: any[] }>(
      `From the text below about "${productName}", list recurring strengths and weaknesses mentioned. Using ONLY this text — no outside knowledge. Each theme needs at least 2 verbatim quote fragments from the text. If the text isn't really about this product, or doesn't support a theme, omit it.

Return ONLY valid JSON: { "strengths": [{ "theme": "...", "evidence": [{ "quote": "..." }, { "quote": "..." }] }], "weaknesses": [...] }`,
      // Real review content is often preceded by several thousand
      // characters of nav/membership/ad boilerplate — confirmed live
      // against real review pages (lib/key-features-resolver.ts hit the
      // same issue) that a small window reliably missed it.
      `Text:\n${text.slice(0, 20_000)}`,
      `web review themes (${sourceType})`,
      { timeoutMs: WEB_REVIEW_TIMEOUT_MS }
    );
    if (!result) {
      logCall("review-tier", { op: `hit:${sourceType}`, outcome: "error", pagesFetched: 1, extractedTextLength: text.length, elapsedMs: Date.now() - hitT0, errorMessage: "AI extraction unavailable" });
      return;
    }

    const verify = (themes: any[]): ReviewTheme[] => {
      if (!Array.isArray(themes)) return [];
      const out: ReviewTheme[] = [];
      for (const t of themes) {
        if (!t?.theme || !Array.isArray(t.evidence)) continue;
        const verifiedEvidence = (t.evidence as any[])
          .map(e => (e?.quote ? stripDateArtifacts(e.quote) : null))
          .filter((q): q is string => !!q && quoteAppearsInText(q, [text]));
        if (verifiedEvidence.length >= MIN_EVIDENCE_PER_THEME) {
          out.push({ theme: t.theme, evidence: verifiedEvidence.map(q => ({ quote: q, date: null })), sourceType, sourceUrl: url });
        }
      }
      return out;
    };

    const s = verify(result.strengths);
    const w = verify(result.weaknesses);
    logCall("review-tier", { op: `hit:${sourceType}`, outcome: (s.length + w.length) > 0 ? "ok" : "empty", pagesFetched: 1, extractedTextLength: text.length, itemCount: s.length + w.length, elapsedMs: Date.now() - hitT0 });
    if (s.length || w.length) {
      if (sourceType === "expert_review") expertReviewCount++;
      else forumCount++;
    }
    strengths.push(...s);
    weaknesses.push(...w);
  };

  await Promise.all([
    ...expertHits.map(h => processHit(h.url, "expert_review" as ReviewSourceType)),
    ...forumHits.map(h => processHit(h.url, "forum" as ReviewSourceType)),
  ]);

  return { strengths, weaknesses, expertReviewCount, forumCount, queries };
}

// Masks recentSentiment in a RESPONSE only — never mutates the object
// passed in (so the caller's cached/stored copy stays untouched). Used by
// the reviews-analysis route on both the cache-hit and fresh-compute paths
// so old cached rows (with real sentiment from before the flag existed)
// reappear immediately when the flag is flipped back on, with zero
// regeneration.
export function maskSentimentForResponse<T extends { recentSentiment: RecentSentiment | null }>(analysis: T, sentimentEnabled: boolean): T {
  if (sentimentEnabled) return analysis;
  return { ...analysis, recentSentiment: null };
}

export async function analyzeReviews(
  asin: string,
  productTitle: string,
  referenceDate: Date = new Date(),
  product?: RainforestProduct | null,
  requiredToolType?: ToolType | null,
  opts?: { includeSentiment?: boolean }
): Promise<ReviewAnalysis> {
  const asinValid = /^[A-Z0-9]{10}$/i.test(asin || "");
  const includeSentiment = opts?.includeSentiment !== false;

  // Broad-audit finding — this function chains up to 4 sequential AI/web
  // calls (Tier A -> B -> C -> checkQuoteQuality) with zero overall deadline
  // anywhere; tracing each call's own timeout through openai.ts's retry math,
  // the full worst-case chain can approach/exceed 2 minutes — already
  // confirmed live by this function's own caller
  // (app/api/amazon/reviews-analysis/[asin]/route.ts's header comment:
  // "confirmed live that the multi-tier resolver... sometimes takes right up
  // to" its 60s maxDuration). Tiers B/C are both explicitly designed as
  // fallbacks ("Only when Tier A/B... found nothing" — their own comments),
  // so they're the right ones to skip under budget pressure; Tier A (real
  // Amazon review data) and checkQuoteQuality (verifying whatever WAS found)
  // never get skipped — this bounds the worst case without ever discarding
  // already-found, already-verified real data.
  const startedAt = Date.now();
  const TIME_BUDGET_MS = 42_000;
  const overBudget = () => Date.now() - startedAt > TIME_BUDGET_MS;

  if (!includeSentiment) {
    logCall("review-tier", { op: "sentiment-skip", outcome: "ok", errorMessage: "disabled via feature flag", elapsedMs: 0 });
  }

  // ---- Tier A: Rainforest full reviews endpoint (multi-pass) ----
  const { all, positive, negative, recent } = await fetchAmazonReviewSets(asin, referenceDate, includeSentiment);
  const amazonOutcome: ReviewSetResult = combineFetchResults([all, positive, negative, recent]);
  const combined = dedupeReviews([...all.reviews, ...positive.reviews, ...negative.reviews, ...recent.reviews]);
  const dateRange = computeDateRange(combined);

  const amazonSufficient = combined.length >= MIN_REVIEWS_REQUIRED;

  let strengths: ReviewTheme[] = [];
  let weaknesses: ReviewTheme[] = [];
  let recentSentiment: RecentSentiment | null = null;
  let anyAiUnavailable = false;

  let tierAOutcome: TierOutcome = !asinValid
    ? "empty"
    : amazonOutcome.status === "ok" ? "success" : amazonOutcome.status === "empty" ? "empty" : "error";

  const tierARejected = { count: 0, reasons: [] as string[] };

  if (amazonSufficient) {
    const { systemPrompt, userPrompt } = buildPrompt(asin, productTitle, positive.reviews, negative.reviews, recent.reviews, includeSentiment);
    const raw = await callAi(systemPrompt, userPrompt);

    if (!raw) {
      anyAiUnavailable = true;
    } else {
      strengths = verifyThemes(raw.strengths, positive.reviews.length ? positive.reviews : combined, "customer_reviews", tierARejected);
      weaknesses = verifyThemes(raw.weaknesses, negative.reviews.length ? negative.reviews : combined, "customer_reviews", tierARejected);

      if (includeSentiment && recent.reviews.length > 0) {
        // Prior-period average — everything NOT in the last-90-days set —
        // lets the trend badge below be a real, code-computed comparison
        // rather than an AI guess at whether sentiment is "improving".
        const recentKeys = new Set(recent.reviews.map(r => `${r.date}|${normalizeWhitespace(r.title)}`));
        const priorReviews = combined.filter(r => !recentKeys.has(`${r.date}|${normalizeWhitespace(r.title)}`));
        const recentAvg = avgRating(recent.reviews);
        const priorAvg = avgRating(priorReviews);

        let trend: RecentSentiment["trend"] = "unknown";
        if (recentAvg !== null && priorAvg !== null) {
          const delta = recentAvg - priorAvg;
          trend = Math.abs(delta) < RATING_TREND_EPSILON ? "stable" : delta > 0 ? "improving" : "declining";
        }

        const dominantThemes = verifyThemes(raw.recentDominantThemes, recent.reviews.length ? recent.reviews : combined, "customer_reviews", tierARejected);
        recentSentiment = { reviewCount: recent.reviews.length, avgRating: recentAvg, priorAvgRating: priorAvg, trend, dominantThemes };
      }
    }
    tierAOutcome = (strengths.length + weaknesses.length) > 0 ? "success" : "empty";
  }

  const tierA: TierResult = {
    tier: "Amazon reviews",
    attempted: asinValid,
    outcome: tierAOutcome,
    itemCount: combined.length,
    errorMessage: asinValid && amazonOutcome.status === "error" ? amazonOutcome.errorMessage : undefined,
  };

  // ---- Tier B: product listing's top_reviews + rating_breakdown ----
  // Reuses the product payload the caller already fetched (route already
  // calls getAmazonProduct before this function) — zero additional
  // Rainforest calls. Only runs when Tier A produced no themes.
  const listingStats: ListingStats | null = product ? {
    rating: product.rating,
    reviewsTotal: product.reviews_total,
    ratingBreakdown: product.rating_breakdown,
    source: "amazon_product_listing",
  } : null;

  let tierBAttempted = false;
  let tierBOutcome: TierOutcome = "empty";
  let tierBItemCount = 0;
  const tierBRejected = { count: 0, reasons: [] as string[] };

  if (strengths.length + weaknesses.length === 0 && product && !overBudget()) {
    const tierBReviews = topReviewsToAmazonReviews(product);
    tierBItemCount = tierBReviews.length;
    tierBAttempted = true;

    if (tierBReviews.length > 0) {
      const positiveTB = tierBReviews.filter(r => (r.rating ?? 0) >= 4);
      const negativeTB = tierBReviews.filter(r => (r.rating ?? 0) <= 2);
      const { systemPrompt, userPrompt } = buildPrompt(product.asin, productTitle, positiveTB, negativeTB, [], false);
      const raw = await callAi(systemPrompt, userPrompt);
      if (!raw) {
        anyAiUnavailable = true;
      } else {
        strengths = [...strengths, ...verifyThemes(raw.strengths, tierBReviews, "amazon_listing", tierBRejected)];
        weaknesses = [...weaknesses, ...verifyThemes(raw.weaknesses, tierBReviews, "amazon_listing", tierBRejected)];
      }
    }
    tierBOutcome = (strengths.length + weaknesses.length) > 0 ? "success" : "empty";
  }

  const tierB: TierResult = {
    tier: "Amazon listing (top reviews)",
    attempted: tierBAttempted,
    outcome: tierBOutcome,
    itemCount: tierBItemCount,
  };

  // ---- Tier C: web expert reviews + forum discussions ----
  // Only when Tiers A and B together still found nothing — merges in.
  let expertReviewCount = 0;
  let forumCount = 0;
  let tierCAttempted = false;
  let tierCQueries: ProvenanceQuery[] = [];

  if (strengths.length + weaknesses.length === 0 && !overBudget()) {
    tierCAttempted = true;
    // Fetched locally here (analyzeReviews's own natural async boundary) —
    // never pushed up to its callers, and never module-level state (see
    // lib/tool-type-taxonomy.ts's header for why).
    const toolTypes = await listToolTypes();
    const web = await resolveWebReviewThemes(productTitle, toolTypes, requiredToolType);
    strengths = [...strengths, ...web.strengths];
    weaknesses = [...weaknesses, ...web.weaknesses];
    expertReviewCount = web.expertReviewCount;
    forumCount = web.forumCount;
    tierCQueries = web.queries;
  }

  // FIX 3: sentiment-agreement + translation check, once per analysis —
  // may drop a mismatched quote (or an entire theme that falls below the
  // minimum afterward), so this must run before the totals/gates below are
  // computed from the final strengths/weaknesses.
  ({ strengths, weaknesses } = await checkQuoteQuality(strengths, weaknesses));

  const tierExpert: TierResult = {
    tier: "Expert reviews",
    attempted: tierCAttempted,
    outcome: tierCAttempted ? (expertReviewCount > 0 ? "success" : "empty") : "empty",
  };
  const tierForum: TierResult = {
    tier: "Forum discussions",
    attempted: tierCAttempted,
    outcome: tierCAttempted ? (forumCount > 0 ? "success" : "empty") : "empty",
  };

  const tiers: TierResult[] = [tierA, tierB, tierExpert, tierForum];

  const totalThemesFound = strengths.length + weaknesses.length + (recentSentiment?.dominantThemes.length ?? 0);
  const hasListingFloor = !!listingStats && (listingStats.rating != null || listingStats.reviewsTotal != null);
  const anyTierErrored = tiers.some(t => t.attempted && t.outcome === "error");

  // Preserves the original gate (Amazon's own full-reviews count below
  // MIN_REVIEWS_REQUIRED AND no themes found anywhere) for when nothing
  // errored; when a tier DID error, that's sourcesUnavailable instead of a
  // (false) claim that no data exists. A real listing's rating/count floor
  // means neither notice should show — there's always something to display.
  const noThemesAnywhere = totalThemesFound === 0 && expertReviewCount === 0 && forumCount === 0 && combined.length < MIN_REVIEWS_REQUIRED;

  const insufficientData = noThemesAnywhere && !hasListingFloor && !anyTierErrored;
  const sourcesUnavailable = noThemesAnywhere && !hasListingFloor && anyTierErrored;

  const provenanceTiers: ProvenanceTier[] = [
    { ...fromTierResult(tierA), rejectedCount: tierARejected.count || undefined, rejectedReasons: tierARejected.reasons.length ? tierARejected.reasons : undefined },
    { ...fromTierResult(tierB), rejectedCount: tierBRejected.count || undefined, rejectedReasons: tierBRejected.reasons.length ? tierBRejected.reasons : undefined },
    fromTierResult(tierExpert),
    fromTierResult(tierForum),
  ];
  const provenanceQueries: ProvenanceQuery[] = [];
  if (asinValid) {
    provenanceQueries.push({ tier: "Amazon reviews", query: `Rainforest reviews API — ASIN ${asin} (all/positive/negative/recent passes)`, outcome: tierAOutcome, itemCount: combined.length, verified: true });
  }
  if (tierBAttempted) {
    provenanceQueries.push({ tier: "Amazon listing (top reviews)", query: `Rainforest product API top_reviews — ASIN ${product?.asin ?? asin}`, outcome: tierBOutcome, itemCount: tierBItemCount, verified: true });
  }
  provenanceQueries.push(...tierCQueries);

  return {
    strengths,
    weaknesses,
    recentSentiment,
    reviewCountAnalyzed: combined.length,
    dateRange,
    insufficientData,
    sourcesUnavailable,
    aiUnavailable: anyAiUnavailable && totalThemesFound === 0,
    listingStats,
    sourcesSummary: {
      amazonReviews: combined.length,
      expertReviews: expertReviewCount,
      forumDiscussions: forumCount,
      tiersTried: tiers.filter(t => t.attempted).map(t => t.tier),
      tiers,
    },
    provenance: { tiers: provenanceTiers, queries: provenanceQueries },
  };
}
