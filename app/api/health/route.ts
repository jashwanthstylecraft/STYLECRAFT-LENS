import { NextResponse } from "next/server";
import { hasAnthropicKey, ANTHROPIC_MODEL } from "@/lib/anthropic";
import { hasOpenAIKey, OPENAI_MODEL } from "@/lib/openai";
import { hasGeminiKey } from "@/lib/gemini";
import { hasRainforestKey } from "@/lib/rainforest";
import { validateEnvOnce } from "@/lib/env";

// The pragmatic Next.js-serverless substitute for a "validate providers at
// boot" check — there's no true run-once-at-deploy hook without extra
// config (experimental.instrumentationHook), so this is a callable-anytime
// endpoint an uptime monitor or a person can hit right after every deploy.
// Deliberately public and boolean-only — reveals presence, never the actual
// secret values. validateEnvOnce() (lib/env.ts) additionally console.error/
// warns anything production-critical that's missing or malformed, visible
// in `vercel logs` the moment this route is hit on a fresh instance.
export async function GET() {
  const env = validateEnvOnce();
  return NextResponse.json({
    // Claude is primary now (see lib/anthropic.ts); OpenAI is the configured
    // fallback, so the app is functionally healthy if either is present.
    ok: (hasAnthropicKey || hasOpenAIKey) && env.ok,
    anthropic: hasAnthropicKey,
    openai: hasOpenAIKey,
    gemini: hasGeminiKey,
    rainforest: hasRainforestKey,
    model: hasAnthropicKey ? ANTHROPIC_MODEL : OPENAI_MODEL,
    env: { ok: env.ok, errorCount: env.errors.length, warningCount: env.warnings.length },
  });
}
