"use client";

import { createContext, createElement, useContext, type ReactNode } from "react";
import { create } from "zustand";
import type { BackgroundAssetKey } from "@/lib/background-stage-config";

interface BackgroundStageState {
  // Set by a route while it's in a temporary "waiting/generating" state
  // (ProgressPanel, ProjectGenerationProgress) — takes priority over the
  // route's own default asset for as long as that state is active, then
  // clears itself on unmount. Null means "use the route default."
  overrideAsset: BackgroundAssetKey | null;
  setOverride: (asset: BackgroundAssetKey) => void;
  clearOverride: () => void;
}

export const useBackgroundStageStore = create<BackgroundStageState>((set) => ({
  overrideAsset: null,
  setOverride: (asset) => set({ overrideAsset: asset }),
  clearOverride: () => set({ overrideAsset: null }),
}));

// Real bug, confirmed live via screenshot on the project detail page's
// Pricing tab: useGlassMode() being purely route-based means EVERY
// MagicBentoCard on a route with a background is told "glass," even ones
// nested inside an opaque, fully solid bg-surface-2 box (the project
// page's "Tab Content Canvas" wrapping all 6 tabs' content) that already
// completely covers the cinema image behind it. .magic-bento-card--glass's
// text tokens (near-white/light-gray) are calibrated for sitting on a
// near-black translucent fill directly over that dark image — blended
// against a LIGHT opaque box instead, the fill renders as a medium gray
// that's too close to those same gray tokens (--text-muted especially),
// producing the exact "label text barely visible, only the boldest value
// text readable" pattern seen in the screenshot. GlassModeOverride lets an
// opaque ancestor declare "nothing under me is really floating over the
// image, even though the route has one" — every existing useGlassMode()
// call site (MagicBentoCard included) picks this up for free, zero
// changes needed at each call site.
const GlassModeOverrideContext = createContext<boolean | null>(null);

export function GlassModeOverride({ value, children }: { value: boolean; children: ReactNode }) {
  return createElement(GlassModeOverrideContext.Provider, { value }, children);
}

// Background videos/images (BackgroundStage) were removed app-wide for
// performance and text-visibility reasons — routes no longer have a "cinema
// image" behind them, so this always resolves to plain/solid rendering now.
// An explicit GlassModeOverride still wins if some future caller passes one.
export function useGlassMode(): boolean {
  const override = useContext(GlassModeOverrideContext);
  if (override !== null) return override;
  return false;
}
