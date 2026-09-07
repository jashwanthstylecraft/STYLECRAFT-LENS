import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY || "";

// A flag to check if the user has provided a real key or if we are in mock/demo mode.
// TEMPORARILY forced false — the configured GEMINI_API_KEY has expired, so
// every Gemini call was failing anyway, just after wasting real request time
// finding that out first (this string-shape check can't detect an expired
// key, only a missing/placeholder one — that only surfaces as a real auth
// error at call time). Every caller across the app (analysis Phase 0-3
// fallback, GTM/TDS/artwork generation, report rewrite) is already written
// to gracefully fall through to its next tier when hasGeminiKey is false, so
// this one flag correctly routes everything straight to OpenAI/its own
// next fallback instead of stalling on a doomed Gemini attempt first.
// Remove the `&& false` below once a real, current GEMINI_API_KEY is set.
export const hasGeminiKey =
  !!apiKey &&
  apiKey !== "" &&
  !apiKey.includes("your-gemini") &&
  !apiKey.includes("xxxx") &&
  false;

// Broad-audit finding — every Gemini call in this codebase (8 call sites)
// had NO timeout at all. Confirmed by reading the SDK's own source
// (node_modules/@google/genai): with no `httpOptions.timeout` set, its
// internal `timeout_ms` resolves to -1, which the SDK explicitly treats as
// "never attach an AbortSignal" — a stalled Google endpoint would hang for
// however long the platform allows, exactly the "Connection dropped" class
// of bug lib/rainforest.ts's own header comment already describes fixing
// once for Rainforest (nothing ever logged server-side, the fetch just sat
// there consuming the whole remaining request budget until Vercel force-
// killed the function). Setting httpOptions.timeout here applies to every
// call through this one shared client — 45s leaves real headroom under
// Vercel's 60s hard cap for the calling route to still do something useful
// with a timeout error, while still being generous enough for this app's
// genuinely slow calls (web-search-augmented generation, vision analysis).
export const genAI = new GoogleGenAI({ apiKey: apiKey || "mock-key-for-development", httpOptions: { timeout: 45_000 } });

// Fast, cheap, current-generation model used for all text/JSON generation and
// vision calls across the app (market research, sales kit, TDS, artwork, rewrite).
export const GEMINI_MODEL = "gemini-3.5-flash";

// Strip markdown code fences some models wrap JSON responses in, then
// extract just the JSON object/array itself. Tool-augmented responses
// (Claude with web_search, Gemini with googleSearch) routinely prepend
// conversational prose before the JSON ("Based on the search results,
// here's the identification: {...}") or append it after — a plain
// fence-strip still leaves that prose in place and JSON.parse throws. Scan
// for the first '{' or '[' and use balanced bracket-matching to find its
// true closing bracket, discarding anything outside that span.
export function cleanJsonString(text: string): string {
  const fenceStripped = text.replace(/```json|```/g, "").trim();

  const firstBrace = fenceStripped.indexOf("{");
  const firstBracket = fenceStripped.indexOf("[");
  const starts = [firstBrace, firstBracket].filter(i => i !== -1);
  if (starts.length === 0) return fenceStripped;

  const start = Math.min(...starts);
  const open = fenceStripped[start];
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  for (let i = start; i < fenceStripped.length; i++) {
    if (fenceStripped[i] === open) depth++;
    else if (fenceStripped[i] === close) {
      depth--;
      if (depth === 0) return fenceStripped.slice(start, i + 1);
    }
  }
  // No balanced close found — return from the start onward and let
  // JSON.parse throw naturally rather than silently truncating.
  return fenceStripped.slice(start);
}
