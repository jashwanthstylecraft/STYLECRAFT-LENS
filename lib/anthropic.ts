import Anthropic from "@anthropic-ai/sdk";
import { logCall } from "./obs";

const apiKey = process.env.ANTHROPIC_API_KEY || "";

// maxRetries: 0 — same reasoning as lib/openai.ts: this app already has its
// own deliberate, budget-aware retry/fallback logic (runClaudeWebSearch's
// deadline below, and lib/analysisEngine.ts's withAiFallback chain), so the
// SDK's automatic retries would only double up on a timed-out call and blow
// through Vercel's 60s cap.
export const anthropic = new Anthropic({ apiKey: apiKey || "mock-key-for-development", maxRetries: 0 });

// Primary AI provider — analysis (competitor discovery, Phase 1/2/3) and
// GTM/TDS/Content Form field generation try Claude first now; OpenAI is the
// configured fallback (see lib/openai.ts), with Gemini further behind that
// (currently disabled app-wide — see lib/gemini.ts's own kill-switch).
export const hasAnthropicKey = !!apiKey && apiKey !== "";

// The closest practical equivalent to a "validate at boot" check in a
// Next.js serverless runtime — fires once per cold start and is visible
// immediately in Vercel's function logs, matching lib/openai.ts's own check.
if (!hasAnthropicKey) {
  console.error("[anthropic] ANTHROPIC_API_KEY is not set — every Claude-backed call (analysis, GTM/TDS/Content Form generation) will fall back to OpenAI for this instance.");
}

export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

// Strip markdown fences and extract the JSON object/array itself — same
// balanced-bracket approach as lib/openai.ts's/lib/gemini.ts's cleanJsonString
// (each provider file keeps its own copy — established precedent in this
// codebase rather than a shared cross-provider import).
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
  return fenceStripped.slice(start);
}

export type ClaudeErrorClass = "auth" | "rate_limit" | "overload" | "connection" | "unknown";

// Order matters exactly like lib/openai.ts's classifyOpenAiError — most
// specific subclass first.
export function classifyClaudeError(err: any): ClaudeErrorClass {
  if (err instanceof Anthropic.AuthenticationError || err?.status === 401) return "auth";
  if (err instanceof Anthropic.RateLimitError || err?.status === 429) return "rate_limit";
  if (err instanceof Anthropic.InternalServerError || (typeof err?.status === "number" && err.status >= 500)) return "overload";
  if (err instanceof Anthropic.APIConnectionError) return "connection";
  return "unknown";
}

export interface ClaudeSearchResult {
  text: string;
  queries: string[];
}

// Bounds server-tool iterations at the tool level — the same lesson learned
// from the prior, now-removed Anthropic integration: an uncapped web-search
// call once ran 30+ minutes in testing (see lib/analysisEngine.ts's own
// comment on runOpenAiWebSearch, which replaced it). Matches
// lib/openai.ts's runOpenAiWebSearch's max_tool_calls: 5.
const CLAUDE_WEB_SEARCH_MAX_USES = 5;
// A hard ceiling on total loop iterations (pause_turn resumes), independent
// of max_uses — belt-and-suspenders against that same runaway-duration risk,
// on top of the timeoutMs deadline below.
const CLAUDE_WEB_SEARCH_MAX_TURNS = 6;

// Claude equivalent of lib/openai.ts's runOpenAiWebSearch — searches live via
// the web_search server tool, resuming through `pause_turn` (a long
// server-tool turn hits its own internal iteration cap and pauses; per
// Anthropic's docs the API resumes automatically once the paused assistant
// turn is echoed back — no synthetic "continue" user message). `timeoutMs`
// bounds the WHOLE loop via a shared deadline (not just one HTTP call),
// mirroring every other AI call in lib/analysisEngine.ts's own
// ROUTE_TIME_BUDGET_MS discipline.
export async function runClaudeWebSearch(systemPrompt: string, userPrompt: string, timeoutMs: number): Promise<ClaudeSearchResult> {
  if (!hasAnthropicKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const tools: any[] = [{ type: "web_search_20260209", name: "web_search", max_uses: CLAUDE_WEB_SEARCH_MAX_USES }];
  let messages: any[] = [{ role: "user", content: userPrompt }];
  const queries: string[] = [];
  const deadline = Date.now() + timeoutMs;

  for (let turn = 0; turn < CLAUDE_WEB_SEARCH_MAX_TURNS; turn++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Claude web search exceeded its ${timeoutMs}ms budget`);

    const response: any = await anthropic.messages.create(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 16000,
        output_config: { effort: "low" },
        system: systemPrompt,
        tools,
        messages,
      } as any,
      { timeout: remaining }
    );

    // Best-effort query capture for the live progress panel only — never
    // lets an unexpected content-block shape break the actual JSON answer.
    for (const block of response.content || []) {
      if (block?.type === "server_tool_use" && block?.name === "web_search" && typeof block?.input?.query === "string") {
        queries.push(block.input.query);
      }
    }

    if (response.stop_reason === "pause_turn") {
      messages = [...messages, { role: "assistant", content: response.content }];
      continue;
    }

    const text = (response.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    if (!text) throw new Error(`Empty response from Claude web search call (stop_reason: ${response.stop_reason})`);
    return { text, queries };
  }

  throw new Error(`Claude web search exceeded ${CLAUDE_WEB_SEARCH_MAX_TURNS} turns without a final answer`);
}

// General-purpose JSON generation — the Claude equivalent of
// lib/openai.ts's callOpenAiForJson. `webSearch: true` attaches the native
// web_search tool for calls that need live grounding (analysis,
// identification, GTM field lookups); omit it for pure text/JSON tasks
// where no search is needed.
export async function callClaudeForJson<T = any>(
  systemInstruction: string,
  userContent: string,
  label: string,
  opts?: { webSearch?: boolean; timeoutMs?: number; projectId?: string }
): Promise<T | null> {
  if (!hasAnthropicKey) return null;

  const timeoutMs = opts?.timeoutMs ?? 25_000;
  const callT0 = Date.now();
  try {
    if (opts?.webSearch) {
      const { text } = await runClaudeWebSearch(systemInstruction, userContent, timeoutMs);
      logCall("anthropic", { op: "messages.create", label, projectId: opts?.projectId, outcome: "ok", elapsedMs: Date.now() - callT0 });
      return JSON.parse(cleanJsonString(text));
    }

    const response: any = await anthropic.messages.create(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 16000,
        output_config: { effort: "low" },
        system: systemInstruction,
        messages: [{ role: "user", content: userContent }],
      } as any,
      { timeout: timeoutMs }
    );

    const usage = response.usage || {};
    logCall("anthropic", {
      op: "messages.create", label, projectId: opts?.projectId, outcome: "ok", elapsedMs: Date.now() - callT0,
      tokensIn: usage.input_tokens, tokensOut: usage.output_tokens,
    });

    const text = (response.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    if (!text) return null;
    return JSON.parse(cleanJsonString(text));
  } catch (err: any) {
    const errorClass = classifyClaudeError(err);
    console.warn(`Claude ${label} generation failed:`, err);
    logCall("anthropic", {
      op: "messages.create", label, projectId: opts?.projectId, outcome: "error",
      errorClass, errorMessage: err?.message || String(err), elapsedMs: Date.now() - callT0,
    });
    return null;
  }
}
