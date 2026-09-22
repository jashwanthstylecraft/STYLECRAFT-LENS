// scripts/verify-anthropic-provider.ts
// Offline regression check for lib/anthropic.ts — the new Claude primary AI
// provider (analysis + GTM/TDS/Content Form generation). No live Anthropic
// call: anthropic.messages.create is monkey-patched directly (same
// technique as scripts/verify-openai-retry-timeout.ts), not the raw fetch
// layer, since the SDK method itself is the stable seam.
//
// Covers the exact failure mode the prior, now-removed Anthropic
// integration had: an uncapped web-search call once ran 30+ minutes in
// testing. runClaudeWebSearch bounds this two ways — a hard turn ceiling
// (CLAUDE_WEB_SEARCH_MAX_TURNS) and a wall-clock deadline threaded through
// every resumed turn — both asserted here directly against synthetic
// pause_turn sequences.
//
// Run with: npx tsx scripts/verify-anthropic-provider.ts

import Anthropic from "@anthropic-ai/sdk";

export {};

// hasAnthropicKey is computed at module-import time from this env var — set
// before importing lib/anthropic below so runClaudeWebSearch's own
// !hasAnthropicKey guard doesn't short-circuit before the monkey-patched
// anthropic.messages.create ever runs. Same pattern as
// scripts/verify-motor-price-discovery.ts's RAINFOREST_API_KEY stub.
process.env.ANTHROPIC_API_KEY = "test-key-not-a-real-credential";

