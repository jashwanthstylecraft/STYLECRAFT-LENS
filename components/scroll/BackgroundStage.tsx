"use client";

// The cinematic full-viewport background video/image (with GSAP crossfade,
// depth-rig parallax, etc.) was removed app-wide — it was a real source of
// perceived slowness (autoplaying video decode, continuous GSAP/parallax
// work) and, per stores/backgroundStageStore.ts's own history, an actual
// text-visibility bug (glass-mode text tokens calibrated for sitting over a
// dark image went low-contrast once nothing was really behind them). Kept as
// a no-op component (rather than deleted) so its two mount points —
// components/layout/Shell.tsx and the standalone auth pages — don't need
// their own changes; every route now just shows its plain solid
// bg-surface-1 background (app/globals.css's `body` rule).
export default function BackgroundStage() {
  return null;
}
