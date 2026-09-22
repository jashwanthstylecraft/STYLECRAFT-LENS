// scripts/verify-analysis-fallback-reliability.ts
// Offline regression check for withAiFallback's Claude -> OpenAI -> Gemini ->
// mock chain (Claude is primary now; OpenAI is the configured fallback,
// Gemini remains behind that) and for the original "Connection dropped —
// retrying" bug: Phase 1/2/3 of a live analysis were hitting Vercel's 60s
// hard function timeout because a fallback tier was always attempted
// (including Gemini's own ungrounded retry) regardless of how much of the
// route's time budget earlier tiers had already burned, and never
// short-circuited a Gemini 429/RESOURCE_EXHAUSTED quota error before
// wastefully retrying ungrounded. No live Claude/OpenAI/Gemini call, no
// .env.local loaded — this only exercises the pure classification/budget
// logic with synthetic promises.
//
// Run with: npx tsx scripts/verify-analysis-fallback-reliability.ts

export {};

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

async function main() {
  const { isGeminiQuotaExhausted, withAiFallback, ROUTE_TIME_BUDGET_MS, MIN_VIABLE_GEMINI_ATTEMPT_MS, MIN_VIABLE_OPENAI_ATTEMPT_MS } = await import("../lib/analysisEngine");

  // ---- Section 1: isGeminiQuotaExhausted classification ----
  console.log("\n[1] isGeminiQuotaExhausted — real production error shapes");
  const rawQuotaError = new Error(
    '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}'
  );
  assert(isGeminiQuotaExhausted(rawQuotaError) === true, "the exact production RESOURCE_EXHAUSTED message string is detected");
  assert(isGeminiQuotaExhausted({ status: 429, message: "rate limited" }) === true, "a typed .status === 429 is detected");
  assert(isGeminiQuotaExhausted({ code: 429, message: "rate limited" }) === true, "a typed .code === 429 is detected");
  assert(isGeminiQuotaExhausted(new Error("Empty response (finishReason: SAFETY)")) === false, "an unrelated Gemini error is NOT misclassified as quota exhaustion");
  assert(isGeminiQuotaExhausted(new Error("503 UNAVAILABLE — model overloaded")) === false, "a 503 overload error is NOT misclassified as quota exhaustion (different failure, different handling)");

  // ---- Section 2: withAiFallback — Claude success short-circuits everything ----
  console.log("\n[2] withAiFallback — Claude success never touches OpenAI/Gemini/mock");
  let openAiCalled = false, geminiCalled = false, mockCalled = false;
  const r1 = await withAiFallback(
    "test",
    async () => "claude-result",
    async () => { openAiCalled = true; return "openai"; },
    async () => { geminiCalled = true; return "gemini"; },
    () => { mockCalled = true; return "mock"; },
    Date.now()
  );
  assert(r1 === "claude-result", "Claude's result is returned as-is");
  assert(!openAiCalled && !geminiCalled && !mockCalled, "OpenAI, Gemini, and mock are never invoked when Claude succeeds");

  // ---- Section 3: Claude fails, plenty of budget left -> OpenAI is attempted ----
  console.log("\n[3] withAiFallback — Claude fails with time to spare -> OpenAI attempted");
  let openAiAttempted = false;
  const r2 = await withAiFallback(
    "test",
    async () => { throw new Error("claude failed"); },
    async () => { openAiAttempted = true; return "openai-result"; },
    async () => "gemini-result",
    () => "mock",
    Date.now() // full budget remaining
  );
  assert(r2 === "openai-result", "OpenAI's result is used when Claude fails and there's time left");
  assert(openAiAttempted, "OpenAI was actually attempted");

  // ---- Section 4: Claude + OpenAI fail, plenty of budget left -> Gemini is attempted ----
  console.log("\n[4] withAiFallback — Claude+OpenAI fail with time to spare -> Gemini attempted");
  let geminiAttempted = false;
  const r3 = await withAiFallback(
    "test",
    async () => { throw new Error("claude failed"); },
    async () => { throw new Error("openai timeout"); },
    async () => { geminiAttempted = true; return "gemini-result"; },
    () => "mock",
    Date.now() // full budget remaining
  );
  assert(r3 === "gemini-result", "Gemini's result is used when Claude+OpenAI fail and there's time left");
  assert(geminiAttempted, "Gemini was actually attempted");

  // ---- Section 5: Claude fails, budget nearly exhausted -> OpenAI AND Gemini both SKIPPED, straight to mock ----
  console.log("\n[5] withAiFallback — Claude fails with budget nearly exhausted -> OpenAI+Gemini SKIPPED, straight to mock");
  let openAiCalledWhenLate = false, geminiCalledWhenLate = false;
  const minViableWindow = Math.max(MIN_VIABLE_OPENAI_ATTEMPT_MS, MIN_VIABLE_GEMINI_ATTEMPT_MS);
  const lateStartTime = Date.now() - (ROUTE_TIME_BUDGET_MS - minViableWindow + 1000); // 1s short of the minimum viable window for both
  const r4 = await withAiFallback(
    "test",
    async () => { throw new Error("claude failed"); },
    async () => { openAiCalledWhenLate = true; return "openai-result"; },
    async () => { geminiCalledWhenLate = true; return "gemini-result"; },
    () => "mock-result",
    lateStartTime
  );
  assert(r4 === "mock-result", "falls back to mock when too little time remains for a real OpenAI/Gemini attempt");
  assert(!openAiCalledWhenLate, "OpenAI's function was never even invoked");
  assert(!geminiCalledWhenLate, "Gemini's function was never even invoked — this is exactly what prevents the Vercel 60s hard-kill");

  // ---- Section 6: every real provider fails -> falls through to mock ----
  console.log("\n[6] withAiFallback — Claude, OpenAI, and Gemini all fail -> falls through to mock");
  const r5 = await withAiFallback(
    "test",
    async () => { throw new Error("claude failed"); },
    async () => { throw new Error("openai failed"); },
    async () => { throw new Error("gemini also failed"); },
    () => "mock-result",
    Date.now()
  );
  assert(r5 === "mock-result", "mock is the final fallback when every real provider fails");

  // ---- Section 7: no providers configured at all -> mock directly ----
  console.log("\n[7] withAiFallback — no providers configured -> mock directly, no wasted attempts");
  const r6 = await withAiFallback("test", null, null, null, () => "mock-only", Date.now());
  assert(r6 === "mock-only", "mock runs directly when every provider callback is null");

  console.log(`\n${passes} passed, ${failures} failed`);
  // Same fix as scripts/verify-review-tiers.ts — only exited explicitly on
  // failure, so a passing run relied on natural process exit that never
  // actually happens (something in the module graph keeps the event loop
  // alive), hanging forever instead of exiting 0.
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