let failures = 0;
let passes = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passes++;
    console.log(`  PASS: ${message}`);
  } else {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

function textBlock(text: string) {
  return { type: "text", text };
}
function serverToolUseBlock(query: string) {
  return { type: "server_tool_use", name: "web_search", input: { query } };
}

async function main() {
  const { anthropic, cleanJsonString, classifyClaudeError, runClaudeWebSearch } = await import("../lib/anthropic");
  const originalCreate = anthropic.messages.create.bind(anthropic.messages);

  console.log("\n[1] cleanJsonString — strips fences/prose, extracts the balanced JSON substring");
  assert(cleanJsonString('```json\n{"a":1}\n```') === '{"a":1}', "strips a ```json fence");
  assert(cleanJsonString('Sure, here you go:\n{"a":1}\nHope that helps!') === '{"a":1}', "strips leading/trailing prose around a JSON object");
  assert(cleanJsonString('[{"a":1},{"b":2}]') === '[{"a":1},{"b":2}]', "a top-level array is extracted intact");
  assert(cleanJsonString('prefix {"a": {"nested": 1}} suffix') === '{"a": {"nested": 1}}', "nested braces are balanced correctly, not cut at the first close-brace");

  console.log("\n[2] classifyClaudeError — real SDK error classes map to the right bucket, most-specific first");
  assert(classifyClaudeError(new Anthropic.AuthenticationError(401, { message: "bad key" } as any, "bad key", undefined as any, "authentication_error")) === "auth", "AuthenticationError -> auth");
  assert(classifyClaudeError(new Anthropic.RateLimitError(429, { message: "rate limited" } as any, "rate limited", undefined as any, "rate_limit_error")) === "rate_limit", "RateLimitError -> rate_limit");
  assert(classifyClaudeError(new Anthropic.InternalServerError(500, { message: "server error" } as any, "server error", undefined as any, "api_error")) === "overload", "InternalServerError -> overload");
  assert(classifyClaudeError(new Anthropic.APIConnectionError({ message: "network down" })) === "connection", "APIConnectionError -> connection");
  assert(classifyClaudeError(new Error("something else")) === "unknown", "a plain, unclassified Error -> unknown");
  assert(classifyClaudeError({ status: 401 }) === "auth", "a plain object with .status 401 (not an SDK instance) still classifies via the status fallback");

  console.log("\n[3] runClaudeWebSearch — single-turn success: text extracted, search queries captured");
  let calls = 0;
  (anthropic.messages as any).create = async (_params: any) => {
    calls++;
    return {
      stop_reason: "end_turn",
      content: [serverToolUseBlock("best cordless trimmer 2026"), { type: "web_search_tool_result", content: [] }, textBlock('{"competitors":[]}')],
    };
  };
  const single = await runClaudeWebSearch("system", "user", 10_000);
  assert(calls === 1, "exactly 1 underlying call for a plain end_turn response");
  assert(single.text === '{"competitors":[]}', "the final text block is returned verbatim");
  assert(single.queries.length === 1 && single.queries[0] === "best cordless trimmer 2026", "the server_tool_use block's query is captured for the progress panel");

  console.log("\n[4] runClaudeWebSearch — pause_turn resumes automatically, no synthetic 'continue' message");
  calls = 0;
  const seenMessagesPerCall: any[][] = [];
  (anthropic.messages as any).create = async (params: any) => {
    calls++;
    seenMessagesPerCall.push(params.messages);
    if (calls === 1) {
      return { stop_reason: "pause_turn", content: [serverToolUseBlock("query one")] };
    }
    return { stop_reason: "end_turn", content: [serverToolUseBlock("query two"), textBlock('{"ok":true}')] };
  };
  const resumed = await runClaudeWebSearch("system", "user", 10_000);
  assert(calls === 2, "exactly 2 calls — 1 paused, 1 resumed to completion");
  assert(resumed.text === '{"ok":true}', "the resumed call's final text is returned");
  assert(resumed.queries.length === 2 && resumed.queries.includes("query one") && resumed.queries.includes("query two"), "queries from BOTH the paused and resumed turns are captured");
  assert(seenMessagesPerCall[1].length === 2 && seenMessagesPerCall[1][1].role === "assistant", "the resume call appends the paused assistant turn as the 2nd message");
  assert(seenMessagesPerCall[1].every((m: any) => m.role !== "system"), "no synthetic 'continue' user message is injected — matches Anthropic's own documented auto-resume behavior");

  console.log("\n[5] runClaudeWebSearch — a pause_turn loop that never finishes is bounded by CLAUDE_WEB_SEARCH_MAX_TURNS, not left to run forever");
  calls = 0;
  (anthropic.messages as any).create = async () => {
    calls++;
    return { stop_reason: "pause_turn", content: [] };
  };
  let maxTurnsError: any = null;
  try {
    await runClaudeWebSearch("system", "user", 60_000);
  } catch (err) {
    maxTurnsError = err;
  }
  assert(maxTurnsError !== null, "an endless pause_turn sequence eventually throws instead of looping forever");
  assert(calls <= 6, `the loop is bounded by a small, fixed turn ceiling regardless of the time budget (made ${calls} calls) — this is the fix for the prior Anthropic integration's 30+ minute runaway web-search call`);

  console.log("\n[6] runClaudeWebSearch — wall-clock deadline is enforced across resumed turns, independent of the turn ceiling");
  calls = 0;
  (anthropic.messages as any).create = async () => {
    calls++;
    await new Promise(r => setTimeout(r, 40));
    return { stop_reason: "pause_turn", content: [] };
  };
  const deadlineStart = Date.now();
  let deadlineError: any = null;
  try {
    await runClaudeWebSearch("system", "user", 90); // shorter than a few 40ms turns combined
  } catch (err) {
    deadlineError = err;
  }
  const deadlineElapsed = Date.now() - deadlineStart;
  assert(deadlineError !== null, "exceeding the wall-clock budget throws rather than continuing to resume");
  assert(String(deadlineError?.message || "").includes("budget"), `the error names the budget as the reason (got: ${deadlineError?.message})`);
  assert(deadlineElapsed < 500, `stops promptly once the budget is exceeded rather than running all ${calls} calls to their natural conclusion (took ${deadlineElapsed}ms)`);

  console.log("\n[7] runClaudeWebSearch — an empty final response is a real failure, never silently returned as an empty answer");
  calls = 0;
  (anthropic.messages as any).create = async () => ({ stop_reason: "end_turn", content: [] });
  let emptyError: any = null;
  try {
    await runClaudeWebSearch("system", "user", 10_000);
  } catch (err) {
    emptyError = err;
  }
  assert(emptyError !== null, "an end_turn response with no text content throws instead of returning an empty/fabricated answer");

  (anthropic.messages as any).create = originalCreate;

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
